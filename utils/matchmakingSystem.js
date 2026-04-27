const gameEngine = require('../core/GameEngine');

class MatchmakingSystem {
  get queue() { return gameEngine.queue; }
  set queue(v) { gameEngine.queue = v; }
  get activeMatches() { return gameEngine.activeMatches; }
  set activeMatches(v) { gameEngine.activeMatches = v; }
  get queueCooldowns() { return gameEngine.queueCooldowns; }
  set queueCooldowns(v) { gameEngine.queueCooldowns = v; }

  canJoinQueue(userId, tournamentId) {
    const cooldownKey = `${userId}:${tournamentId}`;
    const cooldown = gameEngine.queueCooldowns.get(cooldownKey);
    if (cooldown && Date.now() < cooldown) {
      return { allowed: false, retryAfter: Math.ceil((cooldown - Date.now()) / 1000) };
    }
    const alreadyInQueue = gameEngine.queue.some(p => p.userId === userId);
    if (alreadyInQueue) {
      return { allowed: false, retryAfter: 0, reason: 'Already in queue' };
    }
    return { allowed: true };
  }

  getMatchingRange(rankingPoints, tournamentId) {
    const tournamentQueue = gameEngine.queue.filter(p => p.tournamentId === tournamentId);
    if (tournamentQueue.length === 0) return { min: 0, max: 9999 };
    const similarPlayers = tournamentQueue.filter(p => Math.abs(p.rankingPoints - rankingPoints) <= 100);
    if (similarPlayers.length >= 1 && Math.random() <= 0.75) {
      return { min: rankingPoints - 100, max: rankingPoints + 100 };
    }
    const allPlayers = tournamentQueue;
    const avgSkill = allPlayers.reduce((sum, p) => sum + p.rankingPoints, 0) / allPlayers.length;
    return { min: avgSkill - 200, max: avgSkill + 200 };
  }

  findMatch(player, tournamentId) {
    const tournamentQueue = gameEngine.queue.filter(p =>
      p.tournamentId === tournamentId && p.userId !== player.userId
    );
    if (tournamentQueue.length === 0) return null;
    const range = this.getMatchingRange(player.rankingPoints, tournamentId);
    let potentialMatches = tournamentQueue.filter(p =>
      p.rankingPoints >= range.min && p.rankingPoints <= range.max
    );
    if (potentialMatches.length === 0) potentialMatches = tournamentQueue;
    if (potentialMatches.length === 0) return null;
    potentialMatches.sort((a, b) =>
      Math.abs(a.rankingPoints - player.rankingPoints) - Math.abs(b.rankingPoints - player.rankingPoints)
    );
    return potentialMatches[0];
  }

  addToQueue(player) {
    gameEngine.removeFromQueue(player.userId);
    gameEngine.queue.push(player);
  }

  removeFromQueue(userId) {
    gameEngine.removeFromQueue(userId);
  }

  setQueueCooldown(userId, tournamentId, cooldownMs = 5000) {
    gameEngine.setQueueCooldown(userId, tournamentId, cooldownMs);
  }

  getQueueSize(tournamentId = null) {
    return gameEngine.getQueueSize(tournamentId);
  }

  getQueue() {
    return gameEngine.getQueue();
  }

  createMatch(player1, player2, mapCode = null) {
    const matchId = `${player1.userId}-${player2.userId}-${Date.now()}`;
    gameEngine.activeMatches.set(matchId, {
      matchId, player1, player2, mapCode,
      createdAt: new Date(), reports: {}, evidence: [],
      chatLogs: [], resultExpiresAt: null, disputed: false, status: 'pending',
    });
    gameEngine.removeFromQueue(player1.userId);
    gameEngine.removeFromQueue(player2.userId);
    gameEngine.setQueueCooldown(player1.userId, player1.tournamentId);
    gameEngine.setQueueCooldown(player2.userId, player2.tournamentId);
    return { matchId, player1, player2 };
  }

  getActiveMatch(matchId) { return gameEngine.getActiveMatch(matchId); }

  removeActiveMatch(matchId) { gameEngine.removeActiveMatch(matchId); }

  getActiveMatchCount() { return gameEngine.getActiveMatchCount(); }
}

module.exports = new MatchmakingSystem();
