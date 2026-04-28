const mongoose = require('mongoose');

const tournamentSchema = new mongoose.Schema({
  // Basic info
  title: {
    type: String,
    required: true,
  },
  description: {
    type: String,
    required: true,
  },
  bannerImage: {
    type: String,
    default: null,
  },
  // Map info
  mapCode: {
    type: String,
    required: true,
  },
  mapName: {
    type: String,
    default: null,
  },
  // Rules
  rules: {
    type: String,
    required: true,
  },
  // Tournament settings
  type: {
    type: String,
    enum: ['1v1', '2v2', '3v3', '4v4'],
    default: '1v1',
  },
  startDate: {
    type: Date,
    required: true,
  },
  endDate: {
    type: Date,
    required: true,
  },
  registrationDeadline: {
    type: Date,
    default: null,
  },
  maxPlayers: {
    type: Number,
    default: 16,
    min: 2,
    max: 128,
  },
  minSkillRating: {
    type: Number,
    default: 0,
  },
  maxSkillRating: {
    type: Number,
    default: 3000,
  },
  prize: {
    type: String,
    default: null,
  },
  // Host info
  hostedBy: {
    discordId: String,
    discordName: String,
  },
  // Status
  status: {
    type: String,
    enum: ['registration', 'active', 'completed', 'cancelled'],
    default: 'registration',
  },
  // Participants
  participants: [{
    userId: String,
    discordName: String,
    rankingPoints: Number,
    epicName: String,
    registeredAt: Date,
    teamId: String, // For team modes
    teamName: String,
  }],
  // Matches
  matches: [{
    matchId: String,
    player1Id: String,
    player2Id: String,
    winnerId: String,
    score: String,
    status: String,
    reportedBy: String,
    verifiedBy: String,
    createdAt: Date,
    completedAt: Date,
  }],
  // Leaderboard
  leaderboard: [{
    userId: String,
    discordId: String,
    discordName: String,
    discordAvatar: String,
    wins: Number,
    losses: Number,
    points: Number,
  }],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('Tournament', tournamentSchema);