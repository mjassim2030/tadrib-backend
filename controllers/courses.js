// routes/courses.routes.js
const express = require('express');
const Course = require('../models/course');
const verifyToken = require('../middleware/verify-token');

const router = express.Router();

/* ---------- Helpers ---------- */
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

  // numeric fields
  if (payload.cost != null) payload.cost = Number(payload.cost);
  if (payload.students != null) payload.students = Number(payload.students);
  if (payload.materialsCost != null) payload.materialsCost = Number(payload.materialsCost);

  // instructors as STRING IDs (e.g., "i1")
  if (Array.isArray(payload.instructors)) {
    payload.instructors = payload.instructors.map((v) => String(v));
  }

  // rates map
  payload.instructorRates = normalizeInstructorRates(payload.instructorRates);

  return payload;
}

/* ---------- Routes ---------- */

// GET all courses (with filters/pagination)
router.get('/', verifyToken, async (req, res) => {
  try {
    const { page = 1, limit = 20, q, instructor, from, to, sort = '-createdAt' } = req.query;
    const filter = {};

    if (q) filter.$text = { $search: q };

    if (instructor) {
      // match string IDs directly; also allow rate map key presence
      filter.$or = [
        { instructors: String(instructor) },
        { [`instructorRates.${String(instructor)}`]: { $exists: true } },
      ];
    }

    if (from || to) {
      filter.start_date = {};
      if (from) filter.start_date.$gte = new Date(from);
      if (to) filter.start_date.$lte = new Date(to);
    }

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, parseInt(limit, 10));
    const skip = (pageNum - 1) * limitNum;

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

// GET one course
router.get('/:id', verifyToken, async (req, res) => {
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

// POST create course
router.post('/', verifyToken, async (req, res) => {
  try {
    const payload = sanitizePayload(req.body);

    if (req.user?._id) payload.owner = req.user._id;

    // auto-generate sessions if not provided
    if ((!Array.isArray(payload.courseDatesTimes) || payload.courseDatesTimes.length === 0) &&
        payload.start_date && payload.end_date &&
        Array.isArray(payload.daysOfWeek) && payload.daysOfWeek.length > 0) {
      payload.courseDatesTimes = buildSessions(payload);
    }

    const item = await Course.create(payload);
    const populated = await item.populate('owner', 'username email');

    res.status(201).json(populated.toJSON({ virtuals: true }));
  } catch (err) {
    // Validation errors should be 400
    if (err.name === 'ValidationError') {
      return res.status(400).json({ err: err.message });
    }
    res.status(500).json({ err: err.message });
  }
});

// PUT update full course
router.put('/:id', verifyToken, async (req, res) => {
  try {
    const payload = sanitizePayload(req.body);

    const shouldRegen =
      payload._regenerateSessions === true ||
      ((!Array.isArray(payload.courseDatesTimes) || payload.courseDatesTimes.length === 0) &&
        payload.start_date && payload.end_date && Array.isArray(payload.daysOfWeek) && payload.daysOfWeek.length > 0);

    if (shouldRegen) {
      payload.courseDatesTimes = buildSessions(payload);
    }

    const updated = await Course.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    }).populate('owner', 'username email');

    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated.toJSON({ virtuals: true }));
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ err: err.message });
    }
    res.status(500).json({ err: err.message });
  }
});

// PATCH partial update
router.patch('/:id', verifyToken, async (req, res) => {
  try {
    const payload = sanitizePayload(req.body);

    const wantsRegen = payload._regenerateSessions === true;
    const touchedRange = payload.start_date || payload.end_date || payload.daysOfWeek ||
                         payload.range_start_time || payload.range_end_time;

    if (wantsRegen || touchedRange) {
      const current = await Course.findById(req.params.id).lean();
      if (!current) return res.status(404).json({ error: 'Not found' });
      payload.courseDatesTimes = buildSessions({ ...current, ...payload });
    }

    const updated = await Course.findByIdAndUpdate(
      req.params.id,
      { $set: payload },
      { new: true, runValidators: true }
    ).populate('owner', 'username email');

    if (!updated) return res.status(404).json({ error: 'Not found' });
    res.json(updated.toJSON({ virtuals: true }));
  } catch (err) {
    if (err.name === 'ValidationError') {
      return res.status(400).json({ err: err.message });
    }
    res.status(500).json({ err: err.message });
  }
});

// DELETE course
router.delete('/:id', verifyToken, async (req, res) => {
  try {
    const deleted = await Course.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Not found' });
    res.status(204).send();
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

// POST regenerate sessions
router.post('/:id/regenerate-sessions', verifyToken, async (req, res) => {
  try {
    const course = await Course.findById(req.params.id);
    if (!course) return res.status(404).json({ error: 'Not found' });

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