function isBracketType(type) {
  return type === '1v1_bracket';
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function seededParticipants(participants = []) {
  return [...participants]
    .filter((p) => p && p.userId)
    .sort((a, b) => (b.rankingPoints || 0) - (a.rankingPoints || 0))
    .map((p) => ({
      userId: String(p.userId),
      discordName: p.discordName || 'Player',
    }));
}

function createInitialBracket(participants = []) {
  const seeded = seededParticipants(participants);
  const count = Math.max(2, seeded.length);
  const bracketSize = nextPow2(count);
  const roundsCount = Math.log2(bracketSize);
  const rounds = [];

  let matchCount = bracketSize / 2;
  for (let r = 1; r <= roundsCount; r++) {
    const matches = [];
    for (let m = 1; m <= matchCount; m++) {
      matches.push({
        id: `r${r}m${m}`,
        round: r,
        slot: m,
        player1Id: null,
        player1Name: null,
        player2Id: null,
        player2Name: null,
        winnerId: null,
        winnerName: null,
        loserId: null,
        loserName: null,
        activeMatchId: null,
        status: 'waiting',
      });
    }
    rounds.push({ round: r, matches });
    matchCount /= 2;
  }

  const firstRound = rounds[0];
  for (let i = 0; i < firstRound.matches.length; i++) {
    const p1 = seeded[i * 2] || null;
    const p2 = seeded[i * 2 + 1] || null;
    const match = firstRound.matches[i];

    match.player1Id = p1?.userId || null;
    match.player1Name = p1?.discordName || null;
    match.player2Id = p2?.userId || null;
    match.player2Name = p2?.discordName || null;

    if (p1 && p2) {
      match.status = 'pending';
    } else if (p1 || p2) {
      const winner = p1 || p2;
      match.winnerId = winner.userId;
      match.winnerName = winner.discordName;
      match.status = 'bye';
    }
  }

  const bracket = {
    mode: 'single_elimination',
    generatedAt: new Date(),
    rounds,
    championId: null,
    championName: null,
    status: 'active',
  };

  propagateWinners(bracket);
  return bracket;
}

function propagateWinners(bracket) {
  if (!bracket?.rounds?.length) return;
  for (let r = 1; r < bracket.rounds.length; r++) {
    const prev = bracket.rounds[r - 1].matches;
    const curr = bracket.rounds[r].matches;
    for (let i = 0; i < curr.length; i++) {
      const left = prev[i * 2] || null;
      const right = prev[i * 2 + 1] || null;
      const match = curr[i];

      const p1Id = left?.winnerId || null;
      const p1Name = left?.winnerName || null;
      const p2Id = right?.winnerId || null;
      const p2Name = right?.winnerName || null;

      match.player1Id = p1Id;
      match.player1Name = p1Name;
      match.player2Id = p2Id;
      match.player2Name = p2Name;
      match.activeMatchId = match.activeMatchId || null;

      if (p1Id && p2Id) {
        const existingWinnerStillValid = match.winnerId && (match.winnerId === p1Id || match.winnerId === p2Id);
        if (existingWinnerStillValid) {
          match.status = 'completed';
          match.loserId = match.winnerId === p1Id ? p2Id : p1Id;
          match.loserName = match.winnerId === p1Id ? p2Name : p1Name;
        } else {
          match.winnerId = null;
          match.winnerName = null;
          match.loserId = null;
          match.loserName = null;
          match.status = 'pending';
          match.activeMatchId = null;
        }
      } else if (p1Id || p2Id) {
        const winnerId = p1Id || p2Id;
        const winnerName = p1Name || p2Name;
        match.winnerId = winnerId;
        match.winnerName = winnerName;
        match.loserId = null;
        match.loserName = null;
        match.status = 'bye';
        match.activeMatchId = null;
      } else {
        match.winnerId = null;
        match.winnerName = null;
        match.loserId = null;
        match.loserName = null;
        match.status = 'waiting';
        match.activeMatchId = null;
      }
    }
  }

  const finalRound = bracket.rounds[bracket.rounds.length - 1];
  const finalMatch = finalRound?.matches?.[0];
  if (finalMatch?.winnerId) {
    bracket.championId = finalMatch.winnerId;
    bracket.championName = finalMatch.winnerName || null;
    bracket.status = 'completed';
  } else {
    bracket.championId = null;
    bracket.championName = null;
    bracket.status = 'active';
  }
}

function ensureBracket(tournament) {
  if (!tournament || !isBracketType(tournament.type)) return;
  if (!tournament.bracket?.rounds?.length) {
    tournament.bracket = createInitialBracket(tournament.participants || []);
    return;
  }
  propagateWinners(tournament.bracket);
}

function getPendingMatchForUser(tournament, userId) {
  const state = getQueueStateForUser(tournament, userId);
  return state.state === 'ready' ? state.match : null;
}

function getQueueStateForUser(tournament, userId) {
  if (!tournament?.bracket?.rounds?.length) return null;
  const uid = String(userId);
  let involvedAny = false;
  for (const round of tournament.bracket.rounds) {
    for (const match of round.matches || []) {
      const involved = String(match.player1Id || '') === uid || String(match.player2Id || '') === uid;
      if (!involved) continue;
      involvedAny = true;
      if (match.winnerId) {
        // If this match is completed and user lost, they are eliminated.
        if (String(match.winnerId) !== uid) {
          return { state: 'eliminated', match };
        }
        // User already won this match; keep scanning for next round assignment.
        continue;
      }
      if (!match.player1Id || !match.player2Id) {
        return { state: 'waiting_next_round', match };
      }
      if (match.status === 'pending' || match.status === 'in_progress') {
        return { state: 'ready', match };
      }
      return { state: 'waiting_next_round', match };
    }
  }
  if (!involvedAny) return { state: 'not_in_bracket', match: null };
  return { state: 'waiting_next_round', match: null };
}

function applyMatchResult(tournament, winnerId, loserId, activeMatchId = null) {
  if (!tournament?.bracket?.rounds?.length) return null;
  const w = String(winnerId);
  const l = String(loserId);
  let target = null;
  for (const round of tournament.bracket.rounds) {
    for (const match of round.matches || []) {
      const samePair =
        (String(match.player1Id || '') === w && String(match.player2Id || '') === l) ||
        (String(match.player1Id || '') === l && String(match.player2Id || '') === w);
      if (!samePair) continue;
      if (match.winnerId) continue;
      target = match;
      break;
    }
    if (target) break;
  }
  if (!target) return null;

  if (![String(target.player1Id || ''), String(target.player2Id || '')].includes(w)) return null;

  target.winnerId = w;
  target.winnerName = String(target.player1Id || '') === w ? target.player1Name : target.player2Name;
  target.loserId = l;
  target.loserName = String(target.player1Id || '') === l ? target.player1Name : target.player2Name;
  target.status = 'completed';
  target.activeMatchId = activeMatchId || target.activeMatchId || null;
  target.completedAt = new Date();
  propagateWinners(tournament.bracket);
  return target;
}

module.exports = {
  isBracketType,
  ensureBracket,
  getPendingMatchForUser,
  getQueueStateForUser,
  applyMatchResult,
};
