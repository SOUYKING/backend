const jwt = require('jsonwebtoken');
const User = require('../models/User');

const ADMIN_ROLES = ['admin', 'owner', 'staff', 'content_creator'];
const activeAdminConnections = new Map();

function setupAdminSocket(io) {
  const adminNamespace = io.of('/admin');

  adminNamespace.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('No admin token'));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findOne({ discordId: decoded.id }).select('role isOwner');
      if (!user) return next(new Error('User not found'));

      const isAdmin = ADMIN_ROLES.includes(user.role) || user.isOwner;
      if (!isAdmin) return next(new Error('Not authorized'));

      socket.data.user = { id: decoded.id, username: decoded.username, role: user.role };
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  adminNamespace.on('connection', (socket) => {
    const discordId = socket.data.user.id;
    const username = socket.data.user.username;

    const existingSocketId = activeAdminConnections.get(discordId);
    if (existingSocketId) {
      const oldSocket = adminNamespace.sockets.get(existingSocketId);
      if (oldSocket && oldSocket.connected) {
        console.log(`[ADMIN_RECONNECTED] Disconnecting old socket ${existingSocketId} for ${username}`);
        oldSocket.emit('admin:replaced', { message: 'New admin session opened elsewhere' });
        oldSocket.disconnect(true);
      }
    }
    activeAdminConnections.set(discordId, socket.id);
    console.log(`[ADMIN SOCKET] ${username} (${socket.data.user.role}) connected [active: ${activeAdminConnections.size}]`);

    socket.emit('admin:connected', {
      user: socket.data.user,
      timestamp: new Date().toISOString(),
    });

    socket.on('admin:subscribe', () => {
      socket.join('admin-room');
      socket.emit('admin:subscribed');
    });

    socket.on('disconnect', () => {
      if (activeAdminConnections.get(discordId) === socket.id) {
        activeAdminConnections.delete(discordId);
      }
      console.log(`[ADMIN SOCKET] ${username} disconnected [active: ${activeAdminConnections.size}]`);
    });
  });

  return adminNamespace;
}

module.exports = { setupAdminSocket, activeAdminConnections };
