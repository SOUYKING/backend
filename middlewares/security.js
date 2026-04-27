const rateLimit = new Map();

function cleanupStaleRateLimits() {
  const now = Date.now();
  for (const [key, record] of rateLimit.entries()) {
    if (now > record.resetTime + 60000) {
      rateLimit.delete(key);
    }
  }
}

setInterval(cleanupStaleRateLimits, 120000);

const rateLimitMiddleware = (maxRequests = 100, windowMs = 60000, isAuthCallback = false) => {
  return (req, res, next) => {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded
      ? forwarded.split(',')[0].trim()
      : req.ip || req.connection?.remoteAddress || 'unknown';
    const now = Date.now();
    const key = `${ip}:${req.path}`;

    if (!rateLimit.has(key)) {
      rateLimit.set(key, { count: 1, resetTime: now + windowMs });
      return next();
    }

    const record = rateLimit.get(key);

    if (now > record.resetTime) {
      record.count = 1;
      record.resetTime = now + windowMs;
      return next();
    }

    record.count++;

    if (record.count > maxRequests) {
      if (isAuthCallback) {
        const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:3000';
        const retryAfter = Math.ceil((record.resetTime - now) / 1000);
        return res.redirect(`${FRONTEND_URL}?error=rate_limited&retryAfter=${retryAfter}`);
      }
      return res.status(429).json({
        message: 'Too many requests. Please wait before trying again.',
        retryAfter: Math.ceil((record.resetTime - now) / 1000),
      });
    }

    next();
  };
};

const globalRateLimit = rateLimitMiddleware(1000, 60000);
const authRateLimit = rateLimitMiddleware(60, 60000);
const matchRateLimit = rateLimitMiddleware(20, 60000);
const adminRateLimit = rateLimitMiddleware(100, 60000);

const securityHeaders = (req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.removeHeader('X-Powered-By');
  next();
};

const sanitizeInput = (req, res, next) => {
  const sanitize = (obj) => {
    if (!obj || typeof obj !== 'object') return obj;
    for (const key of Object.keys(obj)) {
      if (typeof obj[key] === 'string') {
        obj[key] = obj[key].replace(/[<>'"]/g, '');
      } else if (typeof obj[key] === 'object') {
        sanitize(obj[key]);
      }
    }
    return obj;
  };

  if (req.body) sanitize(req.body);
  if (req.query) sanitize(req.query);
  if (req.params) sanitize(req.params);
  next();
};

const validateDiscordId = (req, res, next) => {
  const discordId = req.params.discordId || req.body.discordId;
  if (discordId && !/^\d{17,19}$/.test(discordId)) {
    return res.status(400).json({ message: 'Invalid Discord ID format' });
  }
  next();
};

module.exports = {
  rateLimitMiddleware,
  globalRateLimit,
  authRateLimit,
  matchRateLimit,
  adminRateLimit,
  securityHeaders,
  sanitizeInput,
  validateDiscordId,
};