# Deploying to SiteGround

> Status: **research notes + live findings** (milestone 1). The copy-paste checklist is finished and verified in milestone 5.
>
> **Decision: production uses SiteGround's MySQL, not SQLite.** See "Verified on the live project" below and DECISIONS.md #15.

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

## Not stated in the docs: must confirm in Site Tools or with support before going live

| Question | Why it matters | Our default |
|---|---|---|
| ~~Which Node versions can be selected?~~ | 22 is selected and works | `engines: >=22` |
| ~~What is the start command?~~ | `npm start` runs (no field to change it) | `npm start` |
| ~~Is `PORT` injected?~~ | **Yes** | reads `PORT` |
| ~~Persistent files?~~ | **No writable persistent folder; using MySQL** | `DB_CLIENT=mysql` |
| ~~Native modules build?~~ | Yes, better-sqlite3 installed fine | — |
| Is the process kept running, and how is it restarted? | sessions, nightly backup timer | — |

**Early warning about persistence:** the docs describe separate builds per deployment that can each be deleted to free inodes. That strongly suggests each deploy goes into a new folder, so **a database inside the repo folder (`./data`) would be lost on the next push.** Production `DATA_DIR` has to point outside the build folder (e.g. a folder in the account's home directory). If SiteGround can't guarantee such a path survives redeploys, the plan is to stop and move storage to the **MySQL database included with the project**, behind the existing `src/db/` module. See CLAUDE.md section 12.
