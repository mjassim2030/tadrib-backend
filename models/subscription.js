// models/subscription.js
const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema(
  {
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },

    planId: {
      type: String,
      enum: ['free', 'pro', 'business'],
      default: 'free',
    },

    cycle: {
      type: String,
      enum: ['monthly', 'annual'],
      default: 'monthly',
    },

    status: {
      type: String,
      enum: ['active', 'trialing', 'past_due', 'canceled', 'incomplete', 'incomplete_expired'],
      default: 'active',
    },

    // Stripe linkage (optional)
    stripeCustomerId: { type: String, index: true },
    stripeSubscriptionId: { type: String, index: true },
    stripePriceId: String,

    // Current period (as provided by Stripe or computed for free plan)
    currentPeriodStart: Date,
    currentPeriodEnd: Date,

    meta: { type: Object }, // room for future metadata
  },
  { timestamps: true }
);

subscriptionSchema.set('toJSON', {
  transform: (_doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
  },
});

module.exports = mongoose.model('Subscription', subscriptionSchema);