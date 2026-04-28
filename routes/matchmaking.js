const express = require('express');
const User = require('../models/User');
const Tournament = require('../models/Tournament');
const authenticate = require('../middlewares/authenticate');
const GameEngine = require('../core/GameEngine');
const router = express.Router();

router.post('/join', authenticate, async (req, res) => {
  const { tournamentId, epicName } = req.body;
  if (!tournamentId) return res.status(400).json({ message: 'Tournament ID is required' });

  try {
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found' });

    const now = new Date();
    const startDate = new Date(tournament.startDate);
    const endDate = new Date(tournament.endDate);

    // Check if queue is open (between startDate and endDate)
    if (now < startDate) return res.status(400).json({ message: `Tournament queue starts at ${startDate.toLocaleTimeString()}` });
    if (now > endDate) return res.status(400).json({ message: 'Tournament has ended' });

    const user = await User.findOne({ discordId: req.user.id });
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.isBanned) return res.status(403).json({ message: user.banReason || 'Your account is banned.' });
    if (!user.epicVerified) return res.status(403).json({ message: 'You must verify your Epic Games account to play' });

    // Auto-add to participants if not already registered
    let isRegistered = tournament.participants.some(p => p.userId === req.user.id);
    if (!isRegistered) {
      tournament.participants.push({
        userId: req.user.id,
        discordName: req.user.username,
        rankingPoints: user.rankingPoints,
        epicName: user.epicGamesName,
        registeredAt: new Date(),
      });
      tournament.leaderboard.push({
        userId: req.user.id,
        discordId: req.user.id,
        discordName: req.user.username,
        discordAvatar: user.discordAvatar || null,
        wins: 0,
        losses: 0,
        points: 0,
      });
      await tournament.save();
    }

    const player = {
      userId: req.user.id,
      username: req.user.username,
      rankingPoints: user.rankingPoints,
      epicName: epicName || user.epicGamesName,
      tournamentId,
      socketId: null,
    };

    const result = await GameEngine.joinQueue(player);
    if (!result.success) return res.status(400).json({ message: result.reason });

    console.log(`✅ ${req.user.username} joined matchmaking queue for tournament: ${tournament.title}`);
    res.json({ message: 'Joined matchmaking queue', queueSize: GameEngine.getQueueSize(tournamentId) });
  } catch (error) {
    console.error('Error joining matchmaking:', error);
    res.status(500).json({ message: 'Failed to join matchmaking' });
  }
});

router.post('/leave', authenticate, async (req, res) => {
  try {
    GameEngine.leaveQueue(req.user.id);
    console.log(`❌ ${req.user.username} left matchmaking queue`);
    res.json({ message: 'Left matchmaking queue' });
  } catch (error) {
    console.error('Error leaving matchmaking:', error);
    res.status(500).json({ message: 'Failed to leave matchmaking' });
  }
});

router.get('/status', authenticate, async (req, res) => {
  try {
    res.json({ queueSize: GameEngine.getQueueSize() });
  } catch (error) {
    console.error('Error getting queue status:', error);
    res.status(500).json({ message: 'Failed to get queue status' });
  }
});

module.exports = router;
