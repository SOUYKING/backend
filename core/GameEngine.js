const User = require('../models/User');
const Match = require('../models/Match');
const Team = require('../models/Team');
const Tournament = require('../models/Tournament');
const StaffNotification = require('../models/StaffNotification');
const eventBus = require('../utils/eventBus');
const { getRank, calculatePointsChange } = require('../utils/rankSystem');

const MATCHMAKING_INTERVAL = 2000;
const RESULT_TIMEOUT_MS = 10 * 60 * 1000;
const AUTO_RESOLVE_MS = 5 * 60 * 1000;

class GameEngine {
  constructor() {
    this.queue = [];
    this.activeMatches = new Map();
    this.queueCooldowns = new Map();
    this._matchmakingTimer = null;
    this._initialized = false;
  }

  init() {
    if (this._initialized) return;
    this._initialized = true;
    this._startMatchmakingLoop();
    console.log('[GAME ENGINE] Initialized');
  }

  // ──────────────────────────────────────────────
  // QUEUE
  // ──────────────────────────────────────────────

  async releaseTeamTournamentLock(teamId, tournamentId) {
    if (!teamId || !tournamentId) return;
    try {
      await Team.updateOne(
        { _id: teamId },
        { $pull: { tournamentLocks: { tournamentId: String(tournamentId) } } },
      );
    } catch (e) {
      console.warn('[GAME ENGINE] releaseTeamTournamentLock:', e.message);
    }
  }

  async releaseTeamQueueLockForEntity(entity) {
    if (entity?.teamMode && entity.teamId && entity.tournamentId) {
      await this.releaseTeamTournamentLock(entity.teamId, entity.tournamentId);
    }
  }

  async joinQueue(user) {
    const validation = await this.validateQueueEntity(user);
    if (!validation.valid) return { success: false, reason: validation.reason };

    const alreadyInQueue = this.queue.some(p => p.userId === user.userId);
    if (alreadyInQueue) return { success: false, reason: 'Already in queue' };

    const cooldownKey = `${user.userId}:${user.tournamentId}`;
    const cooldown = this.queueCooldowns.get(cooldownKey);
    if (cooldown && Date.now() < cooldown) {
      return { success: false, reason: 'Queue cooldown active', retryAfter: Math.ceil((cooldown - Date.now()) / 1000) };
    }

    this.removeFromQueue(user.userId);
    this.queue.push({ ...user, joinedAt: Date.now() });

    eventBus.emit('admin:queue-join', {
      userId: user.userId,
      username: user.username,
      tournamentId: user.tournamentId,
      epicName: user.epicName,
      role: user.role,
      queueSize: this.getQueueSize(user.tournamentId),
    }, { source: 'gameEngine' });

    await this.processMatchmaking();

    return { success: true };
  }

  async leaveQueue(userId) {
    const entry = this.queue.find((p) =>
      p.userId === userId ||
      p.captainId === userId ||
      (p.teamMemberIds || []).includes(userId)
    );
    const wasInQueue = !!entry;
    if (entry) await this.releaseTeamQueueLockForEntity(entry);
    this.removeFromQueue(userId);
    if (wasInQueue) {
      eventBus.emit('admin:queue-leave', { userId }, { source: 'gameEngine' });
    }
    return { success: true };
  }

  removeFromQueue(userId) {
    this.queue = this.queue.filter((p) =>
      p.userId !== userId &&
      p.captainId !== userId &&
      !(p.teamMemberIds || []).includes(userId)
    );
  }

  getQueueSize(tournamentId = null) {
    if (tournamentId) return this.queue.filter(p => p.tournamentId === tournamentId).length;
    return this.queue.length;
  }

  getQueue() {
    return [...this.queue];
  }

  // ──────────────────────────────────────────────
  // MATCHMAKING
  // ──────────────────────────────────────────────

  async processMatchmaking() {
    const paired = new Set();

    for (let i = 0; i < this.queue.length; i++) {
      if (paired.has(i)) continue;
      const playerA = this.queue[i];

      let bestMatch = null;
      let bestMatchIdx = -1;
      let bestDiff = Infinity;

      for (let j = i + 1; j < this.queue.length; j++) {
        if (paired.has(j)) continue;
        const playerB = this.queue[j];

        if (playerA.tournamentId !== playerB.tournamentId) continue;

        const diff = Math.abs((playerA.rankingPoints || 0) - (playerB.rankingPoints || 0));
        if (diff < bestDiff) {
          bestDiff = diff;
          bestMatch = playerB;
          bestMatchIdx = j;
        }
      }

      if (bestMatch && bestMatchIdx !== -1) {
        paired.add(i);
        paired.add(bestMatchIdx);
        await this.createMatch(playerA, bestMatch);
      }
    }
  }

