// // models/course.js
// const mongoose = require('mongoose');

// const courseDatesTimes = new mongoose.Schema(
//   {
//     date: {
//       type: Date,
//       required: true,
//     },
//     start_time: {
//       type: String,
//       required: true,
//     },
//     end_time: {
//       type: String,
//       required: true,
//     },
//   },
//   { _id: false }
// );

// const courseSchema = new mongoose.Schema(
//   {
//     title: {
//       type: String,
//       required: true,
//     },
//     description: {
//       type: String,
//       required: true,
//     },
//     start_date: {
//       type: Date,
//       required: true,
//     },
//     end_date: {
//       type: Date,
//       required: true,
//     },
//     location: {
//       type: String,
//       required: true,
//     },
//     courseDatesTimes: [courseDatesTimes],
//     // instructor_id: { type: mongoose.Schema.Types.ObjectId, ref: 'Instructor', required: true },
//   },
//   { timestamps: true }
// );

// const Course = mongoose.model('Course', courseSchema);
// module.exports = Course;



// models/course.js
const mongoose = require('mongoose');

const { Schema } = mongoose;

/**
 * Subdocument: a single session in the course calendar.
 * date is stored as a Date (yyyy-mm-dd). Times are "HH:mm" strings.
 */
const SessionSchema = new Schema(
  {
    date: { type: Date, required: true },       // e.g., "2025-08-15"
    start_time: { type: String, required: true }, // "HH:mm"
    end_time: { type: String, required: true },   // "HH:mm"
  },
  { _id: false }
);

const CourseSchema = new Schema(
  {
    // Basics
    title: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },

    // Location (adjust enum if you have fixed options)
    location: {
      type: String,
      required: true,
      trim: true,
      enum: ['News', 'Games', 'Music', 'Movies', 'Sports', 'Television'], // align with UI
    },

    // Date range + frequency
    start_date: { type: Date, required: true },
    end_date: { type: Date, required: true },
    range_start_time: { type: String, required: true, default: '16:00' }, // "HH:mm"
    range_end_time: { type: String, required: true, default: '18:00' },   // "HH:mm"
    daysOfWeek: {
      type: [Number], // 0..6 (Sun..Sat)
      default: [],
      validate: {
        validator: arr => arr.every(n => Number.isInteger(n) && n >= 0 && n <= 6),
        message: 'daysOfWeek must contain integers between 0 and 6.',
      },
    },

    // Generated sessions (UI populates this from the range + daysOfWeek)
    courseDatesTimes: { type: [SessionSchema], default: [] },

    // Instructors
    // If you have an Instructor collection, use ObjectId refs. Otherwise keep as strings.
    instructors: [{ type: Schema.Types.ObjectId, ref: 'Instructor' }],

    /**
     * Hourly rates keyed by instructor id (stringified ObjectId).
     * Example payload from UI: { "64f...": 12, "650...": 15 }
     */
    instructorRates: {
      type: Map,
      of: Number,
      default: {},
    },

    // Financials
    cost: { type: Number, required: true, min: 0 },          // per student / course
    students: { type: Number, required: true, min: 0 },      // count
    materialsCost: { type: Number, default: 0, min: 0 },

    // Ownership / auditing (optional)
    owner: { type: Schema.Types.ObjectId, ref: 'User' },

  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* ---------- Validation ---------- */
CourseSchema.path('end_date').validate(function (value) {
  return !this.start_date || value >= this.start_date;
}, 'end_date must be on or after start_date.');

/* ---------- Helpers ---------- */
function hhmmToMinutes(hhmm) {
  if (!hhmm || typeof hhmm !== 'string') return 0;
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
  if ([h, m].some(n => Number.isNaN(n))) return 0;
  return h * 60 + m;
}

function diffHours(startHHMM, endHHMM) {
  let start = hhmmToMinutes(startHHMM);
  let end = hhmmToMinutes(endHHMM);
  if (end < start) end += 24 * 60; // cross-midnight safety
  return (end - start) / 60;
}

/* ---------- Virtuals (computed like your UI) ---------- */
CourseSchema.virtual('totalSessions').get(function () {
  return Array.isArray(this.courseDatesTimes) ? this.courseDatesTimes.length : 0;
});

CourseSchema.virtual('totalHours').get(function () {
  if (!Array.isArray(this.courseDatesTimes)) return 0;
  return this.courseDatesTimes.reduce((sum, s) => {
    return sum + diffHours(s.start_time, s.end_time);
  }, 0);
});

CourseSchema.virtual('revenue').get(function () {
  const cost = Number.isFinite(this.cost) ? this.cost : 0;
  const students = Number.isFinite(this.students) ? this.students : 0;
  return cost * students;
});

CourseSchema.virtual('instructorExpense').get(function () {
  const hours = this.totalHours || 0;
  if (!this.instructorRates || !(this.instructorRates instanceof Map)) return 0;
  const perHourSum = Array.from(this.instructorRates.values()).reduce(
    (sum, v) => sum + (Number.isFinite(v) ? v : 0),
    0
  );
  return perHourSum * hours;
});

CourseSchema.virtual('profit').get(function () {
  const materials = Number.isFinite(this.materialsCost) ? this.materialsCost : 0;
  return (this.revenue || 0) - (this.instructorExpense || 0) - materials;
});

/* ---------- Indexes (optional but recommended) ---------- */
CourseSchema.index({ start_date: 1, end_date: 1 });
CourseSchema.index({ title: 'text', description: 'text' });

module.exports = mongoose.model('Course', CourseSchema);