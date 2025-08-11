// routes/courses.routes.js
const express = require('express');
const Course = require('../models/course');
const Instructor = require('../models/instructor');
const User = require('../models/user');
const verifyToken = require('../middleware/verify-token');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

/* ------------------------------ Helpers ------------------------------ */
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

async function resolveInstructorIdForUser(userId) {
  // 1) direct link via Instructor.user
  const linked = await Instructor.findOne({ user: userId }).select('_id').lean();
  if (linked) return String(linked._id);

  // 2) fallback: username is the email
  const u = await User.findById(userId).select('username').lean();
  const uname = (u?.username || '').trim().toLowerCase();
  if (!uname) return null;

  const byEmail = await Instructor.findOne({ email: uname }).select('_id').lean();
  return byEmail ? String(byEmail._id) : null;
}

async function canViewCourse(req, res, next) {
  try {
    const userId = String(req.user?._id || '');
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const roles = Array.isArray(req.user?.roles) ? req.user.roles : [];
    const isAdmin = roles.some(r => ['owner','admin','manager','staff'].includes(String(r).toLowerCase()));

    const course = await Course.findById(req.params.id)
      .select('owner instructors enrolled')
      .lean();
    if (!course) return res.status(404).json({ error: 'Not found' });

    if (isAdmin) return next();
    if (String(course.owner || '') === userId) return next();

    const myInstructorId = await resolveInstructorIdForUser(userId);
    if (myInstructorId && (course.instructors || []).map(String).includes(myInstructorId)) {
      return next();
    }

    // Optional: allow enrolled students
    if ((course.enrolled || []).some(s => String(s.user || s) === userId)) {
      return next();
    }

    return res.status(403).json({ error: 'Forbidden' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Auth check failed' });
  }
}

function buildSessions({ start_date, end_date, daysOfWeek = [], range_start_time, range_end_time }) {
  if (!start_date || !end_date || !Array.isArray(daysOfWeek) || daysOfWeek.length === 0) return [];
  const start = new Date(start_date);
  const end = new Date(end_date);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];

  const sessions = [];
  for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
    if (daysOfWeek.includes(d.getDay())) {
      sessions.push({
        date: new Date(d.toISOString().slice(0, 10)),
        start_time: range_start_time || '16:00',
        end_time: range_end_time || '18:00',
      });
    }
  }
  return sessions;
}

function normalizeInstructorRates(instructorRates) {
  if (!instructorRates) return {};
  const out = {};
  for (const [k, v] of Object.entries(instructorRates)) {
    const num = Number(v);
    out[String(k)] = Number.isFinite(num) ? num : 0;
  }
  return out;
}

function sanitizePayload(body = {}) {
  const payload = { ...body };
  if (payload.cost != null) payload.cost = Number(payload.cost);
  if (payload.students != null) payload.students = Number(payload.students);
  if (payload.materialsCost != null) payload.materialsCost = Number(payload.materialsCost);
  if (Array.isArray(payload.instructors)) {
    payload.instructors = payload.instructors.map((v) => String(v));
  }
  payload.instructorRates = normalizeInstructorRates(payload.instructorRates);
  return payload;
}

/* --------------------------- Access helpers -------------------------- */
async function findInstructorForUser(userId) {
  // direct link
  const byUser = await Instructor.findOne({ user: userId }).select('_id owner').lean();
  if (byUser) return { id: String(byUser._id), owner: String(byUser.owner) };

  // fallback by username (treated as email)
  const u = await User.findById(userId).select('username').lean();
  const uname = (u?.username || '').trim().toLowerCase();
  if (!uname) return null;

  const byUname = await Instructor.findOne({ email: uname }).select('_id owner').lean();
  return byUname ? { id: String(byUname._id), owner: String(byUname.owner) } : null;
}

function courseIncludesInstructor(course, instructorId) {
  if (!course || !instructorId) return false;
  const list = Array.isArray(course.instructors) ? course.instructors : [];
  return list.map(String).includes(String(instructorId));
}

function isOwner(course, userId) {
  return course?.owner && String(course.owner) === String(userId);
}

