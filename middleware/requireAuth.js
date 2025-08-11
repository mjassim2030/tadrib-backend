// middleware/requireAuth.js
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

function extractUser(decoded) {
  const root = decoded || {};
  const nested = root.payload || {}; // old tokens

  const id =
    root.sub || root.uid || root._id ||
    nested._id || nested.uid || nested.sub;

  const roles = root.roles || nested.roles || [];
  const username = root.username || nested.username;

  return { id: id ? String(id) : null, roles: Array.isArray(roles) ? roles : [], username };
}

module.exports = function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const decoded = jwt.verify(token, JWT_SECRET);
    const u = extractUser(decoded);
    if (!u.id) return res.status(401).json({ error: 'Invalid token payload' });

    req.auth = { userId: u.id, roles: u.roles, username: u.username, raw: decoded };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};