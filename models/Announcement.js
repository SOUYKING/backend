const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema({
  title: {
    type: String,
    required: true,
  },
  body: {
    type: String,
    required: true,
  },
  type: {
    type: String,
    enum: ['info', 'warning', 'update', 'maintenance', 'event'],
    default: 'info',
  },
  priority: {
    type: String,
    enum: ['low', 'normal', 'high', 'urgent'],
    default: 'normal',
  },
  createdBy: {
    discordId: String,
    discordName: String,
  },
  active: {
    type: Boolean,
    default: true,
  },
  expiresAt: {
    type: Date,
    default: null,
  },
}, { timestamps: true });

announcementSchema.index({ active: 1, createdAt: -1 });

module.exports = mongoose.model('Announcement', announcementSchema);
