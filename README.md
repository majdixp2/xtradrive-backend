# XtraDrive Backend

Minimal serverless API (Vercel Functions) backing the XtraDrive driver/rider ride sessions.

## Endpoints
- `POST /api/sessions` — create a new ride session, returns `{ success, code }`
- `GET /api/sessions/:code` — read a session's current state
- `PUT /api/sessions/:code` — merge-update a session's state

Data is stored in Upstash Redis with a 12-hour TTL per session (ride sessions are short-lived by design).
