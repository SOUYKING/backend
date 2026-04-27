const axios = require('axios');

const IP_INFO_TOKEN = process.env.IPINFO_TOKEN;

class RealIPChecker {
  static getClientIP(req) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
      const ips = forwarded.split(',');
      return ips[0].trim();
    }
    const realIP = req.headers['x-real-ip'];
    if (realIP) return realIP;
    return req.connection?.remoteAddress || req.socket?.remoteAddress || req.ip || 'unknown';
  }

  static async checkIP(ip, req) {
    const result = {
      ip,
      isVPN: false,
      isProxy: false,
      isTor: false,
      isHosting: false,
      risk: 'low',
      country: null,
      city: null,
      isp: null,
      org: null,
      asn: null,
      proxyScore: 0,
    };

    if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') {
      return result;
    }

    if (IP_INFO_TOKEN) {
      try {
        const response = await axios.get(`https://ipinfo.io/${ip}?token=${IP_INFO_TOKEN}`, { timeout: 5000 });
        const data = response.data;

        result.country = data.country;
        result.city = data.city;
        result.isp = data.carrier?.name || data.org;
        result.org = data.org;

        const hostname = data.hostname || '';
        const asn = data.asn?.asn || '';
        
        if (
          hostname.includes('tor') ||
          hostname.includes('exit') ||
          asn.toLowerCase().includes('tor') ||
          asn.toLowerCase().includes('onion')
        ) {
          result.isTor = true;
          result.risk = 'high';
          result.proxyScore += 50;
        }

        if (
          data.privacy?.vpn ||
          hostname.includes('vpn') ||
          asn.toLowerCase().includes('vpn') ||
          asn.toLowerCase().includes('virtual') ||
          data.hosting || data.colo
        ) {
          result.isVPN = true;
          result.isHosting = data.hosting || false;
          result.risk = 'high';
          result.proxyScore += 40;
        }

        if (
          data.proxy?.proxy ||
          data.proxy?.tor ||
          data.proxy?.relay ||
          hostname.includes('proxy') ||
          asn.toLowerCase().includes('proxy') ||
          asn.toLowerCase().includes('datacenter') ||
          asn.toLowerCase().includes('cloud')
        ) {
          result.isProxy = true;
          result.risk = result.risk === 'high' ? 'high' : 'medium';
          result.proxyScore += 35;
        }

        const suspiciousISPs = ['hostinger', 'ovh', 'digitalocean', 'vultr', 'linode', 'aws', 'gce', 'azure', 'cloudflare'];
        if (suspiciousISPs.some(isp => (data.isp || data.org || '').toLowerCase().includes(isp))) {
          result.isHosting = true;
          result.proxyScore += 20;
        }
      } catch (error) {
        console.log('IPInfo lookup failed:', error.message);
      }
    } else {
      const localChecks = this.localCheck(ip);
      Object.assign(result, localChecks);
    }

    return result;
  }

  static localCheck(ip) {
    const result = { proxyScore: 0 };

    const privateRanges = [
      /^10\./,
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
      /^192\.168\./,
      /^127\./,
      /^169\.254\./,
      /^::1$/,
      /^fe80:/i,
    ];

    const isPrivate = privateRanges.some(range => range.test(ip));
    if (isPrivate) {
      result.isHosting = true;
      result.proxyScore += 15;
    }

    const hostingPatterns = [
      /^54\./, /^52\./, /^54\./,
      /^35\./, /^45\./, /^52\./
    ];

    if (hostingPatterns.some(p => p.test(ip))) {
      result.isHosting = true;
      result.proxyScore += 10;
    }

    return result;
  }

  static async checkIPBatch(ips) {
    const results = await Promise.all(ips.map(ip => this.checkIP(ip)));
    return results;
  }

  static analyzeIPPatterns(ipAddresses) {
    const uniqueIPs = [...new Set(ipAddresses.map(i => i.ip))];
    const analysis = {
      uniqueIPCount: uniqueIPs.length,
      totalLogins: ipAddresses.reduce((sum, i) => sum + i.loginCount, 0),
      suspicious: false,
      reasons: [],
    };

    if (uniqueIPs.length > 10) {
      analysis.suspicious = true;
      analysis.reasons.push(`High number of unique IPs: ${uniqueIPs.length}`);
    }

    const geoLocations = new Set(ipAddresses.map(i => i.country).filter(Boolean));
    if (geoLocations.size > 3) {
      analysis.suspicious = true;
      analysis.reasons.push(`Multiple locations: ${geoLocations.size} different countries`);
    }

    const recentLogins = ipAddresses.filter(i => {
      const weekAgo = new Date();
      weekAgo.setDate(weekAgo.getDate() - 7);
      return new Date(i.lastSeen) > weekAgo;
    });
    const recentUniqueIPs = [...new Set(recentLogins.map(i => i.ip))];

    if (recentUniqueIPs.length > 5) {
      analysis.suspicious = true;
      analysis.reasons.push(`Many recent IPs: ${recentUniqueIPs.length} in last 7 days`);
    }

    return analysis;
  }

  static async detectMultiaccountByIP(User) {
    const pipeline = [
      { $unwind: '$ipAddresses' },
      {
        $group: {
          _id: '$ipAddresses.ip',
          users: {
            $push: {
              discordId: '$discordId',
              discordName: '$discordName',
              isBanned: '$isBanned',
            }
          },
          count: { $sum: 1 },
          lastSeen: { $max: '$ipAddresses.lastSeen' }
        }
      },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } }
    ];

    const results = await User.aggregate(pipeline);

    const violations = results.map(group => ({
      ip: group._id,
      accounts: group.users,
      count: group.count,
      lastSeen: group.lastSeen,
      activeAccounts: group.users.filter(u => !u.isBanned).length,
    }));

    return violations;
  }

  static async flagSuspiciousUsers(User) {
    const suspiciousUsers = [];

    const users = await User.find({
      isBanned: false,
      'ipAddresses.1': { $exists: true }
    });

    for (const user of users) {
      const analysis = this.analyzeIPPatterns(user.ipAddresses);

      if (analysis.suspicious) {
        user.addAnticheatFlag(
          'suspiciousActivity',
          'medium',
          'SYSTEM',
          `IP pattern analysis: ${analysis.reasons.join('; ')}`
        );
        user.anticheatScore = Math.max(0, user.anticheatScore - 10);
        await user.save();
        suspiciousUsers.push(user.discordId);
      }
    }

    return suspiciousUsers;
  }
}

module.exports = RealIPChecker;