function ymd(d) {
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

/* ---------- Access helpers ---------- */
async function resolveInstructorIdForUser(userId) {
  const byUser = await Instructor.findOne({ user: userId }).select('_id').lean();
  if (byUser) return String(byUser._id);

  const u = await User.findById(userId).select('email').lean();
  if (!u?.email) return null;

  const byEmail = await Instructor.findOne({ email: u.email.toLowerCase() }).select('_id').lean();
  return byEmail ? String(byEmail._id) : null;
}

// NEW: robust check for admin power
async function userHasAdminPower(req) {
  // roles may be on req.user (from JWT) or in DB
  let roles = req.user?.roles;
  if (!Array.isArray(roles) || roles.length === 0) {
    const u = await User.findById(req.user._id).select('roles').lean();
    roles = Array.isArray(u?.roles) ? u.roles : [];
  }
  const adminSet = new Set(['admin', 'owner', 'manager', 'staff']);
  return roles.some(r => adminSet.has(String(r).toLowerCase()));
}

/* -------------------------------- Routes ----------------------------- */

/**
 * GET /api/courses
 * Query params:
 *  - q: text search
 *  - instructor: 'me' | <instructorId>
 *  - from, to: filter by start_date range
 *  - page, limit, sort
 *
 * Behavior:
 *  - instructor='me': resolve caller's instructor profile and scope to its tenant (owner = instructor.owner).
 *  - instructor='<id>':
 *      * if caller is that instructor -> scope to that instructor's tenant.
 *      * else (admin/staff)          -> scope to caller's tenant (owner = req.user._id).
 *  - no instructor: owner-scoped list (owner = req.user._id).
 */
/**
 * GET /api/courses
 * Supports ?instructor=me|<id>, ?q, ?from, ?to, ?page, ?limit, ?sort
 */
router.get('/', verifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, q, instructor, from, to, sort = '-createdAt' } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limitNum;

    const filter = {};
    let instructorId = null;

    if (q) filter.$text = { $search: q };

    if (instructor) {
      instructorId = instructor === 'me'
        ? await resolveInstructorIdForUser(req.user._id)
        : String(instructor);

      if (!instructorId) {
        return res.json({ page: pageNum, limit: limitNum, total: 0, items: [] });
      }

      filter.$or = [
        { instructors: String(instructorId) },
        { [`instructorRates.${String(instructorId)}`]: { $exists: true } },
      ];
    } else {
      filter.owner = req.user._id;
    }

    if (from || to) {
      filter.start_date = {};
      if (from) filter.start_date.$gte = new Date(from);
      if (to) filter.start_date.$lte = new Date(to);
    }

    const [items, total] = await Promise.all([
      Course.find(filter)
        .populate('owner', 'username email')
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .lean({ virtuals: true }),
      Course.countDocuments(filter),
    ]);

    res.json({ page: pageNum, limit: limitNum, total, items });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/**
 * Convenience:
 * GET /api/courses/instructors/:instructorId/courses
 * - If caller is that instructor -> scope by the instructor's tenant
 * - Else                        -> scope by caller's tenant (owner)
 */
router.get('/instructors/:instructorId/courses', verifyToken, async (req, res) => {
  try {
    const instructorId = String(req.params.instructorId);

    // Resolve caller (if instructor)
    const meInst = await findInstructorForUser(req.user._id);
    const callerIsInstructor = meInst && meInst.id === instructorId;

    // Resolve the target instructor to get its owner (tenant)
    const targetInst = await Instructor.findById(instructorId).select('_id owner').lean();
    if (!targetInst) {
      return res.json({ page: 1, limit: 0, total: 0, items: [] });
    }

    const filter = {
      owner: callerIsInstructor ? String(targetInst.owner) : String(req.user._id),
      $or: [
        { instructors: instructorId },
        { [`instructorRates.${instructorId}`]: { $exists: true } },
      ],
    };

    const items = await Course.find(filter)
      .populate('owner', 'username email')
      .sort('-createdAt')
      .lean({ virtuals: true });

    res.json({ page: 1, limit: items.length, total: items.length, items });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/**
 * GET /api/courses/:id
 * (owner OR assigned instructor)
 */
router.get('/:id', verifyToken, canViewCourse, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate('owner', 'username email')
      .lean({ virtuals: true });

    if (!course) return res.status(404).json({ error: 'Not found' });
    res.json(course);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/**
 * POST /api/courses
 * (owner only)
 */
router.post('/', verifyToken, async (req, res) => {
  try {
    const payload = sanitizePayload(req.body);
    if (req.user?._id) payload.owner = req.user._id;

    if ((!Array.isArray(payload.courseDatesTimes) || payload.courseDatesTimes.length === 0) &&
        payload.start_date && payload.end_date &&
        Array.isArray(payload.daysOfWeek) && payload.daysOfWeek.length > 0) {
      payload.courseDatesTimes = buildSessions(payload);
    }

    const item = await Course.create(payload);
    const populated = await item.populate('owner', 'username email');

    res.status(201).json(populated.toJSON({ virtuals: true }));
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ err: err.message });
    res.status(500).json({ err: err.message });
  }
});

/**
 * PUT /api/courses/:id
 * (owner only)
 */
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const existing = await Course.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found' });
    if (!isOwner(existing, req.user._id)) return res.status(403).json({ error: 'Forbidden' });

    const payload = sanitizePayload(req.body);

    const shouldRegen =
      payload._regenerateSessions === true ||
      ((!Array.isArray(payload.courseDatesTimes) || payload.courseDatesTimes.length === 0) &&
        payload.start_date && payload.end_date &&
        Array.isArray(payload.daysOfWeek) && payload.daysOfWeek.length > 0);

    if (shouldRegen) {
      payload.courseDatesTimes = buildSessions(payload);
    }

    const updated = await Course.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    }).populate('owner', 'username email');

    res.json(updated.toJSON({ virtuals: true }));
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ err: err.message });
    res.status(500).json({ err: err.message });
  }
});

