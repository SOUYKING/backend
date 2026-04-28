const express = require('express');
const User = require('../models/User');
const Tournament = require('../models/Tournament');
const Match = require('../models/Match');
const authenticate = require('../middlewares/authenticate');
const adminAuth = require('../middlewares/adminAuth');
const Announcement = require('../models/Announcement');
const AdminLog = require('../models/AdminLog');
const IPWhitelist = require('../models/IPWhitelist');
const { getRank, calculatePointsChange, getRankProgress } = require('../utils/rankSystem');
const GameEngine = require('../core/GameEngine');
const eventBus = require('../utils/eventBus');
const router = express.Router();

async function logAction(req, action, targetId = null, targetName = null, details = {}) {
  try {
    await AdminLog.create({
      adminId: req.user.discordId,
      adminName: req.user.discordName || 'Unknown',
      action,
      targetId,
      targetName,
      tournamentId: details.tournamentId || null,
      matchId: details.matchId || null,
      reason: details.reason || null,
      details,
    });
  } catch (err) {
    console.error('Admin log error:', err);
  }
}

router.use(authenticate);
router.use(adminAuth);

// ============ DASHBOARD STATS ============
router.get('/dashboard/stats', async (req, res) => {
  try {
    const [
      totalUsers,
      activeUsers,
      bannedUsers,
      premiumUsers,
      totalMatches,
      activeTournaments,
      suspiciousUsers,
      flaggedAccounts,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ lastActive: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } }),
      User.countDocuments({ isBanned: true }),
      User.countDocuments({ isPremium: true }),
      Match.countDocuments(),
      Tournament.countDocuments({ status: 'active' }),
      User.countDocuments({ 'anticheatFlags.suspiciousActivity': true }),
      User.countDocuments({ anticheatScore: { $lt: 50 } }),
    ]);

    const recentBans = await User.find({ isBanned: true })
      .sort({ bannedAt: -1 })
      .limit(5)
      .select('discordName discordId bannedAt banReason');

    const recentFlags = await User.find({
      flagHistory: { $exists: true, $ne: [] },
      'flagHistory.0': { $exists: true }
    })
      .sort({ 'flagHistory.createdAt': -1 })
      .limit(10)
      .select('discordName discordId anticheatScore flagHistory');

    const topPlayers = await User.find({ isBanned: false })
      .sort({ rankingPoints: -1 })
      .limit(10)
      .select('discordName discordAvatar wins losses rankingPoints totalMatches');

    const matchActivity = await Match.aggregate([
      {
        $match: {
          date: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
        }
      },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$date' } },
          count: { $sum: 1 },
        }
      },
      { $sort: { _id: 1 } }
    ]);

    const queueCount = GameEngine.getQueueSize();
    const activeMatchCount = GameEngine.getActiveMatchCount();

    res.json({
      overview: {
        totalUsers,
        activeUsers,
        bannedUsers,
        premiumUsers,
        totalMatches,
        activeTournaments,
        suspiciousUsers,
        flaggedAccounts,
        queueCount,
        activeMatchCount,
      },
      recentBans,
      recentFlags,
      topPlayers,
      matchActivity,
    });
  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({ message: 'Failed to fetch dashboard stats' });
  }
});

// ============ USER MANAGEMENT ============
router.get('/users', async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '', role, banned, risk, sort = 'lastActive', order = 'desc' } = req.query;

    const query = {};

    if (search) {
      query.$or = [
        { discordName: { $regex: search, $options: 'i' } },
        { discordId: { $regex: search, $options: 'i' } },
        { epicGamesName: { $regex: search, $options: 'i' } },
      ];
    }

    if (role) query.role = role;
    if (banned !== undefined) query.isBanned = banned === 'true';
    if (risk) {
      if (risk === 'suspicious') query['anticheatFlags.suspiciousActivity'] = true;
      if (risk === 'flagged') query.anticheatScore = { $lt: 50 };
    }

    const sortObj = { [sort]: order === 'desc' ? -1 : 1 };

    const [users, total] = await Promise.all([
      User.find(query)
        .sort(sortObj)
        .skip((page - 1) * limit)
        .limit(parseInt(limit))
        .select('-ipAddresses -deviceFingerprints -accountsLinkedToIP -flagHistory'),
      User.countDocuments(query),
    ]);

    res.json({
      users,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({ message: 'Failed to fetch users' });
  }
});

