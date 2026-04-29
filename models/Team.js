const mongoose = require('mongoose');

const teamMemberSchema = new mongoose.Schema({
  discordId: { type: String, required: true },
  discordName: { type: String, required: true },
  status: { type: String, enum: ['accepted', 'pending'], default: 'accepted' },
  joinedAt: { type: Date, default: Date.now },
  invitedBy: { type: String, default: null },
}, { _id: false });

const teamSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  size: { type: Number, enum: [2, 3, 4], required: true },
  captainDiscordId: { type: String, required: true },
  captainDiscordName: { type: String, required: true },
  members: { type: [teamMemberSchema], default: [] },
  isActive: { type: Boolean, default: true },
  tournamentLocks: [{
    tournamentId: { type: String, required: true },
    lockedAt: { type: Date, default: Date.now },
  }],
  createdAt: { type: Date, default: Date.now },
});

teamSchema.index({ captainDiscordId: 1 });
teamSchema.index({ 'members.discordId': 1 });
teamSchema.index({ size: 1, isActive: 1 });

module.exports = mongoose.model('Team', teamSchema);
