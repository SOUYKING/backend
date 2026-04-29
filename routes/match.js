const express = require('express');
const Match = require('../models/Match');
const User = require('../models/User');
const Team = require('../models/Team');
const Tournament = require('../models/Tournament');
const authenticate = require('../middlewares/authenticate');
const GameEngine = require('../core/GameEngine');
const eventBus = require('../utils/eventBus');
const { getRank, getRankProgress, calculatePointsChange } = require('../utils/rankSystem');
const router = express.Router();

async function buildActiveMatchSide(queuePlayer) {
  if (!queuePlayer) return null;
  if (queuePlayer.teamMode && Array.isArray(queuePlayer.teamMemberIds) && queuePlayer.teamMemberIds.length > 0) {
    const ids = [...queuePlayer.teamMemberIds];
    const users = await User.find({ discordId: { $in: ids } })
      .select('discordId discordName discordAvatar epicGamesName rankingPoints');
    const byId = Object.fromEntries(users.map((u) => [u.discordId, u]));
    const captainId = queuePlayer.captainId;
    const members = ids.map((id) => {
      const u = byId[id];
      return {
        id,
        username: u?.discordName || 'Player',
        epicName: u?.epicGamesName || null,
        avatar: u?.discordAvatar || null,
        rankingPoints: u?.rankingPoints ?? 0,
        isCaptain: id === captainId,
      };
    });
    members.sort((a, b) => Number(b.isCaptain) - Number(a.isCaptain));
    return {
      teamMode: true,
      teamId: queuePlayer.teamId || null,
      label: queuePlayer.teamName || queuePlayer.username,
      teamSize: queuePlayer.teamSize || members.length,
      queueUserId: queuePlayer.userId,
      members,
    };
  }
  return {
    teamMode: false,
    teamId: null,
    label: queuePlayer.username,
    teamSize: 1,
    queueUserId: queuePlayer.userId,
    members: [
      {
        id: queuePlayer.userId,
        username: queuePlayer.username,
        epicName: queuePlayer.epicName || null,
        avatar: queuePlayer.avatar || null,
        rankingPoints: queuePlayer.rankingPoints ?? 0,
        isCaptain: true,
      },
    ],
  };
}

function isQueueEntityParticipant(queuePlayer, discordId) {
  if (!queuePlayer || !discordId) return false;
  if (queuePlayer.userId === discordId) return true;
  if (queuePlayer.captainId === discordId) return true;
  if ((queuePlayer.teamMemberIds || []).includes(discordId)) return true;
  return false;
}

function isActiveMatchParticipant(activeMatch, discordId) {
  if (!activeMatch || !discordId) return false;
  return isQueueEntityParticipant(activeMatch.player1, discordId)
    || isQueueEntityParticipant(activeMatch.player2, discordId);
}

// ──────────────────────────────────────────────
// MATCH HISTORY (user's completed matches)
// ──────────────────────────────────────────────