router.get('/users/:discordId', async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userMatches = await Match.find({
      $or: [{ player1DiscordId: user.discordId }, { player2DiscordId: user.discordId }]
    })
      .sort({ date: -1 })
      .limit(50);

    const relatedAccounts = await User.find({
      $or: [
        { 'ipAddresses.ip': { $in: user.ipAddresses.map(i => i.ip) } },
        { 'deviceFingerprints.fingerprint': { $in: user.deviceFingerprints.map(d => d.fingerprint) } },
      ],
      discordId: { $ne: user.discordId },
    }).select('discordName discordId epicGamesName anticheatScore isBanned ipAddresses');

    res.json({
      user,
      userMatches,
      relatedAccounts,
      riskLevel: user.getRiskLevel(),
      activeWarnings: user.getActiveWarnings(),
    });
  } catch (error) {
    console.error('Get user details error:', error);
    res.status(500).json({ message: 'Failed to fetch user details' });
  }
});

// ============ BAN MANAGEMENT ============
router.post('/users/:discordId/ban', async (req, res) => {
  try {
    const { reason } = req.body;
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.isOwner) {
      return res.status(403).json({ message: 'Cannot ban the owner' });
    }

    user.isBanned = true;
    user.banReason = reason || 'Banned by admin';
    user.bannedAt = new Date();
    user.bannedBy = req.user.discordId;
    await user.save();

    await logAction(req, 'ban_user', user.discordId, user.discordName, { reason: reason || 'Banned by admin' });
    eventBus.emit('admin:user-banned', { discordId: user.discordId, discordName: user.discordName, by: req.user.discordName, reason: reason || 'Banned by admin', role: user.role }, { source: 'admin' });
    eventBus.emit('user:banned', { reason: reason || 'Banned by admin', discordId: user.discordId }, { source: 'admin' });
    eventBus.emitStatsUpdate();

    const relatedAccounts = await User.find({
      'ipAddresses.ip': { $in: user.ipAddresses.map(i => i.ip) },
      discordId: { $ne: user.discordId },
      isBanned: false,
    });

    res.json({
      message: 'User banned successfully',
      relatedAccountsFound: relatedAccounts.length,
      relatedAccounts: relatedAccounts.map(u => ({ discordName: u.discordName, discordId: u.discordId })),
    });
  } catch (error) {
    console.error('Ban user error:', error);
    res.status(500).json({ message: 'Failed to ban user' });
  }
});

router.post('/users/:discordId/unban', async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.isBanned = false;
    user.banReason = null;
    user.bannedAt = null;
    user.bannedBy = null;
    await user.save();

    await logAction(req, 'unban_user', user.discordId, user.discordName, { reason: 'Unbanned by admin' });
    eventBus.emit('admin:user-unbanned', { discordId: user.discordId, discordName: user.discordName, by: req.user.discordName }, { source: 'admin' });
    eventBus.emit('user:unbanned', { discordId: user.discordId }, { source: 'admin' });
    eventBus.emitStatsUpdate();

    res.json({ message: 'User unbanned successfully' });
  } catch (error) {
    console.error('Unban user error:', error);
    res.status(500).json({ message: 'Failed to unban user' });
  }
});

// ============ PROFILE MANAGEMENT ============
router.post('/users/:discordId/reset', async (req, res) => {
  try {
    const { resetType = 'full', reason } = req.body;
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const previousStats = user.resetProfile(
      resetType,
      req.user.discordId,
      req.user.discordName,
      reason
    );
    await user.save();

    await logAction(req, 'reset_profile', user.discordId, user.discordName, { resetType, reason });

    res.json({
      message: `Profile ${resetType} reset successful`,
      previousStats,
    });
  } catch (error) {
    console.error('Reset profile error:', error);
    res.status(500).json({ message: 'Failed to reset profile' });
  }
});

router.post('/users/:discordId/update-role', async (req, res) => {
  try {
    const { role } = req.body;
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.isOwner) {
      return res.status(403).json({ message: 'Cannot change owner role' });
    }

    const validRoles = ['player', 'content_creator', 'staff', 'admin'];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ message: 'Invalid role' });
    }

    user.role = role;
    await user.save();

    await logAction(req, 'update_role', user.discordId, user.discordName, { oldRole: user.role, newRole: role });

    res.json({ message: 'Role updated successfully', role });
  } catch (error) {
    console.error('Update role error:', error);
    res.status(500).json({ message: 'Failed to update role' });
  }
});

// ============ MUTE / UNMUTE ============
router.post('/users/:discordId/mute', async (req, res) => {
  try {
    const { durationMinutes, reason } = req.body;
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.mutedUntil = new Date(Date.now() + (durationMinutes || 60) * 60 * 1000);
    user.mutedBy = req.user.discordId;
    await user.save();

    await logAction(req, 'mute_player', user.discordId, user.discordName, { durationMinutes, reason });

    res.json({ message: `User muted for ${durationMinutes || 60} minutes` });
  } catch (error) {
    console.error('Mute user error:', error);
    res.status(500).json({ message: 'Failed to mute user' });
  }
});

