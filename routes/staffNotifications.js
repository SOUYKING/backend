const express = require('express');
const StaffNotification = require('../models/StaffNotification');
const authenticate = require('../middlewares/authenticate');
const adminAuth = require('../middlewares/adminAuth');
const router = express.Router();

router.use(authenticate);
router.use(adminAuth);

router.get('/', async (req, res) => {
  try {
    const notifications = await StaffNotification.find().sort({ createdAt: -1 }).limit(100);
    const unreadCount = await StaffNotification.countDocuments({ read: false });
    res.json({ notifications, unreadCount });
  } catch (error) {
    console.error('Get staff notifications error:', error);
    res.status(500).json({ message: 'Failed to fetch notifications' });
  }
});

router.post('/:id/read', async (req, res) => {
  try {
    await StaffNotification.findByIdAndUpdate(req.params.id, { read: true });
    res.json({ message: 'Marked as read' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to mark as read' });
  }
});

router.post('/mark-all-read', async (req, res) => {
  try {
    await StaffNotification.updateMany({ read: false }, { read: true });
    res.json({ message: 'All marked as read' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to mark all as read' });
  }
});

module.exports = router;