router.get('/history', authenticate, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.user.id });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const matches = await Match.find({
      $or: [{ player1: user._id }, { player2: user._id }],
    })
      .populate('player1 player2')
      .sort({ date: -1 });

    const tournamentIds = [...new Set(matches.map((m) => String(m.tournamentId)))];
    const tournaments = await Tournament.find({ _id: { $in: tournamentIds } }).select('title type');
    const tournamentById = Object.fromEntries(
      tournaments.map((t) => [String(t._id), { title: t.title, type: t.type }]),
    );

    const teamIdSet = new Set();
    for (const m of matches) {
      if (m.winnerTeamId) teamIdSet.add(String(m.winnerTeamId));
      if (m.loserTeamId) teamIdSet.add(String(m.loserTeamId));
    }
    const teamIds = [...teamIdSet];
    const teams = teamIds.length
      ? await Team.find({ _id: { $in: teamIds } }).select('name')
      : [];
    const teamNameById = Object.fromEntries(teams.map((t) => [String(t._id), t.name]));

    const captainLookupOr = [];
    const captainLookupKey = new Set();
    const addCaptainLookup = (captainDiscordId, tournamentId) => {
      if (!captainDiscordId || !tournamentId) return;
      const k = `${captainDiscordId}|${tournamentId}`;
      if (captainLookupKey.has(k)) return;
      captainLookupKey.add(k);
      captainLookupOr.push({
        captainDiscordId,
        'tournamentLocks.tournamentId': tournamentId,
      });
    };

    for (const m of matches) {
      const isP1 = String(m.player1?._id) === String(user._id);
      let r;
      if (m.disputed || m.status === 'disputed') r = 'Disputed';
      else if (m.result === 'draw') r = 'Draw';
      else if (m.result === 'player1') r = isP1 ? 'Win' : 'Loss';
      else if (m.result === 'player2') r = !isP1 ? 'Win' : 'Loss';
      else if (m.status === 'pending') r = 'Pending';
      else r = 'Unknown';
      const tm = !!(m.winnerTeamId || m.loserTeamId);
      const hasBothTeamIds = !!(m.winnerTeamId && m.loserTeamId);
      const clearWinLoss = r === 'Win' || r === 'Loss';
      if (!tm || (clearWinLoss && hasBothTeamIds)) continue;
      const tournId = String(m.tournamentId);
      addCaptainLookup(m.player1?.discordId, tournId);
      addCaptainLookup(m.player2?.discordId, tournId);
    }

    let captainTeamNameByCapTournament = {};
    if (captainLookupOr.length) {
      const capTeams = await Team.find({ $or: captainLookupOr }).select(
        'name captainDiscordId tournamentLocks',
      );
      for (const t of capTeams) {
        for (const lock of t.tournamentLocks || []) {
          captainTeamNameByCapTournament[`${t.captainDiscordId}|${String(lock.tournamentId)}`] =
            t.name;
        }
      }
    }

    const formatted = matches.map((match) => {
      const isPlayer1 = String(match.player1?._id) === String(user._id);
      const opp = isPlayer1 ? match.player2 : match.player1;

      let result;
      if (match.disputed || match.status === 'disputed') result = 'Disputed';
      else if (match.result === 'draw') result = 'Draw';
      else if (match.result === 'player1') result = isPlayer1 ? 'Win' : 'Loss';
      else if (match.result === 'player2') result = !isPlayer1 ? 'Win' : 'Loss';
      else if (match.status === 'pending') result = 'Pending';
      else result = 'Unknown';

      const tid = String(match.tournamentId);
      const tour = tournamentById[tid] || {};
      const tournamentType = tour.type || '1v1';
      const teamMatch = !!(match.winnerTeamId || match.loserTeamId);

      let yourTeamName = null;
      let opponentTeamName = null;
      if (teamMatch) {
        const youWon =
          (match.result === 'player1' && isPlayer1) ||
          (match.result === 'player2' && !isPlayer1);
        const hasBothTeamIds = !!(match.winnerTeamId && match.loserTeamId);
        const clearWinLoss = result === 'Win' || result === 'Loss';
        if (clearWinLoss && hasBothTeamIds) {
          const yourTid = youWon ? match.winnerTeamId : match.loserTeamId;
          const oppTid = youWon ? match.loserTeamId : match.winnerTeamId;
          yourTeamName = teamNameById[String(yourTid)] || null;
          opponentTeamName = teamNameById[String(oppTid)] || null;
        }
        if (!yourTeamName || !opponentTeamName) {
          const c1 = match.player1?.discordId;
          const c2 = match.player2?.discordId;
          const p1Name = c1 ? captainTeamNameByCapTournament[`${c1}|${tid}`] : null;
          const p2Name = c2 ? captainTeamNameByCapTournament[`${c2}|${tid}`] : null;
          if (!yourTeamName) yourTeamName = (isPlayer1 ? p1Name : p2Name) || null;
          if (!opponentTeamName) opponentTeamName = (isPlayer1 ? p2Name : p1Name) || null;
        }
      }

      return {
        id: match._id,
        opponent: opp?.discordName || 'Unknown Player',
        opponentId: opp?.discordId,
        opponentAvatar: opp?.discordAvatar,
        selfId: user.discordId,
        selfAvatar: user.discordAvatar || null,
        result,
        date: match.date,
        tournamentId: match.tournamentId,
        tournamentTitle: tour.title || null,
        tournamentType,
        teamMatch,
        yourTeamName,
        opponentTeamName,
        winnerTeamId: match.winnerTeamId || null,
        loserTeamId: match.loserTeamId || null,
        status: match.status || 'completed',
        disputed: !!match.disputed,
      };
    });

    res.json(formatted);
  } catch (error) {
    console.error('Error fetching match history:', error);
    res.status(500).json({ message: 'Failed to fetch match history' });
  }
});

