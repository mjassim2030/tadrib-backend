// routes/billing.js
const express = require('express');
const jwt = require('jsonwebtoken');
const Subscription = require('../models/subscription');
const User = require('../models/user');
const verifyToken = require('../middleware/verify-token');

const router = express.Router();

/* ------------------------- Config / Helpers ------------------------- */
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL?.replace(/\/+$/, '') || 'http://localhost:5173';

// Map your Stripe Price IDs via env (leave blank in dev to use mock flow)
const PRICE_MAP = {
  pro: {
    monthly: process.env.STRIPE_PRICE_PRO_MONTHLY || '',
    annual: process.env.STRIPE_PRICE_PRO_ANNUAL || '',
  },
  business: {
    monthly: process.env.STRIPE_PRICE_BUSINESS_MONTHLY || '',
    annual: process.env.STRIPE_PRICE_BUSINESS_ANNUAL || '',
  },
};

let stripe = null;
if (STRIPE_SECRET_KEY) {
  // lazy load Stripe only if keys provided
  const Stripe = require('stripe');
  stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
}

const PLANS = new Set(['free', 'pro', 'business']);
const CYCLES = new Set(['monthly', 'annual']);

function requireValidPlanCycle(planId, cycle) {
  if (!PLANS.has(planId)) throw new Error('Invalid planId');
  if (planId !== 'free' && !CYCLES.has(cycle)) throw new Error('Invalid cycle');
}

function monthsFromNow(n) {
  const d = new Date();
  d.setMonth(d.getMonth() + n);
  return d;
}

async function getOrCreateUserSubscription(userId) {
  let sub = await Subscription.findOne({ owner: userId });
  if (!sub) {
    sub = await Subscription.create({
      owner: userId,
      planId: 'free',
      status: 'active',
    });
  }
  return sub;
}

function chooseSuccessUrl(planId, cycle) {
  const p = encodeURIComponent(planId);
  const c = encodeURIComponent(cycle || 'monthly');
  return `${FRONTEND_BASE_URL}/subscriptions/success?plan=${p}&cycle=${c}`;
}
function chooseCancelUrl() {
  return `${FRONTEND_BASE_URL}/subscriptions`;
}

function priceIdFor(planId, cycle) {
  return PRICE_MAP?.[planId]?.[cycle] || '';
}

/* ------------------------- GET current status ------------------------- */
/**
 * GET /api/billing/status
 * Returns the caller's subscription (creates a default `free` record if missing).
 */
