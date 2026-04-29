const express = require('express');
const authenticate = require('../middlewares/authenticate');
const GameEngine = require('../core/GameEngine');
const Team = require('../models/Team');
const TeamInvite = require('../models/TeamInvite');
const User = require('../models/User');

const router = express.Router();

/** DB locks can linger after queue leave, match end, server restart, or deleted tournaments — clear if not live. */
async function clearStaleTournamentLocks(team) {
  if (!team?.tournamentLocks?.length) return;
  if (!GameEngine.isTeamInLiveQueueOrMatch(String(team._id))) {
    team.tournamentLocks = [];
    await team.save();
  }
}

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
    for (const t of teams) {
      await clearStaleTournamentLocks(t);
    }
    res.json(teams);
  } catch (error) {
    console.error('Get my teams error:', error);
    res.status(500).json({ message: 'Failed to fetch teams' });
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

router.post('/create', async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    const size = Number(req.body.size);
    const memberDiscordIds = Array.isArray(req.body.memberDiscordIds) ? req.body.memberDiscordIds : [];
    if (!name || ![2, 3, 4].includes(size)) {
      return res.status(400).json({ message: 'Valid team name and size (2/3/4) are required' });
    }
    if (memberDiscordIds.length > size - 1) {
      return res.status(400).json({ message: `You can select up to ${size - 1} teammates` });
    }

    const normalizedMemberIds = [...new Set(memberDiscordIds.filter((id) => id && id !== req.user.id))];

    const creator = await User.findOne({ discordId: req.user.id }).select('discordName');
    if (!creator) return res.status(404).json({ message: 'User not found' });

    const existingTeam = await Team.findOne({
      isActive: true,
      name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
    });
    if (existingTeam) {
      return res.status(400).json({ message: 'Team name already exists' });
    }

    const invitedUsers = normalizedMemberIds.length
      ? await User.find({
          discordId: { $in: normalizedMemberIds },
          isBanned: { $ne: true },
        }).select('discordId discordName')
      : [];

    if (invitedUsers.length !== normalizedMemberIds.length) {
      return res.status(400).json({ message: 'One or more selected users are invalid or banned' });
    }

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

    if (invitedUsers.length > 0) {
      const pendingMembers = invitedUsers.map((u) => ({
        discordId: u.discordId,
        discordName: u.discordName,
        status: 'pending',
        invitedBy: req.user.id,
      }));
      team.members.push(...pendingMembers);
      await team.save();

      await TeamInvite.insertMany(invitedUsers.map((u) => ({
        teamId: team._id,
        fromDiscordId: req.user.id,
        fromDiscordName: creator.discordName || req.user.username || 'Captain',
        toDiscordId: u.discordId,
        toDiscordName: u.discordName,
        status: 'pending',
      })));
    }

    res.status(201).json(team);
  } catch (error) {
    console.error('Create team error:', error);
    res.status(500).json({ message: 'Failed to create team' });
  }
});

router.get('/:teamId/detail', async (req, res) => {
  try {
    const team = await Team.findById(req.params.teamId);
    if (!team || !team.isActive) return res.status(404).json({ message: 'Team not found' });

    const isMember = (team.members || []).some((m) => m.discordId === req.user.id);
    const isCaptain = team.captainDiscordId === req.user.id;
    if (!isMember && !isCaptain) {
      return res.status(403).json({ message: 'Not a member of this team' });
    }

    const ids = [...new Set((team.members || []).map((m) => m.discordId))];
    const users = await User.find({ discordId: { $in: ids } }).select('discordId discordName discordAvatar');
    const userMap = Object.fromEntries(users.map((u) => [u.discordId, u]));

    const roster = (team.members || []).map((m) => ({
      discordId: m.discordId,
      discordName: m.discordName,
      status: m.status,
      isCaptain: m.discordId === team.captainDiscordId,
      discordAvatar: userMap[m.discordId]?.discordAvatar || null,
    }));

    const accepted = roster.filter((m) => m.status === 'accepted');
    const pending = roster.filter((m) => m.status === 'pending');
    const readyForQueue = accepted.length === team.size;

    res.json({
      team: {
        _id: team._id,
        name: team.name,
        size: team.size,
        captainDiscordId: team.captainDiscordId,
        captainDiscordName: team.captainDiscordName,
        statsWins: team.statsWins ?? 0,
        statsLosses: team.statsLosses ?? 0,
        tournamentLocks: team.tournamentLocks || [],
        createdAt: team.createdAt,
      },
      roster,
      viewer: { isCaptain, discordId: req.user.id },
      meta: {
        acceptedCount: accepted.length,
        pendingCount: pending.length,
        readyForQueue,
      },
    });
  } catch (error) {
    console.error('Team detail error:', error);
    res.status(500).json({ message: 'Failed to load team' });
  }
});

