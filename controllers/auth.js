const express = require('express');
// routes/auth-invite.js
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const InviteToken = require('../models/invite-token');
const User = require('../models/user');
const Instructor = require('../models/instructor');
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';
const JWT_EXPIRES_IN = '7d';

const router = express.Router();


const saltRounds = 12;

router.get('/sign-in', (_, res) => res.sendStatus(405));
router.get('/sign-up',  (_, res) => res.sendStatus(405));

router.post('/sign-up', async (req, res) => {
  try {
    const userInDatabase = await User.findOne({ username: req.body.username });
    
    if (userInDatabase) {
      return res.status(409).json({err: 'Username already taken.'});
    }
    
    const user = await User.create({
      username: req.body.username,
      hashedPassword: bcrypt.hashSync(req.body.password, saltRounds)
    });

    // Construct the payload
    const payload = { username: user.username, _id: user._id };

    // Create the token, attaching the payload
    const token = jwt.sign({ payload }, process.env.JWT_SECRET);

    // Send the token instead of the user
    res.status(201).json({ token });
  } catch (err) {
    res.status(400).json({ err: err.message });
  }
});

router.post('/sign-in', async (req, res) => {
  try {
    const user = await User.findOne({ username: req.body.username });
    if (!user) {
      return res.status(401).json({ err: 'Invalid credentials.' });
    }

    const isPasswordCorrect = bcrypt.compareSync(
      req.body.password, user.hashedPassword
    );
    if (!isPasswordCorrect) {
      return res.status(401).json({ err: 'Invalid credentials.' });
    }

    // Construct the payload
    const payload = { username: user.username, _id: user._id };

    // Create the token, attaching the payload
    const token = jwt.sign({ payload }, process.env.JWT_SECRET);

    // Send the token instead of the message
    res.status(200).json({ token });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// Helper to find token doc safely
async function findTokenDoc(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return null;
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  const doc = await InviteToken.findOne({ tokenHash }).lean();
  return doc;
}

/**
 * GET /auth/invite/inspect?token=...
 * Returns who this invite is for (username) and expiry metadata.
 */
router.get('/invite/inspect', async (req, res) => {
  try {
    const token = req.query.token;
    const tdoc = await findTokenDoc(token);
    if (!tdoc) return res.status(404).send('Invalid invite.');
    if (tdoc.usedAt) return res.status(410).send('Invite already used.');
    if (new Date(tdoc.expiresAt) <= new Date()) return res.status(410).send('Invite expired.');

    const user = await User.findById(tdoc.user).select('username').lean();
    if (!user) return res.status(404).send('User not found for this invite.');

    let instructorName = null;
    const instr = await Instructor.findById(tdoc.instructor).select('name').lean();
    if (instr) instructorName = instr.name;

    res.json({ username: user.username, expiresAt: tdoc.expiresAt, instructorName });
  } catch (err) {
    res.status(500).send(err?.message || 'Failed to inspect invite.');
  }
});

/**
 * POST /auth/accept-invite
 * Body: { token, password }
 * Sets user's password, marks invite used, returns login JWT.
 */
router.post('/accept-invite', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).send('token and password are required.');
    if (String(password).length < 8) return res.status(400).send('Password must be at least 8 characters.');

    const tdoc = await findTokenDoc(token);
    if (!tdoc) return res.status(404).send('Invalid invite.');
    if (tdoc.usedAt) return res.status(410).send('Invite already used.');
    if (new Date(tdoc.expiresAt) <= new Date()) return res.status(410).send('Invite expired.');

    const user = await User.findById(tdoc.user);
    if (!user) return res.status(404).send('User not found.');

    // Set password
    user.hashedPassword = await bcrypt.hash(password, 10);

    // Optional: mark active / roles if your schema supports it
    if (User.schema.path('status')) user.status = 'active';
    if (User.schema.path('roles')) {
      const roles = new Set([...(user.roles || []), 'instructor']);
      user.roles = Array.from(roles);
    }
    user.lastLoginAt = new Date();
    await user.save();

    // Mark invite as used and purge other invites for the same instructor
    await InviteToken.updateOne({ _id: tdoc._id }, { $set: { usedAt: new Date() } });
    await InviteToken.deleteMany({
      instructor: tdoc.instructor,
      _id: { $ne: tdoc._id },
    });

    // Issue JWT
    const payload = { sub: String(user._id), uid: String(user._id), roles: user.roles || [] };
    const jwtToken = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

    res.json({ token: jwtToken, user: user.toJSON() });
  } catch (err) {
    res.status(500).send(err?.message || 'Failed to accept invite.');
  }
});

module.exports = router;