const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  discordId: {
    type: String,
    required: true,
    unique: true,
  },
  discordName: {
    type: String,
    required: true,
  },
  discordAvatar: {
    type: String,
    default: null,
  },
  epicGamesId: {
    type: String,
    default: null,
    unique: true,
    sparse: true,
  },
  epicGamesName: {
    type: String,
    default: null,
    unique: true,
    sparse: true,
  },
  epicVerified: {
    type: Boolean,
    default: false,
  },
  rankingPoints: {
    type: Number,
    default: 0,
  },
  wins: {
    type: Number,
    default: 0,
  },
  losses: {
    type: Number,
    default: 0,
  },
  draws: {
    type: Number,
    default: 0,
  },
  totalMatches: {
    type: Number,
    default: 0,
  },
  role: {
    type: String,
    enum: ['player', 'content_creator', 'staff', 'admin', 'owner'],
    default: 'player',
  },
  isOwner: {
    type: Boolean,
    default: false,
  },
  isBanned: {
    type: Boolean,
    default: false,
  },
  banReason: {
    type: String,
    default: null,
  },
  bannedAt: {
    type: Date,
    default: null,
  },
  bannedBy: {
    type: String,
    default: null,
  },
  tournamentWins: [{
    tournamentId: String,
    tournamentName: String,
    date: Date,
  }],
  tournamentHistory: [{
    tournamentId: String,
    tournamentName: String,
    placement: String,
    pointsDelta: Number,
    date: Date,
  }],
  lastEpicUpdate: {
    type: Date,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  lastActive: {
    type: Date,
    default: Date.now,
  },
  // ============ IP TRACKING & ANTICHEAT ============
  ipAddresses: [{
    ip: String,
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    loginCount: { type: Number, default: 1 },
    userAgents: [String],
  }],
  deviceFingerprints: [{
    fingerprint: String,
    firstSeen: { type: Date, default: Date.now },
    lastSeen: { type: Date, default: Date.now },
    count: { type: Number, default: 1 },
  }],
  accountsLinkedToIP: [{
    ip: String,
    discordId: String,
    discordName: String,
    linkType: { type: String, enum: ['shared_ip', 'same_device', 'same_location'] },
    detectedAt: { type: Date, default: Date.now },
  }],
  // ============ ANTICHEAT FLAGS ============
  anticheatFlags: {
    multiAccounting: { type: Boolean, default: false },
    suspiciousActivity: { type: Boolean, default: false },
    boostingDetected: { type: Boolean, default: false },
    vpnUsage: { type: Boolean, default: false },
    proxyDetected: { type: Boolean, default: false },
    modifiedClient: { type: Boolean, default: false },
  },
  anticheatScore: {
    type: Number,
    default: 100,
    min: 0,
    max: 100,
  },
  flagHistory: [{
    flag: String,
    severity: { type: String, enum: ['low', 'medium', 'high', 'critical'] },
    detectedBy: String,
    description: String,
    resolved: { type: Boolean, default: false },
    resolvedBy: String,
    resolvedAt: Date,
    createdAt: { type: Date, default: Date.now },
  }],
  // ============ PREMIUM/PAYMENT SYSTEM ============
  isPremium: {
    type: Boolean,
    default: false,
  },
  premiumExpiresAt: {
    type: Date,
    default: null,
  },
  premiumTier: {
    type: String,
    enum: ['none', 'basic', 'pro', 'elite'],
    default: 'none',
  },
  paymentHistory: [{
    transactionId: String,
    amount: Number,
    currency: { type: String, default: 'USD' },
    status: { type: String, enum: ['pending', 'completed', 'failed', 'refunded'] },
    provider: String,
    description: String,
    createdAt: { type: Date, default: Date.now },
  }],
  // ============ PROFILE RESET SYSTEM ============
  profileResetHistory: [{
    resetType: { type: String, enum: ['full', 'stats_only', 'rating_only'] },
    resetBy: String,
    resetByName: String,
    reason: String,
    previousStats: {
      wins: Number,
      losses: Number,
      draws: Number,
      totalMatches: Number,
      rankingPoints: Number,
    },
    resetAt: { type: Date, default: Date.now },
  }],
  // ============ DISCORD METADATA ============
  discordAccountCreatedAt: {
    type: Date,
    default: null,
  },
  discordJoinedAt: {
    type: Date,
    default: null,
  },
  // ============ TRUST SCORE ============
  trustScore: {
    type: Number,
    default: 100,
    min: 0,
    max: 100,
  },
  reportsReceived: {
    type: Number,
    default: 0,
  },
  reportsGiven: {
    type: Number,
    default: 0,
  },
  badges: [{
    type: String,
  }],
  // ============ QUEUE ABUSE PROTECTION ============
  queueCooldownUntil: {
    type: Date,
    default: null,
  },
  lastMatchLeaveAt: {
    type: Date,
    default: null,
  },
  dodgeCount: {
    type: Number,
    default: 0,
  },
  // ============ CHAT SAFETY ============
  mutedUntil: {
    type: Date,
    default: null,
  },
  mutedBy: {
    type: String,
    default: null,
  },
  // ============ WARNINGS & STRIKES ============
  warnings: [{
    warningId: String,
    type: { type: String, enum: ['anticheat', 'toxicity', 'disconnect', 'dispute', 'other'] },
    reason: String,
    givenBy: String,
    givenByName: String,
    expiresAt: Date,
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  }],
  strikes: {
    type: Number,
    default: 0,
  },
  strikesHistory: [{
    strikeId: String,
    reason: String,
    givenBy: String,
    givenByName: String,
    createdAt: { type: Date, default: Date.now },
  }],
});

