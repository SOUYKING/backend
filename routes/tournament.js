const express = require('express');
const Tournament = require('../models/Tournament');
const Team = require('../models/Team');
const User = require('../models/User');
const authenticate = require('../middlewares/authenticate');
const router = express.Router();

async function pullTeamRosterLocksForTournament(tournamentId) {
  const tid = String(tournamentId);
  await Team.updateMany(
    { 'tournamentLocks.tournamentId': tid },
    { $pull: { tournamentLocks: { tournamentId: tid } } },
  );
}

const getTournamentLifecycle = (tournament) => {
  const now = new Date();
  const startDate = new Date(tournament.startDate);
  const endDate = new Date(tournament.endDate);

  // Queue is open from startDate to endDate - anyone can join
  const queueOpen = now >= startDate && now <= endDate;
  const queueStartsSoon = now < startDate;

  let lifecycleStage = 'waiting';
  if (now > endDate || tournament.status === 'completed' || tournament.status === 'cancelled') {
    lifecycleStage = tournament.status === 'cancelled' ? 'cancelled' : 'completed';
  } else if (queueOpen) {
    lifecycleStage = 'active';
  }

  return { lifecycleStage, queueOpen, queueStartsSoon };
};

// Get all tournaments
router.get('/', async (req, res) => {
  try {
    const tournaments = await Tournament.find().sort({ createdAt: -1 });
    const decorated = tournaments.map((tournament) => {
      const lifecycle = getTournamentLifecycle(tournament);
      return { ...tournament.toObject(), ...lifecycle };
    });
    res.json(decorated);
  } catch (error) {
    console.error('Error fetching tournaments:', error.message);
    res.status(500).json({ message: 'Failed to fetch tournaments' });
  }
});

// Get active tournaments
router.get('/active', async (req, res) => {
  try {
    const now = new Date();
    const activeTournaments = await Tournament.find({
      startDate: { $lte: now },
      endDate: { $gte: now },
      status: { $ne: 'cancelled' }
    }).sort({ startDate: 1 });
    const decorated = activeTournaments
      .map((tournament) => ({ ...tournament.toObject(), ...getTournamentLifecycle(tournament) }))
      .filter((t) => t.lifecycleStage === 'active');
    res.json(decorated);
  } catch (error) {
    console.error('Error fetching active tournaments:', error.message);
    res.status(500).json({ message: 'Failed to fetch active tournaments' });
  }
});

// Get tournaments registered by current user
router.get('/mine/registered', authenticate, async (req, res) => {
  try {
    const tournaments = await Tournament.find({
      'participants.userId': req.user.id,
    }).sort({ startDate: 1 });

    const decorated = tournaments.map((tournament) => {
      const lifecycle = getTournamentLifecycle(tournament);
      return { ...tournament.toObject(), ...lifecycle };
    });
    res.json(decorated);
  } catch (error) {
    console.error('Error fetching registered tournaments:', error.message);
    res.status(500).json({ message: 'Failed to fetch registered tournaments' });
  }
});

// Get tournament by ID
router.get('/:id', async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }
    res.json({ ...tournament.toObject(), ...getTournamentLifecycle(tournament) });
  } catch (error) {
    console.error('Error fetching tournament:', error.message);
    res.status(500).json({ message: 'Failed to fetch tournament' });
  }
});

// Create tournament
router.post('/', authenticate, async (req, res) => {
  console.log('Create tournament request received');
  console.log('User:', req.user);
  
  const isAuthorized = req.user.isAdmin === true || req.user.role === 'owner' || req.user.role === 'admin' || req.user.role === 'content_creator' || req.user.role === 'staff';
  
  if (!isAuthorized) {
    return res.status(403).json({ message: 'Only admins, staff, and content creators can create tournaments' });
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
    maxPlayers,
    minSkillRating,
    maxSkillRating,
    prize
  } = req.body;

  if (!title || !description || !mapCode || !rules || !startDate || !endDate) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    const parsedStartDate = new Date(startDate);
    const parsedEndDate = new Date(endDate);

    if (parsedStartDate >= parsedEndDate) {
      return res.status(400).json({ message: 'Start date must be before end date' });
    }

    const tournament = new Tournament({
      title,
      description,
      bannerImage: bannerImage || null,
      mapCode,
      mapName: mapName || null,
      rules,
      type: type || '1v1',
      startDate: parsedStartDate,
      endDate: parsedEndDate,
      maxPlayers: maxPlayers || 16,
      minSkillRating: minSkillRating || 0,
      maxSkillRating: maxSkillRating || 3000,
      prize: prize || null,
      hostedBy: {
        discordId: req.user.id,
        discordName: req.user.username,
      },
      status: 'registration',
      participants: [],
      matches: [],
      leaderboard: []
    });

    await tournament.save();
    console.log(`✅ Tournament created: ${title}`);
    res.status(201).json({ message: 'Tournament created successfully!', tournament });
  } catch (error) {
    console.error('Error creating tournament:', error.message);
    res.status(500).json({ message: 'Failed to create tournament' });
  }
});

