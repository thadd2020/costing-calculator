---
name: siteground-node-deploy
description: Use when deploying, configuring or debugging a Node.js app on SiteGround deployed from GitHub - env vars, port, persistent storage, health check, rollback.
---

# SiteGround Node.js deploy

## Rule zero
Do not assume SiteGround's behaviour. Before relying on any item in "Verify first", read SiteGround's CURRENT official Node.js documentation and record what you found under "Verified facts". If a fact can't be confirmed, say so and stop rather than guessing.

## Verify first
- Supported Node.js versions
- How the start command and port are configured (and whether PORT is injected)
- How environment variables are set
- How GitHub deploys are triggered (branch, auto or manual)
- Where persistent files can live, and whether they survive redeploys (critical for SQLite)
- Log access and restart method

## Pre-deploy checklist
1. `npm test` passes and `npm start` works from a clean clone
2. App reads `PORT`, `DATA_DIR`, `SESSION_SECRET`, `ADMIN_PASSWORD_HASH` from env only
3. `.env.example` is current; `.env`, `data/`, `node_modules/` are gitignored; no secrets in git history
4. `/healthz` returns 200 without auth
5. `app.set('trust proxy', 1)` is set

## Deploy
1. Create the Node.js project in SiteGround and connect the GitHub repo and branch
2. Set env vars in SiteGround, not in the repo
3. Deploy, then check `/healthz`
4. Set the admin password hash, log in, run a real task end to end

## Rollback
Redeploy the previous known-good commit. Back up the database file BEFORE any deploy that includes a migration.

## Common failures
- App listens on a hard-coded port instead of `PORT`
- Database path inside the repo folder gets wiped on redeploy
- Missing env var in production only
- Cookies not sent because `secure` is set but the proxy isn't trusted

## Verified facts (fill in after the first successful deploy)
- Node version:
- Start command / port:
- Env var location:
- Persistent storage path:
- Deploy trigger:
- Gotchas found:
