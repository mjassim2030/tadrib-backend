const express = require("express");
const verifyToken = require("../middleware/verify-token.js");
const Model = require("../models/instructor.js");
const router = express.Router();

router.post("/", verifyToken, async (req, res) => {
  try {
    const item = await Model.create(req.body);
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

router.get("/", verifyToken, async (req, res) => {
  try {
    const items = await Model.find({}).sort({ createdAt: "desc" });
    res.status(200).json(items);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const item = await Model.findById(req.params.id);
    if (!item) return res.status(404).json({ err: "Item not found" });
    res.status(200).json(item);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

router.put("/:id", verifyToken, async (req, res) => {
  try {
    const item = await Model.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!item) return res.status(404).json({ err: "Item not found" });
    res.status(200).json(item);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});

router.delete("/:id", verifyToken, async (req, res) => {
  try {
    const item = await Model.findByIdAndDelete(req.params.id);
    if (!item) return res.status(404).json({ err: "Item not found" });
    res.status(200).json(item);
  } catch (err) {
    res.status(500).json({ err: err.message });
  }
});


module.exports = router;