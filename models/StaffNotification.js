const mongoose = require("mongoose");

const StaffNotificationSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ["dispute", "call_staff", "match_completed", "system"],
    required: true,
  },
  matchId: { type: String, default: null },
  title: { type: String, default: "" },
  message: { type: String, required: true },
  player1Name: { type: String, default: "" },
  player2Name: { type: String, default: "" },
  read: { type: Boolean, default: false },
  resolved: { type: Boolean, default: false },
  resolvedBy: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("StaffNotification", StaffNotificationSchema);
