// models/invite-token.js
const mongoose = require('mongoose');

const inviteTokenSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true }, // sha256(token)
    instructor: { type: mongoose.Schema.Types.ObjectId, ref: 'Instructor', required: true, index: true },
    owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // may be set on invite generation
    expiresAt: { type: Date, required: true, index: true },
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Auto-delete after expiry
inviteTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('InviteToken', inviteTokenSchema);