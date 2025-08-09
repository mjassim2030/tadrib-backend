const express = require('express');
const Instructor = require('../models/instructor');
const verifyToken = require('../middleware/verify-token'); // remove if not using auth

const router = express.Router();

// GET /api/instructors?q=...
router.get('/', verifyToken, async (req, res, next) => {
  try {
    const { q } = req.query;
    const filter = q ? { name: new RegExp(q, 'i') } : {};
    const items = await Instructor.find(filter).sort({ createdAt: -1 });
    res.json(items);
  } catch (err) { next(err); }
});

// GET /api/instructors/:id
router.get('/:id', verifyToken, async (req, res, next) => {
  try {
    const doc = await Instructor.findById(req.params.id);
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json(doc);
  } catch (err) { next(err); }
});

// POST /api/instructors
router.post('/', verifyToken, async (req, res, next) => {
  try {
    const doc = await Instructor.create(req.body);
    res.status(201).json(doc);
  } catch (err) { next(err); }
});

// PATCH /api/instructors/:id
router.patch('/:id', verifyToken, async (req, res, next) => {
  try {
    const doc = await Instructor.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ message: 'Not found' });
    res.json(doc);
  } catch (err) { next(err); }
});

// DELETE /api/instructors/:id
router.delete('/:id', verifyToken, async (req, res, next) => {
  try {
    const ok = await Instructor.findByIdAndDelete(req.params.id);
    if (!ok) return res.status(404).json({ message: 'Not found' });
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