// ──────────────────────────────────────────────
// SUBMIT RESULT
// ──────────────────────────────────────────────

router.post('/:matchId/result', authenticate, async (req, res) => {
  const { matchId } = req.params;
  const { winnerDiscordId, evidence } = req.body;

  if (!winnerDiscordId) return res.status(400).json({ message: 'winnerDiscordId is required' });

  try {
    const result = await GameEngine.submitMatchResult(matchId, req.user.id, winnerDiscordId, evidence);

    if (!result.success) {
      const statusCode = result.status === 'expired' ? 408 : result.status === 'disputed' ? 409 : 400;
      return res.status(statusCode).json({ message: result.reason, status: result.status });
    }

    if (result.status === 'pending_confirmation') {
      return res.json({
        message: 'Result submitted. Waiting for opponent confirmation (5 min auto-resolve).',
        status: 'pending_confirmation',
        autoResolveAt: result.autoResolveAt,
      });
    }

    res.json({
      message: 'Match result recorded successfully',
      winner: req.user.username,
      winnerRank: result.winnerRank,
      loserRank: result.loserRank,
    });
  } catch (error) {
    console.error('Error reporting match result:', error);
    res.status(500).json({ message: 'Failed to report match result' });
  }
});

// ──────────────────────────────────────────────
// SUBMIT EVIDENCE
// ──────────────────────────────────────────────

router.post('/:matchId/evidence', authenticate, async (req, res) => {
  const { matchId } = req.params;
  const { screenshots, videoLinks, replayCodes, streamLinks } = req.body;

  try {
    const activeMatch = GameEngine.getActiveMatch(matchId);
    if (activeMatch) {
      if (!isActiveMatchParticipant(activeMatch, req.user.id)) {
        return res.status(403).json({ message: 'Only match participants can add evidence' });
      }
      activeMatch.evidence = activeMatch.evidence || [];
      activeMatch.evidence.push({
        playerDiscordId: req.user.id,
        screenshots: screenshots || [], videoLinks: videoLinks || [],
        replayCodes: replayCodes || [], streamLinks: streamLinks || [],
        submittedAt: new Date(),
      });
      eventBus.emit('receiveMessage', {
        sender: 'System', message: `📎 Evidence submitted by ${req.user.username || 'a player'}`,
        time: new Date().toISOString(), isSystem: true, matchId,
      }, { targets: [`match:${matchId}`], source: 'match' });
      return res.json({ message: 'Evidence submitted' });
    }

    const savedMatch = await Match.findById(matchId);
    if (!savedMatch) return res.status(404).json({ message: 'Match not found' });
    const isParticipant = [String(savedMatch.player1?._id), String(savedMatch.player2?._id)].includes(req.user.id);
    if (!isParticipant && req.user.role !== 'admin' && req.user.role !== 'owner' && req.user.role !== 'staff') {
      return res.status(403).json({ message: 'Not authorized to add evidence' });
    }
    savedMatch.evidence = savedMatch.evidence || [];
    savedMatch.evidence.push({
      playerDiscordId: req.user.id, screenshots: screenshots || [], videoLinks: videoLinks || [],
      replayCodes: replayCodes || [], streamLinks: streamLinks || [],
      submittedAt: new Date(),
    });
    await savedMatch.save();
    res.json({ message: 'Evidence added to match' });
  } catch (error) {
    console.error('Error submitting evidence:', error);
    res.status(500).json({ message: 'Failed to submit evidence' });
  }
});

// ──────────────────────────────────────────────
// STAFF DISPUTE RESOLVE
// ──────────────────────────────────────────────

