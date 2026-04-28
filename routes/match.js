const express = require('express');
const Match = require('../models/Match');
const User = require('../models/User');
const Tournament = require('../models/Tournament');
const authenticate = require('../middlewares/authenticate');
const GameEngine = require('../core/GameEngine');
const eventBus = require('../utils/eventBus');
const { getRank, getRankProgress, calculatePointsChange } = require('../utils/rankSystem');
const router = express.Router();

// ──────────────────────────────────────────────
// MATCH HISTORY (user's completed matches)
// ──────────────────────────────────────────────

router.get('/history', authenticate, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.user.id });
    if (!user) return res.status(404).json({ message: 'User not found' });

    const matches = await Match.find({
      $or: [{ player1: user._id }, { player2: user._id }]
    }).populate('player1 player2').sort({ date: -1 });

    const formatted = matches.map(match => {
      const isPlayer1 = String(match.player1?._id) === String(user._id);
      const opp = isPlayer1 ? match.player2 : match.player1;

      let result;
      if (match.disputed && match.status === 'disputed') result = 'Disputed';
      else if (match.result === 'draw') result = 'Draw';
      else if (match.result === 'player1') result = isPlayer1 ? 'Win' : 'Loss';
      else if (match.result === 'player2') result = !isPlayer1 ? 'Win' : 'Loss';
      else result = isPlayer1 ? 'Win' : 'Loss';

      return {
        id: match._id,
        opponent: opp?.discordName,
        opponentId: opp?.discordId,
        opponentAvatar: opp?.discordAvatar,
        result,
        date: match.date,
        tournamentId: match.tournamentId,
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
      const isParticipant = [activeMatch.player1.userId, activeMatch.player2.userId].includes(req.user.id);
      if (!isParticipant) return res.status(403).json({ message: 'Only match participants can add evidence' });
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
      targetName: result.match?.winnerDiscordId || 'Unknown',
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
      const self = currentMatch.player1.userId === req.user.id ? currentMatch.player1 : currentMatch.player2;
      const opponent = currentMatch.player1.userId === req.user.id ? currentMatch.player2 : currentMatch.player1;

      const [selfUser, oppUser] = await Promise.all([
        User.findOne({ discordId: self.userId }).select('discordAvatar rankingPoints'),
        User.findOne({ discordId: opponent.userId }).select('discordAvatar rankingPoints'),
      ]);

      const selfRankingPoints = self.rankingPoints ?? selfUser?.rankingPoints ?? 0;
      const oppRankingPoints = opponent.rankingPoints ?? oppUser?.rankingPoints ?? 0;

      const buildAvatar = (id, hash) => {
        if (!id || !hash) return null;
        const ext = hash.startsWith('a_') ? 'gif' : 'png';
        return `https://cdn.discordapp.com/avatars/${id}/${hash}.${ext}?size=256`;
      };

      res.json({
        inMatch: true,
        matchId: currentMatch.matchId,
        selfId: self.userId,
        selfName: self.username,
        selfEpicName: self.epicName,
        selfAvatar: buildAvatar(self.userId, self.avatar || selfUser?.discordAvatar),
        selfSkillRating: selfRankingPoints,
        opponent: opponent.username,
        opponentId: opponent.userId,
        opponentEpicName: opponent.epicName,
        opponentRank: getRank(oppRankingPoints).name,
        opponentSkillRating: oppRankingPoints,
        opponentAvatar: buildAvatar(opponent.userId, opponent.avatar || oppUser?.discordAvatar),
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
    const isParticipant = String(match.player1) === String(req.user?._id) || String(match.player2) === String(req.user?._id);
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
    if (match.disputed && match.status === 'disputed') result = 'Disputed';
    else if (match.result === 'draw') result = 'Draw';
    else if (match.result === 'player1') result = isPlayer1 ? 'Win' : 'Loss';
    else if (match.result === 'player2') result = !isPlayer1 ? 'Win' : 'Loss';
    else result = isPlayer1 ? 'Win' : 'Loss';

    res.json({
      id: match._id, date: match.date, result, disputed: !!match.disputed, status: match.status,
      tournamentId: match.tournamentId,
      self: { discordId: selfUser?.discordId, discordName: selfUser?.discordName, discordAvatar: selfUser?.discordAvatar },
      opponent: { discordId: oppUser?.discordId, discordName: oppUser?.discordName, discordAvatar: oppUser?.discordAvatar },
      winnerDiscordId: match.winnerDiscordId, loserDiscordId: match.loserDiscordId,
      reports: match.reports || {}, evidence: match.evidence || [], chatLogs: match.chatLogs || [],
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

    const user = await User.findOne({ discordId: req.user.id });
    const isStaff = req.user.role === 'admin' || req.user.role === 'owner' || req.user.role === 'staff';
    const isParticipant = activeMatch.player1.userId === req.user.id || activeMatch.player2.userId === req.user.id;

    // Staff ALWAYS join as staff/observer, never as a player slot
    const effectiveIsParticipant = isParticipant && !isStaff;
    const effectiveIsStaff = isStaff;
    const effectiveIsSpectator = !effectiveIsParticipant && !effectiveIsStaff;

    // Only show self for actual players (not staff)
    const selfPlayer = effectiveIsParticipant ? (activeMatch.player1.userId === req.user.id ? activeMatch.player1 : activeMatch.player2) : null;
    const opponent = effectiveIsParticipant
      ? (activeMatch.player1.userId === req.user.id ? activeMatch.player2 : activeMatch.player1)
      : activeMatch.player1; // staff see player1 as "opponent" reference

    const selfUser = effectiveIsParticipant ? await User.findOne({ discordId: selfPlayer.userId }).select('discordAvatar rankingPoints') : null;
    const oppUser = await User.findOne({ discordId: opponent.userId }).select('discordAvatar rankingPoints');

    res.json({
      inMatch: true,
      matchId: activeMatch.matchId,
      isSpectator: effectiveIsSpectator,
      isStaff: effectiveIsStaff,
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
    });
  } catch (error) {
    console.error('Error fetching active match info:', error);
    res.status(500).json({ message: 'Failed to fetch match info' });
  }
});

module.exports = router;
