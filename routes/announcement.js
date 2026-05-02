const express = require('express');
const Announcement = require('../models/Announcement');
const router = express.Router();

/** Public read: active announcements only (same payload as before; no auth required). */
router.get('/', async (req, res) => {
  try {
    const announcements = await Announcement.find({
      active: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
    }).sort({ createdAt: -1 }).limit(20);
    res.json(announcements);
  } catch (error) {
    console.error('Get active announcements error:', error);
    res.status(500).json({ message: 'Failed to fetch announcements' });
  }
});

module.exports = router;
