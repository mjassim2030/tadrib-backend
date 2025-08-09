// models/course.js
const mongoose = require('mongoose');

const studentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    tel1: {
      type: String,
      required: true,
    },
    tel2: {
      type: String,
      required: false,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
  },
  { timestamps: true }
);

const Student = mongoose.model('Student', studentSchema);
module.exports = Student;