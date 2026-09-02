# SkillHub admin API

This beta admin API is protected by JWT authentication plus the server-side `admin` role.

## Real dashboard data

- `GET /api/admin/stats` — real user, seller, service, booking and open-case counts. `testCommissions` is derived from completed bookings only and is not real collected money while payments remain disabled.
- `GET /api/admin/verifications` — pending identity verification requests.
- `PATCH /api/admin/verifications/:id` — mark a verification `verified` or `rejected`.
- `GET /api/admin/cases` — reports and disputes.
- `PATCH /api/admin/reports/:id` and `/api/admin/disputes/:id` — update case status.
- `GET /api/admin/users` — searchable account list.
- `PATCH /api/admin/users/:id/status` — suspend/reactivate a normal user account.

## Security changes included

Authentication now reloads the current role and account status from PostgreSQL on protected requests, verifies the JWT issuer, and blocks suspended accounts. Booking creation uses a database transaction so an availability slot is not lost if booking creation fails. Booking status changes now follow an explicit state transition policy.
