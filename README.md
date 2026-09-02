# SkillHub API

Production-oriented Express API backed by PostgreSQL.

## Local setup

1. Copy `.env.example` to `.env` and update its values.
2. Create the PostgreSQL database.
3. Run `npm install` and `npm start`.

The tables are created automatically. Create the first admin manually in PostgreSQL; public registration creates unified `user` accounts.

## Render

Use the repository Blueprint (`render.yaml`). After deployment, verify `/api/health` returns `{\"status\":\"ok\"}`.


## Payment readiness

The API records payment state and calculates a 10% platform commission for each new booking. The public `/api/payments/config` endpoint intentionally reports `enabled: false`: this release does not collect cards, mark bookings as paid, or transfer real money.

Real processing must only be enabled after an eligible account owner completes the payment provider's business and identity verification. Payment state must then be updated from verified provider webhooks, never from the browser.