router.post('/:matchId/resolve', authenticate, async (req, res) => {
  const canResolve = req.user.isOwner || req.user.role === 'owner' || req.user.role === 'admin' || req.user.role === 'staff';
  if (!canResolve) return res.status(403).json({ message: 'Only staff/admin can resolve disputes' });

  const { matchId } = req.params;
  const { winnerDiscordId, reason } = req.body;
  if (!winnerDiscordId) return res.status(400).json({ message: 'winnerDiscordId is required' });

  try {
    const result = await GameEngine.forceFinishMatch(matchId, winnerDiscordId, req.user.id, 'force');
    if (!result.success) return res.status(404).json({ message: result.reason });

    const AdminLog = require('../models/AdminLog');
    await AdminLog.create({
      adminId: req.user.id,
      adminName: req.user.username || req.user.discordName || 'Unknown',
      action: 'force_win',
      targetId: winnerDiscordId,
      targetName: result.match?.winnerName || winnerDiscordId || 'Unknown',
      matchId,
      reason: reason || 'Staff resolved dispute',
    });

    return res.json({ message: 'Dispute resolved and match finalized', winnerRank: result.winnerRank, loserRank: result.loserRank });
  } catch (error) {
    console.error('Error resolving dispute:', error);
    return res.status(500).json({ message: 'Failed to resolve dispute' });
  }
});

// ──────────────────────────────────────────────
// LEAVE ACTIVE MATCH
// ──────────────────────────────────────────────

router.post('/leave', authenticate, async (req, res) => {
  try {
    const match = GameEngine.getActiveMatchForUser(req.user.id);
    if (match) {
      const now = new Date();
      const matchAge = now.getTime() - new Date(match.createdAt || now).getTime();
      if (matchAge < 60000) {
        await User.findOneAndUpdate(
          { discordId: req.user.id },
          { $inc: { dodgeCount: 1 }, lastMatchLeaveAt: now }
        );
      } else {
        await User.findOneAndUpdate(
          { discordId: req.user.id },
          { lastMatchLeaveAt: now }
        );
      }
      GameEngine.removeActiveMatch(match.matchId);
      console.log(`❌ ${req.user.username || 'User'} left match`);
      res.json({ message: 'Left match successfully' });
    } else {
      res.json({ message: 'No active match found' });
    }
  } catch (error) {
    console.error('Error leaving match:', error);
    res.status(500).json({ message: 'Failed to leave match' });
  }
});

// ──────────────────────────────────────────────
// GET CURRENT MATCH
// ──────────────────────────────────────────────

