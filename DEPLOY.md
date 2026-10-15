# Deploying to SiteGround

Production runs as a SiteGround **Node.js project** deployed from GitHub (`thadd2020/costing-calculator`, branch `main`), using the project's **MySQL** database. SQLite is for local development only, because SiteGround builds every deploy into a fresh folder.

## Checklist

### First-time setup (done 15 Oct 2026, kept for reference)

1. **Create the project:** Client Area > Websites > Node.js Projects > New Project > Import Git repository > `thadd2020/costing-calculator`, branch `main`.
2. **Node version:** Site Tools > Node.js > Deployment Options > Node version **22** (or newer). Package manager npm. SiteGround runs `npm start`.
3. **Database:** Site Tools > Site > MySQL. Create a database and a user, and give the user **All privileges** on the database. Note the full (prefixed) names and the host (usually `localhost`).

### Environment variables

Site Tools > Node.js > Deployment Options > Environment variables. **Save them before you deploy**: a deploy only gets the variables that were saved when it started.

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DB_CLIENT` | `mysql` |
| `DB_HOST` | from the MySQL page, usually `localhost` |
| `DB_PORT` | `3306` |
| `DB_NAME` | full database name |
| `DB_USER` | full user name |
| `DB_PASSWORD` | the user's password |
| `SESSION_SECRET` | a long random string (see below) |
| `ADMIN_PASSWORD_HASH` | the hash from `npm run set-password` (see below) |

Make the two secrets **on your own computer**, in the project folder:

```sh
# SESSION_SECRET: paste the output into Site Tools
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# ADMIN_PASSWORD_HASH: type your password twice (it isn't shown), paste the $2b$... line into Site Tools
npm run set-password
```

With `NODE_ENV=production`, the app **refuses to start** if the MySQL settings, `SESSION_SECRET` (32+ characters) or `ADMIN_PASSWORD_HASH` are missing, and the deploy log says which.

### Every deploy

1. On your computer: `npm test`. Everything must pass.
2. If the change includes a new file in `src/db/migrations/mysql/`, **back up first**: Settings > Export and backup > Full backup. MySQL can't roll back a half-applied migration.
3. `git push`. SiteGround builds and deploys automatically. (An empty commit may not trigger a build.)
4. Site Tools > Node.js > Logs: wait for the new entry to show as successful.
5. Open `https://<your domain>/healthz`. It must say `ok` (it also checks the database connection).
6. Log in and open a dish to check the figures look right.

### Setting or resetting the password

- **Normal change:** Settings > Change password. This also logs out every other device.
- **Forgotten password:** a password changed in the app is stored in the database and takes priority over `ADMIN_PASSWORD_HASH`. To reset it: make a new hash with `npm run set-password`, save it as `ADMIN_PASSWORD_HASH` and redeploy (so the app sees the new value). Then run this in **phpMyAdmin** (Site Tools > Site > MySQL > phpMyAdmin) so the app stops using the old in-app password:

  ```sql
  DELETE FROM settings WHERE `key` = 'admin_password_hash';
  ```

  Log in with the new password straight away; no restart needed.

### Rollback

1. Find the last good commit: `git log --oneline`.
2. Undo the bad one without rewriting history: `git revert <bad-commit>` then `git push`. SiteGround redeploys the previous behaviour.
3. Check `/healthz` and log in.
4. If the bad deploy damaged data: restore the database from **Site Tools > Security > Backups** (SiteGround's daily copy), or ask SiteGround support to restore the MySQL database from a backup. A JSON backup from the app can be loaded with `npm run restore -- backup.json` wherever the database is reachable (locally, that's your SQLite copy).

### Backups

- **Nightly (automatic):** the app saves a full snapshot inside the database every ~24 hours and keeps the newest 14. Download any of them from Settings > Export and backup.
- **Second location:** SiteGround's own daily backups (Site Tools > Security > Backups) include the MySQL database. Check this is switched on for the project.
- **Manual:** Settings > Export and backup > Full backup downloads everything except the password. Keep a copy off the server now and then (e.g. monthly, and before big imports).

### Logs