userSchema.index({ 'ipAddresses.ip': 1 });
userSchema.index({ 'deviceFingerprints.fingerprint': 1 });
userSchema.index({ anticheatScore: 1 });
userSchema.index({ isBanned: 1 });
userSchema.index({ isPremium: 1 });
userSchema.index({ 'flagHistory.createdAt': -1 });

userSchema.methods.addIPAddress = function(ip, userAgent) {
  const existingIP = this.ipAddresses.find(entry => entry.ip === ip);
  if (existingIP) {
    existingIP.lastSeen = new Date();
    existingIP.loginCount += 1;
    if (userAgent && !existingIP.userAgents.includes(userAgent)) {
      existingIP.userAgents.push(userAgent);
    }
  } else {
    this.ipAddresses.push({
      ip,
      userAgent,
      firstSeen: new Date(),
      lastSeen: new Date(),
      loginCount: 1,
      userAgents: userAgent ? [userAgent] : [],
    });
  }
};

userSchema.methods.addDeviceFingerprint = function(fingerprint) {
  const existing = this.deviceFingerprints.find(entry => entry.fingerprint === fingerprint);
  if (existing) {
    existing.lastSeen = new Date();
    existing.count += 1;
  } else {
    this.deviceFingerprints.push({
      fingerprint,
      firstSeen: new Date(),
      lastSeen: new Date(),
      count: 1,
    });
  }
};

userSchema.methods.addAnticheatFlag = function(flag, severity, detectedBy, description) {
  this.flagHistory.push({
    flag,
    severity,
    detectedBy,
    description,
    createdAt: new Date(),
  });
  const scoreDecrement = { low: 5, medium: 15, high: 30, critical: 50 };
  this.anticheatScore = Math.max(0, this.anticheatScore - (scoreDecrement[severity] || 10));
  if (this.anticheatScore < 30) {
    this.anticheatFlags.suspiciousActivity = true;
  }
  if (this.anticheatScore < 15) {
    this.anticheatFlags.multiAccounting = true;
  }
};

userSchema.methods.addWarning = function(type, reason, givenBy, givenByName, daysUntilExpiry = 30) {
  const warningId = `WRN-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  this.warnings.push({
    warningId,
    type,
    reason,
    givenBy,
    givenByName,
    expiresAt: new Date(Date.now() + daysUntilExpiry * 24 * 60 * 60 * 1000),
    isActive: true,
    createdAt: new Date(),
  });
  return warningId;
};

userSchema.methods.addStrike = function(reason, givenBy, givenByName) {
  this.strikes += 1;
  const strikeId = `STR-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  this.strikesHistory.push({
    strikeId,
    reason,
    givenBy,
    givenByName,
    createdAt: new Date(),
  });
  if (this.strikes >= 3) {
    this.isBanned = true;
    this.banReason = `Auto-banned: 3 strikes accumulated`;
    this.bannedAt = new Date();
    this.bannedBy = 'SYSTEM';
  }
  return strikeId;
};

userSchema.methods.resetProfile = function(resetType, resetBy, resetByName, reason) {
  const previousStats = {
    wins: this.wins,
    losses: this.losses,
    draws: this.draws,
    totalMatches: this.totalMatches,
    rankingPoints: this.rankingPoints,
  };
  this.profileResetHistory.push({
    resetType,
    resetBy,
    resetByName,
    reason,
    previousStats,
    resetAt: new Date(),
  });
  if (resetType === 'full' || resetType === 'stats_only') {
    this.wins = 0;
    this.losses = 0;
    this.draws = 0;
    this.totalMatches = 0;
  }
  if (resetType === 'full' || resetType === 'rating_only') {
    this.rankingPoints = 0;
  }
  return previousStats;
};

userSchema.methods.getActiveWarnings = function() {
  return this.warnings.filter(w => w.isActive && new Date(w.expiresAt) > new Date());
};

userSchema.methods.getRiskLevel = function() {
  if (this.isBanned) return 'banned';
  if (this.anticheatScore >= 80) return 'safe';
  if (this.anticheatScore >= 50) return 'low';
  if (this.anticheatScore >= 30) return 'medium';
  if (this.anticheatScore >= 15) return 'high';
  return 'critical';
};

userSchema.methods.calculateTrustScore = function() {
  let score = 50;

  // Discord account age (up to 20 points)
  if (this.discordAccountCreatedAt) {
    const accountAgeDays = (Date.now() - new Date(this.discordAccountCreatedAt).getTime()) / (1000 * 86400);
    score += Math.min(20, Math.floor(accountAgeDays / 30));
  }

  // Server membership age (up to 15 points)
  if (this.discordJoinedAt) {
    const membershipDays = (Date.now() - new Date(this.discordJoinedAt).getTime()) / (1000 * 86400);
    score += Math.min(15, Math.floor(membershipDays / 14));
  }

  // Matches played (up to 15 points)
  score += Math.min(15, (this.totalMatches || 0));

  // Deductions for reports received (max -20)
  score -= Math.min(20, (this.reportsReceived || 0) * 5);

  // Deductions for dodges (max -15)
  score -= Math.min(15, (this.dodgeCount || 0) * 5);

  // Deductions for strikes (max -20)
  score -= Math.min(20, (this.strikes || 0) * 7);

  // Anticheat score bonus (up to 10)
  score += Math.floor(((this.anticheatScore || 100) - 50) / 10);

  // Epic verified bonus
  if (this.epicVerified) score += 5;

  this.trustScore = Math.max(0, Math.min(100, Math.round(score)));
  return this.trustScore;
};

module.exports = mongoose.model('User', userSchema);