router.get('/current', authenticate, async (req, res) => {
  try {
    const currentMatch = GameEngine.getActiveMatchForUser(req.user.id);

    if (currentMatch) {
      const isOnP1 = currentMatch.player1.userId === req.user.id || (currentMatch.player1.teamMemberIds || []).includes(req.user.id);
      const self = isOnP1 ? currentMatch.player1 : currentMatch.player2;
      const opponent = isOnP1 ? currentMatch.player2 : currentMatch.player1;

      const selfTeam = !!self.teamMode;
      const oppTeam = !!opponent.teamMode;
      const selfLookupDiscordId = selfTeam ? null : self.userId;
      const oppLookupDiscordId = oppTeam ? (opponent.captainId || null) : opponent.userId;

      const [selfUser, oppUser, callerUser] = await Promise.all([
        selfLookupDiscordId
          ? User.findOne({ discordId: selfLookupDiscordId }).select('discordAvatar rankingPoints')
          : Promise.resolve(null),
        oppLookupDiscordId
          ? User.findOne({ discordId: oppLookupDiscordId }).select('discordAvatar rankingPoints')
          : Promise.resolve(null),
        selfTeam
          ? User.findOne({ discordId: req.user.id }).select('discordAvatar rankingPoints')
          : Promise.resolve(null),
      ]);

      const selfRankingPoints = self.rankingPoints ?? selfUser?.rankingPoints ?? callerUser?.rankingPoints ?? 0;
      const oppRankingPoints = opponent.rankingPoints ?? oppUser?.rankingPoints ?? 0;

      const buildAvatar = (id, hash) => {
        if (!id || !hash) return null;
        const ext = hash.startsWith('a_') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}?size=256`;
      };

      const selfAvatarDiscordId = selfTeam ? req.user.id : self.userId;
      const selfAvatarHash = selfTeam
        ? (callerUser?.discordAvatar || self.avatar)
        : (self.avatar || selfUser?.discordAvatar);
      const oppAvatarDiscordId = oppLookupDiscordId || opponent.userId;
      const oppAvatarHash = opponent.avatar || oppUser?.discordAvatar;

      res.json({
        inMatch: true,
        matchId: currentMatch.matchId,
        selfId: selfTeam ? (self.captainId || self.userId) : self.userId,
        selfName: self.username,
        selfEpicName: self.epicName,
        selfAvatar: buildAvatar(selfAvatarDiscordId, selfAvatarHash),
        selfSkillRating: selfRankingPoints,
        opponent: opponent.username,
        opponentId: opponent.userId,
        opponentEpicName: opponent.epicName,
        opponentRank: getRank(oppRankingPoints).name,
        opponentSkillRating: oppRankingPoints,
        opponentAvatar: buildAvatar(oppAvatarDiscordId, oppAvatarHash),
        tournamentId: currentMatch.player1.tournamentId,
        mapCode: currentMatch.mapCode || null,
        resultExpiresAt: currentMatch.resultExpiresAt || null,
        reports: currentMatch.reports || {},
        evidence: currentMatch.evidence || [],
      });
    } else {
      res.json({ inMatch: false });
    }
  } catch (error) {
    console.error('Error getting current match:', error);
    res.status(500).json({ message: 'Failed to get current match' });
  }
});

// ──────────────────────────────────────────────
// MATCH CHAT
// ──────────────────────────────────────────────

// Active match chat — any authenticated user can view (staff, player, or spectator)
router.get('/:matchId/match-chat', authenticate, async (req, res) => {
  try {
    const activeMatch = GameEngine.getActiveMatch(req.params.matchId);
    if (activeMatch) {
      return res.json({ chatLogs: activeMatch.chatLogs || [] });
    }
    const match = await Match.findById(req.params.matchId).select('chatLogs');
    if (!match) return res.status(404).json({ message: 'Match not found' });
    res.json({ chatLogs: match.chatLogs || [] });
  } catch (error) {
    console.error('Error fetching match chat:', error);
    res.status(500).json({ message: 'Failed to fetch match chat' });
  }
});

// Stored match chat — requires authentication (kept for legacy compatibility)
router.get('/:matchId/chat', authenticate, async (req, res) => {
  try {
    const activeMatch = GameEngine.getActiveMatch(req.params.matchId);
    if (activeMatch) {
      return res.json({ chatLogs: activeMatch.chatLogs || [] });
    }
    const match = await Match.findById(req.params.matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    const requestingUser = await User.findOne({ discordId: req.user.id }).select('_id');
    const isParticipant = requestingUser
      ? String(match.player1) === String(requestingUser._id) || String(match.player2) === String(requestingUser._id)
      : false;
    const isStaff = req.user.role === 'admin' || req.user.role === 'owner' || req.user.role === 'staff';
    if (!isParticipant && !isStaff) return res.status(403).json({ message: 'Not authorized to view this chat' });
    res.json({ chatLogs: match.chatLogs || [] });
  } catch (error) {
    console.error('Error fetching match chat:', error);
    res.status(500).json({ message: 'Failed to fetch match chat' });
  }
});

// ──────────────────────────────────────────────
// ACTIVE MATCH CHECK (fallback for frontend)
// ──────────────────────────────────────────────

router.get('/active', authenticate, async (req, res) => {
  try {
    const match = GameEngine.getActiveMatchForUser(req.user.id);
    if (match) {
      res.json({ inMatch: true, matchId: match.matchId, match });
    } else {
      res.json({ inMatch: false });
    }
  } catch (error) {
    console.error('Error checking active match:', error);
    res.status(500).json({ message: 'Failed to check active match' });
  }
});

// ──────────────────────────────────────────────
// MATCH DETAILS
// ──────────────────────────────────────────────

router.get('/:matchId/details', authenticate, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.user.id });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const match = await Match.findById(req.params.matchId).populate('player1 player2');
    if (!match) return res.status(404).json({ message: 'Match not found' });

    const isParticipant = String(match.player1?._id) === String(user._id) || String(match.player2?._id) === String(user._id);
    const isStaff = req.user.role === 'admin' || req.user.role === 'owner' || req.user.role === 'staff';
    const isSpectator = !isParticipant && !isStaff;

    const isPlayer1 = isParticipant ? String(match.player1?._id) === String(user._id) : true;
    const selfUser = isPlayer1 ? match.player1 : match.player2;
    const oppUser = isPlayer1 ? match.player2 : match.player1;

    let result;
    if (match.disputed || match.status === 'disputed') result = 'Disputed';
    else if (match.result === 'draw') result = 'Draw';
    else if (match.result === 'player1') result = isPlayer1 ? 'Win' : 'Loss';
    else if (match.result === 'player2') result = !isPlayer1 ? 'Win' : 'Loss';
    else if (match.status === 'pending') result = 'Pending';
    else result = 'Unknown';

    const tid = match.tournamentId ? String(match.tournamentId) : '';
    const teamMatch = !!(match.winnerTeamId || match.loserTeamId);
    const teamIdList = [match.winnerTeamId, match.loserTeamId].filter(Boolean);
    const [tournament, teamDocs] = await Promise.all([
      tid ? Tournament.findById(tid).select('title type').lean() : Promise.resolve(null),
      teamIdList.length
        ? Team.find({ _id: { $in: teamIdList } }).select('name').lean()
        : Promise.resolve([]),
    ]);
    const teamNameById = Object.fromEntries(teamDocs.map((t) => [String(t._id), t.name]));
    const winnerTeamName = match.winnerTeamId ? teamNameById[String(match.winnerTeamId)] : null;
    const loserTeamName = match.loserTeamId ? teamNameById[String(match.loserTeamId)] : null;

    const c1 = match.player1?.discordId;
    const c2 = match.player2?.discordId;
    const capOr = [];
    if (teamMatch && tid) {
      if (c1) capOr.push({ captainDiscordId: c1, 'tournamentLocks.tournamentId': tid });
      if (c2) capOr.push({ captainDiscordId: c2, 'tournamentLocks.tournamentId': tid });
    }
    let capTidToName = {};
    if (capOr.length) {
      const capTeams = await Team.find({ $or: capOr })
        .select('name captainDiscordId tournamentLocks')
        .lean();
      for (const t of capTeams) {
        for (const lock of t.tournamentLocks || []) {
          capTidToName[`${t.captainDiscordId}|${String(lock.tournamentId)}`] = t.name;
        }
      }
    }
    const player1TeamName = c1 && tid ? capTidToName[`${c1}|${tid}`] || null : null;
    const player2TeamName = c2 && tid ? capTidToName[`${c2}|${tid}`] || null : null;

    let yourTeamName = null;
    let opponentTeamName = null;
    if (teamMatch && isParticipant) {
      const youWon =
        (match.result === 'player1' && isPlayer1) || (match.result === 'player2' && !isPlayer1);
      const hasBothTeamIds = !!(match.winnerTeamId && match.loserTeamId);
      const clearWinLoss = result === 'Win' || result === 'Loss';
      if (clearWinLoss && hasBothTeamIds) {
        yourTeamName = youWon ? winnerTeamName : loserTeamName;
        opponentTeamName = youWon ? loserTeamName : winnerTeamName;
      }
      if (!yourTeamName || !opponentTeamName) {
        if (!yourTeamName) yourTeamName = (isPlayer1 ? player1TeamName : player2TeamName) || null;
        if (!opponentTeamName) {
          opponentTeamName = (isPlayer1 ? player2TeamName : player1TeamName) || null;
        }
      }
    }

    res.json({
      id: match._id,
      date: match.date,
      result,
      disputed: !!match.disputed,
      status: match.status,
      tournamentId: match.tournamentId,
      tournamentTitle: tournament?.title || null,
      tournamentType: tournament?.type || '1v1',
      teamMatch,
      winnerTeamId: match.winnerTeamId || null,
      loserTeamId: match.loserTeamId || null,
      winnerTeamName,
      loserTeamName,
      player1TeamName,
      player2TeamName,
      yourTeamName,
      opponentTeamName,
      winnerRank: match.winnerRank || null,
      loserRank: match.loserRank || null,
      self: {
        discordId: selfUser?.discordId,
        discordName: selfUser?.discordName,
        discordAvatar: selfUser?.discordAvatar,
      },
      opponent: {
        discordId: oppUser?.discordId,
        discordName: oppUser?.discordName,
        discordAvatar: oppUser?.discordAvatar,
      },
      winnerDiscordId: match.winnerDiscordId,
      loserDiscordId: match.loserDiscordId,
      reports: match.reports || {},
      evidence: match.evidence || [],
      chatLogs: match.chatLogs || [],
      isSpectator,
      isParticipant,
    });
  } catch (error) {
    console.error('Error fetching match details:', error);
    res.status(500).json({ message: 'Failed to fetch match details' });
  }
});

// Public active match info (any logged-in user can view)
router.get('/:matchId/active-info', authenticate, async (req, res) => {
  try {
    const activeMatch = GameEngine.getActiveMatch(req.params.matchId);
    if (!activeMatch) return res.status(404).json({ message: 'Active match not found or already completed' });

    const roleNorm = String(req.user.role || '').toLowerCase();
    const isStaff =
      !!req.user.isOwner ||
      roleNorm === 'owner' ||
      roleNorm === 'admin' ||
      roleNorm === 'staff';
    const isParticipant =
      activeMatch.player1.userId === req.user.id ||
      activeMatch.player2.userId === req.user.id ||
      (activeMatch.player1.teamMemberIds || []).includes(req.user.id) ||
      (activeMatch.player2.teamMemberIds || []).includes(req.user.id);

    // If a staff account is one of the two players, treat them as a normal participant.
    const effectiveIsParticipant = isParticipant;
    const effectiveIsStaff = isStaff && !isParticipant;
    const effectiveIsSpectator = !effectiveIsParticipant && !effectiveIsStaff;

    // Show self for actual match participants (including staff accounts that are playing).
    const selfPlayer = effectiveIsParticipant
      ? (
        activeMatch.player1.userId === req.user.id || (activeMatch.player1.teamMemberIds || []).includes(req.user.id)
          ? activeMatch.player1
          : activeMatch.player2
      )
      : null;
    const opponent = effectiveIsParticipant
      ? (
        activeMatch.player1.userId === req.user.id || (activeMatch.player1.teamMemberIds || []).includes(req.user.id)
          ? activeMatch.player2
          : activeMatch.player1
      )
      : activeMatch.player1; // staff see player1 as "opponent" reference

    const selfUser = effectiveIsParticipant && !String(selfPlayer.userId || '').startsWith('team:')
      ? await User.findOne({ discordId: selfPlayer.userId }).select('discordAvatar rankingPoints')
      : null;
    const oppDiscordId = String(opponent.userId || '').startsWith('team:') ? opponent.captainId : opponent.userId;
    const oppUser = oppDiscordId
      ? await User.findOne({ discordId: oppDiscordId }).select('discordAvatar rankingPoints')
      : null;

    let participantSide = null;
    if (effectiveIsParticipant) {
      const onP1 =
        activeMatch.player1.userId === req.user.id ||
        (activeMatch.player1.teamMemberIds || []).includes(req.user.id);
      participantSide = onP1 ? 'player1' : 'player2';
    }

    const isTeamMatch = !!(activeMatch.player1.teamMode || activeMatch.player2.teamMode);
    const isTeamCaptain =
      !effectiveIsParticipant
        ? false
        : !selfPlayer.teamMode || selfPlayer.captainId === req.user.id;

    const [sidePlayer1, sidePlayer2] = await Promise.all([
      buildActiveMatchSide(activeMatch.player1),
      buildActiveMatchSide(activeMatch.player2),
    ]);

    res.json({
      inMatch: true,
      matchId: activeMatch.matchId,
      isSpectator: effectiveIsSpectator,
      isStaff: effectiveIsStaff,
      teamMatch: isTeamMatch,
      participantSide,
      isTeamCaptain,
      self: effectiveIsParticipant ? {
        id: selfPlayer.userId, username: selfPlayer.username, epicName: selfPlayer.epicName,
        avatar: selfPlayer.avatar || selfUser?.discordAvatar,
      } : null,
      opponent: {
        id: opponent.userId, username: opponent.username, epicName: opponent.epicName,
        avatar: opponent.avatar || oppUser?.discordAvatar,
      },
      mapCode: activeMatch.mapCode || null,
      player1: { id: activeMatch.player1.userId, username: activeMatch.player1.username, avatar: activeMatch.player1.avatar },
      player2: { id: activeMatch.player2.userId, username: activeMatch.player2.username, avatar: activeMatch.player2.avatar },
      sides: { player1: sidePlayer1, player2: sidePlayer2 },
    });
  } catch (error) {
    console.error('Error fetching active match info:', error);
    res.status(500).json({ message: 'Failed to fetch match info' });
  }
});

module.exports = router;
