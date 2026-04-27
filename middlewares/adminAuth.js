const User = require('../models/User');

module.exports = async (req, res, next) => {
  try {
    if (!req.user) {
      return res.status(401).json({ message: 'Unauthorized: No authentication token provided' });
    }

    const discordId = req.user.id || req.user.discordId;
    const user = await User.findOne({ discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found. Your account may have been deleted.' });
    }

    if (user.isBanned) {
      return res.status(403).json({ message: user.banReason || 'Your account is banned.' });
    }

    const isAdmin = user.role === 'admin' || user.role === 'owner' || user.role === 'staff' || user.role === 'content_creator' || user.isOwner;

    if (!isAdmin) {
      return res.status(403).json({ message: 'Admin access required. You do not have permission to access this area.' });
    }

    req.user.isAdmin = true;
    req.user.discordId = discordId;
    req.user.discordName = user.discordName;
    req.user.userModel = user;
    next();
  } catch (error) {
    console.error('Admin auth error:', error);
    res.status(500).json({ message: 'Authentication error. Please try again.' });
  }
};