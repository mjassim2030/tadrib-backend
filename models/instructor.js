// models/instructor.js
const mongoose = require('mongoose');

const instructorSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    bio: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

const Instructor = mongoose.model('Instructor', instructorSchema);
module.exports = Instructor;