router.post('/users/:discordId/unmute', async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.mutedUntil = null;
    user.mutedBy = null;
    await user.save();

    await logAction(req, 'unmute_player', user.discordId, user.discordName);

    res.json({ message: 'User unmuted' });
  } catch (error) {
    console.error('Unmute user error:', error);
    res.status(500).json({ message: 'Failed to unmute user' });
  }
});

// ============ WARNINGS & STRIKES ============
router.post('/users/:discordId/warn', async (req, res) => {
  try {
    const { type, reason, daysUntilExpiry = 30 } = req.body;
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const warningId = user.addWarning(
      type || 'other',
      reason,
      req.user.discordId,
      req.user.discordName,
      daysUntilExpiry
    );
    await user.save();

    await logAction(req, 'warn_player', user.discordId, user.discordName, { type, reason, warningId });
    eventBus.emit('admin:user-warned', { discordId: user.discordId, discordName: user.discordName, by: req.user.discordName, reason: reason || 'No reason', warningId }, { source: 'admin' });

    res.json({ message: 'Warning issued', warningId });
  } catch (error) {
    console.error('Issue warning error:', error);
    res.status(500).json({ message: 'Failed to issue warning' });
  }
});

router.post('/users/:discordId/strike', async (req, res) => {
  try {
    const { reason } = req.body;
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const strikeId = user.addStrike(reason, req.user.discordId, req.user.discordName);
    await user.save();

    await logAction(req, 'strike_player', user.discordId, user.discordName, { reason, strikes: user.strikes, autoBanned: user.isBanned });
    eventBus.emit('admin:user-striked', { discordId: user.discordId, discordName: user.discordName, by: req.user.discordName, reason: reason || 'No reason', strikes: user.strikes, autoBanned: user.isBanned }, { source: 'admin' });
    if (user.isBanned) eventBus.emitStatsUpdate();

    res.json({
      message: `Strike issued (${user.strikes}/3 strikes)`,
      strikeId,
      autoBanned: user.isBanned,
    });
  } catch (error) {
    console.error('Issue strike error:', error);
    res.status(500).json({ message: 'Failed to issue strike' });
  }
});

router.post('/users/:discordId/remove-warning/:warningId', async (req, res) => {
  try {
    const { warningId } = req.params;
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const warning = user.warnings.find(w => w.warningId === warningId);
    if (warning) {
      warning.isActive = false;
      await user.save();
    }

    res.json({ message: 'Warning removed' });
  } catch (error) {
    console.error('Remove warning error:', error);
    res.status(500).json({ message: 'Failed to remove warning' });
  }
});

// ============ ANTICHEAT ============
router.get('/anticheat/alerts', async (req, res) => {
  try {
    const { page = 1, limit = 50, severity } = req.query;

    const users = await User.find({
      'flagHistory.0': { $exists: true },
      'flagHistory.resolved': false,
      ...(severity && { 'flagHistory.severity': severity }),
    })
      .select('discordName discordId anticheatScore anticheatFlags flagHistory')
      .sort({ 'flagHistory.createdAt': -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const alerts = users.flatMap(user =>
      user.flagHistory.filter(f => !f.resolved).map(f => ({
        ...f.toObject(),
        userId: user.discordId,
        userName: user.discordName,
        anticheatScore: user.anticheatScore,
      }))
    ).sort((a, b) => {
      const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
      return severityOrder[a.severity] - severityOrder[b.severity];
    });

    res.json({ alerts });
  } catch (error) {
    console.error('Get anticheat alerts error:', error);
    res.status(500).json({ message: 'Failed to fetch anticheat alerts' });
  }
});

router.post('/anticheat/investigate/:discordId', async (req, res) => {
  try {
    const { type, flag, severity = 'medium', description } = req.body;
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.addAnticheatFlag(flag, severity, req.user.discordId, description);
    await user.save();

    await logAction(req, 'anticheat_flag', user.discordId, user.discordName, { type, flag, severity, description });

    res.json({ message: 'Anticheat flag added', anticheatScore: user.anticheatScore });
  } catch (error) {
    console.error('Investigate error:', error);
    res.status(500).json({ message: 'Failed to add anticheat flag' });
  }
});

router.post('/anticheat/resolve/:discordId/:flagId', async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const flag = user.flagHistory.id(req.params.flagId);
    if (flag) {
      flag.resolved = true;
      flag.resolvedBy = req.user.discordId;
      flag.resolvedAt = new Date();
      user.anticheatScore = Math.min(100, user.anticheatScore + 10);
      await user.save();

      await logAction(req, 'anticheat_resolve', user.discordId, user.discordName, { flagId: req.params.flagId });
    }

    res.json({ message: 'Flag resolved', anticheatScore: user.anticheatScore });
  } catch (error) {
    console.error('Resolve flag error:', error);
    res.status(500).json({ message: 'Failed to resolve flag' });
  }
});

