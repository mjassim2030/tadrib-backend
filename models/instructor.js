// models/instructor.js
const mongoose = require('mongoose');

const instructorSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    bio: { type: String, required: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },

    // 🔗 Link to the platform user account (optional until backfilled)
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true, sparse: true },

  },
  { timestamps: true }
);

// ✅ Make email unique per owner (multi-tenant safe)
instructorSchema.index({ owner: 1, email: 1 }, { unique: true });

// ✅ Allow linking one user -> one instructor (optional for admins who don’t teach)
instructorSchema.index({ user: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('Instructor', instructorSchema);