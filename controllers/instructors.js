// routes/instructors.js
const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const User = require('../models/user');
const Instructor = require('../models/instructor');
const InviteToken = require('../models/invite-token');
const verifyToken = require('../middleware/verify-token');

const router = express.Router();

/* --------------------------- Config / Helpers --------------------------- */
const SELF_EDITABLE_FIELDS = ['name', 'bio', 'phone', 'photoUrl', 'skills'];

const FRONTEND_URL =
  process.env.FRONTEND_APP_URL ||
  process.env.APP_ORIGIN ||
  process.env.WEB_APP_URL ||
  'http://localhost:5173'|| 
  'https://whale-app-2vav2.ondigitalocean.app';

const toStr = (v) => (v == null ? '' : String(v));
const sameId = (a, b) => String(a) === String(b);
const normalizeEmail = (e) => toStr(e).trim().toLowerCase();

function sanitizeUpdatable(body = {}) {
  const out = { ...body };
  if ('email' in out && out.email) out.email = normalizeEmail(out.email);
  if ('name' in out && out.name) out.name = toStr(out.name).trim();
  return out;
}

function canAccess(doc, userId) {
  if (!doc) return false;
  const isOwner = sameId(doc.owner, userId);
  const isSelf = doc.user && sameId(doc.user, userId);
  return isOwner || isSelf;
}

// Replace your existing resolveOrLinkInstructorForUser with this version:
async function resolveOrLinkInstructorForUser(userId) {
  // 1) direct link
  const linked = await Instructor.findOne({ user: userId });
  if (linked) return linked;

  // 2) auto-link by username (treated as email)
  const u = await User.findById(userId).select('username');
  const uname = (u?.username || '').trim().toLowerCase();
  if (!uname) return null;

  const candidates = await Instructor.find({ email: uname }).limit(2);
  if (candidates.length === 1) {
    candidates[0].user = userId;
    await candidates[0].save();
    return candidates[0];
  }
  if (candidates.length > 1) {
    const err = new Error('Multiple instructor profiles match this username.');
    err.code = 'AMBIGUOUS_INSTRUCTOR';
    throw err;
  }
  return null;
}


function buildInviteUrl(token) {
  return `${FRONTEND_URL.replace(/\/+$/, '')}/set-password?token=${encodeURIComponent(token)}`;
}

function generateOpaqueToken(bytes = 32) {
  // URL-safe token
  return crypto.randomBytes(bytes).toString('base64url');
}

/* -------------------------------- Routes -------------------------------- */
/**
 * GET /api/instructors?q=
 * Owner-scoped list (multi-tenant)
 */
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const { q } = req.query;
    const filter = { owner: req.user._id };
    if (q) {
      filter.$or = [{ name: new RegExp(q, 'i') }, { email: new RegExp(q, 'i') }];
    }
    const items = await Instructor.find(filter).sort({ createdAt: -1 });
    res.json(items);
  } catch (err) { next(err); }
});

/**
 * GET /api/instructors/me
 */
router.get('/me', verifyToken, async (req, res, next) => {
  try {
    const doc = await resolveOrLinkInstructorForUser(req.user._id);
    if (!doc) {
      return res.status(404).json({
        message: 'Instructor profile not found for this user. Ask an admin to link your account.',
      });
    }
    res.json(doc);
  } catch (err) {
    if (err.code === 'AMBIGUOUS_INSTRUCTOR') {
      return res.status(409).json({
        message: 'Multiple instructor profiles match this account. Contact an admin to resolve.',
      });
    }
    next(err);
  }
});

/**
 * GET /api/instructors/:id
 * Read if owner OR linked user
 */
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const doc = await Instructor.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Not found' });
    if (!canAccess(doc, req.user._id)) return res.status(403).json({ message: 'Forbidden' });
    res.json(doc);
  } catch (err) { next(err); }
});

/**
 * POST /api/instructors
 * Owner-scoped create
 */
router.post('/', verifyToken, async (req, res, next) => {
  try {
    const payload = sanitizeUpdatable(req.body);
    payload.owner = req.user._id;

    if (!payload.email && !payload.name) {
      return res.status(400).json({ err: 'name or email is required' });
    }

    const doc = await Instructor.create(payload);
    res.status(201).json(doc);
  } catch (err) { next(err); }
});

/**
 * PATCH /api/instructors/:id
 * Owner OR linked user can update
 */
