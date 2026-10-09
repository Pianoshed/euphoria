# Audit notes

## Fixed (all covered by tests; wallet/tests/test_hardening.py)
- square: `display_name` lives on Profile, not User -> tests fixed, `_who()` reads the profile (was always falling back to username).
- stub payment provider could be selected in production (docstring claimed a guard that did not exist) and auto-credits wallets. Now refused unless DEBUG / ALLOW_STUB_PAYMENTS / tests. Empty webhook secret never verifies.
- withdrawals: daily-limit check raced (read before the wallet lock). Now serialized per user on the wallet row. Idempotency key replayed with a different amount/account is rejected.
- earnings payouts: reservations from two in-flight payouts overwrote each other's `reservation_key`; settlement now uses the per-withdrawal allocations. Bank reversal of a COMPLETED earnings payout used to 500 (webhook retried forever, user never refunded) - now restores earnings. Forged/unreserved allocations rejected. View no longer double-releases a reservation after the withdrawal row exists; password checked before reserving.
- post-settlement refunds always failed when a platform fee applied (compared planner net vs gross). Planner now bears only their net share.
- gifts: never expired (funds stuck forever); accepting an expired gift rolled its own status change back and never returned the money. Gifts now expire (GIFT_EXPIRY_DAYS, default 7), `expire_gifts` command added. Idempotency replay checks recipient/amount; concurrent same-key create handled.
- deposits: concurrent same-key initiate raised IntegrityError (500); a signed full-payment webhook after a FAILED mark was ignored (customer paid, not credited).
- legacy escrow rows (paid_amount=0 after migration) refunded 0; now refund in full. Staff can no longer adjust their own wallet.
- tests: missing chat/tests/__init__.py, stale duplicate economy tests (contradicting design) replaced, bad usernames in group-cap test.

## Round 2 (also fixed, tested)
- Withdrawals (wallet + earnings) now require an authenticator code (`otp_code`) when 2FA is on; rate-limited.
- Deposits are re-verified with Monnify (GET /api/v2/transactions/{ref}) before crediting. If Monnify says unpaid/short, or is unreachable, nothing is credited and the webhook is retried.
- Booking timeouts: `manage.py settle_stale_bookings` (daily) auto-releases COMPLETED bookings after 7 days and auto-refunds FUNDED/IN_PROGRESS after 14 days. Same row locks as the manual endpoints.
- Ledger now equals balance when promo credit is used (hold/refund entries record the paid part only).
- Removed duplicate apps/chat/test_call_signaling.py.

## Cron jobs to schedule
- `reconcile_withdrawals` every 10 min, `expire_gifts` hourly, `settle_stale_bookings` daily.

## Still open (config / your decision)
- Use Postgres and a shared cache (Redis) in prod: SQLite ignores select_for_update; the password/OTP attempt limiter lives in the cache.
- Withdrawals with provider status "unknown" need a human.
- Frontend: send `otp_code` with withdrawal requests for users with 2FA.

## Round 3: friend blocking
- Direct chats with a blocked person (either direction) disappear from the chat list; unblocking brings them back with history. Group chats unaffected.
- Blocked-people list (GET /api/accounts/blocks/) returns display_name, can_unblock and unblock_until.
- A block can be undone for 6 months (DELETE /api/accounts/blocks/<id>/). After that it is permanent and unblock is refused. Re-blocking does not restart the clock.
