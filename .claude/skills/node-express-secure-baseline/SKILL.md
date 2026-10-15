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
