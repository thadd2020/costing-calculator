# Deploying to SiteGround

> Status: **research notes only** (milestone 1). The copy-paste checklist is finished and verified in milestone 5.

## What SiteGround's official docs confirm (read 15 Oct 2026)

Sources: [What is a Node.js Project?](https://www.siteground.com/kb/what-is-node-js-project), [How to create a Node.js project](https://www.siteground.com/kb/create-node-js-project), [How to manage a Node.js project in Site Tools](https://www.siteground.com/kb/manage-node-js-project), [launch blog post](https://www.siteground.com/blog/hosting-node-js-projects-with-siteground).

- Node.js Projects are on **GrowBig (5 projects), GoGeek (10), Cloud (unlimited)**. Not on StartUp.
- Created under Client Area > Websites > Node.js Projects > New Project. Deploy either by **importing a GitHub repo** (SiteGround GitHub App, one install per GitHub account) or by **uploading an archive** (.zip/.tar.gz/.tgz, max 128 MB).
- With GitHub linked, **every push to the linked branch triggers a rebuild and redeploy**. Auto-deploy can be paused, the repo switched or disconnected.
- Site Tools > Node.js > Deployment Options lets you set: framework preset, branch, **Node version**, package manager, **build command**, **output directory**, **environment variables**.
- Site Tools > Node.js > Logs keeps every deployment (author, branch, commit, status) with the full build log. Older builds can be deleted "to free inodes". The live build can't be deleted.
- Each project also has File Manager, **MySQL and PostgreSQL databases**, Backups, SSL/HTTPS enforce, Cron Jobs and SSH keys in Site Tools.
- Projects start on a temporary domain; your own domain can be assigned later.

## Not stated in the docs: must confirm in Site Tools or with support before going live

| Question | Why it matters | Our default |
|---|---|---|
| Which Node versions can be selected? | better-sqlite3 13 needs Node 22+ | `engines: >=22` |
| What is the start command, and is it configurable? | we need `npm start` (= `node server.js`) | `npm start` |
| Is `PORT` injected? | app must listen on the given port | reads `PORT`, falls back to 3000 |
| **Do files outside the build folder survive redeploys? Is there a writable path outside the build?** | **SQLite file must not be wiped** | `DATA_DIR`, default `./data` |
| Does the build step compile native modules (better-sqlite3)? | prebuilt binaries usually download; else needs a compiler | — |
| Is the process kept running, and how is it restarted? | sessions, nightly backup timer | — |

**Early warning about persistence:** the docs describe separate builds per deployment that can each be deleted to free inodes. That strongly suggests each deploy goes into a new folder, so **a database inside the repo folder (`./data`) would be lost on the next push.** Production `DATA_DIR` has to point outside the build folder (e.g. a folder in the account's home directory). If SiteGround can't guarantee such a path survives redeploys, the plan is to stop and move storage to the **MySQL database included with the project**, behind the existing `src/db/` module. See CLAUDE.md section 12.