router.post('/anticheat/scan-multiaccount', async (req, res) => {
  try {
    const ipGroups = await User.aggregate([
      { $unwind: '$ipAddresses' },
      { $group: { _id: '$ipAddresses.ip', users: { $push: { discordId: '$discordId', discordName: '$discordName' } } } },
      { $match: { 'users.1': { $exists: true } } },
    ]);

    const flagged = [];
    for (const group of ipGroups) {
      for (const user of group.users) {
        await User.updateOne(
          { discordId: user.discordId },
          {
            $set: { 'anticheatFlags.multiAccounting': true },
            $addToSet: {
              accountsLinkedToIP: {
                ip: group._id,
                linkType: 'shared_ip',
                detectedAt: new Date(),
              }
            }
          }
        );
        flagged.push(user);
      }
    }

    res.json({
      message: `Scan complete. Found ${flagged.length} accounts sharing IPs across ${ipGroups.length} IP addresses`,
      ipGroups: ipGroups.length,
      flaggedAccounts: flagged.length,
    });
  } catch (error) {
    console.error('Multi-account scan error:', error);
    res.status(500).json({ message: 'Failed to scan multi-accounts' });
  }
});

// ============ PREMIUM/PAYMENT MANAGEMENT ============
router.post('/users/:discordId/premium', async (req, res) => {
  try {
    const { tier = 'pro', durationDays = 30 } = req.body;
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.isPremium = true;
    user.premiumTier = tier;
    user.premiumExpiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
    await user.save();

    await logAction(req, 'premium_activate', user.discordId, user.discordName, { tier, durationDays });

    res.json({
      message: 'Premium activated',
      tier,
      expiresAt: user.premiumExpiresAt,
    });
  } catch (error) {
    console.error('Activate premium error:', error);
    res.status(500).json({ message: 'Failed to activate premium' });
  }
});

router.post('/users/:discordId/remove-premium', async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.isPremium = false;
    user.premiumTier = 'none';
    user.premiumExpiresAt = null;
    await user.save();

    await logAction(req, 'premium_remove', user.discordId, user.discordName);

    res.json({ message: 'Premium removed' });
  } catch (error) {
    console.error('Remove premium error:', error);
    res.status(500).json({ message: 'Failed to remove premium' });
  }
});

router.post('/users/:discordId/add-payment', async (req, res) => {
  try {
    const { transactionId, amount, provider, description } = req.body;
    const user = await User.findOne({ discordId: req.params.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    user.paymentHistory.push({
      transactionId,
      amount,
      provider,
      description,
      status: 'completed',
      createdAt: new Date(),
    });
    await user.save();

    res.json({ message: 'Payment recorded' });
  } catch (error) {
    console.error('Add payment error:', error);
    res.status(500).json({ message: 'Failed to add payment' });
  }
});

// ============ MATCH MANAGEMENT ============
router.get('/matches', async (req, res) => {
  try {
    const { page = 1, limit = 50, status, disputed, startDate, endDate } = req.query;

    const query = {};
    if (status) query.status = status;
    if (disputed !== undefined) query.disputed = disputed === 'true';
    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = new Date(startDate);
      if (endDate) query.date.$lte = new Date(endDate);
    }

    const [matches, total] = await Promise.all([
      Match.find(query)
        .populate('player1 player2', 'discordId discordName discordAvatar epicGamesName rankingPoints')
        .sort({ date: -1 })
        .skip((page - 1) * limit)
        .limit(parseInt(limit)),
      Match.countDocuments(query),
    ]);

    res.json({
      matches,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Get matches error:', error);
    res.status(500).json({ message: 'Failed to fetch matches' });
  }
});

router.get('/matches/:matchId', async (req, res) => {
  try {
    const match = await Match.findById(req.params.matchId);
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }
    res.json(match);
  } catch (error) {
    console.error('Get match error:', error);
    res.status(500).json({ message: 'Failed to fetch match' });
  }
});

router.post('/matches/:matchId/override', async (req, res) => {
  try {
    const { winner, reason } = req.body;
    const match = await Match.findById(req.params.matchId).populate('player1 player2');

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    match.result = winner;
    match.disputed = false;
    match.status = 'completed';
    match.adminOverride = {
      overriddenBy: req.user.discordId,
      overriddenAt: new Date(),
      reason: reason || 'Admin override',
    };

    // Apply ranking points for the override
    if (match.player1 && match.player2 && winner && winner !== 'draw') {
      const p1 = match.player1;
      const p2 = match.player2;
      const p1Points = p1.rankingPoints || 0;
      const p2Points = p2.rankingPoints || 0;

      if (winner === 'player1') {
        const pointsChange = calculatePointsChange(p1Points, p2Points);
        p1.rankingPoints += pointsChange.winPoints;
        p2.rankingPoints = Math.max(0, p2.rankingPoints - pointsChange.lossPoints);
        p1.wins = (p1.wins || 0) + 1;
        p2.losses = (p2.losses || 0) + 1;
      } else if (winner === 'player2') {
        const pointsChange = calculatePointsChange(p2Points, p1Points);
        p2.rankingPoints += pointsChange.winPoints;
        p1.rankingPoints = Math.max(0, p1.rankingPoints - pointsChange.lossPoints);
        p2.wins = (p2.wins || 0) + 1;
        p1.losses = (p1.losses || 0) + 1;
      }

      await p1.save();
      await p2.save();
    }

    await match.save();

    await logAction(req, 'override_result', `${match.player1?.discordName || 'P1'} vs ${match.player2?.discordName || 'P2'}`, null, {
      matchId: match._id.toString(),
      winner,
      reason: reason || 'Admin override',
    });

    res.json({ message: 'Match result overridden with ranking points adjustment' });
  } catch (error) {
    console.error('Override match error:', error);
    res.status(500).json({ message: 'Failed to override match' });
  }
});

// ============ TOURNAMENT MANAGEMENT ============
router.get('/tournaments', async (req, res) => {
  try {
    const { status, search } = req.query;
    const query = {};
    
    if (status) query.status = status;
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
      ];
    }
    
    const tournaments = await Tournament.find(query)
      .sort({ createdAt: -1 })
      .populate('hostedBy.discordId', 'discordName');

    const decorated = tournaments.map(t => ({
      ...t.toObject(),
      participantCount: t.participants?.length || 0,
      matchCount: t.matches?.length || 0,
    }));

    res.json(decorated);
  } catch (error) {
    console.error('Get tournaments error:', error);
    res.status(500).json({ message: 'Failed to fetch tournaments' });
  }
});

