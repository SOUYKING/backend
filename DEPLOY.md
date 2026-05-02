# FNT Arena — Deployment & Current Project State

## READ THIS FIRST — for new chats & AI assistants

**If the user asks you to read `DEPLOY.md` (or “read deploy.md”) about hosting or the project:** treat **this file** as the primary briefing. You should infer:

| Topic | Where in this file |
|--------|-------------------|
| **What the product is** | [What is FNT Arena?](#what-is-fnt-arena) + [Overview](#overview) |
| **How to host / ship code** | [How hosting works](#how-hosting-works-summary), [Deploy Steps](#deploy-steps), [Environment Variables](#environment-variables) |
| **What was built recently** | [Changelog](#changelog-recent-shipped-work) |
| **Where code lives** | [Repositories](#repositories), [Local folder layout](#local-folder-layout-if-you-have-the-monorepo) |
| **Important files** | [Key Files Reference](#key-files-reference-high-impact) |
| **When something breaks** | [Troubleshooting](#troubleshooting) |

**Suggested reply pattern after reading:** briefly restate stack (backend on Render, frontend on Vercel, MongoDB, Discord OAuth), confirm two GitHub repos, and follow user instructions using paths under `backend/` and `frontend/`.

**Keeping this doc useful:** when you ship meaningful features or infra changes, append a short bullet under [Changelog](#changelog-recent-shipped-work) and bump [Last doc update](#last-doc-update) below.

### Last doc update
- **Purpose:** onboarding + deploy reference for humans and AI.
- **Changelog:** Socket JWT handshake, security/UI hardening — see changelog (May 2026).

---

## What is FNT Arena?

**FNT Arena** is a web app where players **log in with Discord**, join **time-boxed Fortnite tournaments** (1v1 or squads 2v2 / 3v3 / 4v4), **queue for opponents**, enter a **live match room** (chat, map code, result reporting), and earn **rank points** and **tournament leaderboard** stats. **Staff/admin** can handle disputes and force results. **Teams** (rosters + captain) back squad tournaments; **only captains** queue and submit official results; **teammates** join the match room like players.

---

## How hosting works (summary)

1. **Code** is in **two separate GitHub repos** — backend and frontend (see table below). Day-to-day: commit to `main`, push; hosts usually auto-deploy.
2. **Backend** runs on **Render** (Node server: HTTP API + **Socket.io**). It needs **MongoDB** (e.g. Atlas) and **Discord** app credentials in Render env vars.
3. **Frontend** runs on **Vercel** (static/React build). It must point to the live backend via `REACT_APP_API_URL` and `REACT_APP_SOCKET_URL`.
4. **Custom domain** (e.g. `fntarena.online`) typically points to **Vercel**; OAuth redirect / CORS must include that URL and the backend callback URL in Discord’s developer portal.

No secrets belong in this markdown — only in Render/Vercel dashboards.

---

## Local folder layout (if you have the monorepo)

Some developers keep one folder with both apps (not a single git repo):

```
fortnite-1v1-tournament-main/
  DEPLOY.md          ← this file (may exist only locally at repo root)
  backend/           ← git repo: SOUYKING/backend
  frontend/          ← git repo: SOUYKING/FRONTEND
```

Each of `backend/` and `frontend/` may also contain its **own copy** of `DEPLOY.md` (same content, committed to GitHub).

---

## Overview

Fortnite tournament matchmaking platform: **1v1**, **2v2**, **3v3**, and **4v4** (squads use the same match lifecycle as solos, with team entities and captain rules).

- Backend: Node.js, Express, Socket.io, MongoDB (Mongoose), JWT, Discord OAuth
- Frontend: React (CRA), React Router, Socket.io client, Axios
- Hosting: Render (backend), Vercel (frontend), Namecheap custom domain

---

## Repositories

| Component | GitHub URL |
|---|---|
| Backend | https://github.com/SOUYKING/backend |
| Frontend | https://github.com/SOUYKING/FRONTEND |

---

## Live URLs

| Service | URL |
|---|---|
| Backend | https://backend-97zg.onrender.com |
| Frontend | https://frontend-nine-zeta-89.vercel.app |
| Custom Domain | https://fntarena.online |

---

## Changelog (recent shipped work)

Use this section to confirm production matches `main` on both repos after deploy.

### May 2026 — tournament max players
- **Backend / Frontend:** `maxPlayers` schema and admin create/edit forms allow up to **300** (was 128).

### May 2026 — security, sockets, UI polish
- **Backend (`SOUYKING/backend`):** Socket.io **`io.use` JWT** — `socket.userId` is set only from a valid Bearer token in `handshake.auth` (optional anonymous connect without token). `register` only reattaches queue `socketId` (no client-supplied Discord id). **`GET /auth/emergency-login` disabled** (405; use POST only). **`GET /teams/search-users`** escapes regex in the query. **`GET /announcements`** is public (active rows only; no auth).
- **Frontend (`SOUYKING/FRONTEND`):** **`utils/gameSocket.js`** — connect after login with `auth.token`; **`App.js`** uses it instead of anonymous auto-connect. **Sidebar:** Notifications link, safe `user` JSON parse, `user-updated` refreshes admin section. **NotificationPage:** safe local notifications parse; announcements via **`getAnnouncements`**. **Dashboard:** safe stored user parse. **QueuePage:** team validation before “joining” state; `register` without spoofed id. **MatchPage:** chat errors/warnings in **`chatNotice`** banner (not mixed with result status). **`api.js`:** **`leaveActiveMatch`** → `POST /match/leave`. **Login:** removed fake random “matches” stat.

### Squad modes (2v2 / 3v3 / 4v4) — behavior summary
- **Queue:** Only the **team captain** joins queue (socket `joinQueue` and REST `POST /matchmaking/join`). Team row in memory uses `userId: team:<MongoId>`, `teamMemberIds`, `captainId`, `teamSize`, average RP for pairing.
- **Matchmaking:** Pairs two queue entries in the **same tournament** (closest average RP), same as 1v1 but each entry can be a full team.
- **Match room:** Any roster member can `joinMatch`; chat uses expected player count for the “room ready” system message (see backend `expectedMatchRoomPlayers`).
- **Results:** Only **captains** submit `POST /match/:matchId/result`. Two captain reports → agree, dispute, or auto-resolve (same as 1v1).
- **Ranking:** `calculatePointsChange(winnerAvg, loserAvg)` uses **average** RP of each side; **every** member gets the same `+winPoints` / `−lossPoints`; per-user rank tiers still come from individual `rankingPoints`. Tournament leaderboard rows update per member. `Team` model gets `statsWins` / `statsLosses` once per match.
- **Persistence:** Completed `Match` document stores captains as `player1`/`player2` references; full roster already received RP updates in `finishMatch`.

### Backend (`SOUYKING/backend`, `main`)
- **`routes/match.js`**
  - `GET /match/current`: correct User/avatar handling when `userId` is `team:…` (caller + opponent captain lookups).
  - `GET /match/:matchId/active-info`: `sides`, `teamMatch`, `participantSide`, `isTeamCaptain`, staff/participant detection.
  - **`POST /match/:matchId/evidence` (active match):** participation uses `isActiveMatchParticipant` so **all teammates** can upload evidence (not only raw `player1.userId` / `player2.userId`).
  - Helpers: `buildActiveMatchSide`, `isQueueEntityParticipant`, `isActiveMatchParticipant`.
- **`app.js`**
  - `expectedMatchRoomPlayers` + squad-aware “all players in room” chat message (waits for full roster count in team modes).
  - Socket **`register`:** reattaches queue `socketId` for **captain only** when `teamMode` (fixes captain reconnect; avoids teammates overwriting captain socket).
- **`core/GameEngine.js`:** team queue validation, `submitMatchResult` / `finishMatch` for squads (no change list here — see code).
- **`routes/matchmaking.js`**, **`routes/teams.js`**, **`app.js` `joinQueue`:** team size, captain, accepted members, locks — aligned with tournament `type`.

### Frontend (`SOUYKING/FRONTEND`, `main`)
- **`utils/api.js`:** `resolveDisplayAvatar` for API URLs vs Discord hashes.
- **`pages/MatchPage.js` + CSS:** squad layout, `active-info` integration, captain reporting; on match complete clears `localStorage.currentMatchId` and dispatches `current-match-ended`.
- **`pages/CurrentGame.js` + CSS:** **multiple** registered tournaments (sort: match’s tournament first, then queue-open); squad hints; avatars via `resolveDisplayAvatar`.
- **`pages/Tournaments.js` + CSS:** `joinTournament` before queue when live; **Registered** badge; squad copy; `getMyRegisteredTournaments` merged into fetch.
- **`pages/Dashboard.js` + CSS:** `lifecycleStage` filtering; **live match** banner; per-tournament **Queue** links when open.
- **`pages/QueuePage.js` + CSS:** teammate hint + link to Current Game; team select flow.
- **`App.js`:** `current-match-ended` listener; improved `matchFound` navigation state (Discord display name from profile).
- **`components/Sidebar.js` + CSS:** **Live** pill on Current Game when `liveMatchId` set.

### Git references (verify on GitHub if needed)
- Backend: includes commits such as **team `/current` + room message**, **evidence + register fixes** (e.g. `d069c51` area).
- Frontend: includes **multi-tournament / join / UX** commits through **live match sidebar + dashboard** (e.g. `a954bef` area).

---

## Current Production Features (Cumulative)

### Core flow
- Tournaments → register/join queue → match → history; **1v1 and squad tournaments** supported.
- **Current Game:** multiple open registrations, live match return, squad copy.
- **Queue:** team selection, captain-only queue, refresh, teammate guidance.
- **Match page:** roster sides, hub UI, captain result submission, staff/owner tools as implemented.

### Account + match history
- Account, match history, and admin flows as previously documented (Epic, disputes, staff alerts, etc.).

### Tournaments + dashboard
- Stage filters, banners, **join tournament** before queue when live, registered badges.
- Dashboard: active tournaments with queue links, live match banner.

### Background + UI polish
- Gaming icons background, motion, and related `App.css` / `GamingIcons.js` behavior.

---

## Key Files Reference (high impact)

### Backend
| File | Notes |
|------|--------|
| `app.js` | Socket: `joinQueue`, `joinMatch`, `register`, match found emit, room-ready message, CORS |
| `core/GameEngine.js` | Queue, matchmaking, active matches, results, `finishMatch`, RP for full roster |
| `routes/match.js` | `/current`, `/active-info`, evidence, history, dispute resolve |
| `routes/matchmaking.js` | REST queue join (solo + team) |
| `routes/tournament.js` | Lifecycle, join/leave, mine/registered |
| `routes/teams.js` | Teams API |
| `utils/rankSystem.js` | `getRank`, `calculatePointsChange` |

### Frontend
| File | Notes |
|------|--------|
| `App.js` | Auth, socket, `matchFound`, `current-match-ended` |
| `pages/MatchPage.js` | Live match UI, `getActiveMatchInfo` |
| `pages/QueuePage.js` | Queue + team select |
| `pages/CurrentGame.js` | Registrations + live match |
| `pages/Tournaments.js` | Browse + join |
| `pages/Dashboard.js` | Home + live banner |
| `components/Sidebar.js` | Nav + live indicator |
| `utils/api.js` | HTTP client, `resolveDisplayAvatar` |

---

## Environment Variables

Set values in dashboards (Render/Vercel). Do not commit secrets to git.

### Backend (Render)
- `MONGO_URI`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_CALLBACK_URL`
- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`
- `ADMIN_ROLE_ID`
- `STAFF_ROLE_ID`
- `CONTENT_CREATOR_ROLE_ID`
- `JWT_SECRET`
- `OWNER_DISCORD_ID`
- `FRONTEND_URL`
- `IPINFO_TOKEN` (optional)

### Frontend (Vercel)
- `REACT_APP_API_URL`
- `REACT_APP_SOCKET_URL`
- `REACT_APP_DISCORD_CLIENT_ID`

---

## Deploy Steps

### Backend deploy (Render)
1. Push to `main` in `SOUYKING/backend`.
2. Render auto-deploys from GitHub.
3. If needed: Render Dashboard → Manual Deploy → Deploy latest commit.

### Frontend deploy (Vercel)
1. Push to `main` in `SOUYKING/FRONTEND`.
2. Vercel auto-deploys from GitHub.
3. Optional manual deploy from `frontend/`: `npx vercel --prod`.

### After deploy checklist
- Open frontend with `REACT_APP_API_URL` / `REACT_APP_SOCKET_URL` pointing at the deployed backend.
- Smoke test: login, **1v1 queue**, **2v2** (captain queue, teammate Current Game), match complete, RP/leaderboard row updates.
- Confirm Render env `FRONTEND_URL` matches the site users use (CORS + OAuth).
- Verify search ownership files and sitemap endpoints:
  - Google verification file must be at root (example): `https://fntarena.online/googleXXXXXXXXXXXX.html`
  - Bing verification file must be at root: `https://fntarena.online/BingSiteAuth.xml`
  - Sitemap is separate (indexing, not ownership): `https://fntarena.online/sitemap.xml`

---

## Fresh session — paste for the user (optional)

You can paste this in a new chat **after** attaching or pointing to `DEPLOY.md`:

> Read `DEPLOY.md` first. Repos: `SOUYKING/backend` + `SOUYKING/FRONTEND`. Backend: Render. Frontend: Vercel. Domain: fntarena.online. Then: [your task].

---

## Security Checklist

- Rotate any previously exposed secrets immediately.
- Keep all secrets only in Render/Vercel environment settings.
- Never store real credentials/tokens inside `DEPLOY.md` or committed files.

---

## Troubleshooting

### Login/OAuth issues
- Confirm callback URL in Discord app matches backend callback route.
- Check Render logs for OAuth errors and rejected redirects.

### Queue or match sync issues
- Verify frontend and backend are both deployed to latest commits.
- Check socket connection URL and CORS allowlist.

### Squad-specific issues
- **Teammate can’t join room:** use **Current Game** or direct `/match/:matchId`; captain must have gotten a match; all members must be on `teamMemberIds`.
- **No match found event for teammate:** expected — only captain’s socket gets `matchFound`; teammates use HTTP `/match/current` or navigation.
- **Evidence 403:** deploy backend that includes `isActiveMatchParticipant` on active match evidence route.

### Data/API mismatch
- Confirm both repos are on expected versions (`main`) and deployments completed.
- Rebuild frontend if stale bundle is suspected.