// Edit tournament
router.put('/:id', authenticate, async (req, res) => {
  const isAuthorized = req.user.isAdmin === true || req.user.role === 'owner' || req.user.role === 'admin' || req.user.role === 'content_creator' || req.user.role === 'staff';
  
  if (!isAuthorized) {
    return res.status(403).json({ message: 'Only admins, staff, and content creators can edit tournaments' });
  }

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
    if (mapName) tournament.mapName = mapName;
    if (rules) tournament.rules = rules;
    if (type) tournament.type = type;
    if (startDate) tournament.startDate = new Date(startDate);
    if (endDate) tournament.endDate = new Date(endDate);
    if (new Date(tournament.startDate) >= new Date(tournament.endDate)) {
      return res.status(400).json({ message: 'Start date must be before end date' });
    }

    if (maxPlayers) tournament.maxPlayers = maxPlayers;
    if (minSkillRating !== undefined) tournament.minSkillRating = minSkillRating;
    if (maxSkillRating !== undefined) tournament.maxSkillRating = maxSkillRating;
    if (prize !== undefined) tournament.prize = prize;
    if (status) tournament.status = status;

    await tournament.save();
    if (status && ['completed', 'cancelled'].includes(tournament.status)) {
      await pullTeamRosterLocksForTournament(tournament._id);
    }
    console.log(`✅ Tournament updated: ${tournament.title}`);
    res.json({ message: 'Tournament updated successfully!', tournament });
  } catch (error) {
    console.error('Error updating tournament:', error.message);
    res.status(500).json({ message: 'Failed to update tournament' });
  }
});

// Delete tournament
router.delete('/:id', authenticate, async (req, res) => {
  const isAdmin = req.user.isAdmin === true || req.user.role === 'owner' || req.user.role === 'admin';
  
  if (!isAdmin) {
    return res.status(403).json({ message: 'Only admins can delete tournaments' });
  }

  try {
    const tournament = await Tournament.findByIdAndDelete(req.params.id);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }
    await pullTeamRosterLocksForTournament(req.params.id);
    console.log(`✅ Tournament deleted: ${tournament.title}`);
    res.json({ message: 'Tournament deleted successfully!' });
  } catch (error) {
    console.error('Error deleting tournament:', error.message);
    res.status(500).json({ message: 'Failed to delete tournament' });
  }
});

// Activate tournament
router.post('/:id/activate', authenticate, async (req, res) => {
  const isAuthorized = req.user.isAdmin === true || req.user.role === 'owner' || req.user.role === 'admin' || req.user.role === 'content_creator' || req.user.role === 'staff';
  
  if (!isAuthorized) {
    return res.status(403).json({ message: 'Only admins, staff, and content creators can activate tournaments' });
  }

  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    tournament.status = 'active';
    await tournament.save();
    console.log(`✅ Tournament activated: ${tournament.title}`);
    res.json({ message: 'Tournament activated successfully!', tournament });
  } catch (error) {
    console.error('Error activating tournament:', error.message);
    res.status(500).json({ message: 'Failed to activate tournament' });
  }
});

// Join tournament (pre-registration - now redirects to queue info)
router.post('/:id/join', authenticate, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const now = new Date();
    const startDate = new Date(tournament.startDate);
    const endDate = new Date(tournament.endDate);
    const END_GRACE_MS = 6 * 60 * 60 * 1000;

    if (tournament.status === 'cancelled') {
      return res.status(400).json({ message: 'Tournament is cancelled' });
    }

    if (now < startDate) {
      return res.status(400).json({ message: `Tournament queue opens at ${startDate.toLocaleString()}`, queueOpensAt: startDate });
    }
    if (now.getTime() > endDate.getTime() + END_GRACE_MS) {
      return res.status(400).json({ message: 'Tournament has ended' });
    }

    if (tournament.status !== 'active') {
      tournament.status = 'active';
    }

    const user = await User.findOne({ discordId: req.user.id });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    if (user.isBanned) {
      return res.status(403).json({ message: user.banReason || 'Your account is banned.' });
    }
    if (!user.epicVerified) {
      return res.status(403).json({ message: 'You must verify your Epic Games account to join tournaments' });
    }

    const alreadyRegistered = tournament.participants.some(p => p.userId === req.user.id);
    if (!alreadyRegistered) {
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
    } else if (tournament.isModified('status')) {
      await tournament.save();
    }

    console.log(`✅ ${req.user.username} joined tournament: ${tournament.title}`);
    res.json({ message: 'Joined tournament! Queue is open — go to the queue page to start matching.', tournament });
  } catch (error) {
    console.error('Error joining tournament:', error.message);
    res.status(500).json({ message: 'Failed to join tournament' });
  }
});

// Leave tournament registration before start
router.post('/:id/leave', authenticate, async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }

    const now = new Date();
    if (now >= new Date(tournament.startDate)) {
      return res.status(400).json({ message: 'Cannot leave after tournament has started' });
    }

    const wasRegistered = tournament.participants.some((p) => p.userId === req.user.id);
    if (!wasRegistered) {
      return res.status(400).json({ message: 'You are not registered for this tournament' });
    }

    tournament.participants = tournament.participants.filter((p) => p.userId !== req.user.id);
    tournament.leaderboard = tournament.leaderboard.filter((l) => l.userId !== req.user.id);
    await tournament.save();

    res.json({ message: 'You left the tournament registration successfully.' });
  } catch (error) {
    console.error('Error leaving tournament:', error.message);
    res.status(500).json({ message: 'Failed to leave tournament' });
  }
});

// Get tournament leaderboard
router.get('/:id/leaderboard', async (req, res) => {
  try {
    const tournament = await Tournament.findById(req.params.id);
    if (!tournament) {
      return res.status(404).json({ message: 'Tournament not found' });
    }
    const sortedLeaderboard = [...tournament.leaderboard].sort((a, b) => b.points - a.points);
    res.json(sortedLeaderboard);
  } catch (error) {
    console.error('Error fetching leaderboard:', error.message);
    res.status(500).json({ message: 'Failed to fetch leaderboard' });
  }
});

module.exports = router;