const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, trim: true },

    // Optional but recommended for login/notifications
    email: { type: String, trim: true, lowercase: true, unique: true, sparse: true },

    fullName: { type: String, trim: true },

    // ✅ Key addition #1: role-based access
    roles: {
      type: [String],
      enum: ['admin', 'instructor', 'student', 'staff', 'manager', 'owner'],
      default: ['student'],
    },

    // ✅ Key addition #2: link to instructor profile (if you have an Instructor model)
    instructor: { type: mongoose.Schema.Types.ObjectId, ref: 'Instructor' },

    // Auth
    hashedPassword: { type: String, required: true },

    // Operational
    status: { type: String, enum: ['active', 'invited', 'suspended'], default: 'active' },
    lastLoginAt: { type: Date },
  },
  { timestamps: true }
);

// Clean JSON output
userSchema.set('toJSON', {
  transform: (doc, ret) => {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    delete ret.hashedPassword;
  },
});

const User = mongoose.model('User', userSchema);
module.exports = User;