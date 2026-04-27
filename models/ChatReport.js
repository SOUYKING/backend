const mongoose = require('mongoose');

const ChatReportSchema = new mongoose.Schema({
  matchId: {
    type: String,
    required: true,
  },
  reportedPlayerDiscordId: {
    type: String,
    required: true,
  },
  reportedPlayerName: {
    type: String,
    default: null,
  },
  reporterDiscordId: {
    type: String,
    required: true,
  },
  reporterName: {
    type: String,
    default: null,
  },
  message: {
    type: String,
    required: true,
  },
  reason: {
    type: String,
    default: 'Inappropriate message',
  },
  resolved: {
    type: Boolean,
    default: false,
  },
  resolvedBy: {
    type: String,
    default: null,
  },
  actionTaken: {
    type: String,
    enum: ['none', 'warning', 'mute', 'ban'],
    default: 'none',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

ChatReportSchema.index({ matchId: 1 });
ChatReportSchema.index({ reportedPlayerDiscordId: 1 });
ChatReportSchema.index({ resolved: 1 });

module.exports = mongoose.model('ChatReport', ChatReportSchema);