  _startMatchmakingLoop() {
    if (this._matchmakingTimer) clearInterval(this._matchmakingTimer);
    this._matchmakingTimer = setInterval(async () => {
      if (this.queue.length >= 2) {
        await this.processMatchmaking();
        eventBus.emitStatsUpdate();
      }
    }, MATCHMAKING_INTERVAL);
  }

  async createMatch(player1, player2) {
    const v1 = await this.validateQueueEntity(player1);
    const v2 = await this.validateQueueEntity(player2);
    if (!v1.valid || !v2.valid) {
      if (!v1.valid) {
        await this.releaseTeamQueueLockForEntity(player1);
        this.removeFromQueue(player1.userId);
      }
      if (!v2.valid) {
        await this.releaseTeamQueueLockForEntity(player2);
        this.removeFromQueue(player2.userId);
      }
      return null;
    }

    const matchId = `${player1.userId}-${player2.userId}-${Date.now()}`;
    const now = new Date();

    const match = {
      matchId,
      player1,
      player2,
      mapCode: player1.mapCode || player2.mapCode || null,
      createdAt: now,
      reports: {},
      evidence: [],
      chatLogs: [],
      resultExpiresAt: null,
      disputed: false,
      status: 'pending',
      _autoResolveTimer: null,
      _autoResolveWinner: null,
    };

    this.removeFromQueue(player1.userId);
    this.removeFromQueue(player2.userId);

    this.setQueueCooldown(player1.userId, player1.tournamentId);
    this.setQueueCooldown(player2.userId, player2.tournamentId);

    this.activeMatches.set(matchId, match);

    eventBus.emit('admin:match-start', {
      matchId,
      player1: player1.username,
      player1Id: player1.userId,
      player2: player2.username,
      player2Id: player2.userId,
      tournamentId: player1.tournamentId,
      mapCode: match.mapCode,
    }, { targets: ['admin-room'], source: 'gameEngine' });

    this.scheduleAutoResolve(matchId);
    return match;
  }

  // ──────────────────────────────────────────────
  // MATCH LIFECYCLE
  // ──────────────────────────────────────────────

  getActiveMatch(matchId) {
    return this.activeMatches.get(matchId) || null;
  }

  getActiveMatches() {
    return Array.from(this.activeMatches.values());
  }

  getActiveMatchCount() {
    return this.activeMatches.size;
  }

  getActiveMatchForUser(userId) {
    for (const match of this.activeMatches.values()) {
      const p1Members = match.player1.teamMemberIds || [];
      const p2Members = match.player2.teamMemberIds || [];
      if (
        match.player1.userId === userId ||
        match.player2.userId === userId ||
        p1Members.includes(userId) ||
        p2Members.includes(userId)
      ) {
        return match;
      }
    }
    return null;
  }

  removeActiveMatch(matchId) {
    this.clearAutoResolveTimer(matchId);
    this.activeMatches.delete(matchId);
  }

