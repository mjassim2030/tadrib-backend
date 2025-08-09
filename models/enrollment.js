// models/enrollment.js
const mongoose = require('mongoose');

const enrollmentSchema = new mongoose.Schema(
  {
    student_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Student', required: true },
    course_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', required: true },
    enrolled_at: {
      type: Date,
      default: Date.now,
    },
  },
  { timestamps: true }
);

const Enrollment = mongoose.model('Enrollment', enrollmentSchema);
module.exports = Enrollment;