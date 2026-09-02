# SkillHub — Controlled Beta Backend Checklist

This branch keeps SkillHub in a controlled beta state while the core marketplace flow is tested.

## Enabled for beta

- PostgreSQL persistence for users, services, availability, bookings, profiles, reviews, messages, reports and disputes.
- Unified user accounts: a normal user can buy services and publish services from the same account.
- JWT authentication and ownership checks for protected actions.
- Availability slots and booking lifecycle.
- Verified reviews only after a completed booking.
- Helmet, CORS allow-list, JSON body limit and authentication rate limiting.

## Intentionally disabled

- Real card collection.
- Real charges.
- Payouts/withdrawals.
- Browser-controlled payment state.

`GET /api/payments/config` must continue to report `enabled: false` until a payment provider is integrated server-side with verified webhooks.

## Required production environment variables

- `DATABASE_URL`
- `JWT_SECRET` (at least 32 random characters; never commit the real value)
- `FRONTEND_URL` (comma-separated allow-list)
- `NODE_ENV=production`

## Beta launch checks

1. `/api/health` returns `{ "status": "ok" }`.
2. Registration and login work with a test account.
3. A user can publish a service.
4. The service owner can publish an availability slot.
5. A different user can reserve that exact slot.
6. A user cannot reserve their own service.
7. Unauthorized users cannot change another user's data.
8. Booking status transitions are tested from both client and provider perspectives.
9. Reviews are rejected unless the booking is completed and belongs to the reviewer.
10. The frontend clearly labels the product as beta and does not imply that test payment values are real money.

## Before real payments

Do not enable payments by only changing a frontend flag. Add a payment provider on the backend, keep secret keys in environment variables, validate provider webhooks, make webhook processing idempotent, and only derive `payment_status` from trusted server-side events.
