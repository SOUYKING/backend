const RANKS = require('../config/ranks.json');

function getRank(points) {
  let rank = RANKS[0];
  for (const r of RANKS) {
    if (points >= r.minPoints) rank = r;
    else break;
  }
  return rank;
}

function getRankProgress(points) {
  const rank = getRank(points);
  const nextIdx = RANKS.indexOf(rank) + 1;
  if (nextIdx >= RANKS.length) return 100;
  const nextRank = RANKS[nextIdx];
  const range = nextRank.minPoints - rank.minPoints;
  if (range <= 0) return 100;
  const progress = ((points - rank.minPoints) / range) * 100;
  return Math.min(100, Math.max(0, progress));
}

function calculatePointsChange(winnerPoints, loserPoints) {
  const winnerRank = getRank(winnerPoints);
  const loserRank = getRank(loserPoints);
  const winnerIdx = RANKS.indexOf(winnerRank);
  const loserIdx = RANKS.indexOf(loserRank);

  let winPoints = 25;
  let lossPoints = 15;

  const rankDiff = loserIdx - winnerIdx;
  winPoints += rankDiff * 2;
  lossPoints -= rankDiff * 2;

  winPoints = Math.max(10, Math.min(40, winPoints));
  lossPoints = Math.max(5, Math.min(25, lossPoints));

  return { winPoints, lossPoints };
}

module.exports = { getRank, getRankProgress, calculatePointsChange, RANKS };