router.post('/:teamId/leave', async (req, res) => {
  try {
    const team = await Team.findById(req.params.teamId);
    if (!team || !team.isActive) return res.status(404).json({ message: 'Team not found' });
    await clearStaleTournamentLocks(team);
    if (team.captainDiscordId === req.user.id) {
      return res.status(400).json({ message: 'Captain cannot leave this way — delete the team instead.' });
    }
    if ((team.tournamentLocks || []).length > 0) {
      return res.status(400).json({ message: 'Team is locked in a tournament' });
    }
    const before = (team.members || []).length;
    team.members = (team.members || []).filter((m) => m.discordId !== req.user.id);
    if (team.members.length === before) return res.status(404).json({ message: 'You are not on this team' });
    await team.save();
    await TeamInvite.updateMany(
      { teamId: team._id, toDiscordId: req.user.id, status: 'pending' },
      { $set: { status: 'cancelled', respondedAt: new Date() } },
    );
    res.json({ message: 'You left the team' });
  } catch (error) {
    console.error('Leave team error:', error);
    res.status(500).json({ message: 'Failed to leave team' });
  }
});

router.delete('/:teamId/members/:memberDiscordId', async (req, res) => {
  try {
    const { teamId, memberDiscordId } = req.params;
    const team = await Team.findById(teamId);
    if (!team || !team.isActive) return res.status(404).json({ message: 'Team not found' });
    await clearStaleTournamentLocks(team);
    if (team.captainDiscordId !== req.user.id) return res.status(403).json({ message: 'Only captain can remove members' });
    if (memberDiscordId === team.captainDiscordId) return res.status(400).json({ message: 'Cannot remove captain' });
    if ((team.tournamentLocks || []).length > 0) return res.status(400).json({ message: 'Team is locked in a tournament' });

    const exists = (team.members || []).some((m) => m.discordId === memberDiscordId);
    if (!exists) return res.status(404).json({ message: 'Member not found' });

    team.members = (team.members || []).filter((m) => m.discordId !== memberDiscordId);
    await team.save();
    await TeamInvite.updateMany(
      { teamId: team._id, toDiscordId: memberDiscordId, status: 'pending' },
      { $set: { status: 'cancelled', respondedAt: new Date() } },
    );
    res.json({ message: 'Member removed' });
  } catch (error) {
    console.error('Remove member error:', error);
    res.status(500).json({ message: 'Failed to remove member' });
  }
});

router.delete('/:teamId', async (req, res) => {
  try {
    const team = await Team.findById(req.params.teamId);
    if (!team || !team.isActive) return res.status(404).json({ message: 'Team not found' });
    await clearStaleTournamentLocks(team);
    if (team.captainDiscordId !== req.user.id) return res.status(403).json({ message: 'Only captain can delete team' });
    if ((team.tournamentLocks || []).length > 0) return res.status(400).json({ message: 'Cannot delete team while locked in tournament' });

    team.isActive = false;
    await team.save();
    await TeamInvite.updateMany({ teamId: team._id, status: 'pending' }, { $set: { status: 'cancelled', respondedAt: new Date() } });
    res.json({ message: 'Team deleted successfully' });
  } catch (error) {
    console.error('Delete team error:', error);
    res.status(500).json({ message: 'Failed to delete team' });
  }
});

router.post('/:teamId/invite', async (req, res) => {
  try {
    const { teamId } = req.params;
    const { targetDiscordId } = req.body;
    if (!targetDiscordId) return res.status(400).json({ message: 'targetDiscordId is required' });

    const team = await Team.findById(teamId);
    if (!team || !team.isActive) return res.status(404).json({ message: 'Team not found' });
    await clearStaleTournamentLocks(team);
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

    // Reserve a pending slot so team capacity stays consistent while invite is open.
    team.members.push({
      discordId: targetUser.discordId,
      discordName: targetUser.discordName,
      status: 'pending',
      invitedBy: req.user.id,
    });
    await team.save();

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
      const team = await Team.findById(invite.teamId);
      if (team && team.isActive) {
        team.members = (team.members || []).filter((m) => !(m.discordId === req.user.id && m.status === 'pending'));
        await team.save();
      }
      invite.status = 'declined';
      invite.respondedAt = new Date();
      await invite.save();
      return res.json({ message: 'Invite declined' });
    }

    const team = await Team.findById(invite.teamId);
    if (!team || !team.isActive) return res.status(404).json({ message: 'Team no longer available' });
    await clearStaleTournamentLocks(team);
    if ((team.tournamentLocks || []).length > 0) return res.status(400).json({ message: 'Team is locked in a tournament' });
    const existingMember = team.members.find((m) => m.discordId === req.user.id);
    if (existingMember && existingMember.status === 'accepted') return res.status(400).json({ message: 'Already in team' });
    if (!existingMember && team.members.length >= team.size) return res.status(400).json({ message: 'Team is already full' });

    const me = await User.findOne({ discordId: req.user.id }).select('discordName');
    if (existingMember && existingMember.status === 'pending') {
      existingMember.status = 'accepted';
      existingMember.discordName = me?.discordName || req.user.username || existingMember.discordName || 'Player';
    } else {
      team.members.push({
        discordId: req.user.id,
        discordName: me?.discordName || req.user.username || 'Player',
        status: 'accepted',
        invitedBy: invite.fromDiscordId,
      });
    }
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
