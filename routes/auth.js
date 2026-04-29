const express = require('express');
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { isAdmin } = require('../utils/discord');
const User = require('../models/User');
const IPWhitelist = require('../models/IPWhitelist');
const { getRank } = require('../utils/rankSystem');
const authenticate = require('../middlewares/authenticate');
const eventBus = require('../utils/eventBus');
const router = express.Router();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';

function logAuthAttempt({ discordId, discordName, role, ip, success, reason, whitelisted, banned, altDetected, ...extra }) {
  const entry = {
    timestamp: new Date().toISOString(),
    discordId: discordId || 'unknown',
    discordName: discordName || 'unknown',
    role: role || 'unknown',
    ip: ip || 'unknown',
    success: !!success,
    reason: reason || null,
    whitelisted: !!whitelisted,
    banned: !!banned,
    altDetected: !!altDetected,
    ...extra,
  };
  if (success) {
    console.log(`[AUTH_OK]`, JSON.stringify(entry));
  } else {
    console.warn(`[AUTH_FAIL]`, JSON.stringify(entry));
  }
  return entry;
}

function isPrivateOrLocalIP(ip = '') {
  if (!ip) return true;
  const normalized = ip.replace('::ffff:', '').toLowerCase();
  if (normalized === '::1' || normalized === '127.0.0.1' || normalized === 'localhost') return true;
  if (normalized.startsWith('10.')) return true;
  if (normalized.startsWith('192.168.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized)) return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  return false;
}

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.headers['x-real-ip']
    || req.ip
    || req.connection?.remoteAddress
    || req.socket?.remoteAddress
    || 'unknown';
}

router.get('/callback', async (req, res) => {
  const { code } = req.query;
  const clientIP = getClientIP(req);

  if (!code) {
    logAuthAttempt({ ip: clientIP, success: false, reason: 'missing_oauth_code' });
    return res.redirect(`${FRONTEND_URL}?error=no_code`);
  }

  try {
    console.log("Processing OAuth callback with code:", code.substring(0, 20) + "...");

    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const callbackUrl = process.env.DISCORD_CALLBACK_URL || `${proto}://${req.get('host')}/auth/callback`;
    console.log('Callback URL constructed:', callbackUrl);

    const tokenResponse = await axios.post(
      'https://discord.com/api/oauth2/token',
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
        redirect_uri: callbackUrl,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );

    const { access_token } = tokenResponse.data;

    const userResponse = await axios.get('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const discordUser = userResponse.data;

    let userIsAdmin = false;
    let userRole = 'player';
    let isOwner = false;
    let isServerMember = false;
    let discordJoinedAt = null;

    if (process.env.DISCORD_GUILD_ID && process.env.DISCORD_BOT_TOKEN) {
      try {
        const guildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', {
          headers: { Authorization: `Bearer ${access_token}` },
        });

        const userGuilds = guildsResponse.data;
        const targetGuild = userGuilds.find(g => g.id === process.env.DISCORD_GUILD_ID);

        if (targetGuild) {
          isServerMember = true;
          userIsAdmin = await isAdmin(discordUser.id, process.env.DISCORD_GUILD_ID);

          const memberResponse = await axios.get(
            `https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordUser.id}`,
            {
              headers: {
                Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
              },
            }
          );

          const member = memberResponse.data;
          const roles = member.roles || [];
          discordJoinedAt = member.joined_at ? new Date(member.joined_at) : null;

          if (process.env.OWNER_DISCORD_ID && discordUser.id === process.env.OWNER_DISCORD_ID) {
            userRole = 'owner';
            userIsAdmin = true;
            isOwner = true;
          } else if (roles.includes(process.env.ADMIN_ROLE_ID)) {
            userRole = 'admin';
          } else if (roles.includes(process.env.CONTENT_CREATOR_ROLE_ID)) {
            userRole = 'content_creator';
          } else if (roles.includes(process.env.STAFF_ROLE_ID)) {
            userRole = 'staff';
          } else {
            userRole = 'player';
          }
        }

        console.log(`User ${discordUser.username} role: ${userRole}, Admin: ${userIsAdmin}`);
      } catch (err) {
        console.log("Role check failed, defaulting to player:", err.message);
        userIsAdmin = false;
        userRole = 'player';
      }
    }

    if (process.env.DISCORD_GUILD_ID && !isServerMember) {
      logAuthAttempt({ discordId: discordUser.id, discordName: discordUser.username, role: 'player', ip: clientIP, success: true, reason: 'not_in_guild_defaulted_player' });
      console.log(`User ${discordUser.username} not in guild, defaulting to player role`);
      userRole = 'player';
      userIsAdmin = false;
      isOwner = false;
    }

    // Owner check works regardless of guild membership
    if (process.env.OWNER_DISCORD_ID && discordUser.id === process.env.OWNER_DISCORD_ID && !isOwner) {
      userRole = 'owner';
      userIsAdmin = true;
      isOwner = true;
      console.log(`Owner override for ${discordUser.username}`);
    }

    let user;
    const userAgent = req.headers['user-agent'] || 'unknown';
    const discordAccountCreatedAt = discordUser.verified
      ? new Date(parseInt(discordUser.id) / 4194304 + 1420070400000)
      : null;

    try {
      user = await User.findOne({ discordId: discordUser.id });

      if (!user) {
        const fp = generateDeviceFingerprint(req);
        user = await User.create({
          discordId: discordUser.id,
          discordName: discordUser.username,
          discordAvatar: discordUser.avatar,
          discordAccountCreatedAt,
          discordJoinedAt,
          role: userRole,
          isOwner,
          rankingPoints: 0,
          wins: 0,
          losses: 0,
          totalMatches: 0,
          epicVerified: false,
          lastActive: new Date(),
          ipAddresses: [{
            ip: clientIP,
            firstSeen: new Date(),
            lastSeen: new Date(),
            loginCount: 1,
            userAgents: [userAgent]
          }],
          deviceFingerprints: [{
            fingerprint: fp,
            firstSeen: new Date(),
            lastSeen: new Date(),
            count: 1
          }]
        });
        user.calculateTrustScore();
        await user.save();
        console.log(`New user created: ${discordUser.username} (IP: ${clientIP})`);
      } else {
        user.discordName = discordUser.username;
        user.discordAvatar = discordUser.avatar;
        user.role = userRole;
        user.isOwner = isOwner;
        user.lastActive = new Date();
        if (discordJoinedAt && !user.discordJoinedAt) user.discordJoinedAt = discordJoinedAt;
        if (discordAccountCreatedAt && !user.discordAccountCreatedAt) user.discordAccountCreatedAt = discordAccountCreatedAt;

        trackIPAddress(user, clientIP, userAgent, req);

        user.calculateTrustScore();
        await user.save();
        console.log(`User updated: ${discordUser.username} (IP: ${clientIP})`);
      }
    } catch (dbError) {
      console.error('Database error during login:', dbError.message);
      logAuthAttempt({ discordId: discordUser.id, discordName: discordUser.username, role: userRole, ip: clientIP, success: false, reason: 'database_error' });
      return res.redirect(`${FRONTEND_URL}?error=server_error`);
    }

    if (user.isBanned) {
      logAuthAttempt({ discordId: discordUser.id, discordName: discordUser.username, role: userRole, ip: clientIP, banned: true, success: false, reason: `banned: ${user.banReason}` });
      eventBus.emit('admin:login-attempt', { discordId: discordUser.id, discordName: discordUser.username, role: userRole, ip: clientIP, success: false, reason: `banned: ${user.banReason}` }, { source: 'auth' });
      const reason = encodeURIComponent(user.banReason || 'Your account is banned.');
      return res.redirect(`${FRONTEND_URL}?error=banned&reason=${reason}`);
    }

    const isOwnerOrAdmin = userRole === 'owner' || userRole === 'admin' || isOwner || userIsAdmin;

    const whitelisted = !isPrivateOrLocalIP(clientIP)
      ? await IPWhitelist.exists({ ip: clientIP })
      : true;

    if (!isPrivateOrLocalIP(clientIP) && !whitelisted && !isOwnerOrAdmin) {
      try {
        const RealIPChecker = require('../utils/ipChecker');
        const ipInfo = await RealIPChecker.checkIP(clientIP);

        if (ipInfo?.isTor || ipInfo?.isProxy || ipInfo?.isVPN) {
          const flagType = ipInfo.isTor ? 'torUsage' : ipInfo.isProxy ? 'proxyDetected' : 'vpnUsage';
          const severity = ipInfo.isTor ? 'high' : ipInfo.isProxy ? 'medium' : 'low';

          await user.addAnticheatFlag(flagType, severity, 'SYSTEM', `Login from ${flagType} IP: ${clientIP}. ISP: ${ipInfo.isp || 'Unknown'}`);
          user.anticheatScore = Math.max(0, user.anticheatScore - (ipInfo.proxyScore || 10));
          user.calculateTrustScore();
          await user.save();

          console.warn(`[AUTH_FLAG] ${discordUser.username} logged in from ${flagType} IP: ${clientIP} (NOT blocked)`);
          eventBus.emit('admin:flag-raised', { discordId: discordUser.id, discordName: discordUser.username, flag: flagType, severity, ip: clientIP, description: `${flagType} from ${clientIP}` }, { source: 'auth' });
        }
      } catch (ipGuardError) {
        console.error('Login IP guard error:', ipGuardError.message);
      }
    }

    const token = jwt.sign(
      {
        id: discordUser.id,
        username: discordUser.username,
        avatar: discordUser.avatar,
        isAdmin: userIsAdmin || isOwner,
        role: userRole,
        isOwner,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    logAuthAttempt({ discordId: discordUser.id, discordName: discordUser.username, role: userRole, ip: clientIP, whitelisted, success: true });
    console.log(`User logged in: ${discordUser.username} (Role: ${userRole}, Admin: ${userIsAdmin || isOwner})`);
    eventBus.emit('admin:login-attempt', { discordId: discordUser.id, discordName: discordUser.username, role: userRole, ip: clientIP, success: true }, { source: 'auth' });
    eventBus.emitStatsUpdate();

    return res.redirect(`${FRONTEND_URL}?token=${token}`);

  } catch (error) {
    const discordErr = error.response?.data || {};
    const statusCode = error.response?.status || '';
    console.error('Error during OAuth callback:', statusCode, JSON.stringify(discordErr).substring(0, 300) || error.message);
    logAuthAttempt({ ip: clientIP, success: false, reason: discordErr.error || 'oauth_failed' });
    eventBus.emit('admin:login-attempt', { ip: clientIP, success: false, reason: discordErr.error || 'oauth_failed' }, { source: 'auth' });
    return res.redirect(`${FRONTEND_URL}?error=oauth_failed`);
  }
});

router.get('/verify', authenticate, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.user.id });

    return res.status(200).json({
      valid: true,
      user: {
        id: req.user.id,
        username: req.user.username,
        avatar: req.user.avatar,
        isAdmin: req.user.isAdmin,
        role: user?.role || 'player',
        isOwner: user?.isOwner || false,
        epicVerified: user?.epicVerified || false,
        epicGamesName: user?.epicGamesName || null,
        wins: user?.wins || 0,
        losses: user?.losses || 0,
        totalMatches: user?.totalMatches || 0,
        trustScore: user?.trustScore || 100,
        rank: getRank(user?.rankingPoints || 0).name,
        rankIcon: getRank(user?.rankingPoints || 0).icon,
        rankColor: getRank(user?.rankingPoints || 0).color,
      }
    });
  } catch (error) {
    console.error('Token verification failed:', error.message);
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
});

