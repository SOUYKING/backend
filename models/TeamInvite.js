const mongoose = require('mongoose');

const teamInviteSchema = new mongoose.Schema({
  teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'Team', required: true },
  fromDiscordId: { type: String, required: true },
  fromDiscordName: { type: String, required: true },
  toDiscordId: { type: String, required: true },
  toDiscordName: { type: String, required: true },
  status: { type: String, enum: ['pending', 'accepted', 'declined', 'cancelled'], default: 'pending' },
  createdAt: { type: Date, default: Date.now },
  respondedAt: { type: Date, default: null },
});

teamInviteSchema.index({ toDiscordId: 1, status: 1 });
teamInviteSchema.index({ teamId: 1, status: 1 });

module.exports = mongoose.model('TeamInvite', teamInviteSchema);