/**
 * PATCH /api/courses/:id
 * (owner only)
 */
router.patch('/:id', verifyToken, async (req, res) => {
  try {
    const current = await Course.findById(req.params.id);
    if (!current) return res.status(404).json({ error: 'Not found' });
    if (!isOwner(current, req.user._id)) return res.status(403).json({ error: 'Forbidden' });

    const payload = sanitizePayload(req.body);

    const wantsRegen = payload._regenerateSessions === true;
    const touchedRange =
      payload.start_date || payload.end_date || payload.daysOfWeek ||
      payload.range_start_time || payload.range_end_time;

    if (wantsRegen || touchedRange) {
      payload.courseDatesTimes = buildSessions({ ...current.toObject(), ...payload });
    }

    const updated = await Course.findByIdAndUpdate(
      req.params.id,
      { $set: payload },
      { new: true, runValidators: true }
    ).populate('owner', 'username email');

    res.json(updated.toJSON({ virtuals: true }));
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ err: err.message });
    res.status(500).json({ err: err.message });
  }
});

/**
 * DELETE /api/courses/:id
 * (owner only)
 */
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const current = await Course.findById(req.params.id);
    if (!current) return res.status(404).json({ error: 'Not found' });
    if (!isOwner(current, req.user._id)) return res.status(403).json({ error: 'Forbidden' });

    await Course.findByIdAndDelete(req.params.id);
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/**
 * POST /api/courses/:id/regenerate-sessions
 * (owner only)
 */
router.post('/:id/regenerate-sessions', verifyToken, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Not found' });
    if (!isOwner(course, req.user._id)) return res.status(403).json({ error: 'Forbidden' });

    const basis = {
      start_date: req.body.start_date ?? course.start_date,
      end_date: req.body.end_date ?? course.end_date,
      daysOfWeek: req.body.daysOfWeek ?? course.daysOfWeek,
      range_start_time: req.body.range_start_time ?? course.range_start_time,
      range_end_time: req.body.range_end_time ?? course.range_end_time,
    };

    course.courseDatesTimes = buildSessions(basis);
    await course.save();

    const populated = await course.populate('owner', 'username email');
    res.json(populated.toJSON({ virtuals: true }));
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/* ---------------------- NEW: Attendance endpoints ---------------------- */

/**
 * GET /api/courses/:id/attendance
 * Returns { [instructorId]: string[] } of session keys.
 * (owner OR assigned instructor)
 */
router.get('/:id/attendance', verifyToken, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id).lean();
    if (!course) return res.status(404).json({ error: 'Not found' });

    if (!isOwner(course, req.user._id)) {
      const myInstructorId = await resolveInstructorIdForUser(req.user._id);
      if (!courseIncludesInstructor(course, myInstructorId)) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    // Ensure plain object of arrays
    const map = {};
    const att = course.attendance || {};
    for (const [k, v] of Object.entries(att)) {
      map[String(k)] = Array.isArray(v) ? v.map(String) : [];
    }
    return res.json(map);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/**
 * PUT /api/courses/:id/attendance
 * Owner: can set full map { [instructorId]: string[] }
 * Instructor: can only set their own list (body can be array OR { [myId]: string[] })
 */
router.put('/:id/attendance', verifyToken, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Not found' });

    // Build allowed session keys (by date and by index fallback)
    const sessions = Array.isArray(course.courseDatesTimes) ? course.courseDatesTimes : [];
    const byDate = sessions.map((s) => ymd(s?.date));
    const byIdx  = sessions.map((_, i) => `idx-${i}`);
    const allowed = new Set([...byDate, ...byIdx]);

    const sanitizeList = (arr) => {
      const out = [];
      const seen = new Set();
      (Array.isArray(arr) ? arr : []).forEach((x) => {
        const k = String(x || '');
        if (!allowed.has(k)) return;
        if (seen.has(k)) return;
        seen.add(k);
        out.push(k);
      });
      return out;
    };

    if (isOwner(course, req.user._id)) {
      // Owner can replace the whole map
      const incoming = req.body && typeof req.body === 'object' ? req.body : {};
      const next = {};
      for (const [insId, arr] of Object.entries(incoming)) {
        next[String(insId)] = sanitizeList(arr);
      }
      course.attendance = next;
      await course.save();
      return res.json(course.attendance || {});
    }

    // Not owner: must be assigned instructor
    const myInstructorId = await resolveInstructorIdForUser(req.user._id);
    if (!courseIncludesInstructor(course, myInstructorId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Accept either an array (meaning "mine"), or an object with my id
    let myList = [];
    if (Array.isArray(req.body)) {
      myList = sanitizeList(req.body);
    } else if (req.body && typeof req.body === 'object') {
      myList = sanitizeList(req.body[myInstructorId] || []);
    }

    const map = course.attendance || {};
    map[String(myInstructorId)] = myList;
    course.attendance = map;
    await course.save();

    return res.json({ [String(myInstructorId)]: myList });
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

module.exports = router;