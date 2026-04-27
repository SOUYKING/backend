const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
require('dotenv').config();

const connectDB = require('./utils/db');

const authRoutes = require('./routes/auth');
const accountRoutes = require('./routes/account');
const tournamentRoutes = require('./routes/tournament');
const matchmakingRoutes = require('./routes/matchmaking');
const matchRoutes = require('./routes/match');
const adminRoutes = require('./routes/admin');
const announcementRoutes = require('./routes/announcement');
const staffNotificationRoutes = require('./routes/staffNotifications');

const { securityHeaders, globalRateLimit, authRateLimit, matchRateLimit, adminRateLimit, sanitizeInput } = require('./middlewares/security');
const socketManager = require('./utils/socketManager');
const eventBus = require('./utils/eventBus');
const { setupAdminSocket } = require('./utils/adminSocket');

const GameEngine = require('./core/GameEngine');
const { getRank } = require('./utils/rankSystem');
const { containsProfanity, filterProfanity } = require('./utils/wordFilter');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const io = socketIo(server, {
  cors: { origin: FRONTEND_URL, methods: ['GET', 'POST'] },
});
socketManager.init(io);
eventBus.init(io);
const adminSocket = setupAdminSocket(io);
GameEngine.init();

app.use(cors({ origin: FRONTEND_URL }));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(securityHeaders);
app.use(globalRateLimit);
app.use(sanitizeInput);

connectDB();

app.use('/auth', authRateLimit, authRoutes);
app.use('/account', accountRoutes);
app.use('/tournament', tournamentRoutes);
app.use('/matchmaking', matchRateLimit, matchmakingRoutes);
app.use('/match', matchRoutes);
app.use('/admin', adminRateLimit, adminRoutes);
app.use('/announcements', announcementRoutes);
app.use('/staff-notifications', staffNotificationRoutes);

const chatRateLimits = new Map();
const MESSAGE_COOLDOWN_MS = 1500;
const MAX_MESSAGES_PER_MINUTE = 20;

function ensureJoinedRoom(socket, roomId) {
  if (!roomId) return false;
  if (socket.rooms.has(roomId)) {
    console.log(`[ROOM_ALREADY_JOINED] ${socket.id} already in room ${roomId}`);
    return false;
  }
  socket.join(roomId);
  return true;
}

function checkChatSpam(userId) {
  const now = Date.now();
  const record = chatRateLimits.get(userId) || { count: 0, resetTime: now + 60000, lastMessageAt: 0 };

  if (now > record.resetTime) {
    record.count = 0;
    record.resetTime = now + 60000;
  }

  if (now - record.lastMessageAt < MESSAGE_COOLDOWN_MS) {
    return { allowed: false, reason: 'Please slow down (message cooldown)' };
  }

  if (record.count >= MAX_MESSAGES_PER_MINUTE) {
    return { allowed: false, reason: 'Message limit reached. Wait 1 minute.' };
  }

  record.count++;
  record.lastMessageAt = now;
  chatRateLimits.set(userId, record);
  return { allowed: true };
}

