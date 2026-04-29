const express = require('express');
const User = require('../models/User');
const Tournament = require('../models/Tournament');
const Team = require('../models/Team');
const authenticate = require('../middlewares/authenticate');
const GameEngine = require('../core/GameEngine');
const router = express.Router();

router.post('/join', authenticate, async (req, res) => {
  const { tournamentId, epicName, teamId } = req.body;
  if (!tournamentId) return res.status(400).json({ message: 'Tournament ID is required' });

  try {
    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) return res.status(404).json({ message: 'Tournament not found' });

    const now = new Date();
    const startDate = new Date(tournament.startDate);
    const endDate = new Date(tournament.endDate);

    // Check if queue is open (between startDate and endDate), with small grace for timezone drift
    const END_GRACE_MS = 6 * 60 * 60 * 1000;
    if (tournament.status === 'cancelled') return res.status(400).json({ message: 'Tournament is cancelled' });
    if (now < startDate) return res.status(400).json({ message: `Tournament queue starts at ${startDate.toLocaleTimeString()}` });
    if (now.getTime() > endDate.getTime() + END_GRACE_MS) return res.status(400).json({ message: 'Tournament has ended' });

    if (tournament.status !== 'active') {
      tournament.status = 'active';
      await tournament.save();
    }

    const user = await User.findOne({ discordId: req.user.id });
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.isBanned) return res.status(403).json({ message: user.banReason || 'Your account is banned.' });
    if (!user.epicVerified) return res.status(403).json({ message: 'You must verify your Epic Games account to play' });

    const requiredTeamSize = tournament.type === '2v2' ? 2 : tournament.type === '3v3' ? 3 : tournament.type === '4v4' ? 4 : 1;
    let player;
    if (requiredTeamSize === 1) {
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

      player = {
        userId: req.user.id,
        username: req.user.username,
        rankingPoints: user.rankingPoints,
        epicName: epicName || user.epicGamesName,
        tournamentId,
        socketId: null,
      };
    } else {
      if (!teamId) return res.status(400).json({ message: `This is a ${tournament.type} tournament. Select a team first.` });
      const team = await Team.findById(teamId);
      if (!team || !team.isActive) return res.status(404).json({ message: 'Team not found' });
      if (team.size !== requiredTeamSize) return res.status(400).json({ message: `Team must be ${requiredTeamSize} players for this tournament` });
      if (team.captainDiscordId !== req.user.id) return res.status(403).json({ message: 'Only team captain can join queue' });

      const acceptedMembers = (team.members || []).filter((m) => m.status === 'accepted');
      if (acceptedMembers.length !== requiredTeamSize) {
        return res.status(400).json({ message: `Team must have exactly ${requiredTeamSize} accepted members` });
      }

      const memberIds = acceptedMembers.map((m) => m.discordId);
      const memberUsers = await User.find({ discordId: { $in: memberIds } }).select('discordId discordName discordAvatar rankingPoints epicGamesName isBanned');
      if (memberUsers.length !== requiredTeamSize) return res.status(400).json({ message: 'Some team members are missing profiles' });
      if (memberUsers.some((m) => m.isBanned)) return res.status(403).json({ message: 'A team member is banned' });

      const teamIdStr = String(team._id);
      const teamNameStr = team.name;

      for (const member of memberUsers) {
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
      await tournament.save();

      const avgRp = Math.round(memberUsers.reduce((sum, m) => sum + (m.rankingPoints || 0), 0) / requiredTeamSize);
      player = {
        userId: `team:${team._id}`,
        username: team.name,
        rankingPoints: avgRp,
        epicName: team.name,
        tournamentId,
        socketId: null,
        teamMode: true,
        teamId: String(team._id),
        teamName: team.name,
        teamSize: requiredTeamSize,
        teamMemberIds: memberIds,
        captainId: team.captainDiscordId,
      };
    }

    const result = await GameEngine.joinQueue(player);
    if (!result.success) {
      return res.status(400).json({ message: result.reason });
    }

    if (requiredTeamSize > 1 && teamId) {
      const lockTeam = await Team.findById(teamId);
      if (lockTeam) {
        const tid = String(tournament._id);
        const alreadyLocked = (lockTeam.tournamentLocks || []).some((lock) => String(lock.tournamentId) === tid);
        if (!alreadyLocked) {
          lockTeam.tournamentLocks.push({ tournamentId: tid, lockedAt: new Date() });
          await lockTeam.save();
        }
      }
    }

    console.log(`✅ ${req.user.username} joined matchmaking queue for tournament: ${tournament.title}`);
    res.json({ message: 'Joined matchmaking queue', queueSize: GameEngine.getQueueSize(tournamentId) });
  } catch (error) {
    console.error('Error joining matchmaking:', error);
    res.status(500).json({ message: 'Failed to join matchmaking' });
  }
});

router.post('/leave', authenticate, async (req, res) => {
  try {
    await GameEngine.leaveQueue(req.user.id);
    console.log(`❌ ${req.user.username} left matchmaking queue`);
    res.json({ message: 'Left matchmaking queue' });
  } catch (error) {
    console.error('Error leaving matchmaking:', error);
    res.status(500).json({ message: 'Failed to leave matchmaking' });
  }
});

router.get('/status', authenticate, async (req, res) => {
  try {
    const tournamentId = req.query.tournamentId || null;
    res.json({ queueSize: GameEngine.getQueueSize(tournamentId) });
  } catch (error) {
    console.error('Error getting queue status:', error);
    res.status(500).json({ message: 'Failed to get queue status' });
  }
});

module.exports = router;