router.get('/tournaments/:id', async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id)
      .populate('participants.userId', 'discordName discordAvatar rankingPoints');
    
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    res.json({
      ...tournament.toObject(),
      participantCount: tournament.participants?.length || 0,
      matchCount: tournament.matches?.length || 0,
    });
  } catch (error) {
    console.error('Get tournament error:', error);
    res.status(500).json({ message: 'Failed to fetch tournament' });
  }
});

router.post('/tournaments', async (req, res) => {
  try {
    const {
      title,
      description,
      bannerImage,
      mapCode,
      mapName,
      rules,
      type,
      startDate,
      endDate,
      registrationDeadline,
      maxPlayers,
      minSkillRating,
      maxSkillRating,
      prize
    } = req.body;

    if (!title || !description || !mapCode || !rules || !startDate || !endDate || !registrationDeadline) {
      return res.status(400).json({ message: 'Missing required fields: title, description, mapCode, rules, startDate, endDate, registrationDeadline' });
    }

    const parsedStartDate = new Date(startDate);
    const parsedEndDate = new Date(endDate);
    const parsedRegistrationDeadline = new Date(registrationDeadline);
    const now = new Date();

    if (isNaN(parsedStartDate.getTime()) || isNaN(parsedEndDate.getTime()) || isNaN(parsedRegistrationDeadline.getTime())) {
      return res.status(400).json({ message: 'Invalid date format' });
    }

    if (parsedRegistrationDeadline > parsedStartDate) {
      return res.status(400).json({ message: 'Registration deadline must be before or at start date' });
    }

    if (parsedStartDate >= parsedEndDate) {
      return res.status(400).json({ message: 'End date must be AFTER start date' });
    }

    const tournament = await Tournament.create({
      title,
      description,
      bannerImage: bannerImage || null,
      mapCode,
      mapName: mapName || null,
      rules,
      type: type || '1v1',
      startDate: parsedStartDate,
      endDate: parsedEndDate,
      registrationDeadline: parsedRegistrationDeadline,
      maxPlayers: maxPlayers || 16,
      minSkillRating: minSkillRating || 0,
      maxSkillRating: maxSkillRating || 3000,
      prize: prize || null,
      hostedBy: {
        discordId: req.user.discordId,
        discordName: req.user.discordName,
      },
      status: 'registration',
      participants: [],
      matches: [],
      leaderboard: []
    });

    await logAction(req, 'create_tournament', tournament._id.toString(), title, { type, startDate, endDate, maxPlayers });

    console.log(`✅ Tournament created by ${req.user.discordName}: ${title}`);
    res.status(201).json({ message: 'Tournament created successfully!', tournament });
  } catch (error) {
    console.error('Create tournament error:', error);
    res.status(500).json({ message: 'Failed to create tournament' });
  }
});