  async submitMatchResult(matchId, userId, winnerDiscordId, evidence) {
    const match = this.activeMatches.get(matchId);
    if (!match) return { success: false, reason: 'Match not found' };

    const isTeamMode = !!(match.player1.teamMode || match.player2.teamMode);
    const isParticipant = isTeamMode
      ? (match.player1.teamMemberIds || []).includes(userId) || (match.player2.teamMemberIds || []).includes(userId)
      : (match.player1.userId === userId || match.player2.userId === userId);
    if (!isParticipant) return { success: false, reason: 'Not a participant' };

    if (isTeamMode && ![match.player1.captainId, match.player2.captainId].includes(userId)) {
      return { success: false, reason: 'Only team captain can submit result' };
    }

    const validWinnerIds = isTeamMode
      ? [match.player1.userId, match.player2.userId, match.player1.captainId, match.player2.captainId]
      : [match.player1.userId, match.player2.userId];
    if (!validWinnerIds.includes(winnerDiscordId)) {
      return { success: false, reason: 'Invalid winner' };
    }

    const matchAge = Date.now() - new Date(match.createdAt || Date.now()).getTime();
    if (matchAge > RESULT_TIMEOUT_MS && !match.reports?.[userId]) {
      await StaffNotification.create({
        type: 'match_completed',
        matchId,
        title: '⏰ Match Result Timeout',
        message: `Match ${matchId} has expired. Players failed to submit results in time.`,
        player1Name: match.player1.username,
        player2Name: match.player2.username,
      });
      return { success: false, reason: 'Result submission time expired', status: 'expired' };
    }

    match.reports = match.reports || {};
    match.reports[userId] = { reporterDiscordId: userId, winnerDiscordId, at: new Date() };

    if (evidence) {
      match.evidence = match.evidence || [];
      match.evidence.push({
        playerDiscordId: userId,
        screenshots: evidence.screenshots || [],
        videoLinks: evidence.videoLinks || [],
        replayCodes: evidence.replayCodes || [],
        streamLinks: evidence.streamLinks || [],
        submittedAt: new Date(),
      });
    }

    if (!match.resultExpiresAt) {
      match.resultExpiresAt = new Date(Date.now() + RESULT_TIMEOUT_MS);
    }
    this.activeMatches.set(matchId, match);

    const reportEntries = Object.values(match.reports);
    const isWinnerP1 = [match.player1.userId, match.player1.captainId].includes(winnerDiscordId);
    const reporterName = (match.player1.teamMemberIds || []).includes(userId) || match.player1.userId === userId ? match.player1.username : match.player2.username;
    const winnerName = isWinnerP1 ? match.player1.username : match.player2.username;

    if (reportEntries.length < 2) {
      match._autoResolveWinner = { winnerDiscordId, submittedBy: userId, submittedAt: new Date() };
      this.activeMatches.set(matchId, match);

      eventBus.emit('receiveMessage', {
        sender: 'System',
        message: `📋 ${reporterName} submitted result: ${winnerName} wins. Opponent has 5 minutes to respond or the win will be auto-granted.`,
        time: new Date().toISOString(),
        isSystem: true,
        matchId,
      }, { targets: [`match:${matchId}`], source: 'gameEngine' });

      eventBus.emit('winSubmitted', {
        matchId,
        submittedBy: reporterName,
        winnerName,
        autoResolveAt: new Date(Date.now() + AUTO_RESOLVE_MS).toISOString(),
      }, { targets: [`match:${matchId}`], source: 'gameEngine' });

      this.scheduleAutoResolve(matchId);
      return { success: true, status: 'pending_confirmation', autoResolveAt: new Date(Date.now() + AUTO_RESOLVE_MS).toISOString() };
    }

    this.clearAutoResolveTimer(matchId);
    const [firstReport, secondReport] = reportEntries;

    if (firstReport.winnerDiscordId !== secondReport.winnerDiscordId) {
      match.disputed = true;
      match.status = 'disputed';
      this.activeMatches.set(matchId, match);

      await StaffNotification.create({
        type: 'dispute',
        matchId,
        title: '⚖️ Match Dispute',
        message: `Players ${match.player1.username} and ${match.player2.username} reported different winners. Staff review required.`,
        player1Name: match.player1.username,
        player2Name: match.player2.username,
      });

      eventBus.emit('receiveMessage', {
        sender: 'System',
        message: '⚠️ Both players reported different winners. Staff has been notified for review.',
        time: new Date().toISOString(),
        isSystem: true,
        matchId,
      }, { targets: [`match:${matchId}`], source: 'gameEngine' });

      eventBus.emit('disputeOpened', { matchId }, { targets: [`match:${matchId}`, 'admin-room'], source: 'gameEngine' });

      return { success: false, reason: 'Result mismatch detected. Staff review required.', status: 'disputed' };
    }

    return this.finishMatch(matchId, firstReport.winnerDiscordId, 'agreed');
  }

