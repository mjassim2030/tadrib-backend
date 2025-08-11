// models/invite-token.js
const mongoose = require('mongoose');

const InviteTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true }, // unique is fine here
    user:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },       // no index:true
    instructor:{ type: mongoose.Schema.Types.ObjectId, ref: 'Instructor', required: true }, // no index:true
    expiresAt: { type: Date, required: true }, // no index:true (TTL below)
    usedAt:    { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Declare indexes ONCE here
InviteTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL
InviteTokenSchema.index({ user: 1 });
InviteTokenSchema.index({ instructor: 1 });

module.exports = mongoose.model('InviteToken', InviteTokenSchema);