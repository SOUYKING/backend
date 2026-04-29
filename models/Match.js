const mongoose = require("mongoose");

const MatchSchema = new mongoose.Schema({
  player1: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  player2: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  result: { type: String, default: null },
  winnerDiscordId: { type: String, default: null },
  loserDiscordId: { type: String, default: null },
  status: { type: String, enum: ["pending", "disputed", "completed"], default: "pending" },
  disputed: { type: Boolean, default: false },
  autoResolved: { type: Boolean, default: false },
  reports: {
    type: Object,
    default: {},
  },
  evidence: [{
    playerDiscordId: { type: String, required: true },
    screenshots: [{ type: String }],
    videoLinks: [{ type: String }],
    replayCodes: [{ type: String }],
    streamLinks: [{ type: String }],
    submittedAt: { type: Date, default: Date.now },
  }],
  chatLogs: [{
    sender: { type: String },
    message: { type: String },
    time: { type: Date },
    isSystem: { type: Boolean, default: false },
  }],
  adminOverride: {
    overriddenBy: { type: String, default: null },
    overriddenAt: { type: Date, default: null },
    reason: { type: String, default: null },
  },
  resultExpiresAt: { type: Date, default: null },
  resolvedBy: { type: String, default: null },
  winnerRank: { type: String, default: null },
  loserRank: { type: String, default: null },
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: "Tournament", required: true },
  winnerTeamId: { type: String, default: null },
  loserTeamId: { type: String, default: null },
  date: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Match", MatchSchema);
