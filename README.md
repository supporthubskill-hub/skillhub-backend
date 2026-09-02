# SkillHub API

Production-oriented Express API backed by PostgreSQL.

## Local setup

1. Copy `.env.example` to `.env` and update its values.
2. Create the PostgreSQL database.
3. Run `npm install` and `npm start`.

The tables are created automatically. Create the first admin manually in PostgreSQL; public registration can only create `client` and `provider` accounts.

## Render

Use the repository Blueprint (`render.yaml`). After deployment, verify `/api/health` returns `{\"status\":\"ok\"}`.
