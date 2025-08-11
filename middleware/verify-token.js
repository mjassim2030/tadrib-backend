// middleware/verify-token.js
const jwt = require('jsonwebtoken');

function verifyToken(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ err: 'Missing Bearer token.' });
    }

    const token = auth.slice(7).trim();
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Support BOTH shapes:
    // 1) Old: { payload: { _id, username, roles? } }
    // 2) New: { _id? uid? sub?, username?, roles? }
    const src =
      decoded && typeof decoded === 'object' && decoded.payload && typeof decoded.payload === 'object'
        ? decoded.payload
        : decoded;

    const _id = String(src._id || src.uid || src.sub || '');
    if (!_id) return res.status(401).json({ err: 'Invalid token payload.' });

    const roles = Array.isArray(src.roles) ? src.roles.map(r => String(r).toLowerCase()) : [];
    const username = src.username || src.email || null;

    // Normalized user object used by your routers:
    req.user = { _id, username, roles };

    return next();
  } catch (err) {
    return res.status(401).json({ err: 'Invalid token.' });
  }
}

module.exports = verifyToken;