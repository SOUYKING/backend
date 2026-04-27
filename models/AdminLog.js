const mongoose = require('mongoose');

const AdminLogSchema = new mongoose.Schema({
  adminId: {
    type: String,
    required: true,
  },
  adminName: {
    type: String,
    default: 'Unknown',
  },
  action: {
    type: String,
    required: true,
    enum: [
      'force_win',
      'override_result',
      'ban_user',
      'unban_user',
      'edit_tournament',
      'create_tournament',
      'delete_tournament',
      'delete_match',
      'mute_player',
      'unmute_player',
      'warn_player',
      'strike_player',
      'clear_flags',
      'reset_profile',
      'ip_whitelist_add',
      'ip_whitelist_remove',
      'system',
    ],
  },
  targetId: {
    type: String,
    default: null,
  },
  targetName: {
    type: String,
    default: null,
  },
  tournamentId: {
    type: String,
    default: null,
  },
  matchId: {
    type: String,
    default: null,
  },
  reason: {
    type: String,
    default: null,
  },
  details: {
    type: Object,
    default: {},
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

AdminLogSchema.index({ createdAt: -1 });
AdminLogSchema.index({ adminId: 1, createdAt: -1 });
AdminLogSchema.index({ action: 1 });

module.exports = mongoose.model('AdminLog', AdminLogSchema);