router.put('/tournaments/:id', async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const {
      title,
      description,
      bannerImage,
      mapCode,
      mapName,
      rules,
      type,
      startDate,
      endDate,
      registrationDeadline,
      maxPlayers,
      minSkillRating,
      maxSkillRating,
      prize,
      status
    } = req.body;

    if (title) tournament.title = title;
    if (description) tournament.description = description;
    if (bannerImage !== undefined) tournament.bannerImage = bannerImage;
    if (mapCode) tournament.mapCode = mapCode;
    if (mapName !== undefined) tournament.mapName = mapName;
    if (rules) tournament.rules = rules;
    if (type) tournament.type = type;
    if (startDate) tournament.startDate = new Date(startDate);
    if (endDate) tournament.endDate = new Date(endDate);
    if (registrationDeadline) tournament.registrationDeadline = new Date(registrationDeadline);
    if (maxPlayers) tournament.maxPlayers = maxPlayers;
    if (minSkillRating !== undefined) tournament.minSkillRating = minSkillRating;
    if (maxSkillRating !== undefined) tournament.maxSkillRating = maxSkillRating;
    if (prize !== undefined) tournament.prize = prize;
    if (status) tournament.status = status;

    await tournament.save();

    await logAction(req, 'edit_tournament', tournament._id.toString(), tournament.title, { changes: Object.keys(req.body) });

    console.log(`✅ Tournament updated by ${req.user.discordName}: ${tournament.title}`);
    res.json({ message: 'Tournament updated successfully!', tournament });
  } catch (error) {
    console.error('Update tournament error:', error);
    res.status(500).json({ message: 'Failed to update tournament' });
  }
});

router.delete('/tournaments/:id', async (req, res) => {
  try {
    const tournament = await Tournament.findByIdAndDelete(req.params.id);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }
    await logAction(req, 'delete_tournament', tournament._id.toString(), tournament.title);

    console.log(`✅ Tournament deleted by ${req.user.discordName}: ${tournament.title}`);
    res.json({ message: 'Tournament deleted successfully!' });
  } catch (error) {
    console.error('Delete tournament error:', error);
    res.status(500).json({ message: 'Failed to delete tournament' });
  }
});

router.post('/tournaments/:id/activate', async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }
    tournament.status = 'active';
    await tournament.save();

    await logAction(req, 'edit_tournament', tournament._id.toString(), tournament.title, { statusChange: 'activated' });

    console.log(`✅ Tournament activated: ${tournament.title}`);
    res.json({ message: 'Tournament activated!', tournament });
  } catch (error) {
    console.error('Activate tournament error:', error);
    res.status(500).json({ message: 'Failed to activate tournament' });
  }
});

router.post('/tournaments/:id/complete', async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }
    tournament.status = 'completed';
    await tournament.save();

    await logAction(req, 'edit_tournament', tournament._id.toString(), tournament.title, { statusChange: 'completed' });

    console.log(`✅ Tournament completed: ${tournament.title}`);
    res.json({ message: 'Tournament completed!', tournament });
  } catch (error) {
    console.error('Complete tournament error:', error);
    res.status(500).json({ message: 'Failed to complete tournament' });
  }
});

router.post('/tournaments/:id/cancel', async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }
    tournament.status = 'cancelled';
    await tournament.save();

    await logAction(req, 'edit_tournament', tournament._id.toString(), tournament.title, { statusChange: 'cancelled' });

    console.log(`❌ Tournament cancelled: ${tournament.title}`);
    res.json({ message: 'Tournament cancelled!', tournament });
  } catch (error) {
    console.error('Cancel tournament error:', error);
    res.status(500).json({ message: 'Failed to cancel tournament' });
  }
});

// ============ IP ANALYSIS ============
router.get('/ip-analysis/users/:discordId', async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const RealIPChecker = require('../utils/ipChecker');
    const ipAnalysis = RealIPChecker.analyzeIPPatterns(user.ipAddresses);

    const detailedIPs = await Promise.all(
      user.ipAddresses.map(async (ipEntry) => {
        const info = await RealIPChecker.checkIP(ipEntry.ip);
        return {
          ...ipEntry.toObject(),
          analysis: info,
        };
      })
    );

    const relatedAccounts = await User.find({
      'ipAddresses.ip': { $in: user.ipAddresses.map(i => i.ip) },
      discordId: { $ne: user.discordId },
    }).select('discordName discordId ipAddresses anticheatScore isBanned');

    res.json({
      userId: user.discordId,
      userName: user.discordName,
      ipAnalysis,
      ipAddresses: detailedIPs,
      relatedAccounts,
    });
  } catch (error) {
    console.error('IP analysis error:', error);
    res.status(500).json({ message: 'Failed to analyze IPs' });
  }
});

