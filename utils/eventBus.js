const EventEmitter = require('events');

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.io = null;
    this.middleware = new Map();
    this._defaultRoutes = null;
    this._dedupCache = new Map();
  }

  _isDuplicate(eventType, payload) {
    if (eventType !== 'receiveMessage') return false;
    if (!payload || !payload.sender || !payload.message) return false;
    const dedupKey = `${payload.sender}:${payload.message}:${payload.matchId || ''}`;
    const now = Date.now();
    const last = this._dedupCache.get(dedupKey);
    if (last && now - last < 500) {
      console.log(`[DUPLICATE_BLOCKED] receiveMessage from ${payload.sender} blocked within 500ms window`);
      return true;
    }
    this._dedupCache.set(dedupKey, now);
    if (this._dedupCache.size > 1000) {
      const oldest = Date.now() - 5000;
      for (const [k, t] of this._dedupCache) {
        if (t < oldest) this._dedupCache.delete(k);
      }
    }
    return false;
  }

  init(io) {
    this.io = io;
    this._registerDefaultRoutes();
  }

  _registerDefaultRoutes() {
    this._defaultRoutes = new Map([
      [/^admin:/, (p, ctx) => {
        if (!ctx.targets) return;
        ctx.targets.push('admin-room');
      }],
      [/^user:/, (p, ctx) => {
        if (!ctx.targets) return;
        ctx.targets.push('admin-room');
        const uid = (p && (p.discordId || p.userId || p.id));
        if (uid) ctx.targets.push(`user:${uid}`);
      }],
      [/^match:/, (p, ctx) => {
        if (!ctx.targets) return;
        ctx.targets.push('admin-room');
        if (p && p.matchId) ctx.targets.push(`match:${p.matchId}`);
      }],
      [/^chat:/, (p, ctx) => {
        if (!ctx.targets) return;
        if (p && p.matchId) ctx.targets.push(`match:${p.matchId}`);
      }],
      [/^queue:/, (p, ctx) => {
        if (!ctx.targets) return;
        ctx.targets.push('admin-room');
      }],
      [/^tournament:/, (p, ctx) => {
        if (!ctx.targets) return;
        ctx.targets.push('admin-room');
        const tid = p && (p.tournamentId || p.id);
        if (tid) ctx.targets.push(`tournament:${tid}`);
      }],
      [/^system:/, () => {}],
    ]);
  }

  emit(eventType, payload, { targets, source } = {}) {
    if (!this.io) return;

    if (this._isDuplicate(eventType, payload)) return;

    const resolvedTargets = Array.isArray(targets) ? [...targets] : [];

    try {
      if (!targets && this._defaultRoutes) {
        for (const [pattern, routeFn] of this._defaultRoutes) {
          if (pattern.test(eventType)) {
            routeFn(payload || {}, { targets: resolvedTargets });
          }
        }
      }
    } catch (routeErr) {
      console.error(`[EVENT] Route error for ${eventType}:`, routeErr.message);
    }

    const safePayload = (payload && typeof payload === 'object') ? payload : {};
    const logEntry = {
      type: eventType,
      timestamp: new Date().toISOString(),
      source: source || 'unknown',
      payload: this._summarize(safePayload),
      targets: [...resolvedTargets],
    };

    const SILENT_EVENTS = ['receiveMessage', 'admin:stats-update'];
    if (!SILENT_EVENTS.includes(eventType)) {
      console.log(`[EVENT] ${eventType} → ${resolvedTargets.join(', ') || '(none)'} from=${logEntry.source}`);
    }

    for (const [name, fn] of this.middleware) {
      try {
        fn(eventType, safePayload, [...resolvedTargets], { ...logEntry });
      } catch (e) {
        console.error(`[EVENT:${name}] Middleware error for ${eventType}:`, e.message);
      }
    }

    for (const target of resolvedTargets) {
      if (typeof target !== 'string' || !target) continue;
      this._emitToTarget(target, eventType, safePayload);
    }
  }

  _emitToTarget(target, eventType, payload) {
    try {
      if (target === 'admin-room') {
        const adminNs = this.io.of('/admin');
        if (adminNs) adminNs.to('admin-room').emit(eventType, { ...payload, _ts: Date.now() });
      } else if (target.startsWith('user:')) {
        const uid = target.slice(5);
        if (uid) this.io.to(target).emit(eventType, payload);
      } else if (target.startsWith('match:')) {
        const mid = target.slice(6);
        if (mid) this.io.to(mid).emit(eventType, payload);
      } else if (target.startsWith('tournament:')) {
        const tid = target.slice(11);
        if (tid) this.io.to(target).emit(eventType, payload);
      } else if (target.startsWith('socket:')) {
        const sid = target.slice(7);
        if (sid) this.io.to(sid).emit(eventType, payload);
      }
    } catch (e) {
      console.error(`[EVENT] Emit error to ${target}:`, e.message);
    }
  }

  _summarize(payload) {
    if (!payload || typeof payload !== 'object') return {};
    const s = { ...payload };
    for (const [k, v] of Object.entries(s)) {
      if (typeof v === 'string' && v.length > 120) s[k] = v.substring(0, 120) + '...';
    }
    return s;
  }

  use(name, fn) {
    if (typeof fn !== 'function') return;
    this.middleware.set(name, fn);
  }

  emitStatsUpdate() {
    this.emit('admin:stats-update', {}, { targets: ['admin-room'], source: 'eventBus' });
  }
}

module.exports = new EventBus();