router.post('/verify-epic', authenticate, async (req, res) => {
  const { epicId, epicName } = req.body;

  if (!epicId || !epicName) {
    return res.status(400).json({ message: 'Epic Games ID and username are required' });
  }

  try {
    let user = await User.findOne({ discordId: req.user.id });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    if (user.lastEpicUpdate) {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      if (user.lastEpicUpdate > sevenDaysAgo) {
        const daysRemaining = Math.ceil((user.lastEpicUpdate.getTime() + 7 * 24 * 60 * 60 * 1000 - Date.now()) / (24 * 60 * 60 * 1000));
        return res.status(403).json({
          message: `You can only verify/change your Epic account once every 7 days. Try again in ${daysRemaining} day(s).`
        });
      }
    }

    const existingUser = await User.findOne({ epicGamesId: epicId });
    if (existingUser && existingUser.discordId !== req.user.id) {
      return res.status(409).json({ message: 'This Epic Games account is already linked to another user. Please contact staff if this is an error.' });
    }

    const existingByName = await User.findOne({ epicGamesName: epicName });
    if (existingByName && existingByName.discordId !== req.user.id) {
      return res.status(409).json({ message: 'This Epic Games display name is already linked to another user.' });
    }

    user.epicGamesId = epicId;
    user.epicGamesName = epicName;
    user.epicVerified = true;
    user.lastEpicUpdate = new Date();

    user.calculateTrustScore();
    await user.save();

    console.log(`Epic account verified for ${user.discordName}: ${epicName} (${epicId})`);

    res.json({
      message: 'Epic Games account verified successfully! You can now join tournaments.',
      epicName: epicName,
      epicVerified: true
    });
  } catch (error) {
    console.error('Epic verification error:', error);
    res.status(500).json({ message: 'Failed to verify Epic Games account. Please try again later.' });
  }
});