router.get('/ip-analysis/violations', async (req, res) => {
  try {
    const RealIPChecker = require('../utils/ipChecker');
    const violations = await RealIPChecker.detectMultiaccountByIP(User);

    res.json({ violations });
  } catch (error) {
    console.error('Get violations error:', error);
    res.status(500).json({ message: 'Failed to get violations' });
  }
});

router.get('/ip-analysis/check/:ip', async (req, res) => {
  try {
    const RealIPChecker = require('../utils/ipChecker');
    const info = await RealIPChecker.checkIP(req.params.ip);
    res.json(info);
  } catch (error) {
    console.error('Check IP error:', error);
    res.status(500).json({ message: 'Failed to check IP' });
  }
});

router.post('/ip-analysis/flag-suspicious', async (req, res) => {
  try {
    const RealIPChecker = require('../utils/ipChecker');
    const flaggedUsers = await RealIPChecker.flagSuspiciousUsers(User);
    res.json({ message: `Flagged ${flaggedUsers.length} users`, users: flaggedUsers });
  } catch (error) {
    console.error('Flag suspicious error:', error);
    res.status(500).json({ message: 'Failed to flag suspicious users' });
  }
});

router.get('/ip-analysis/whitelist', async (req, res) => {
  try {
    const entries = await IPWhitelist.find().sort({ createdAt: -1 });
    res.json({ entries });
  } catch (error) {
    console.error('Get IP whitelist error:', error);
    res.status(500).json({ message: 'Failed to fetch IP whitelist' });
  }
});

router.post('/ip-analysis/whitelist', async (req, res) => {
  try {
    const { ip, note } = req.body;
    if (!ip || typeof ip !== 'string') {
      return res.status(400).json({ message: 'IP is required' });
    }

    const normalizedIP = ip.trim();
    const existing = await IPWhitelist.findOne({ ip: normalizedIP });
    if (existing) {
      return res.status(409).json({ message: 'IP is already whitelisted' });
    }

    const entry = await IPWhitelist.create({
      ip: normalizedIP,
      note: note || '',
      createdBy: req.user.discordId,
      createdByName: req.user.discordName,
    });

    await logAction(req, 'ip_whitelist_add', normalizedIP, normalizedIP, { note: note || '' });
    res.status(201).json({ message: 'IP added to whitelist', entry });
  } catch (error) {
    console.error('Add IP whitelist error:', error);
    res.status(500).json({ message: 'Failed to add IP to whitelist' });
  }
});

router.delete('/ip-analysis/whitelist/:id', async (req, res) => {
  try {
    const entry = await IPWhitelist.findByIdAndDelete(req.params.id);
    if (!entry) {
      return res.status(404).json({ message: 'Whitelist entry not found' });
    }

    await logAction(req, 'ip_whitelist_remove', entry.ip, entry.ip, { note: entry.note || '' });
    res.json({ message: 'IP removed from whitelist' });
  } catch (error) {
    console.error('Remove IP whitelist error:', error);
    res.status(500).json({ message: 'Failed to remove IP from whitelist' });
  }
});

// ============ ANNOUNCEMENTS (BROADCAST) ============
router.get('/announcements', async (req, res) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const announcements = await Announcement.find()
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit));
    const total = await Announcement.countDocuments();
    res.json({ announcements, total, page: parseInt(page) });
  } catch (error) {
    console.error('Get announcements error:', error);
    res.status(500).json({ message: 'Failed to fetch announcements' });
  }
});

router.post('/announcements', async (req, res) => {
  try {
    const { title, body, type, priority, expiresAt } = req.body;
    if (!title || !body) {
      return res.status(400).json({ message: 'Title and body are required' });
    }
    const announcement = await Announcement.create({
      title,
      body,
      type: type || 'info',
      priority: priority || 'normal',
      createdBy: { discordId: req.user.discordId, discordName: req.user.discordName },
      expiresAt: expiresAt ? new Date(expiresAt) : null,
    });
    res.status(201).json({ message: 'Announcement created', announcement });
  } catch (error) {
    console.error('Create announcement error:', error);
    res.status(500).json({ message: 'Failed to create announcement' });
  }
});

router.put('/announcements/:id', async (req, res) => {
  try {
    const announcement = await Announcement.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
    res.json({ message: 'Announcement updated', announcement });
  } catch (error) {
    console.error('Update announcement error:', error);
    res.status(500).json({ message: 'Failed to update announcement' });
  }
});

router.delete('/announcements/:id', async (req, res) => {
  try {
    const announcement = await Announcement.findByIdAndDelete(req.params.id);
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });
    res.json({ message: 'Announcement deleted' });
  } catch (error) {
    console.error('Delete announcement error:', error);
    res.status(500).json({ message: 'Failed to delete announcement' });
  }
});