  async finishMatch(matchId, winnerDiscordId, reason = 'agreed') {
    const match = this.activeMatches.get(matchId);
    if (!match) return { success: false, reason: 'Match not found' };

    this.clearAutoResolveTimer(matchId);

    const winnerSideIsP1 = [match.player1.userId, match.player1.captainId].includes(winnerDiscordId);
    const winnerSide = winnerSideIsP1 ? match.player1 : match.player2;
    const loserSide = winnerSideIsP1 ? match.player2 : match.player1;

    const winnerMemberIds = winnerSide.teamMode ? (winnerSide.teamMemberIds || [winnerSide.captainId]) : [winnerSide.userId];
    const loserMemberIds = loserSide.teamMode ? (loserSide.teamMemberIds || [loserSide.captainId]) : [loserSide.userId];
    const winnerUsers = await User.find({ discordId: { $in: winnerMemberIds } });
    const loserUsers = await User.find({ discordId: { $in: loserMemberIds } });
    if (!winnerUsers.length || !loserUsers.length) return { success: false, reason: 'User not found' };

    const winnerAvg = Math.round(winnerUsers.reduce((sum, u) => sum + (u.rankingPoints || 0), 0) / winnerUsers.length);
    const loserAvg = Math.round(loserUsers.reduce((sum, u) => sum + (u.rankingPoints || 0), 0) / loserUsers.length);
    const pointsChange = calculatePointsChange(winnerAvg, loserAvg);

    for (const w of winnerUsers) {
      w.rankingPoints += pointsChange.winPoints;
      w.wins += 1;
      w.totalMatches += 1;
      await w.save();
    }
    for (const l of loserUsers) {
      l.rankingPoints = Math.max(0, l.rankingPoints - pointsChange.lossPoints);
      l.losses += 1;
      l.totalMatches += 1;
      await l.save();
    }

    const winnerRank = getRank(winnerUsers[0].rankingPoints).name;
    const loserRank = getRank(loserUsers[0].rankingPoints).name;
    const winnerCaptain = winnerUsers.find((u) => u.discordId === winnerSide.captainId) || winnerUsers[0];
    const loserCaptain = loserUsers.find((u) => u.discordId === loserSide.captainId) || loserUsers[0];

    const winnerTeamId = winnerSide.teamMode && winnerSide.teamId ? String(winnerSide.teamId) : null;
    const loserTeamId = loserSide.teamMode && loserSide.teamId ? String(loserSide.teamId) : null;

    const newMatch = await Match.create({
      player1: winnerCaptain._id,
      player2: loserCaptain._id,
      result: 'player1',
      winnerDiscordId: winnerCaptain.discordId,
      loserDiscordId: loserCaptain.discordId,
      winnerRank,
      loserRank,
      status: 'completed',
      disputed: reason !== 'agreed',
      autoResolved: reason === 'auto_resolve',
      reports: match.reports || {},
      evidence: match.evidence || [],
      chatLogs: match.chatLogs || [],
      resolvedBy: reason === 'force' ? match.resolvedBy || 'admin' : null,
      tournamentId: match.player1.tournamentId,
      winnerTeamId,
      loserTeamId,
      date: new Date(),
    });

    if (winnerTeamId) {
      try {
        await Team.updateOne({ _id: winnerTeamId, isActive: true }, { $inc: { statsWins: 1 } });
      } catch (e) {
        console.warn('[GAME ENGINE] Team stats win increment failed:', e.message);
      }
    }
    if (loserTeamId) {
      try {
        await Team.updateOne({ _id: loserTeamId, isActive: true }, { $inc: { statsLosses: 1 } });
      } catch (e) {
        console.warn('[GAME ENGINE] Team stats loss increment failed:', e.message);
      }
    }

    const tid = match.player1.tournamentId ? String(match.player1.tournamentId) : null;
    if (tid) {
      if (match.player1.teamMode && match.player1.teamId) {
        await this.releaseTeamTournamentLock(match.player1.teamId, tid);
      }
      if (match.player2.teamMode && match.player2.teamId) {
        await this.releaseTeamTournamentLock(match.player2.teamId, tid);
      }
    }

    // Update tournament leaderboard
    if (match.player1.tournamentId) {
      try {
        const tournament = await Tournament.findById(match.player1.tournamentId);
        if (tournament) {
          for (const id of winnerMemberIds) {
            const wl = tournament.leaderboard.find(l => l.userId === id);
            if (wl) { wl.wins += 1; wl.points += pointsChange.winPoints; }
          }
          for (const id of loserMemberIds) {
            const ll = tournament.leaderboard.find(l => l.userId === id);
            if (ll) { ll.losses += 1; ll.points = Math.max(0, (ll.points || 0) - pointsChange.lossPoints); }
          }
          await tournament.save();
        }
      } catch (e) { console.error('[GAME ENGINE] Tournament leaderboard update error:', e.message); }
    }

    this.activeMatches.delete(matchId);

    eventBus.emit('receiveMessage', {
      sender: 'System',
      message: `✅ Match completed! ${winnerCaptain.discordName} wins!`,
      time: new Date().toISOString(),
      isSystem: true,
      matchId,
    }, { targets: [`match:${matchId}`], source: 'gameEngine' });

    eventBus.emit('matchCompleted', {
      matchId,
      winner: winnerCaptain.discordName,
      winnerId: winnerCaptain.discordId,
      loser: loserCaptain.discordName,
      loserId: loserCaptain.discordId,
      reason,
    }, { targets: [`match:${matchId}`, 'admin-room'], source: 'gameEngine' });

    eventBus.emitStatsUpdate();

    return { success: true, match: newMatch, winnerRank, loserRank };
  }

