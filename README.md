# XtraDrive Backend

Serverless API (Vercel Functions + Upstash Redis) for XtraDrive.

## Endpoints
Sessions (12-hour TTL):
- `POST /api/sessions` — create a session (driver identified by `Authorization: Bearer <token>`)
- `GET /api/sessions/:code` — read a session
- `PUT /api/sessions/:code` — merge-update a session

Driver accounts (email code sign-in, no passwords):
- `POST /api/auth/request-code` — `{ email, purpose?: "login" | "delete" }`
- `POST /api/auth/verify-code` — `{ email, code }` → `{ token, driver }`
- `GET | PUT | DELETE /api/auth/me` — profile / update / request deletion
- `POST /api/auth/delete-account` — web deletion `{ email, code }`

Pricing and admin:
- `GET /api/pricing` — pricing for all drivers
- `PUT /api/admin/pricing` — admin only
- `GET /api/admin/drivers` — admin only: drivers + daily usage

Account deletion: the account is signed out immediately and erased 30 days later
by the daily cron `/api/cron/purge`. Signing in during those 30 days cancels it.

## Environment variables (Vercel → Settings → Environment Variables)
- `KV_REST_API_URL`, `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) — added by the Upstash integration
- `GMAIL_USER` — sending Gmail address
- `GMAIL_APP_PASSWORD` — Gmail app password (16 characters)
- `ADMIN_EMAILS` — comma-separated admin emails
- `REVIEW_EMAIL`, `REVIEW_CODE` — fixed sign-in for Google Play reviewers
- `CRON_SECRET` — any long random string (secures the daily purge)
