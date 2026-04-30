const express = require('express');
const User = require('../models/User');
const Match = require('../models/Match');
const authenticate = require('../middlewares/authenticate');
const { getRank } = require('../utils/rankSystem');
const router = express.Router();
const MIN_RANKED_MATCHES = 5;

function toWinRate(wins = 0, totalMatches = 0) {
  if (!totalMatches) return 0;
  return Number(((wins / totalMatches) * 100).toFixed(2));
}

function compareGlobalLeaderboard(a, b) {
  // Ranked players first; provisional players (few matches) go below.
  if (a.isProvisional !== b.isProvisional) {
    return a.isProvisional ? 1 : -1;
  }

  if (!a.isProvisional) {
    if ((b.points || 0) !== (a.points || 0)) return (b.points || 0) - (a.points || 0);
    if ((b.winRate || 0) !== (a.winRate || 0)) return (b.winRate || 0) - (a.winRate || 0);
    if ((b.wins || 0) !== (a.wins || 0)) return (b.wins || 0) - (a.wins || 0);
    if ((b.totalMatches || 0) !== (a.totalMatches || 0)) return (b.totalMatches || 0) - (a.totalMatches || 0);
  } else {
    if ((b.totalMatches || 0) !== (a.totalMatches || 0)) return (b.totalMatches || 0) - (a.totalMatches || 0);
    if ((b.points || 0) !== (a.points || 0)) return (b.points || 0) - (a.points || 0);
    if ((b.wins || 0) !== (a.wins || 0)) return (b.wins || 0) - (a.wins || 0);
  }

  return String(a.discordName || '').localeCompare(String(b.discordName || ''));
}

