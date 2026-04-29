const express = require('express');
const authenticate = require('../middlewares/authenticate');
const Team = require('../models/Team');
const TeamInvite = require('../models/TeamInvite');
const User = require('../models/User');

const router = express.Router();

const TEAM_MODE_ENABLED = process.env.TEAM_MODE_ENABLED !== 'false';
const isTeamTesterRole = (role) => ['admin', 'owner', 'staff', 'content_creator'].includes((role || '').toLowerCase());

const requireTeamAccess = async (req, res, next) => {
  if (!TEAM_MODE_ENABLED) return res.status(403).json({ message: 'Team mode is disabled' });
  const user = await User.findOne({ discordId: req.user.id }).select('role');
  if (!user || !isTeamTesterRole(user.role)) {
    return res.status(403).json({ message: 'Team mode is currently admin-only' });
  }
  req.viewerRole = user.role;
  next();
};

router.use(authenticate, requireTeamAccess);

router.get('/search-users', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json([]);
    const users = await User.find({
      discordName: { $regex: q, $options: 'i' },
      discordId: { $ne: req.user.id },
      isBanned: { $ne: true },
    }).select('discordId discordName discordAvatar').limit(10);
    res.json(users);
  } catch (error) {
    console.error('Search users error:', error);
    res.status(500).json({ message: 'Failed to search users' });
  }
});

router.get('/mine', async (req, res) => {
  try {
    const size = Number(req.query.size || 0);
    const query = {
      isActive: true,
      $or: [{ captainDiscordId: req.user.id }, { 'members.discordId': req.user.id }],
    };
    if ([2, 3, 4].includes(size)) query.size = size;
    const teams = await Team.find(query).sort({ createdAt: -1 });
    res.json(teams);
  } catch (error) {
    console.error('Get my teams error:', error);
    res.status(500).json({ message: 'Failed to fetch teams' });
  }
});

router.post('/create', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const size = Number(req.body.size);
    if (!name || ![2, 3, 4].includes(size)) {
      return res.status(400).json({ message: 'Valid team name and size (2/3/4) are required' });
    }

    const creator = await User.findOne({ discordId: req.user.id }).select('discordName');
    if (!creator) return res.status(404).json({ message: 'User not found' });

    const team = await Team.create({
      name,
      size,
      captainDiscordId: req.user.id,
      captainDiscordName: creator.discordName || req.user.username || 'Captain',
      members: [{
        discordId: req.user.id,
        discordName: creator.discordName || req.user.username || 'Captain',
        status: 'accepted',
      }],
    });
    res.status(201).json(team);
  } catch (error) {
    console.error('Create team error:', error);
    res.status(500).json({ message: 'Failed to create team' });
  }
});

router.get('/invites', async (req, res) => {
  try {
    const invites = await TeamInvite.find({ toDiscordId: req.user.id, status: 'pending' })
      .populate('teamId')
      .sort({ createdAt: -1 });
    res.json(invites);
  } catch (error) {
    console.error('Get invites error:', error);
    res.status(500).json({ message: 'Failed to fetch invites' });
  }
});

router.post('/:teamId/invite', async (req, res) => {
  try {
    const { teamId } = req.params;
    const { targetDiscordId } = req.body;
    if (!targetDiscordId) return res.status(400).json({ message: 'targetDiscordId is required' });

    const team = await Team.findById(teamId);
    if (!team || !team.isActive) return res.status(404).json({ message: 'Team not found' });
    if (team.captainDiscordId !== req.user.id) return res.status(403).json({ message: 'Only captain can invite players' });
    if ((team.tournamentLocks || []).length > 0) return res.status(400).json({ message: 'Team is locked in a tournament' });

    const targetUser = await User.findOne({ discordId: targetDiscordId }).select('discordId discordName isBanned');
    if (!targetUser || targetUser.isBanned) return res.status(404).json({ message: 'Target user not available' });
    if (team.members.some((m) => m.discordId === targetDiscordId)) return res.status(400).json({ message: 'User already in team' });
    if (team.members.length >= team.size) return res.status(400).json({ message: 'Team is full' });

    const pendingInvite = await TeamInvite.findOne({
      teamId: team._id,
      toDiscordId: targetDiscordId,
      status: 'pending',
    });
    if (pendingInvite) return res.status(400).json({ message: 'Invite already pending for this user' });

    const invite = await TeamInvite.create({
      teamId: team._id,
      fromDiscordId: req.user.id,
      fromDiscordName: req.user.username || team.captainDiscordName,
      toDiscordId: targetUser.discordId,
      toDiscordName: targetUser.discordName,
    });

    res.status(201).json(invite);
  } catch (error) {
    console.error('Invite member error:', error);
    res.status(500).json({ message: 'Failed to send invite' });
  }
});

router.post('/invites/:inviteId/respond', async (req, res) => {
  try {
    const { inviteId } = req.params;
    const action = (req.body.action || '').toLowerCase();
    if (!['accept', 'decline'].includes(action)) {
      return res.status(400).json({ message: 'action must be accept or decline' });
    }

    const invite = await TeamInvite.findById(inviteId);
    if (!invite || invite.status !== 'pending') return res.status(404).json({ message: 'Invite not found' });
    if (invite.toDiscordId !== req.user.id) return res.status(403).json({ message: 'Not allowed' });

    if (action === 'decline') {
      invite.status = 'declined';
      invite.respondedAt = new Date();
      await invite.save();
      return res.json({ message: 'Invite declined' });
    }

    const team = await Team.findById(invite.teamId);
    if (!team || !team.isActive) return res.status(404).json({ message: 'Team no longer available' });
    if ((team.tournamentLocks || []).length > 0) return res.status(400).json({ message: 'Team is locked in a tournament' });
    if (team.members.some((m) => m.discordId === req.user.id)) return res.status(400).json({ message: 'Already in team' });
    if (team.members.length >= team.size) return res.status(400).json({ message: 'Team is already full' });

    const me = await User.findOne({ discordId: req.user.id }).select('discordName');
    team.members.push({
      discordId: req.user.id,
      discordName: me?.discordName || req.user.username || 'Player',
      status: 'accepted',
      invitedBy: invite.fromDiscordId,
    });
    await team.save();

    invite.status = 'accepted';
    invite.respondedAt = new Date();
    await invite.save();

    res.json({ message: 'Invite accepted', team });
  } catch (error) {
    console.error('Respond invite error:', error);
    res.status(500).json({ message: 'Failed to respond to invite' });
  }
});

module.exports = router;
