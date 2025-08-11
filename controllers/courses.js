// routes/courses.routes.js
const express = require('express');
const Course = require('../models/course');
const Instructor = require('../models/instructor');
const User = require('../models/user');
const verifyToken = require('../middleware/verify-token');

const router = express.Router();

/* ------------------------------ Helpers ------------------------------ */
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
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

  // Support either string ids (e.g., "i1" or ObjectId as string)
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
router.get('/', verifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, q, instructor, from, to, sort = '-createdAt' } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limitNum;

    const filter = {};
    if (q) filter.$text = { $search: q };

    if (instructor) {
      if (instructor === 'me') {
        const meInst = await findInstructorForUser(req.user._id);
        if (!meInst) {
          return res.json({ page: pageNum, limit: limitNum, total: 0, items: [] });
        }
        // Instructor view: courses assigned to me, scoped to my tenant
        filter.owner = meInst.owner;
        filter.$or = [
          { instructors: meInst.id },
          { [`instructorRates.${meInst.id}`]: { $exists: true } },
        ];
      } else {
        // Explicit instructor id
        const targetId = String(instructor);
        const meInst = await findInstructorForUser(req.user._id);
        const callerIsThatInstructor = meInst && meInst.id === targetId;

        if (callerIsThatInstructor) {
          // Instructor self: scope to their tenant
          filter.owner = meInst.owner;
        } else {
          // Admin/staff: scope to caller's tenant
          filter.owner = req.user._id;
        }

        filter.$or = [
          { instructors: targetId },
          { [`instructorRates.${targetId}`]: { $exists: true } },
        ];
      }
    } else {
      // Owner mode: tenant isolation
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
 * Read if:
 *  - owner, OR
 *  - caller is an instructor assigned to this course (and same tenant)
 */
router.get('/:id', verifyToken, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id)
      .populate('owner', 'username email')
      .lean({ virtuals: true });

    if (!course) return res.status(404).json({ error: 'Not found' });

    if (isOwner(course, req.user._id)) {
      return res.json(course);
    }

    // For instructor, verify both assignment AND tenant match
    const meInst = await findInstructorForUser(req.user._id);
    if (!meInst) return res.status(403).json({ error: 'Forbidden' });
    if (String(course.owner) !== String(meInst.owner)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!courseIncludesInstructor(course, meInst.id)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(course);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

/**
 * POST /api/courses
 * Create (owner only – scoped by setting owner to requester)
 */
router.post('/', verifyToken, async (req, res) => {
  try {
    const payload = sanitizePayload(req.body);
    if (req.user?._id) payload.owner = req.user._id;

    // Auto-generate sessions if not provided
    const needsGen =
      (!Array.isArray(payload.courseDatesTimes) || payload.courseDatesTimes.length === 0) &&
      payload.start_date && payload.end_date &&
      Array.isArray(payload.daysOfWeek) && payload.daysOfWeek.length > 0;

    if (needsGen) {
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
 * Update (owner only)
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
 * Partial update (owner only)
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
 * Delete (owner only)
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

module.exports = router;