router.patch('/:id', verifyToken, async (req, res, next) => {
  try {
    const doc = await Instructor.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Not found' });
    if (!canAccess(doc, req.user._id)) return res.status(403).json({ message: 'Forbidden' });

    const isOwner = sameId(doc.owner, req.user._id);
    const isSelf = doc.user && sameId(doc.user, req.user._id);

    let updates = sanitizeUpdatable(req.body);
    if ('owner' in updates) delete updates.owner; // never allow owner change
    if (!isOwner && 'user' in updates) delete updates.user; // linked user can't change linkage

    if (isSelf && !isOwner) {
      updates = Object.fromEntries(
        Object.entries(updates).filter(([k]) => SELF_EDITABLE_FIELDS.includes(k))
      );
    }

    const updated = await Instructor.findByIdAndUpdate(req.params.id, updates, { new: true });
    res.json(updated);
  } catch (err) { next(err); }
});

/**
 * DELETE /api/instructors/:id
 * Owner only
 */
router.delete('/:id', verifyToken, async (req, res, next) => {
  try {
    const doc = await Instructor.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Not found' });
    if (!sameId(doc.owner, req.user._id)) return res.status(403).json({ message: 'Forbidden' });

    await Instructor.findByIdAndDelete(req.params.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

/* ========================== NEW ADMIN-ONLY ENDPOINTS ========================== */
/**
 * POST /api/instructors/:id/invite
 * Admin (owner) generates a set-password invite link for this instructor:
 * - find/create User by instructor.email
 * - set a random placeholder password (since User.hashedPassword is required)
 * - (optional) set roles/status if those fields exist in User schema
 * - create InviteToken (1–3 days expiry)
 * - link instructor.user = user._id
 * - return { url, expiresAt }
 */
// Replace your current /:id/invite endpoint with this:
router.post('/:id/invite', verifyToken, async (req, res, next) => {
  try {
    const instr = await Instructor.findById(req.params.id);
    if (!instr) return res.status(404).json({ message: 'Not found' });
    if (String(instr.owner) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    const username = (instr.email || '').trim().toLowerCase();
    if (!username) return res.status(400).json({ message: 'Instructor is missing a valid email.' });

    // Find or create user by USERNAME (email-as-username)
    let user = await User.findOne({ username });
    if (!user) {
      const crypto = require('crypto');
      const bcrypt = require('bcryptjs');
      const randomPassword = crypto.randomBytes(16).toString('hex');
      const hash = await bcrypt.hash(randomPassword, 10);

      const newUser = { username, hashedPassword: hash };
      if (User.schema.path('roles')) newUser.roles = ['instructor'];
      if (User.schema.path('status')) newUser.status = 'invited';

      user = await User.create(newUser);
    } else {
      if (User.schema.path('status') && user.status !== 'active') {
        user.status = 'invited';
        await user.save();
      }
    }

    // Link instructor to this user if not yet linked
    if (!instr.user || String(instr.user) !== String(user._id)) {
      instr.user = user._id;
      user.instructor = instr._id
      await instr.save();
      await user.save();
    }

    // Create a single-use invite token
    const InviteToken = require('../models/invite-token');
    const crypto = require('crypto');

    const token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 48); // 48 hours

    await InviteToken.deleteMany({ instructor: instr._id, owner: instr.owner });

    await InviteToken.create({
      tokenHash,
      instructor: instr._id,
      owner: instr.owner,
      user: user._id,
      expiresAt,
    });

    const FRONTEND_URL =
      process.env.FRONTEND_APP_URL ||
      process.env.APP_ORIGIN ||
      process.env.WEB_APP_URL ||
      'http://localhost:5173' ||
      'https://whale-app-2vav2.ondigitalocean.app';
    const url = `${FRONTEND_URL.replace(/\/+$/, '')}/set-password?token=${encodeURIComponent(token)}`;

    return res.status(201).json({ url, expiresAt });
  } catch (err) { next(err); }
});

/**
 * POST /api/instructors/:id/link-user
 * Admin (owner) links an existing user by email to this instructor.
 * Body: { email }
 * Returns: updated instructor document
 */
// Replace your current /:id/link-user endpoint with this:
router.post('/:id/link-user', verifyToken, async (req, res, next) => {
  try {
    const instr = await Instructor.findById(req.params.id);
    if (!instr) return res.status(404).json({ message: 'Not found' });
    if (String(instr.owner) !== String(req.user._id)) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    // Accept either { email } or { username } from the client; treat both as username
    const raw = (req.body?.email ?? req.body?.username ?? '').trim().toLowerCase();
    if (!raw) return res.status(400).json({ message: 'Email/username is required.' });

    const user = await User.findOne({ username: raw });
    if (!user) return res.status(404).json({ message: 'User with this username was not found.' });

    instr.user = user._id;
    await instr.save();

    if (User.schema.path('roles')) {
      const roles = new Set([...(user.roles || []), 'instructor']);
      user.roles = Array.from(roles);
      await user.save();
    }

    res.json(instr);
  } catch (err) { next(err); }
});

module.exports = router;