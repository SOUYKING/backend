# FNT Arena — Deployment & Setup Guide

## Overview
Fortnite 1v1 tournament matchmaking platform.  
Backend: Node.js + Express + Socket.io + MongoDB  
Frontend: React (Create React App)

---

## Repositories

| Component | GitHub URL |
|-----------|-----------|
| **Backend** | https://github.com/SOUYKING/backend |
| **Frontend** | https://github.com/SOUYKING/FRONTEND |

---

## Live URLs

| Service | URL |
|---------|-----|
| **Backend (Render)** | https://backend-97zg.onrender.com |
| **Frontend (Vercel)** | https://frontend-nine-zeta-89.vercel.app |
| **Custom Domain** | https://fntarena.online (pointed to Vercel via A records) |

---

## Architecture

### Backend (`/backend`)

**Stack:** Express, Socket.io, Mongoose, JWT, Discord OAuth

**Key files modified:**

| File | Change |
|------|--------|
| `app.js` | Server startup log fixed (no hardcoded `localhost`), port retry loop removed, CORS upgraded to support multiple origins (local dev + Render), `trust proxy` enabled, global `unhandledRejection` and `uncaughtException` handlers added |
| `utils/db.js` | MongoDB connection retry with 5 attempts (5s delay each), no longer crashes on failure, validates `MONGO_URI` is set before connecting, proper timeout options for Atlas, drops old unique indexes on `epicGamesId`/`epicGamesName` on startup |
| `utils/eventBus.js` | Added dedup cache for `receiveMessage` events (500ms window to block duplicates), suppressed noisy event logging for `receiveMessage` and `admin:stats-update` |
| `utils/adminSocket.js` | Added `activeAdminConnections` Map to track admin socket IDs, disconnects old socket when same admin reconnects, cleaner disconnect handling |
| `utils/socketManager.js` | (unchanged) |
| `core/GameEngine.js` | Removed duplicate `_startMatchmakingLoop()` method, preserved async version |
| `routes/auth.js` | OAuth callback now auto-constructs `redirect_uri` from request (no longer requires `DISCORD_CALLBACK_URL` env var), improved Discord error logging with status code and response body, added global error handlers, removed Discord guild membership requirement for login |
| `routes/match.js` | New `GET /match/:matchId/active-info` endpoint — allows any logged-in user to view active match info (spectator mode), removed strict participant check for match detail viewing |

### Frontend (`/frontend`)

**Stack:** React 18, React Router 6, Socket.io Client, Axios

**Key files modified:**

| File | Change |
|------|--------|
| `src/App.js` | Restructured with `AuthenticatedApp` component inside `<Router>` to enable `useNavigate()`, all `window.location.href` replaced with `navigate()`, socket event handlers use named functions for proper cleanup |
| `src/index.css` | Full design system: CSS variables, glassmorphism utilities, neon glow effects, skeleton loaders, page transitions, Orbitron/Inter/JetBrains Mono fonts, premium buttons and cards, `#0a0a0a` dark background |
| `src/App.css` | Animated background with glowing gradient overlay, modal system, notification toasts, form elements, pagination, tabs |
| `src/utils/api.js` | Production URL auto-detection (checks `window.location.hostname`), defaults to `https://backend-97zg.onrender.com` in production, keeps `localhost:5000` for dev, new `getActiveMatchInfo()` API function |
| `src/components/GamingIcons.js` | Animated background with real PNG assets (controller/headphone/keyboard/mouse/pistol/rifle/battle) floating in grid with parallax mouse movement, theme-colored CSS tints |
| `src/components/Sidebar.js` | Added mobile menu toggle with overlay, glassmorphism design |
| `src/pages/Login.js` | Complete landing page redesign: two-column hero with live tournament preview card (fetches from public API), feature section, trust signals, removed fake stats bar, Discord invite link |
| `src/pages/Dashboard.js` | Premium player rank card, stat grid, tournament list, skeleton loading |
| `src/pages/Tournaments.js` | Premium tournament cards with stage badges, prize display, progress bars, countdown timers |
| `src/pages/MatchPage.js` | Full live match interface: VS arena, smart chat scroll (new messages button instead of force-scroll), spectator mode (read-only view for shared links), staff tools, profile modals |
| `src/pages/CurrentGame.js` | VS area layout, player cards, no-game fallback |
| `src/pages/Account.js` | Epic verification with update button (removed Epic ID field — only Epic Games Username needed), 7-day cooldown enforcement |
| `src/pages/MatchHistoryPage.js` | Pagination (10 per page), enhanced match detail modal (player votes, full chat logs, evidence, full info) |
| `src/pages/AdminDashboard.js` | Redesigned Anticheat tab (clean cards with severity badges, user info, score, deduplication), removed IP Analysis tab, fixed tournament timezone offset in create form, enhanced match detail modal |
| `public/index.html` | Title set to "FNT Arena \| 1v1 Tournaments", favicon set to `logo.png` |

---

## Environment Variables

### Backend (set in Render Dashboard → Environment)

