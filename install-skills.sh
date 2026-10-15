#!/usr/bin/env bash
# Installs Claude Code skills for THIS PROJECT ONLY (into ./.claude/skills).
# Nothing is written to ~/.claude, so other projects are unaffected.
# Run from the project root (the folder containing CLAUDE.md).
set -euo pipefail

if [ ! -f CLAUDE.md ] || [ "$PWD" = "$HOME" ]; then
  echo "Run this from the project folder (the one containing CLAUDE.md)." >&2
  exit 1
fi

SK=".claude/skills"
mkdir -p "$SK"

# ---- 1 + 2: Anthropic's frontend-design and skill-creator (copied, project-local) ----
TMP="$(mktemp -d)"
git clone --depth 1 https://github.com/anthropics/skills "$TMP/repo"
for name in frontend-design skill-creator; do
  src="$(find "$TMP/repo" -type d -name "$name" | head -n 1 || true)"
  if [ -n "$src" ]; then
    rm -rf "${SK:?}/$name"
    cp -r "$src" "$SK/$name"
    echo "Installed: $name"
  else
    echo "WARNING: '$name' not found in the repo - skipped" >&2
  fi
done
rm -rf "$TMP"

# ---- 3: siteground-node-deploy ----
mkdir -p "$SK/siteground-node-deploy"
cat > "$SK/siteground-node-deploy/SKILL.md" <<'EOF'
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
EOF

# ---- 4: node-express-secure-baseline ----
mkdir -p "$SK/node-express-secure-baseline"
cat > "$SK/node-express-secure-baseline/SKILL.md" <<'EOF'
---
name: node-express-secure-baseline
description: Use when building or reviewing a Node.js Express app that has login, forms, sessions, uploads or a database - security baseline checklist.
---

# Express security baseline

Apply to every new Express app. Report any item you deliberately skip.

## Authentication and sessions
- Passwords hashed with bcrypt (or argon2); never stored or logged in plain text
- Secrets only from environment variables; provide `.env.example`
- Session cookie: httpOnly, sameSite=lax, `secure` in production, sensible expiry
- Rate-limit login (e.g. 10 attempts per 15 minutes per IP); same error for wrong user or wrong password
- Regenerate the session on login; destroy it on logout

## Requests
- `helmet` with a deliberate CSP
- CSRF token on every state-changing request
- Validate and normalise every input server-side; reject unknown fields
- Parameterised SQL only; never build queries from strings
- Escape output (EJS `<%= %>`; never `<%- %>` on user data)

## Uploads
- Memory storage, strict size limit, allow-list of types checked by content not just extension
- Never write uploads to a web-served folder; never execute uploaded content

## Operations
- `app.set('trust proxy', 1)` behind a proxy
- Generic error pages in production; log detail server-side without secrets or personal data
- `npm audit` before release; keep dependencies few
- Export files: guard against spreadsheet formula injection (prefix cells starting with = + - @ with a single quote)

## Before finishing
List what was applied, what was skipped and why, and anything the owner must configure (env vars, backups).
EOF

# ---- 5: csv-import-preview-commit ----
mkdir -p "$SK/csv-import-preview-commit"
cat > "$SK/csv-import-preview-commit/SKILL.md" <<'EOF'
---
name: csv-import-preview-commit
description: Use when building a bulk CSV import feature - parse, validate, preview changes, then commit in one transaction.
---

# CSV import: parse, validate, preview, commit

## Flow
1. Upload (size and row limits, CSV only, memory storage)
2. Parse leniently: strip BOM, trim and lower-case headers, support header aliases, handle currency symbols, thousands separators, percent formats, yes/no booleans, mixed-case units
3. Validate every row; collect errors as `{row, field, message}` with plain-English messages that say how to fix it
4. Match against existing records on a documented natural key (e.g. lower(name) + lower(supplier))
5. Build a preview: counts of new / changed / unchanged / rejected; old vs new values and percentage change for changed rows; downloadable errors CSV
6. Store the parsed batch server-side (not in the browser) and commit from that stored batch only after explicit confirmation
7. Commit in ONE transaction; write history rows for changed values; summarise results; flag any knock-on effects

## Rules
- Nothing is written before confirmation
- Bad rows are skipped and reported; they never abort the good rows
- Re-uploading the same file must be a no-op (idempotent)
- Provide a downloadable template and an export in the same format so export, edit, re-import works
- Test with: BOM, wrong delimiter, blank lines, duplicate rows within the file, huge file, non-numeric prices, unknown units
EOF

# ---- 6: uk-restaurant-gp ----
mkdir -p "$SK/uk-restaurant-gp"
cat > "$SK/uk-restaurant-gp/SKILL.md" <<'EOF'
---
name: uk-restaurant-gp
description: Use for UK restaurant gross profit (GP) costing - dish costing, VAT handling, target pricing, delivery commission pricing and GP benchmarks.
---

# UK restaurant GP costing

Source for the method and benchmarks: Jelly Blog, "GP Margin Calculator for UK Restaurants" (blog.getjelly.co.uk/gp-margin-calculator-food-beverage). Benchmarks are indicative, not rules.

## Formulas (VAT = 0.20, waste as a fraction)
- unit cost = pack price ex-VAT / pack size in base units
- line cost = quantity x unit cost x (1 + waste)
- true cost = sum of line costs / portions
- price ex-VAT = menu price inc-VAT / (1 + VAT)
- GP money = price ex-VAT - true cost; GP % = GP money / price ex-VAT
- suggested price ex-VAT = true cost / (1 - target GP); inc-VAT = x (1 + VAT)
- delivery price ex-VAT = (price ex-VAT + packaging) / (1 - commission)
- delivery GP % = (revenue kept - packaging - true cost) / revenue kept, where revenue kept = delivery price ex-VAT x (1 - commission)
- markup % = (price - cost) / cost  (NOT the same as GP %; 70% GP = 233% markup)

## Rules of thumb
- ALWAYS calculate GP on ex-VAT figures; using VAT-inclusive prices overstates GP by about 17 points
- Many UK food ingredients are zero-rated; do not blindly divide supplier prices by 1.20. Store VAT per ingredient. Confirm specifics with the owner's accountant
- Typical targets: food 65-70%, drinks 65-75%; below about 60% is a warning sign; delivery after 25-35% commission lands around 35-40% effective GP
- Waste buffer: about 5-8% for fresh food, 1-3% for sealed drinks
- Round suggested prices UP only, so GP never falls below target
- Round only for display; calculate at full precision

## Test vector
Ingredient cost 4.50, waste 6% -> true cost 4.77. Menu 18.00 inc-VAT -> 15.00 ex-VAT, GP 10.23, GP% 68.2%. Target 70% -> 15.90 ex-VAT, 19.08 inc-VAT.
EOF

echo
echo "Done. Project-local skills installed:"
find "$SK" -name SKILL.md | sort
echo
echo "Start 'claude' in this folder to use them. Other folders are unaffected."