// Get user account info
router.get('/', authenticate, async (req, res) => {
  try {
    let user = await User.findOne({ discordId: req.user.discordId });

    // If user doesn't exist, create a new record
    if (!user) {
      user = await User.create({
        discordId: req.user.discordId,
        discordName: req.user.discordName,
        discordAvatar: req.user.avatar || null,
        epicGamesName: null,
        epicGamesId: null,
        epicVerified: false,
        wins: 0,
        losses: 0,
        draws: 0,
        totalMatches: 0,
        role: req.user.role || 'player',
      });
      console.log(`✅ New user created via account route: ${req.user.discordName}`);
    }

    res.json({
      discordId: user.discordId,
      discordName: user.discordName,
      discordAvatar: user.discordAvatar,
      rankingPoints: user.rankingPoints || 0,
      epicGamesName: user.epicGamesName || 'Not Set',
      epicVerified: user.epicVerified || false,
      wins: user.wins || 0,
      losses: user.losses || 0,
      draws: user.draws || 0,
      totalMatches: user.totalMatches || 0,
      role: user.role || 'player',
      isAdmin: req.user.isAdmin || false,
      isOwner: user.isOwner || false,
      isBanned: user.isBanned || false,
      banReason: user.banReason || null,
      anticheatScore: user.anticheatScore ?? 100,
      trustScore: user.trustScore ?? 100,
      strikes: user.strikes || 0,
      warnings: user.getActiveWarnings ? user.getActiveWarnings() : [],
      rank: getRank(user.rankingPoints || 0).name,
      rankIcon: getRank(user.rankingPoints || 0).icon,
      rankColor: getRank(user.rankingPoints || 0).color,
      tournamentHistory: user.tournamentHistory || [],
      tournamentWins: user.tournamentWins || [],
    });
  } catch (error) {
    console.error('Error fetching user account:', error.message);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Get profile detail with recent match/tournament history
router.get('/profile', authenticate, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.user.discordId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const recentMatches = await Match.find({
      $or: [{ player1: user._id }, { player2: user._id }],
    }).populate('player1 player2').sort({ date: -1 }).limit(10);

    const formattedRecentMatches = recentMatches.map((match) => {
      const isPlayer1 = String(match.player1?._id) === String(user._id);
      const opponent = isPlayer1 ? match.player2 : match.player1;
      const myVote = match.reports?.[user.discordId]?.winnerDiscordId || null;
      return {
        id: match._id,
        date: match.date,
        tournamentId: match.tournamentId,
        opponent: opponent?.discordName || 'Unknown',
        status: match.status || 'completed',
        result: match.result,
        disputed: !!match.disputed,
        myVote,
      };
    });

    res.json({
      discordId: user.discordId,
      discordName: user.discordName,
      discordAvatar: user.discordAvatar,
      rankingPoints: user.rankingPoints || 0,
      role: user.role,
      isOwner: user.isOwner || false,
      isBanned: user.isBanned || false,
      banReason: user.banReason || null,
      epicGamesName: user.epicGamesName,
      epicVerified: user.epicVerified,
      wins: user.wins,
      losses: user.losses,
      totalMatches: user.totalMatches,
      anticheatScore: user.anticheatScore ?? 100,
      trustScore: user.trustScore ?? 100,
      strikes: user.strikes || 0,
      warnings: user.getActiveWarnings ? user.getActiveWarnings() : [],
      rank: getRank(user.rankingPoints || 0).name,
      rankIcon: getRank(user.rankingPoints || 0).icon,
      rankColor: getRank(user.rankingPoints || 0).color,
      tournamentHistory: user.tournamentHistory || [],
      tournamentWins: user.tournamentWins || [],
      recentMatches: formattedRecentMatches,
    });
  } catch (error) {
    console.error('Error fetching profile:', error.message);
    res.status(500).json({ message: 'Failed to fetch profile' });
  }
});

// Global leaderboard
router.get('/leaderboard/global', async (req, res) => {
  try {
    const users = await User.find({ isBanned: { $ne: true } })
      .select('discordId discordName discordAvatar wins losses totalMatches rankingPoints role');
    const enriched = users.map(u => {
      const wins = u.wins || 0;
      const losses = u.losses || 0;
      const totalMatches = u.totalMatches || (wins + losses);
      const points = u.rankingPoints || 0;
      const isProvisional = totalMatches < MIN_RANKED_MATCHES;
      return {
      userId: u.discordId,
      discordId: u.discordId,
      discordName: u.discordName,
      discordAvatar: u.discordAvatar,
      wins,
      losses,
      totalMatches,
      winRate: toWinRate(wins, totalMatches),
      points,
      isProvisional,
      leaderboardTier: isProvisional ? 'provisional' : 'ranked',
      role: u.role,
      rank: getRank(points).name,
      rankIcon: getRank(points).icon,
      rankColor: getRank(points).color,
      minRankedMatches: MIN_RANKED_MATCHES,
    };
    });
    enriched.sort(compareGlobalLeaderboard);
    res.json(enriched.slice(0, 100));
  } catch (error) {
    console.error('Error fetching global leaderboard:', error.message);
    res.status(500).json({ message: 'Failed to fetch global leaderboard' });
  }
});

// Owner/Admin tools - ban/unban user
router.post('/admin/ban', authenticate, async (req, res) => {
  const canBan = req.user.isOwner || req.user.role === 'owner' || req.user.role === 'admin';
  if (!canBan) {
    return res.status(403).json({ message: 'Only owner/admin can ban users' });
  }

  const { discordId, reason } = req.body;
  if (!discordId) {
    return res.status(400).json({ message: 'discordId is required' });
  }

  try {
    const user = await User.findOne({ discordId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    user.isBanned = true;
    user.banReason = reason || 'Banned by staff';
    user.bannedAt = new Date();
    await user.save();
    res.json({ message: 'User banned successfully' });
  } catch (error) {
    console.error('Error banning user:', error.message);
    res.status(500).json({ message: 'Failed to ban user' });
  }
});

router.post('/admin/unban', authenticate, async (req, res) => {
  const canBan = req.user.isOwner || req.user.role === 'owner' || req.user.role === 'admin';
  if (!canBan) {
    return res.status(403).json({ message: 'Only owner/admin can unban users' });
  }

  const { discordId } = req.body;
  if (!discordId) {
    return res.status(400).json({ message: 'discordId is required' });
  }

  try {
    const user = await User.findOne({ discordId });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    user.isBanned = false;
    user.banReason = null;
    user.bannedAt = null;
    await user.save();
    res.json({ message: 'User unbanned successfully' });
  } catch (error) {
    console.error('Error unbanning user:', error.message);
    res.status(500).json({ message: 'Failed to unban user' });
  }
});

// Update Epic Games Name
router.post('/update', authenticate, async (req, res) => {
  const epicGamesName = (req.body?.epicGamesName || '').trim();

  if (!epicGamesName) {
    return res.status(400).json({ message: 'Epic Games Name is required' });
  }

  try {
    const user = await User.findOne({ discordId: req.user.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if the user updated their Epic Games name within the past week
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    if (user.lastEpicUpdate && user.lastEpicUpdate > oneWeekAgo) {
      const timeRemaining = Math.ceil(
        (user.lastEpicUpdate.getTime() + 7 * 24 * 60 * 60 * 1000 - now.getTime()) / (24 * 60 * 60 * 1000)
      );
      return res.status(403).json({
        message: `You can only change your Epic Games name once every 7 days. Try again in ${timeRemaining} day(s).`,
      });
    }

    const existingByName = await User.findOne({ epicGamesName });
    if (existingByName && existingByName.discordId !== req.user.discordId) {
      return res.status(409).json({
        message: 'This Epic Games display name is already linked to another user.'
      });
    }

    // Update Epic Games Name and lastEpicUpdate timestamp
    user.epicGamesName = epicGamesName;
    user.lastEpicUpdate = now;
    await user.save();

    res.json({ 
      message: 'Epic Games Name updated successfully!',
      epicGamesName: epicGamesName,
      epicVerified: !!user.epicVerified,
    });
  } catch (error) {
    console.error('Error updating Epic Games Name:', error.message);
    res.status(500).json({ message: 'Failed to update Epic Games Name' });
  }
});

// Update full Epic verification (ID + Name)
router.post('/verify', authenticate, async (req, res) => {
  const { epicGamesId, epicGamesName } = req.body;

  if (!epicGamesId || !epicGamesName) {
    return res.status(400).json({ message: 'Epic Games ID and Name are required' });
  }

  try {
    const user = await User.findOne({ discordId: req.user.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check 7-day cooldown
    const now = new Date();
    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    if (user.lastEpicUpdate && user.lastEpicUpdate > oneWeekAgo) {
      const timeRemaining = Math.ceil(
        (user.lastEpicUpdate.getTime() + 7 * 24 * 60 * 60 * 1000 - now.getTime()) / (24 * 60 * 60 * 1000)
      );
      return res.status(403).json({
        message: `You can only verify/change your Epic account once every 7 days. Try again in ${timeRemaining} day(s).`,
      });
    }

    // Check if Epic ID is already used by another user
    const existingUser = await User.findOne({ epicGamesId: epicGamesId });
    if (existingUser && existingUser.discordId !== req.user.discordId) {
      return res.status(409).json({ 
        message: 'This Epic Games account is already linked to another user. Please contact staff if this is an error.' 
      });
    }

    // Update user
    user.epicGamesId = epicGamesId;
    user.epicGamesName = epicGamesName;
    user.epicVerified = true;
    user.lastEpicUpdate = now;
    await user.save();

    console.log(`✅ Epic account verified for ${user.discordName}: ${epicGamesName} (${epicGamesId})`);

    res.json({ 
      message: 'Epic Games account verified successfully!',
      epicGamesName: epicGamesName,
      epicVerified: true
    });
  } catch (error) {
    console.error('Error verifying Epic account:', error.message);
    res.status(500).json({ message: 'Failed to verify Epic Games account' });
  }
});

// Get user statistics
router.get('/stats', authenticate, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.user.discordId });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const winRate = user.totalMatches > 0 
      ? ((user.wins / user.totalMatches) * 100).toFixed(1) 
      : 0;

    const rank = getRank(user.rankingPoints || 0);

    res.json({
      wins: user.wins,
      losses: user.losses,
      draws: user.draws,
      totalMatches: user.totalMatches,
      winRate: winRate,
      rank: rank.name,
      rankIcon: rank.icon,
      rankColor: rank.color,
      discordAvatar: user.discordAvatar,
      discordId: user.discordId,
      discordName: user.discordName,
      epicVerified: user.epicVerified,
      epicGamesName: user.epicGamesName,
      role: user.role,
    });
  } catch (error) {
    console.error('Error fetching user stats:', error.message);
    res.status(500).json({ message: 'Failed to fetch user statistics' });
  }
});

// Get public player stats for in-match profile cards
router.get('/public/:discordId', authenticate, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.params.discordId }).select(
      'discordId discordName discordAvatar epicGamesName wins losses totalMatches rankingPoints role'
    );

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const points = user.rankingPoints || 0;
    const rank = getRank(points);
    const totalMatches = user.totalMatches || 0;
    const wins = user.wins || 0;
    const losses = user.losses || 0;
    const winRate = totalMatches > 0 ? Number(((wins / totalMatches) * 100).toFixed(1)) : 0;

    res.json({
      discordId: user.discordId,
      discordName: user.discordName,
      discordAvatar: user.discordAvatar,
      epicGamesName: user.epicGamesName || null,
      role: user.role || 'player',
      wins,
      losses,
      totalMatches,
      winRate,
      rankingPoints: points,
      rank: rank.name,
      rankIcon: rank.icon,
      rankColor: rank.color,
    });
  } catch (error) {
    console.error('Error fetching public player stats:', error.message);
    res.status(500).json({ message: 'Failed to fetch player statistics' });
  }
});

module.exports = router;