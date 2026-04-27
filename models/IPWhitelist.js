const mongoose = require('mongoose');

const IPWhitelistSchema = new mongoose.Schema({
  ip: {
    type: String,
    required: true,
    unique: true,
    trim: true,
  },
  note: {
    type: String,
    default: '',
    trim: true,
  },
  createdBy: {
    type: String,
    default: null,
  },
  createdByName: {
    type: String,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('IPWhitelist', IPWhitelistSchema);