io.on('connection', (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  socket.on('register', async ({ userId }) => {
    socket.userId = userId;
    if (userId) {
      socket.join(`user:${userId}`);
    }
    const queue = GameEngine.getQueue();
    const queueIndex = queue.findIndex(p => p.userId === userId);
    if (queueIndex !== -1) {
      GameEngine.queue[queueIndex].socketId = socket.id;
      await GameEngine.processMatchmaking();
    }
  });

  socket.on('joinQueue', async ({ tournamentId, epicName }) => {
    if (!socket.userId || !tournamentId) {
      return socket.emit('error', { message: 'Missing data' });
    }

    try {
      const User = require('./models/User');
      const Tournament = require('./models/Tournament');

      const user = await User.findOne({ discordId: socket.userId });
      const tournament = await Tournament.findById(tournamentId);

      if (!user || !tournament) {
        return socket.emit('error', { message: 'User or tournament not found' });
      }

      if (user.isBanned) {
        return socket.emit('error', { message: user.banReason || 'Your account is banned.' });
      }

      if (user.mutedUntil && new Date(user.mutedUntil) > new Date()) {
        return socket.emit('error', { message: 'You are currently muted and cannot join matches' });
      }

      if (user.queueCooldownUntil && new Date(user.queueCooldownUntil) > new Date()) {
        const waitSec = Math.ceil((new Date(user.queueCooldownUntil) - new Date()) / 1000);
        return socket.emit('error', { message: `Queue cooldown active. Wait ${waitSec}s.` });
      }

      const now = new Date();
      if (now < new Date(tournament.startDate)) {
        return socket.emit('error', { message: 'Tournament has not started yet' });
      }
      if (now > new Date(tournament.endDate) || tournament.status === 'completed' || tournament.status === 'cancelled') {
        return socket.emit('error', { message: 'Tournament is no longer active' });
      }

      if (!user.epicVerified) {
        return socket.emit('error', { message: 'Epic Games account not verified' });
      }

      const isRegistered = tournament.participants?.some((p) => p.userId === socket.userId);
      if (!isRegistered) {
        return socket.emit('error', { message: 'You must register for this tournament before joining queue' });
      }

      if (tournament.status !== 'active') {
        tournament.status = 'active';
        await tournament.save();
      }

      const ext = (user.discordAvatar || '').startsWith('a_') ? 'gif' : 'png';
      const avatarUrl = user.discordAvatar
        ? `https://cdn.discordapp.com/avatars/${socket.userId}/${user.discordAvatar}.${ext}?size=256`
        : null;

      const player = {
        userId: socket.userId,
        username: user.discordName,
        rankingPoints: user.rankingPoints,
        epicName: epicName || user.epicGamesName,
        avatar: user.discordAvatar,
        avatarUrl,
        tournamentId: tournamentId,
        socketId: socket.id,
        role: user.role || 'player',
        mapCode: tournament.mapCode,
      };

      const queueResult = await GameEngine.joinQueue(player);
      if (!queueResult.success) {
        return socket.emit('error', { message: queueResult.reason });
      }

      socket.emit('waiting', { message: 'Waiting for opponent...', queueSize: GameEngine.getQueueSize(tournamentId) });

      const createdMatch = GameEngine.getActiveMatchForUser(socket.userId);
      if (createdMatch) {
        const p1 = createdMatch.player1;
        const p2 = createdMatch.player2;
        const p1AvatarUrl = p1.avatarUrl || null;
        const p2AvatarUrl = p2.avatarUrl || null;

        const emitMatchFound = (targetSocket, self, opp) => {
          eventBus.emit('matchFound', {
            matchId: createdMatch.matchId,
            opponent: opp.username,
            opponentId: opp.userId,
            opponentAvatar: opp.avatar ? `https://cdn.discordapp.com/avatars/${opp.userId}/${opp.avatar}.${(opp.avatar||'').startsWith('a_')?'gif':'png'}?size=256` : null,
            opponentEpicName: opp.epicName || opp.username,
            opponentRank: getRank(opp.rankingPoints || 0).name,
            selfId: self.userId,
            selfEpicName: self.epicName || self.username,
            selfAvatar: self.avatar ? `https://cdn.discordapp.com/avatars/${self.userId}/${self.avatar}.${(self.avatar||'').startsWith('a_')?'gif':'png'}?size=256` : null,
            tournamentId: tournamentId,
            mapCode: tournament.mapCode
          }, { targets: [`socket:${targetSocket}`], source: 'matchmaking' });
        };

        emitMatchFound(p1.socketId, p1, p2);
        if (p2.socketId) emitMatchFound(p2.socketId, p2, p1);

        console.log(`🔥 Match found: ${p1.username} vs ${p2.username}`);
      }
    } catch (error) {
      console.error('Socket joinQueue error:', error);
      socket.emit('error', { message: 'Failed to join queue' });
    }
  });

  socket.on('leaveQueue', () => {
    if (socket.userId) {
      GameEngine.leaveQueue(socket.userId);
      socket.emit('leftQueue', { message: 'Left queue' });
      console.log(`❌ ${socket.userId} left queue`);
    }
  });

  socket.on('joinMatch', ({ matchId, playerName }) => {
    if (!matchId) return;

    const isNewJoin = ensureJoinedRoom(socket, matchId);
    if (isNewJoin) {
      console.log(`👤 ${socket.id} (${playerName || 'unknown'}) joined match room: ${matchId}`);
    }

    const activeMatch = GameEngine.getActiveMatch(matchId);
    if (activeMatch) {
      activeMatch.joinedPlayers = activeMatch.joinedPlayers || new Set();
      activeMatch.chatLogs = activeMatch.chatLogs || [];

      let joinKey = null;
      if (socket.userId) {
        joinKey = socket.userId;
      } else if (playerName) {
        if (playerName === activeMatch.player1.username || playerName === activeMatch.player1.epicName) {
          joinKey = activeMatch.player1.userId;
        } else if (playerName === activeMatch.player2.username || playerName === activeMatch.player2.epicName) {
          joinKey = activeMatch.player2.userId;
        }
      }
      if (joinKey) {
        activeMatch.joinedPlayers.add(joinKey);
      }

      if (isNewJoin) {
        if (activeMatch.joinedPlayers.size >= 2 && !activeMatch._bothJoinedMsgSent) {
          activeMatch._bothJoinedMsgSent = true;
          const timeStr = new Date().toISOString();
          const msg = {
            sender: 'System',
            message: `✅ Both players are now in the match — ${activeMatch.player1.username} vs ${activeMatch.player2.username}. Match started at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}.`,
            time: timeStr,
            isSystem: true,
          };
          eventBus.emit('receiveMessage', { ...msg, matchId }, { targets: [`match:${matchId}`], source: 'chat' });
          activeMatch.chatLogs.push({ ...msg, time: new Date(msg.time) });
        } else if (playerName && !activeMatch._bothJoinedMsgSent) {
          const timeStr = new Date().toISOString();
          const msg = {
            sender: 'System',
            message: `🔵 ${playerName} joined the match room at ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })}.`,
            time: timeStr,
            isSystem: true,
          };
          eventBus.emit('receiveMessage', { ...msg, matchId }, { targets: [`match:${matchId}`], source: 'chat' });
          activeMatch.chatLogs.push({ ...msg, time: new Date(msg.time) });
        }
      }
    }
  });

  socket.on('sendMessage', async ({ matchId, message, sender }) => {
    if (matchId && message && sender) {
      const spamCheck = checkChatSpam(socket.userId || sender);
      if (!spamCheck.allowed) {
        return socket.emit('chatError', { message: spamCheck.reason });
      }

      try {
        const User = require('./models/User');
        const user = await User.findOne({ discordId: socket.userId || sender });
        if (user && user.mutedUntil && new Date(user.mutedUntil) > new Date()) {
          return socket.emit('chatError', { message: 'You are muted and cannot send messages.' });
        }
      } catch (e) {}

      const hasProfanity = containsProfanity(message);
      const finalMessage = hasProfanity ? filterProfanity(message) : message;

      let senderRole = 'player';
      if (socket.userId) {
        try {
          const User = require('./models/User');
          const u = await User.findOne({ discordId: socket.userId }).select('role');
          if (u) senderRole = u.role || 'player';
        } catch (e) {}
      }

      const msg = {
        sender,
        message: finalMessage,
        time: new Date().toISOString(),
        isSystem: false,
        role: senderRole,
      };

      eventBus.emit('receiveMessage', { ...msg, matchId }, { targets: [`match:${matchId}`], source: 'chat' });

      const activeMatch = GameEngine.getActiveMatch(matchId);
      if (activeMatch) {
        activeMatch.chatLogs = activeMatch.chatLogs || [];
        activeMatch.chatLogs.push({ ...msg, time: new Date(msg.time) });
      }

      if (hasProfanity) {
        socket.emit('chatWarning', { message: 'Your message contained inappropriate language and was filtered.' });
      }
    }
  });

  socket.on('reportMessage', async ({ matchId, reportedUserId, reportedUserName, message, reason }) => {
    if (!matchId || !reportedUserId || !message) return;
    try {
      const ChatReport = require('./models/ChatReport');
      await ChatReport.create({
        matchId,
        reportedPlayerDiscordId: reportedUserId,
        reportedPlayerName: reportedUserName || 'Unknown',
        reporterDiscordId: socket.userId || 'Unknown',
        reporterName: socket.userId || 'Unknown',
        message,
        reason: reason || 'Inappropriate message',
      });

      const StaffNotification = require('./models/StaffNotification');
      await StaffNotification.create({
        type: 'system',
        matchId,
        title: '🚨 Chat Report',
        message: `Player reported for message: "${message.substring(0, 100)}". Reporter: ${socket.userId}`,
      });

      socket.emit('reportSubmitted', { message: 'Report submitted. Staff will review.' });
      console.log(`🚨 Chat report submitted in match ${matchId}`);
      eventBus.emit('admin:report-submitted', { matchId, reportedUserId, reportedUserName, reason: reason || 'Inappropriate message' }, { source: 'chat' });
    } catch (err) {
      console.error('Report message error:', err);
    }
  });

  socket.on('callStaff', async ({ matchId, callerName, reason }) => {
    if (!matchId) return;
    try {
      const StaffNotificationModel = require('./models/StaffNotification');
      const notification = new StaffNotificationModel({
        type: 'call_staff',
        matchId,
        title: '🆘 Staff Assistance Requested',
        message: `${callerName || 'A player'} requested staff assistance: ${reason || 'No reason provided'}`,
        player1Name: callerName || 'Unknown',
      });
      await notification.save();

      const msg = {
        sender: 'System',
        message: `🆘 ${callerName || 'A player'} called for staff assistance.`,
        time: new Date().toISOString(),
        isSystem: true,
      };
      eventBus.emit('receiveMessage', { ...msg, matchId }, { targets: [`match:${matchId}`], source: 'chat' });

      const activeMatch = GameEngine.getActiveMatch(matchId);
      if (activeMatch) {
        activeMatch.chatLogs = activeMatch.chatLogs || [];
        activeMatch.chatLogs.push({ ...msg, time: new Date(msg.time) });
      }

      socket.emit('staffNotified', { message: 'Staff has been notified.' });
      console.log(`🆘 Staff called in match ${matchId} by ${callerName}`);
    } catch (err) {
      console.error('callStaff error:', err);
    }
  });

  socket.on('staffJoinMatch', async ({ matchId, staffName }) => {
    if (!matchId) return;
    try {
      const User = require('./models/User');
      const u = await User.findOne({ discordId: socket.userId }).select('role');
      if (!u || (u.role !== 'admin' && u.role !== 'owner' && u.role !== 'staff')) return;
      socket.role = u.role;
    } catch (e) {
      return;
    }

    const isNewJoin = ensureJoinedRoom(socket, matchId);
    if (isNewJoin) {
      const msg = {
        sender: 'System',
        message: `🛡️ Staff ${staffName || 'member'} joined the match room.`,
        time: new Date().toISOString(),
        isSystem: true,
      };
      eventBus.emit('receiveMessage', { ...msg, matchId }, { targets: [`match:${matchId}`], source: 'chat' });
    }
    socket.emit('staffJoinedMatch', { message: 'You joined the match as staff.' });
  });

  socket.on('disconnect', () => {
    console.log(`🔴 Disconnected: ${socket.id}`);
    if (socket.userId) {
      GameEngine.leaveQueue(socket.userId);
    }
  });
});

const PORT = process.env.PORT || 5000;

function startServer(port) {
  server.listen(port, () => {
    console.log(`🚀 Server running on http://localhost:${port}`);
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`❌ Port ${port} busy. Trying ${port + 1}...`);
      startServer(port + 1);
    } else {
      console.error(err);
    }
  });
}

startServer(PORT);