The app logs to stdout: start-up, migrations, nightly backups and errors (method, path and message only). It never logs passwords, secrets or CSV contents. Build logs are in Site Tools > Node.js > Logs.

## What SiteGround's official docs confirm (read 15 Oct 2026)

Sources: [What is a Node.js Project?](https://www.siteground.com/kb/what-is-node-js-project), [How to create a Node.js project](https://www.siteground.com/kb/create-node-js-project), [How to manage a Node.js project in Site Tools](https://www.siteground.com/kb/manage-node-js-project), [launch blog post](https://www.siteground.com/blog/hosting-node-js-projects-with-siteground).

- Node.js Projects are on **GrowBig (5 projects), GoGeek (10), Cloud (unlimited)**. Not on StartUp.
- Created under Client Area > Websites > Node.js Projects > New Project. Deploy either by **importing a GitHub repo** (SiteGround GitHub App, one install per GitHub account) or by **uploading an archive** (.zip/.tar.gz/.tgz, max 128 MB).
- With GitHub linked, **every push to the linked branch triggers a rebuild and redeploy**. Auto-deploy can be paused, the repo switched or disconnected.
- Site Tools > Node.js > Deployment Options lets you set: framework preset, branch, **Node version**, package manager, **build command**, **output directory**, **environment variables**.
- Site Tools > Node.js > Logs keeps every deployment (author, branch, commit, status) with the full build log. Older builds can be deleted "to free inodes". The live build can't be deleted.
- Each project also has File Manager, **MySQL and PostgreSQL databases**, Backups, SSL/HTTPS enforce, Cron Jobs and SSH keys in Site Tools.
- Projects start on a temporary domain; your own domain can be assigned later.

## Verified on the live project (davidt876.sg-host.com, 15 Oct 2026)

- **Node version: 22** (selected in Deployment Options). Package manager npm. No start command field shown, yet the app started, so SiteGround runs `npm start` (= `node server.js`). Building better-sqlite3 (a native module) also worked.
- No output directory field shown. No environment variables set by default.
- **Each deploy goes into a new folder** under `public_html/.nodeapp/`, e.g. `1234567890-origin` (first deploy) and `1792072990-r4o9zr` (next push), plus `latest` (777; points at the live build), `app.json` and `git.log`.
- **Therefore `./data` is fresh on every deploy, and the app can't write to the home folder.** SQLite is ruled out for production. Confirmed: the SQLite "created" time changed on each deploy (15:22:11, then 15:24:30).
- **`PORT` is injected** by SiteGround at runtime. The app reads it.
- **Environment variables set in Deployment Options reach the app at runtime**, but only for deploys started *after* they're saved. Change a variable, then redeploy.
- **MySQL works**: the database and user are created in Site Tools > Site > MySQL; the app connected with `DB_HOST`/`DB_PORT`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` and ran its migrations (created 15:36:43). The time stayed the same after a redeploy.
- **An empty commit may not trigger a deploy.** Push a real change, or redeploy from Site Tools.

## Open questions (answered ones struck through)

| Question | Why it matters | Our default |
|---|---|---|
| ~~Which Node versions can be selected?~~ | 22 is selected and works | `engines: >=22` |
| ~~What is the start command?~~ | `npm start` runs (no field to change it) | `npm start` |
| ~~Is `PORT` injected?~~ | **Yes** | reads `PORT` |
| ~~Persistent files?~~ | **No writable persistent folder; using MySQL** | `DB_CLIENT=mysql` |
| ~~Native modules build?~~ | Yes, better-sqlite3 installed fine | — |
| Is the process kept running, and how is it restarted? | sessions, nightly backup timer | — |

**Persistence (resolved):** the docs describe separate builds per deployment that can each be deleted to free inodes. That strongly suggests each deploy goes into a new folder, so **a database inside the repo folder (`./data`) would be lost on the next push.** Production `DATA_DIR` has to point outside the build folder (e.g. a folder in the account's home directory). If SiteGround can't guarantee such a path survives redeploys, the plan is to stop and move storage to the **MySQL database included with the project**, behind the existing `src/db/` module. See CLAUDE.md section 12.