router.get('/skill-rating', authenticate, async (req, res) => {
  try {
    const user = await User.findOne({ discordId: req.user.id });

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const rank = getRank(user.rankingPoints || 0);

    res.json({
      wins: user.wins,
      losses: user.losses,
      totalMatches: user.totalMatches,
      rank: rank.name,
      rankIcon: rank.icon,
      rankColor: rank.color,
      trustScore: user.trustScore,
    });
  } catch (error) {
    console.error('Error fetching skill rating:', error);
    res.status(500).json({ message: 'Failed to fetch skill rating' });
  }
});

function generateDeviceFingerprint(req) {
  const data = [
    req.headers['user-agent'],
    req.headers['accept-language'],
    req.headers['accept-encoding'],
    req.headers['sec-ch-ua'] || '',
    req.headers['sec-ch-ua-mobile'] || '',
    req.headers['sec-ch-ua-platform'] || '',
    req.headers['sec-fetch-dest'],
    req.headers['sec-fetch-mode'],
  ].join('|');
  return hashString(data);
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `fp_${Math.abs(hash).toString(36)}`;
}

async function trackIPAddress(user, ip, userAgent, req) {
  const existingIP = user.ipAddresses.find(entry => entry.ip === ip);
  const fp = generateDeviceFingerprint(req);

  if (existingIP) {
    existingIP.lastSeen = new Date();
    existingIP.loginCount += 1;
    if (userAgent && !existingIP.userAgents.includes(userAgent)) {
      existingIP.userAgents.push(userAgent);
    }
  } else {
    user.ipAddresses.push({
      ip: ip,
      firstSeen: new Date(),
      lastSeen: new Date(),
      loginCount: 1,
      userAgents: userAgent ? [userAgent] : []
    });
  }

  const existingFP = user.deviceFingerprints.find(entry => entry.fingerprint === fp);
  if (existingFP) {
    existingFP.lastSeen = new Date();
    existingFP.count += 1;
  } else {
    user.deviceFingerprints.push({
      fingerprint: fp,
      firstSeen: new Date(),
      lastSeen: new Date(),
      count: 1
    });
  }
}

async function checkMultiAccounting(user) {
  try {
    const sameIPUsers = await User.find({
      'ipAddresses.ip': { $in: user.ipAddresses.map(i => i.ip) },
      discordId: { $ne: user.discordId }
    });

    if (sameIPUsers.length > 0) {
      console.log(`Multi-accounting detected: ${user.discordName} shares IP(s) with: ${sameIPUsers.map(u => u.discordName).join(', ')}`);

      for (const otherUser of sameIPUsers) {
        const alreadyFlagged = otherUser.flagHistory.some(f =>
          f.flag === 'multiAccounting' && f.description.includes(user.discordName)
        );

        if (!alreadyFlagged) {
          otherUser.addAnticheatFlag(
            'multiAccounting',
            'high',
            'SYSTEM',
            `Same IP (${user.ipAddresses[user.ipAddresses.length - 1]?.ip}) shared with new account: ${user.discordName}`
          );
          otherUser.anticheatScore = Math.max(0, otherUser.anticheatScore - 15);
          otherUser.calculateTrustScore();
          await otherUser.save();
        }
      }
    }

    const fp = user.deviceFingerprints[user.deviceFingerprints.length - 1]?.fingerprint;
    if (fp) {
      const sameDeviceUsers = await User.find({
        'deviceFingerprints.fingerprint': fp,
        discordId: { $ne: user.discordId }
      });

      if (sameDeviceUsers.length > 0) {
        console.log(`Same device detected: ${user.discordName} shares device with: ${sameDeviceUsers.map(u => u.discordName).join(', ')}`);

        for (const otherUser of sameDeviceUsers) {
          const alreadyFlagged = otherUser.flagHistory.some(f =>
            f.flag === 'boostingDetected' && f.description.includes(user.discordName)
          );

          if (!alreadyFlagged) {
            otherUser.addAnticheatFlag(
              'boostingDetected',
              'medium',
              'SYSTEM',
              `Same device used by: ${user.discordName}`
            );
            otherUser.anticheatScore = Math.max(0, otherUser.anticheatScore - 10);
            otherUser.calculateTrustScore();
            await otherUser.save();
          }
        }
      }
    }
  } catch (error) {
    console.error('Multi-account check error:', error);
  }
}

