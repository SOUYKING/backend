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
const teamRoutes = require('./routes/teams');
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

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err.message);
});

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

const allowedOrigins = [
  FRONTEND_URL,
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  'https://backend-97zg.onrender.com',
  'https://frontend-nine-zeta-89.vercel.app',
  'https://fntarena.online',
  'https://www.fntarena.online',
  process.env.FRONTEND_URL2,
].filter(Boolean);

const allowedOriginPatterns = [
  /^https:\/\/.*\.vercel\.app$/,
];

const isAllowedOrigin = (origin = '') => {
  if (allowedOrigins.includes(origin)) return true;
  return allowedOriginPatterns.some((pattern) => pattern.test(origin));
};

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || isAllowedOrigin(origin)) return callback(null, true);
    console.warn(`[CORS_BLOCKED] origin=${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true,
};

const io = socketIo(server, { cors: corsOptions });
socketManager.init(io);
eventBus.init(io);
const adminSocket = setupAdminSocket(io);
GameEngine.init();

app.use(cors(corsOptions));
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
app.use('/teams', teamRoutes);
app.use('/admin', adminRateLimit, adminRoutes);
app.use('/announcements', announcementRoutes);
app.use('/staff-notifications', staffNotificationRoutes);

const chatRateLimits = new Map();
const MESSAGE_COOLDOWN_MS = 1500;
const MAX_MESSAGES_PER_MINUTE = 20;

// Track which match rooms each socket has joined and their role in each room
// socketId -> Map(matchId -> { role: 'player'|'staff'|'viewer', joinedAt: timestamp })
const socketMatchRooms = new Map();

function ensureJoinedRoom(socket, roomId) {
  if (!roomId) return false;
  if (socket.rooms.has(roomId)) {
    return false;
  }
  socket.join(roomId);
  return true;
}

function getSocketRoleInMatch(socketId, matchId) {
  return socketMatchRooms.get(socketId)?.get(matchId)?.role || null;
}

function isSocketInMatchRoom(socketId, matchId) {
  const rooms = socketMatchRooms.get(socketId);
  return rooms ? rooms.has(matchId) : false;
}

function trackSocketJoin(socketId, matchId, role) {
  if (!socketMatchRooms.has(socketId)) {
    socketMatchRooms.set(socketId, new Map());
  }
  socketMatchRooms.get(socketId).set(matchId, { role, joinedAt: Date.now() });
}

function cleanupSocketRooms(socketId) {
  socketMatchRooms.delete(socketId);
}

/** Expected distinct participant Discord accounts that may join the match room (1v1: 2, 2v2: 4, …). */
function expectedMatchRoomPlayers(activeMatch) {
  const sideCount = (p) => {
    if (!p?.teamMode) return 1;
    const n = (Array.isArray(p.teamMemberIds) && p.teamMemberIds.length) || p.teamSize;
    return Math.max(1, Number(n) || 1);
  };
  return sideCount(activeMatch.player1) + sideCount(activeMatch.player2);
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
    const queueIndex = queue.findIndex((p) => {
      if (p.teamMode) return p.captainId === userId;
      return p.userId === userId;
    });
    if (queueIndex !== -1) {
      GameEngine.queue[queueIndex].socketId = socket.id;
      await GameEngine.processMatchmaking();
    }
  });

  socket.on('joinQueue', async ({ tournamentId, epicName, teamId }) => {
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
      const startDate = new Date(tournament.startDate);
      const endDate = new Date(tournament.endDate);
      const END_GRACE_MS = 6 * 60 * 60 * 1000; // tolerate timezone-drifted end times

      if (tournament.status === 'cancelled') {
        return socket.emit('error', { message: 'Tournament is cancelled' });
      }
      if (now < startDate) {
        return socket.emit('error', { message: 'Tournament has not started yet' });
      }
      if (now.getTime() > endDate.getTime() + END_GRACE_MS) {
        return socket.emit('error', { message: 'Tournament has ended' });
      }

      if (!user.epicVerified) {
        return socket.emit('error', { message: 'Epic Games account not verified' });
      }

      const requiredTeamSize = tournament.type === '2v2' ? 2 : tournament.type === '3v3' ? 3 : tournament.type === '4v4' ? 4 : 1;
      let player;
      if (requiredTeamSize === 1) {
        const isRegistered = tournament.participants?.some((p) => p.userId === socket.userId);
        if (!isRegistered) {
          tournament.participants = tournament.participants || [];
          tournament.leaderboard = tournament.leaderboard || [];

          tournament.participants.push({
            userId: socket.userId,
            discordName: user.discordName,
            rankingPoints: user.rankingPoints,
            epicName: user.epicGamesName,
            registeredAt: new Date(),
          });

          tournament.leaderboard.push({
            userId: socket.userId,
            discordId: socket.userId,
            discordName: user.discordName,
            discordAvatar: user.discordAvatar || null,
            wins: 0,
            losses: 0,
            points: 0,
          });
        }

        const ext = (user.discordAvatar || '').startsWith('a_') ? 'gif' : 'png';
        const avatarUrl = user.discordAvatar
          ? `https://cdn.discordapp.com/avatars/${socket.userId}/${user.discordAvatar}.${ext}?size=256`
          : null;

        player = {
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
      } else {
        if (!teamId) return socket.emit('error', { message: `This is a ${tournament.type} tournament. Select a team first.` });
        const Team = require('./models/Team');
        const memberUsers = require('./models/User');
        const team = await Team.findById(teamId);
        if (!team || !team.isActive) return socket.emit('error', { message: 'Team not found' });
        if (team.size !== requiredTeamSize) return socket.emit('error', { message: `Team must be ${requiredTeamSize} players` });
        if (team.captainDiscordId !== socket.userId) return socket.emit('error', { message: 'Only team captain can join queue' });
        const acceptedMembers = (team.members || []).filter((m) => m.status === 'accepted');
        if (acceptedMembers.length !== requiredTeamSize) return socket.emit('error', { message: `Team must have ${requiredTeamSize} accepted members` });

        const memberIds = acceptedMembers.map((m) => m.discordId);
        const teamMembers = await memberUsers.find({ discordId: { $in: memberIds } }).select('discordId discordName discordAvatar rankingPoints epicGamesName isBanned');
        if (teamMembers.length !== requiredTeamSize) return socket.emit('error', { message: 'Team members not found' });
        if (teamMembers.some((m) => m.isBanned)) return socket.emit('error', { message: 'A team member is banned' });

        tournament.participants = tournament.participants || [];
        tournament.leaderboard = tournament.leaderboard || [];
        const teamIdStr = String(team._id);
        const teamNameStr = team.name;
        for (const member of teamMembers) {
          const participant = tournament.participants.find(
            (p) => String(p.userId) === String(member.discordId),
          );
          if (!participant) {
            tournament.participants.push({
              userId: member.discordId,
              discordName: member.discordName,
              rankingPoints: member.rankingPoints,
              epicName: member.epicGamesName,
              registeredAt: new Date(),
              teamId: teamIdStr,
              teamName: teamNameStr,
            });
            tournament.leaderboard.push({
              userId: member.discordId,
              discordId: member.discordId,
              discordName: member.discordName,
              discordAvatar: member.discordAvatar || null,
              wins: 0,
              losses: 0,
              points: 0,
            });
          } else {
            participant.teamId = teamIdStr;
            participant.teamName = teamNameStr;
            const lbRow = tournament.leaderboard.find((l) => String(l.userId) === String(member.discordId));
            if (!lbRow) {
              tournament.leaderboard.push({
                userId: member.discordId,
                discordId: member.discordId,
                discordName: member.discordName,
                discordAvatar: member.discordAvatar || null,
                wins: 0,
                losses: 0,
                points: 0,
              });
            }
          }
        }
        tournament.markModified('participants');
        const avgRp = Math.round(teamMembers.reduce((sum, m) => sum + (m.rankingPoints || 0), 0) / requiredTeamSize);
        player = {
          userId: `team:${team._id}`,
          username: team.name,
          rankingPoints: avgRp,
          epicName: team.name,
          avatar: null,
          avatarUrl: null,
          tournamentId: tournamentId,
          socketId: socket.id,
          role: user.role || 'player',
          mapCode: tournament.mapCode,
          teamMode: true,
          teamId: String(team._id),
          teamName: team.name,
          teamSize: requiredTeamSize,
          teamMemberIds: memberIds,
          captainId: team.captainDiscordId,
        };
      }

      if (tournament.status !== 'active') {
        tournament.status = 'active';
      }
      await tournament.save();

      const queueResult = await GameEngine.joinQueue(player);
      if (!queueResult.success) {
        return socket.emit('error', { message: queueResult.reason });
      }

      if (player.teamMode && player.teamId) {
        const Team = require('./models/Team');
        const lockTeam = await Team.findById(player.teamId);
        if (lockTeam) {
          const tid = String(tournament._id);
          const alreadyLocked = (lockTeam.tournamentLocks || []).some((lock) => String(lock.tournamentId) === tid);
          if (!alreadyLocked) {
            lockTeam.tournamentLocks.push({ tournamentId: tid, lockedAt: new Date() });
            await lockTeam.save();
          }
        }
      }

      socket.emit('waiting', { message: 'Waiting for opponent...', queueSize: GameEngine.getQueueSize(tournamentId) });

      const activeLookupId = player.teamMode ? player.userId : socket.userId;
      const createdMatch = GameEngine.getActiveMatchForUser(activeLookupId);
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

  socket.on('leaveQueue', async () => {
    if (socket.userId) {
      await GameEngine.leaveQueue(socket.userId);
      socket.emit('leftQueue', { message: 'Left queue' });
      console.log(`❌ ${socket.userId} left queue`);
    }
  });

  socket.on('joinMatch', ({ matchId, playerName }) => {
    if (!matchId) return;
    if (!socket.userId) {
      return socket.emit('chatError', { message: 'Please refresh and rejoin the match.' });
    }

    const activeMatch = GameEngine.getActiveMatch(matchId);
    if (!activeMatch) return;

    // Verify this socket's user is actually a participant in this match
    if (
      !socket.userId ||
      (
        socket.userId !== activeMatch.player1.userId &&
        socket.userId !== activeMatch.player2.userId &&
        !(activeMatch.player1.teamMemberIds || []).includes(socket.userId) &&
        !(activeMatch.player2.teamMemberIds || []).includes(socket.userId)
      )
    ) {
      // Not a participant — silently redirect to viewer mode
      socket.emit('joinMatchAsViewer', { matchId, viewerName: playerName || 'Viewer' });
      return;
    }

    const isNewJoin = ensureJoinedRoom(socket, matchId);
    trackSocketJoin(socket.id, matchId, 'player');

    console.log(`👤 ${socket.id} (${playerName || 'unknown'}) joined match room as PLAYER: ${matchId}`);

    activeMatch.joinedPlayers = activeMatch.joinedPlayers || new Set();
    activeMatch.chatLogs = activeMatch.chatLogs || [];

    activeMatch.joinedPlayers.add(socket.userId);

    if (isNewJoin) {
      // Send previous chat history to the joining player
      if (activeMatch.chatLogs && activeMatch.chatLogs.length > 0) {
        socket.emit('chatHistory', { chatLogs: activeMatch.chatLogs });
      }

      const needJoined = expectedMatchRoomPlayers(activeMatch);
      if (activeMatch.joinedPlayers.size >= needJoined && !activeMatch._bothJoinedMsgSent) {
        activeMatch._bothJoinedMsgSent = true;
        const timeStr = new Date().toISOString();
        const timeLabel = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
        const roomReadyText =
          needJoined <= 2
            ? `✅ Both players are now in the match — ${activeMatch.player1.username} vs ${activeMatch.player2.username}. Match started at ${timeLabel}.`
            : `✅ All ${needJoined} players are in the match room — ${activeMatch.player1.username} vs ${activeMatch.player2.username}. Match started at ${timeLabel}.`;
        const msg = {
          sender: 'System',
          message: roomReadyText,
          time: timeStr,
          isSystem: true,
        };
        eventBus.emit('receiveMessage', { ...msg, matchId }, { targets: [`match:${matchId}`], source: 'chat' });
        activeMatch.chatLogs.push({ ...msg, time: new Date(msg.time) });
      } else if (!activeMatch._bothJoinedMsgSent) {
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
  });

  socket.on('joinMatchAsViewer', ({ matchId, viewerName }) => {
    if (!matchId) return;
    if (!socket.userId) {
      return socket.emit('chatError', { message: 'Please refresh and log in again.' });
    }

    const isNewJoin = ensureJoinedRoom(socket, matchId);
    trackSocketJoin(socket.id, matchId, 'viewer');

    if (isNewJoin) {
      console.log(`👁️ ${socket.id} (${viewerName || 'unknown'}) joined match room as VIEWER: ${matchId}`);

      const activeMatch = GameEngine.getActiveMatch(matchId);
      if (activeMatch) {
        activeMatch.chatLogs = activeMatch.chatLogs || [];
        // Send previous chat history to the viewer
        if (activeMatch.chatLogs.length > 0) {
          socket.emit('chatHistory', { chatLogs: activeMatch.chatLogs });
        }
      }
    }
  });

  socket.on('sendMessage', async ({ matchId, message, sender }) => {
    if (!matchId || !message || !sender) return;

    // Check this socket is actually in the match room
    if (!isSocketInMatchRoom(socket.id, matchId)) {
      return socket.emit('chatError', { message: 'You must join the match room first.' });
    }

    const role = getSocketRoleInMatch(socket.id, matchId);
    // Viewers cannot send chat messages
    if (role === 'viewer') {
      return socket.emit('chatError', { message: 'Spectators cannot send messages.' });
    }

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
  });

  socket.on('callStaff', async ({ matchId, callerName, reason }) => {
    if (!matchId) return;

    const role = getSocketRoleInMatch(socket.id, matchId);
    // Only players (not viewers) can call for staff
    if (!role || role === 'viewer') {
      return socket.emit('chatError', { message: 'Only match participants can call for staff.' });
    }

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
    trackSocketJoin(socket.id, matchId, 'staff');

    if (isNewJoin) {
      const activeMatch = GameEngine.getActiveMatch(matchId);
      if (activeMatch && activeMatch.chatLogs && activeMatch.chatLogs.length > 0) {
        socket.emit('chatHistory', { chatLogs: activeMatch.chatLogs });
      }

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

  socket.on('reportMessage', async ({ matchId, reportedUserId, reportedUserName, message, reason }) => {
    if (!matchId || !reportedUserId || !message) return;

    // Only participants can report messages
    const role = getSocketRoleInMatch(socket.id, matchId);
    if (!role || role === 'viewer') {
      return socket.emit('chatError', { message: 'Only match participants can report messages.' });
    }

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

  socket.on('disconnect', () => {
    console.log(`🔴 Disconnected: ${socket.id}`);
    if (socket.userId) {
      GameEngine.leaveQueue(socket.userId).catch((err) => console.warn('[disconnect] leaveQueue', err.message));
    }
    cleanupSocketRooms(socket.id);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
}).on('error', (err) => {
  console.error('❌ Failed to start server:', err.message);
  process.exit(1);
});