| Variable | Value | Notes |
|----------|-------|-------|
| `MONGO_URI` | `mongodb+srv://souy:king@souy.l3881fj.mongodb.net/fortnite?retryWrites=true&w=majority` | MongoDB Atlas connection string |
| `DISCORD_CLIENT_ID` | `1256251737938071643` | From Discord Developer Portal |
| `DISCORD_CLIENT_SECRET` | *(rotated)* | **Must be regenerated — was exposed in conversation** |
| `DISCORD_CALLBACK_URL` | `https://backend-97zg.onrender.com/auth/callback` | Also registered in Discord OAuth Redirects |
| `DISCORD_BOT_TOKEN` | *(rotated)* | **Must be regenerated — was exposed in conversation** |
| `DISCORD_GUILD_ID` | `1255081888377208842` | Discord server ID for membership check |
| `ADMIN_ROLE_ID` | `1256568436838895688` | |
| `STAFF_ROLE_ID` | `1256568436838895688` | |
| `CONTENT_CREATOR_ROLE_ID` | `1256568436838895688` | |
| `JWT_SECRET` | *(rotated)* | **Must be regenerated — was exposed in conversation** |
| `OWNER_DISCORD_ID` | `524975380608581644` | Super admin Discord ID |
| `FRONTEND_URL` | `https://frontend-nine-zeta-89.vercel.app` | Used for CORS and OAuth redirects |
| `IPINFO_TOKEN` | *(rotated)* | Optional — for IP geolocation in anti-cheat |

### Frontend (set in Vercel Dashboard → Environment Variables)

| Variable | Value |
|----------|-------|
| `REACT_APP_API_URL` | `https://backend-97zg.onrender.com` |
| `REACT_APP_SOCKET_URL` | `https://backend-97zg.onrender.com` |
| `REACT_APP_DISCORD_CLIENT_ID` | `1256251737938071643` |

---

## Discord Developer Portal Configuration

**URL:** https://discord.com/developers → your app

### OAuth2 → Redirects
- `https://backend-97zg.onrender.com/auth/callback`
- `https://frontend-nine-zeta-89.vercel.app`
- `http://localhost:3000` (for local dev)

### OAuth2 → General
- Client ID: `1256251737938071643`
- Client Secret: *(rotated)*

### Bot
- Token: *(rotated)*
- Privileged Gateway Intents: MEMBERS INTENT required for guild member checks

---

## Discord Server Membership

Users are NOT required to be in the Discord server to log in. The guild check was removed to avoid blocking new users. Role detection (admin/staff) still works for users who ARE in the guild.

**Server invite:** `https://discord.gg/hMA23CEPHZ` (for users who want to join)

**Login page** shows a Discord invite link below the login button.

---

## MongoDB Atlas

**Cluster:** `souy.l3881fj.mongodb.net`  
**Database:** `fortnite`  
**User:** `souy`  
**Password:** `king` *(should use a stronger password for production)*

### Network Access
- `0.0.0.0/0` (Allow All) — currently set for development; restrict in production

---

## DNS Configuration (Namecheap — fntarena.online)

| Type | Host | Value |
|------|------|-------|
| A | `@` | `76.76.21.21` |
| A | `@` | `76.76.21.98` |
| CNAME | `www` | `cname.vercel-dns.com` |

---

## How to Deploy

### Backend Deploy (Render)
1. Push to `main` branch of `SOUYKING/backend`
2. Render auto-deploys (connected via GitHub)
3. Or use **Manual Deploy → Deploy Latest Commit** in Render Dashboard

### Frontend Deploy (Vercel)
1. Push to `main` branch of `SOUYKING/FRONTEND`
2. Vercel auto-deploys (connected via GitHub)
3. Or use `npx vercel --prod` from the `frontend/` directory

---

## What To Do If Starting Fresh

If you open a new OpenCode/Claude session and need to reorient:

1. I have two repos: `SOUYKING/backend` and `SOUYKING/FRONTEND`
2. Backend runs on Render at `https://backend-97zg.onrender.com`
3. Frontend runs on Vercel at `https://frontend-nine-zeta-89.vercel.app`
4. Custom domain: `fntarena.online`
5. MongoDB Atlas: cluster `souy.l3881fj`, database `fortnite`, user `souy`
6. Discord app ID: `1256251737938071643`
7. All env vars are set in Render Dashboard and Vercel Dashboard
8. Secrets marked "rotated" need fresh values from Discord Developer Portal
9. Read this DEPLOY.md file for complete context

---

## Security Notes

### Exposed Secrets (rotate immediately if not already done)
- `DISCORD_CLIENT_SECRET`: Regenerate at Discord Developer Portal → OAuth2
- `DISCORD_BOT_TOKEN`: Regenerate at Discord Developer Portal → Bot
- `JWT_SECRET`: Generate new random 64-char string
- `IPINFO_TOKEN`: Regenerate at https://ipinfo.io

### .env files
- `backend/.env` and `frontend/.env` are gitignored and were removed from git history
- All environment variables should be set via Render/Vercel dashboards, not in .env files on the server

---

## Troubleshooting

### Backend crashes with "Exited with status 1"
- Check Render logs for the error
- Common causes: MongoDB connection failure, missing env vars, Discord API auth failure
- The app now has: MongoDB retry logic, unhandled rejection handler, and does not crash on DB failure

### "Invalid redirect_uri" during Discord login
- The backend auto-constructs the callback URL from the request headers
- Check Render logs for `Callback URL constructed:` to verify it matches what Discord expects
- Ensure the callback URL is registered in Discord Developer Portal → OAuth2 → Redirects

### 502 Bad Gateway
- Usually means the backend process crashed or timed out
- Check Render logs for the actual error
- On free Render tier, requests that take >30s may timeout

### MongoDB "Authentication failed"
- Check that `MONGO_URI` in Render env vars has correct username/password
- Check MongoDB Atlas → Database Access for user credentials
- Check MongoDB Atlas → Network Access allows Render's IPs (`0.0.0.0/0` for dev)