async function runIPAnalysis(user, clientIP) {
  try {
    const RealIPChecker = require('../utils/ipChecker');
    const ipInfo = await RealIPChecker.checkIP(clientIP);

    if (ipInfo.isVPN || ipInfo.isProxy || ipInfo.isTor) {
      const alreadyFlagged = user.flagHistory.some(f =>
        f.flag === 'vpnUsage' && f.description.includes(ipInfo.ip)
      );

      if (!alreadyFlagged) {
        const flagType = ipInfo.isTor ? 'torUsage' : ipInfo.isProxy ? 'proxyDetected' : 'vpnUsage';
        const severity = ipInfo.isTor ? 'high' : ipInfo.isProxy ? 'medium' : 'low';

        user.addAnticheatFlag(
          flagType,
          severity,
          'SYSTEM',
          `IP ${ipInfo.ip} detected as ${flagType}. ISP: ${ipInfo.isp || 'Unknown'}, Country: ${ipInfo.country || 'Unknown'}`
        );

        user.anticheatScore = Math.max(0, user.anticheatScore - ipInfo.proxyScore);
        user.calculateTrustScore();
        await user.save();

        console.log(`Privacy tool detected for ${user.discordName}: ${flagType} (IP: ${ipInfo.ip})`);
      }
    }

    if (ipInfo.risk === 'high') {
      user.anticheatFlags.vpnUsage = true;
      await user.save();
    }
  } catch (error) {
    console.error('IP analysis error:', error);
  }
}

router.get('/test', (req, res) => {
  res.json({ message: 'Auth router is working' });
});

module.exports = router;
