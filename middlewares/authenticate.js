const jwt = require('jsonwebtoken');
const User = require('../models/User');

const ADMIN_ROLES = ['admin', 'owner', 'staff', 'content_creator'];

const authenticate = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ message: 'Unauthorized: No token provided' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    const dbUser = await User.findOne({ discordId: decoded.id }).select('discordId discordName discordAvatar isBanned banReason role isOwner');
    if (!dbUser) {
      return res.status(401).json({ message: 'User not found' });
    }
    if (dbUser.isBanned) {
      return res.status(403).json({ message: dbUser.banReason || 'Your account is banned.' });
    }

    req.user = {
      id: dbUser.discordId,
      discordId: dbUser.discordId,
      username: dbUser.discordName,
      discordName: dbUser.discordName,
      avatar: dbUser.discordAvatar,
      isAdmin: ADMIN_ROLES.includes(dbUser.role) || !!dbUser.isOwner,
      role: dbUser.role || 'player',
      isOwner: !!dbUser.isOwner,
    };

    next();
  } catch (error) {
    console.error('Error verifying token:', error.message);
    return res.status(401).json({ message: 'Unauthorized: Invalid token' });
  }
};

module.exports = authenticate;