  // ──────────────────────────────────────────────
  // AUTO-RESOLVE
  // ──────────────────────────────────────────────

  clearAutoResolveTimer(matchId) {
    const match = this.activeMatches.get(matchId);
    if (match?._autoResolveTimer) {
      clearTimeout(match._autoResolveTimer);
      match._autoResolveTimer = null;
    }
  }

  scheduleAutoResolve(matchId) {
    this.clearAutoResolveTimer(matchId);
    const match = this.activeMatches.get(matchId);
    if (!match) return;

    match._autoResolveTimer = setTimeout(async () => {
      const currentMatch = this.activeMatches.get(matchId);
      if (!currentMatch || currentMatch.status === 'completed' || currentMatch.status === 'disputed') return;

      const report = currentMatch._autoResolveWinner;
      if (!report || !report.winnerDiscordId) return;

      await this.finishMatch(matchId, report.winnerDiscordId, 'auto_resolve');
    }, AUTO_RESOLVE_MS);
  }

  // ──────────────────────────────────────────────
  // QUEUE COOLDOWN
  // ──────────────────────────────────────────────

  setQueueCooldown(userId, tournamentId, cooldownMs = 5000) {
    this.queueCooldowns.set(`${userId}:${tournamentId}`, Date.now() + cooldownMs);
  }

  // ──────────────────────────────────────────────
  // STATE VALIDATION
  // ──────────────────────────────────────────────

  async validateUserState(userId) {
    if (!userId) return { valid: false, reason: 'Invalid user ID' };

    try {
      const user = await User.findOne({ discordId: userId }).select('discordId isBanned banReason role');
      if (!user) return { valid: false, reason: 'User not found' };
      if (user.isBanned) return { valid: false, reason: user.banReason || 'Your account is banned.' };

      const inMatch = this.getActiveMatchForUser(userId);
      if (inMatch) return { valid: false, reason: 'Already in an active match' };

      return { valid: true, user };
    } catch (e) {
      console.error('[GAME ENGINE] Validation error:', e.message);
      return { valid: false, reason: 'Validation error' };
    }
  }

  /** True if this team is currently in the matchmaking queue or an in-memory active match. */
  isTeamInLiveQueueOrMatch(teamId) {
    if (!teamId) return false;
    const tid = String(teamId);
    const queueUserId = `team:${tid}`;
    if (this.queue.some((p) =>
      p.userId === queueUserId ||
      (p.teamMode && String(p.teamId || '') === tid)
    )) {
      return true;
    }
    for (const m of this.activeMatches.values()) {
      if (String(m.player1?.teamId || '') === tid || String(m.player2?.teamId || '') === tid) {
        return true;
      }
    }
    return false;
  }

  async validateQueueEntity(entity) {
    if (!entity) return { valid: false, reason: 'Invalid queue entity' };
    if (!entity.teamMode) {
      return this.validateUserState(entity.userId);
    }
    const members = entity.teamMemberIds || [];
    if (!members.length) return { valid: false, reason: 'Team has no members' };
    for (const memberId of members) {
      const status = await this.validateUserState(memberId);
      if (!status.valid) return { valid: false, reason: `Team member invalid: ${status.reason}` };
    }
    return { valid: true };
  }

  // ──────────────────────────────────────────────
  // ADMIN
  // ──────────────────────────────────────────────

  async forceFinishMatch(matchId, winnerDiscordId, resolvedBy, reason = 'force') {
    const match = this.activeMatches.get(matchId);
    if (!match) return { success: false, reason: 'Active match not found' };

    match.resolvedBy = resolvedBy;
    this.activeMatches.set(matchId, match);

    return this.finishMatch(matchId, winnerDiscordId, reason);
  }

  // ──────────────────────────────────────────────
  // SHUTDOWN
  // ──────────────────────────────────────────────

  shutdown() {
    if (this._matchmakingTimer) {
      clearInterval(this._matchmakingTimer);
      this._matchmakingTimer = null;
    }
    for (const match of this.activeMatches.values()) {
      this.clearAutoResolveTimer(match.matchId);
    }
    this._initialized = false;
    console.log('[GAME ENGINE] Shut down');
  }
}

module.exports = new GameEngine();