// ============ DELETE MATCH ============
router.delete('/matches/:matchId', async (req, res) => {
  try {
    const match = await Match.findById(req.params.matchId).populate('player1 player2', 'discordName discordId');

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    const matchInfo = `${match.player1?.discordName || 'P1'} vs ${match.player2?.discordName || 'P2'}`;
    await logAction(req, 'delete_match', matchInfo, null, { matchId: match._id.toString() });

    await Match.findByIdAndDelete(req.params.matchId);

    res.json({ message: 'Match deleted successfully' });
  } catch (error) {
    console.error('Delete match error:', error);
    res.status(500).json({ message: 'Failed to delete match' });
  }
});

// ============ ADMIN LOGS ============
router.get('/logs', async (req, res) => {
  try {
    const { page = 1, limit = 100, action, adminId, targetId, startDate, endDate } = req.query;

    const query = {};
    if (action) query.action = action;
    if (adminId) query.adminId = adminId;
    if (targetId) query.targetId = targetId;
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    const [logs, total] = await Promise.all([
      AdminLog.find(query)
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit)),
      AdminLog.countDocuments(query),
    ]);

    res.json({
      logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Get admin logs error:', error);
    res.status(500).json({ message: 'Failed to fetch admin logs' });
  }
});

// ============ AUDIT LOG (alias for admin-logs) ============
router.get('/audit-log', async (req, res) => {
  try {
    const { page = 1, limit = 100, action, userId } = req.query;

    const query = {};
    if (action) query.action = action;
    if (userId) query.targetId = userId;

    const [logs, total] = await Promise.all([
      AdminLog.find(query)
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit)),
      AdminLog.countDocuments(query),
    ]);

    res.json({
      logs,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Get audit log error:', error);
    res.status(500).json({ message: 'Failed to fetch audit log' });
  }
});

// ============ DISPUTE REVIEW ============
router.get('/disputes', async (req, res) => {
  try {
    const { page = 1, limit = 50, status } = req.query;

    const query = { disputed: true };
    if (status === 'resolved') query['adminOverride'] = { $exists: true };
    if (status === 'pending') query['adminOverride'] = { $exists: false };

    const [matches, total] = await Promise.all([
      Match.find(query)
        .populate('player1 player2', 'discordName discordAvatar epicGamesName rankingPoints')
        .sort({ date: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit)),
      Match.countDocuments(query),
    ]);

    res.json({
      disputes: matches,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Get disputes error:', error);
    res.status(500).json({ message: 'Failed to fetch disputes' });
  }
});

router.get('/disputes/:matchId', async (req, res) => {
  try {
    const match = await Match.findById(req.params.matchId)
      .populate('player1 player2', 'discordName discordAvatar epicGamesName rankingPoints');

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    res.json(match);
  } catch (error) {
    console.error('Get dispute detail error:', error);
    res.status(500).json({ message: 'Failed to fetch dispute details' });
  }
});

router.post('/disputes/:matchId/resolve', async (req, res) => {
  try {
    const { winner, reason, action: resolution } = req.body;
    const match = await Match.findById(req.params.matchId).populate('player1 player2');

    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }

    match.result = winner;
    match.disputed = false;
    match.status = 'completed';
    match.adminOverride = {
      overriddenBy: req.user.discordId,
      overriddenAt: new Date(),
      reason: reason || 'Dispute resolved',
    };

    // Apply ranking points
    if (match.player1 && match.player2 && winner && winner !== 'draw') {
      const p1 = match.player1;
      const p2 = match.player2;
      const p1Points = p1.rankingPoints || 0;
      const p2Points = p2.rankingPoints || 0;

      if (winner === 'player1') {
        const pointsChange = calculatePointsChange(p1Points, p2Points);
        p1.rankingPoints += pointsChange.winPoints;
        p2.rankingPoints = Math.max(0, p2.rankingPoints - pointsChange.lossPoints);
        p1.wins = (p1.wins || 0) + 1;
        p2.losses = (p2.losses || 0) + 1;
      } else if (winner === 'player2') {
        const pointsChange = calculatePointsChange(p2Points, p1Points);
        p2.rankingPoints += pointsChange.winPoints;
        p1.rankingPoints = Math.max(0, p1.rankingPoints - pointsChange.lossPoints);
        p2.wins = (p2.wins || 0) + 1;
        p1.losses = (p1.losses || 0) + 1;
      }

      await p1.save();
      await p2.save();
    }

    await match.save();

    await logAction(req, 'dispute_resolve', `${match.player1?.discordName || 'P1'} vs ${match.player2?.discordName || 'P2'}`, null, {
      matchId: match._id.toString(),
      winner,
      reason,
      resolution,
    });

    res.json({ message: 'Dispute resolved with ranking points adjustment', match });
  } catch (error) {
    console.error('Resolve dispute error:', error);
    res.status(500).json({ message: 'Failed to resolve dispute' });
  }
});

module.exports = router;