router.get('/status', verifyToken, async (req, res) => {
  try {
    const sub = await getOrCreateUserSubscription(req.user._id);
    res.json(sub.toJSON());
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/* ------------------------- POST checkout ------------------------- */
/**
 * POST /api/billing/checkout
 * Body: { planId: 'free'|'pro'|'business', cycle: 'monthly'|'annual' }
 * - free: instantly activate
 * - paid:
 *    - if Stripe configured: create Checkout Session, return { url }
 *    - otherwise (dev): immediately activate, return success url
 */
router.post('/checkout', verifyToken, async (req, res) => {
  try {
    const planId = String(req.body.planId || 'free');
    const cycle = String(req.body.cycle || 'monthly');

    requireValidPlanCycle(planId, cycle);

    // Load or initialize user's subscription
    const sub = await getOrCreateUserSubscription(req.user._id);

    // FREE → activate immediately
    if (planId === 'free') {
      sub.planId = 'free';
      sub.cycle = 'monthly';
      sub.status = 'active';
      sub.stripeSubscriptionId = undefined;
      sub.stripePriceId = undefined;
      sub.currentPeriodStart = new Date();
      sub.currentPeriodEnd = undefined; // unlimited
      await sub.save();
      return res.json({ url: chooseSuccessUrl('free', 'monthly') });
    }

    // PAID plans
    if (!stripe) {
      // DEV MODE (no Stripe): immediate activation for convenience
      sub.planId = planId;
      sub.cycle = cycle;
      sub.status = 'active';
      sub.stripeSubscriptionId = undefined;
      sub.stripePriceId = undefined;
      sub.currentPeriodStart = new Date();
      sub.currentPeriodEnd = cycle === 'annual' ? monthsFromNow(12) : monthsFromNow(1);
      await sub.save();
      return res.json({ url: chooseSuccessUrl(planId, cycle), mode: 'dev' });
    }

    // LIVE MODE with Stripe
    const priceId = priceIdFor(planId, cycle);
    if (!priceId) {
      return res
        .status(500)
        .json({ err: 'Stripe price not configured for this plan/cycle.' });
    }

    // Prepare or reuse Stripe customer
    let customerId = sub.stripeCustomerId;
    if (!customerId) {
      // Use username as email if your system stores email in username
      const u = await User.findById(req.user._id).select('username email').lean();
      const email = (u?.email || u?.username || '').trim() || undefined;

      const customer = await stripe.customers.create({
        email,
        metadata: { appUserId: String(req.user._id) },
      });
      customerId = customer.id;
      sub.stripeCustomerId = customerId;
      await sub.save();
    }

    // Create Checkout session
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: chooseSuccessUrl(planId, cycle) + '&session_id={CHECKOUT_SESSION_ID}',
      cancel_url: chooseCancelUrl(),
      metadata: {
        appUserId: String(req.user._id),
        planId,
        cycle,
      },
    });

    return res.json({ url: session.url });
  } catch (err) {
    res.status(400).json({ err: err.message });
  }
});

/* ------------------------- Stripe Portal (optional) ------------------------- */
/**
 * POST /api/billing/portal
 * Returns a Stripe customer portal URL (only when Stripe is configured).
 */
router.post('/portal', verifyToken, async (req, res) => {
  try {
    if (!stripe) return res.status(501).json({ err: 'Stripe is not configured.' });
    const sub = await getOrCreateUserSubscription(req.user._id);
    if (!sub.stripeCustomerId) return res.status(400).json({ err: 'No Stripe customer found.' });

    const portal = await stripe.billingPortal.sessions.create({
      customer: sub.stripeCustomerId,
      return_url: FRONTEND_BASE_URL + '/subscriptions',
    });
    res.json({ url: portal.url });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/* ------------------------- Stripe Webhook (optional) ------------------------- */
/**
 * POST /api/billing/webhook
 * Configure STRIPE_WEBHOOK_SECRET and point your Stripe webhook to this endpoint.
 * Handles checkout and subscription lifecycle events.
 */
if (STRIPE_WEBHOOK_SECRET) {
  // Use raw body for Stripe signature verification
  router.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case 'checkout.session.completed': {
          const session = event.data.object;
          // On subscription checkout, the subscription is available on the session
          const subscriptionId = session.subscription;
          const customerId = session.customer;
          const planId = session.metadata?.planId || undefined;
          const cycle = session.metadata?.cycle || undefined;

          // Fetch subscription to get period data
          const subObj = await stripe.subscriptions.retrieve(subscriptionId);
          const currentPeriodStart = new Date(subObj.current_period_start * 1000);
          const currentPeriodEnd = new Date(subObj.current_period_end * 1000);
          const priceId = subObj.items?.data?.[0]?.price?.id;

          // Find local subscription by customer
          const sub = await Subscription.findOne({ stripeCustomerId: customerId });
          if (sub) {
            sub.planId = planId || sub.planId;
            sub.cycle = cycle || sub.cycle;
            sub.status = subObj.status || 'active';
            sub.stripeSubscriptionId = subscriptionId;
            sub.stripePriceId = priceId;
            sub.currentPeriodStart = currentPeriodStart;
            sub.currentPeriodEnd = currentPeriodEnd;
            await sub.save();
          }
          break;
        }
        case 'customer.subscription.updated':
        case 'customer.subscription.created':
        case 'customer.subscription.deleted': {
          const subObj = event.data.object;
          const customerId = subObj.customer;
          const priceId = subObj.items?.data?.[0]?.price?.id;
          const currentPeriodStart = new Date(subObj.current_period_start * 1000);
          const currentPeriodEnd = new Date(subObj.current_period_end * 1000);
          const status = subObj.status;

          const local = await Subscription.findOne({ stripeCustomerId: customerId });
          if (local) {
            local.status = status;
            local.stripeSubscriptionId = subObj.id;
            local.stripePriceId = priceId;
            local.currentPeriodStart = currentPeriodStart;
            local.currentPeriodEnd = currentPeriodEnd;
            await local.save();
          }
          break;
        }
        default:
          // no-op for other events
          break;
      }

      res.json({ received: true });
    } catch (err) {
      res.status(500).send(`Webhook handler failed: ${err.message}`);
    }
  });
}

module.exports = router;