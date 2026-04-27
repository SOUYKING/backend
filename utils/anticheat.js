const User = require('../models/User');

class AntiCheatSystem {
  static async trackLogin(req, user) {
    try {
      const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.connection?.remoteAddress || 'unknown';
      const userAgent = req.headers['user-agent'] || 'unknown';
      const fingerprint = req.headers['x-fingerprint'] || this.generateFingerprint(req);

      user.addIPAddress(ip, userAgent);
      user.addDeviceFingerprint(fingerprint);
      user.lastActive = new Date();
      await user.save();

      await this.checkMultiAccounting(user, ip, fingerprint);

      return { ip, userAgent, fingerprint };
    } catch (error) {
      console.error('Track login error:', error);
    }
  }

  static generateFingerprint(req) {
    const data = [
      req.headers['user-agent'],
      req.headers['accept-language'],
      req.headers['accept-encoding'],
      req.headers['sec-ch-ua'],
      req.headers['sec-ch-ua-mobile'],
      req.headers['sec-ch-ua-platform'],
    ].join('|');
    return this.hashString(data);
  }

  static hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `fp_${Math.abs(hash).toString(36)}`;
  }

  static async checkMultiAccounting(user, ip, fingerprint) {
    try {
      // Check IP duplicates
      const ipMatches = await User.find({
        'ipAddresses.ip': ip,
        discordId: { $ne: user.discordId },
      });

      if (ipMatches.length > 0) {
        user.addAnticheatFlag(
          'multiAccounting',
          'high',
          'SYSTEM',
          `IP ${ip} shared with ${ipMatches.length} other account(s): ${ipMatches.map(u => u.discordName).join(', ')}`
        );
        await user.save();

        // Flag other accounts too
        for (const match of ipMatches) {
          match.addAnticheatFlag(
            'multiAccounting',
            'high',
            'SYSTEM',
            `IP ${ip} shared with ${user.discordName}`
          );
          await match.save();
        }
      }

      // Check device fingerprint duplicates
      const fpMatches = await User.find({
        'deviceFingerprints.fingerprint': fingerprint,
        discordId: { $ne: user.discordId },
      });

      if (fpMatches.length > 0) {
        user.addAnticheatFlag(
          'boostingDetected',
          'medium',
          'SYSTEM',
          `Same device used by ${fpMatches.length} other account(s)`
        );
        await user.save();
      }
    } catch (error) {
      console.error('Check multi-accounting error:', error);
    }
  }

  static async detectVPN(user, ip) {
    // Simple VPN/proxy detection - could be enhanced with external API
    const suspiciousPatterns = [
      /^10\./, /^172\.(1[6-9]|2[0-9]|3[0-1])\./, /^192\.168\./,
      /^127\./, /^localhost/i,
    ];

    const isSuspicious = suspiciousPatterns.some(p => p.test(ip)) || ip.includes('::1');

    if (isSuspicious) {
      user.addAnticheatFlag('vpnUsage', 'low', 'SYSTEM', 'Suspicious IP address pattern detected');
      await user.save();
    }

    return isSuspicious;
  }

  static async analyzeMatchPattern(user) {
    try {
      const recentMatches = await require('../models/Match').find({
        $or: [{ player1DiscordId: user.discordId }, { player2DiscordId: user.discordId }],
        date: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
      });

      // Check for suspicious win patterns
      const winStreak = this.calculateWinStreak(recentMatches, user.discordId);
      const avgMatchDuration = this.calculateAvgMatchDuration(recentMatches);

      if (winStreak >= 10) {
        user.addAnticheatFlag('boostingDetected', 'high', 'SYSTEM', `${winStreak} win streak detected in 7 days`);
        await user.save();
      }

      if (avgMatchDuration < 60) { // Less than 60 seconds average
        user.addAnticheatFlag('suspiciousActivity', 'medium', 'SYSTEM', `Unusually fast match completion: ${avgMatchDuration}s average`);
        await user.save();
      }

      return { winStreak, avgMatchDuration };
    } catch (error) {
      console.error('Analyze match pattern error:', error);
    }
  }

  static calculateWinStreak(matches, discordId) {
    let streak = 0;
    let maxStreak = 0;

    for (const match of matches.sort((a, b) => b.date - a.date)) {
      const myId = match.player1DiscordId === discordId ? 'player1' : 'player2';
      const won = match.result === myId;

      if (won) {
        streak++;
        maxStreak = Math.max(maxStreak, streak);
      } else {
        streak = 0;
      }
    }

    return maxStreak;
  }

  static calculateAvgMatchDuration(matches) {
    if (matches.length === 0) return 0;
    const totalDuration = matches.reduce((sum, match) => {
      const duration = match.endTime && match.startTime
        ? (new Date(match.endTime) - new Date(match.startTime)) / 1000
        : 0;
      return sum + duration;
    }, 0);
    return Math.round(totalDuration / matches.length);
  }

  static async scanAllUsers() {
    try {
      const users = await User.find({ isBanned: false });
      let flagged = 0;

      for (const user of users) {
        // Check for multiple IPs
        const uniqueIPs = [...new Set(user.ipAddresses.map(i => i.ip))];
        if (uniqueIPs.length > 5) {
          user.addAnticheatFlag('suspiciousActivity', 'medium', 'SYSTEM', `High number of unique IPs: ${uniqueIPs.length}`);
          flagged++;
        }

        // Check for low anticheat score
        if (user.anticheatScore < 30) {
          user.addAnticheatFlag('multiAccounting', 'critical', 'SYSTEM', `Critical anticheat score: ${user.anticheatScore}`);
          flagged++;
        }

        await user.save();
      }

      return { scanned: users.length, flagged };
    } catch (error) {
      console.error('Scan all users error:', error);
    }
  }

  static getRiskLevel(score) {
    if (score >= 80) return { level: 'safe', color: '#22c55e', risk: 0 };
    if (score >= 50) return { level: 'low', color: '#eab308', risk: 1 };
    if (score >= 30) return { level: 'medium', color: '#f97316', risk: 2 };
    if (score >= 15) return { level: 'high', color: '#ef4444', risk: 3 };
    return { level: 'critical', color: '#dc2626', risk: 4 };
  }
}

module.exports = AntiCheatSystem;