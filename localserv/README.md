# Local Services Marketplace -- Phases 1-9: Foundation through Security Hardening

Connects customers with local service providers (repairs, tutoring,
cleaning, errands, etc.).

## Phase 1 -- Foundation

- Project/app structure (`config/`, `apps/common`, `apps/accounts`, ...)
- Environment-based settings split (`dev` / `test` / `prod`), no secrets in code
- Custom `User` model: UUID PK, role, account status, verification
  state -- kept separate from Django's `is_active` login gate
- Argon2 password hashing, strong password validators
- Base security settings (secure cookies in prod, HSTS, CSRF, CORS
  allowlist, safe logging that scrubs known-sensitive keys)
- DRF configured with pagination, scoped throttling, and schema docs

## Phase 2 -- Authentication

- Registration with strong password validation
- Email verification: single-use, expiring, hash-stored tokens (raw
  token is emailed, never persisted -- see `apps/accounts/tokens.py`)
- Login: generic "invalid email or password" (no account-existence
  leak), blocked for non-ACTIVE accounts with an account-specific
  reason (safe to reveal once the password's already been proven)
- TOTP-based 2FA: setup returns a provisioning URI, isn't active until
  confirmed with a real code; when enabled, login returns a signed,
  5-minute challenge token instead of a session, redeemed via a
  separate verify-2fa endpoint
- Logout + session management: every login is recorded
  (`UserSession`), users can list and individually revoke sessions/
  devices, or revoke everything but the current one
- Password reset (generic response either way, single-use expiring
  token) and authenticated password change (requires current
  password) -- both revoke other active sessions and send a security
  alert email
- Disabling 2FA requires re-entering the current password (sensitive-
  action reauth)
- Per-endpoint rate limiting (`login`, `registration`,
  `email_verification`, `password_reset`, `two_factor` throttle scopes)

## Phase 3 -- Profiles, privacy, blocking, discovery

- `Profile` (display name, bio, avatar, free-text general location,
  availability, preferences) and `ProfilePrivacy` are auto-created
  the moment a `User` is created (signal), so there's never a
  window where a user exists without them
- **Exact latitude/longitude are stored but never serialized to
  anyone but the owner** -- only `general_location` (user-controlled
  free text) is public; enforced in `services.get_public_profile`,
  covered by a test
- Visibility rules (`PUBLIC` / `REGISTERED_USERS` / `PRIVATE`) applied
  consistently across both the single-profile endpoint and the
  discovery list -- an anonymous visitor only ever sees `PUBLIC`
  profiles, matching what registered-only profiles hide from them
- Online status / last-seen are opt-in per privacy settings, not
  shown to other users unless explicitly enabled
- Blocking is symmetric for visibility purposes: if A blocks B,
  neither can see the other's profile or find the other in discovery,
  even though only A took the action; self-blocking is rejected at
  both the service layer and a DB `CheckConstraint`
- Avatar upload: declared content-type + size checked, then the
  actual file signature is verified with Pillow (`Image.verify()`),
  then the image is **re-encoded server-side** (strips EXIF --
  including any embedded GPS coordinates -- and any non-image payload
  a crafted file might carry); the stored filename is always
  server-generated, never the client's
- Discovery: paginated, search input length-capped, ordering field
  whitelisted (`common.utils.whitelist_ordering`) so a client can
  never sort by an arbitrary column
- Presence ping endpoint updates `last_seen_at` explicitly (no
  per-request middleware overhead)

Two real bugs the test suite caught here, fixed rather than papered
over:
- `services.upload_avatar` grabbed `old_avatar = profile.avatar`
  before saving the new file -- but that's the *same* `FieldFile`
  object, not a copy, so `.save()` mutated it and the subsequent
  `old_avatar.delete()` deleted the file we'd just written and reset
  the field to empty. Fixed by capturing the old file's name as a
  plain string first.
- `apps.common.validators.validate_image_upload` raised Django's
  `ValidationError`, which DRF's default exception handler does not
  auto-convert (unlike `rest_framework.exceptions.ValidationError`) --
  a bad upload was silently producing a 500 instead of a 400. Fixed at
  the `media_utils` boundary.

## Phase 4 -- Marketplace: listings and the booking state machine

- `ServiceCategory` is staff-managed only (admin panel) -- not
  user-creatable, so it can't be used to bypass moderation via
  arbitrary category names
- `Service` listings: only `PROVIDER`-role accounts can create them;
  status (`DRAFT`/`PUBLISHED`/`ARCHIVED`/`SUSPENDED`) is **never**
  settable from client-submitted JSON -- only through
  `transition_service_status`, which checks an explicit
  owner-transition table and ownership before applying anything.
  `SUSPENDED` is deliberately absent from that table: only staff can
  suspend or lift a suspension
- **Bookings are the security-critical piece here**, per the
  spec's "assume every request can be replayed/raced" instruction:
  - `agreed_price` is snapshotted from the service's price at booking
    creation and never recalculated later, even if the provider
    changes the listing's price afterward (tested explicitly)
  - Every state change goes through one function,
    `transition_booking`, which `select_for_update()`s the row,
    re-reads the *persisted* status (never trusts what the caller
    thinks the current status is), checks the transition against an
    explicit `{from_status: {to_status: required_role}}` table, and
    checks the caller actually holds that role for this specific
    booking -- so a client can never submit an arbitrary `to_status`
    and skip states, and a customer can never accept/complete their
    own booking
  - Every transition is logged to an append-only `BookingEvent` --
    nothing is ever updated or deleted from that table
  - Booking detail/event-history endpoints check the caller is
    actually a participant (customer or provider) before returning
    anything -- a third party gets a 404, not a 403 (doesn't confirm
    the booking exists)
- Reviews: one per booking (DB-enforced via `OneToOneField`), only
  the booking's customer can create one, only once the booking is
  `COMPLETED`, rating DB-constrained to 1-5

## Phase 5 -- Wallet, ledger, and escrow

- `Wallet` (one per user, auto-created via signal like `Profile`),
  `LedgerEntry` (append-only, never updated or deleted), `Escrow`
  (one per funded booking)
- **Every balance mutation is atomic and row-locked**: `Wallet.balance`
  is a cached total, but it is never touched outside a
  `select_for_update()`-protected transaction that also writes the
  justifying `LedgerEntry` in the same transaction -- there is no bare
  `wallet.balance += amount` anywhere in this codebase
- **Idempotency keys** (unique per wallet, DB-enforced via a
  conditional `UniqueConstraint`) on deposits and escrow holds --
  retrying the same request with the same key returns the original
  result rather than double-processing it. Tested two ways: through
  the API (retry a deposit request) and by calling the wallet service
  function directly twice with the same key, bypassing the booking
  state machine entirely, to prove the wallet layer's own guard holds
  independent of the state machine's guard
- **No floats, ever** -- `Decimal` throughout, matching the
  `Decimal`-priced listings from Phase 4. This deliberately departs
  from the original spec's literal "integer token units" instruction;
  see the docstring on `apps.wallet.models.Wallet` for why introducing
  a second unit system with an invented conversion rate would be
  unjustified complexity rather than something the project actually
  needs right now
- DB-level backstops beyond the application logic: `CheckConstraint`s
  preventing a negative wallet balance or a non-positive escrow amount
- **The booking state machine now includes funding**, which is a real
  flow change from Phase 4 (documented, not silently different):
  `ACCEPTED -> FUNDED -> IN_PROGRESS -> COMPLETED -> RELEASED`, plus
  `FUNDED -> CANCELLED` (refunds escrow) and a staff-only
  `DISPUTED -> RELEASED` / `DISPUTED -> REFUNDED` dispute resolution.
  None of these five money-moving transitions are reachable through
  the generic `/transition/` endpoint or its transition table -- each
  has its own dedicated function that re-does the role/state checks
  under its own row lock and then drives the wallet side effect in the
  same atomic block. A test confirms the generic endpoint explicitly
  rejects `to_status=FUNDED`.
- Three Phase 4 tests that assumed the old direct
  `ACCEPTED -> IN_PROGRESS` flow were updated to fund the booking
  first, rather than left silently broken by this phase's changes
- `AuditLog` (in `apps/common`, since it's used across apps): records
  staff-initiated manual wallet adjustments and dispute resolutions,
  who did it, and why -- scoped for now to the money-moving/state-
  overriding actions that exist as of this phase (see its docstring
  for why broader system-wide audit logging is deferred to the
  moderation phase)
- A placeholder self-serve deposit endpoint stands in for Phase 6's
  real payment provider so the escrow flow can be exercised end-to-
  end -- explicitly documented as something to remove or lock down
  the moment real payments exist, since crediting a wallet on nothing
  but the caller's say-so is exactly the anti-pattern the original
  spec warns against for payment webhooks

Explicitly NOT implemented yet (later phases):
- Real payment provider integration, webhooks, actual withdrawals to
  fiat (Phase 6) -- the deposit endpoint above is a stand-in, not this
- Real-time messaging (Phase 7)
- Moderation/disputes/audit log (Phase 8) -- dispute *resolution*
  exists (staff can release or refund a disputed booking's escrow),
  but there's no report/investigation workflow around it yet, and
  `AuditLog` doesn't yet cover moderation actions on content
- Any frontend/UI (templates or a JS app) -- per the original spec,
  the backend is built and hardened first; `templates/` and
  `static/` are still just empty scaffold folders

`apps/moderation` still exists as an empty scaffold (app config +
placeholder urls.py); `apps/wallet` is now fully implemented for this
phase's scope.

## Phase 6 -- Payments

- `PaymentIntent` (one per funding attempt, unique `idempotency_key`),
  `PaymentWebhookEvent` (idempotency record for processed webhook
  deliveries, unique per `(provider, event_id)`), `WithdrawalRequest`
- `apps.wallet.providers.PaymentProvider` -- swappable interface
  (`initiate_deposit`, `verify_webhook_signature`,
  `parse_webhook_event`, `initiate_payout`); only `StubProvider` is
  wired up, since there's no real gateway reachable from this
  environment. `config/settings/prod.py` now **refuses to boot** if
  `PAYMENT_PROVIDER=stub`, so this can't accidentally ship
- **The Phase 5 placeholder `DepositView`/`POST /api/wallet/deposit/`
  is removed**, exactly as flagged in its own docstring. Replaced with
  `POST /api/wallet/deposits/` (creates a `PaymentIntent`, asks the
  provider to start payment) and `POST /api/wallet/deposits/webhook/`
  (provider-facing, signature-verified). A wallet is now credited in
  exactly one place -- `payment_services._complete_deposit` -- reached
  only after a verified webhook (or, for the stub provider only, a
  synchronous "auto-completed" response, since there's no real gateway
  to redirect to)
- Two new ledger primitives added to `apps/wallet/services.py`
  (`withdraw`, `reverse_withdrawal_credit`), alongside the existing
  `deposit`/`hold_escrow`/etc. -- not built by reusing `deposit()` with
  a negative amount, which was tried first and correctly rejected by
  `deposit()`'s own `amount <= 0` guard
- Withdrawals require the current password re-entered
  (`request_withdrawal`), same reauth pattern as
  `apps.accounts.services.disable_2fa`
- Idempotency: both deposits and withdrawals accept a client-supplied
  `idempotency_key`; replaying the same request returns the original
  result rather than double-processing (same DB-enforced pattern as
  Phase 5's escrow holds)
- Staff-only `reverse_withdrawal`, for when a completed withdrawal
  turns out to have failed on the provider's side after the fact --
  credits the funds back via `reverse_withdrawal_credit` (its own
  ledger entry type, not reusing `deposit`) and records who/why on
  `WithdrawalRequest` itself
- New throttle scope `payment_webhook` (120/min) on the webhook
  endpoint, separate from `wallet_write`, since a provider retrying a
  webhook delivery is a different traffic shape than a user hitting
  the API
- Manual smoke-tested end to end (not a formal pytest suite yet, per
  this round's scope): below-minimum deposit/withdrawal rejected,
  idempotent replay doesn't double-credit/debit, wrong password
  rejected, insufficient balance rolls back atomically with nothing
  created, staff reversal credits funds back, non-staff reversal
  attempt rejected, invalid webhook signature rejected. Two real bugs
  were caught and fixed during this: `initiate_deposit` discarding
  `_complete_deposit`'s return value (would have shown `PENDING` on an
  already-`SUCCEEDED` intent), and the `deposit()`-with-negative-amount
  withdrawal attempt described above

Explicitly NOT implemented yet (later phases):
- Real-time messaging (Phase 7)
- Async withdrawal review workflow -- see the "Known gaps" section
- Moderation/disputes/audit log (Phase 8)
- Any frontend/UI

## Phase 7 -- Real-time messaging

- `channels`, `channels-redis`, `daphne` added to `requirements.txt`;
  `config/asgi.py` now wires a real `ProtocolTypeRouter`
  (`AllowedHostsOriginValidator(AuthMiddlewareStack(URLRouter(...)))`)
  instead of a bare `get_asgi_application()`. WebSocket auth reuses the
  same Django session cookie as the REST API -- no separate token
  scheme
- `Conversation` (direct, exactly 2 participants, canonically-ordered
  `user_a`/`user_b` pair with a `UniqueConstraint` so the same two
  users can never get two conversation rows), `ConversationParticipantState`
  (per-user `last_read_at` -- stands in for the spec's separate
  `ReadReceipt` model; a single "read up to this time" timestamp is
  enough for a 2-person thread and is far cheaper than a row per
  message per participant), `Message` (soft-deleted, editable, one
  optional image attachment -- see the post-Phase-10 addendum below)
- `apps.chat.consumers.ChatConsumer` enforces, in order, on every
  connection attempt: authenticated -> account `status == ACTIVE` ->
  is a participant -> not blocked (either direction) -- re-checked at
  connect time even though all of this was true when the conversation
  was created, since account status and block state can both change
  afterward. Verified with a real `WebsocketCommunicator` test:
  anonymous rejected, non-participant rejected, blocked participant
  rejected even though they *are* a participant, suspended account
  rejected
- Dual delivery path: `POST /api/chat/conversations/<id>/messages/`
  (REST) and the WebSocket `{"type": "message", "body": ...}` frame
  both funnel through the same `services.send_message`, then both
  broadcast identically via `services.broadcast_message` -- a client
  using either transport sees the same live delivery, verified by
  sending over REST and receiving over an open WS connection in the
  same test
- WebSocket messages are rate-limited too
  (`services.check_and_increment_ws_rate_limit`, matching the existing
  `messages` DRF throttle scope's 120/min budget) -- DRF's throttle
  classes are HTTP-request-scoped and can't reach a Channels consumer
  directly, so this is a separate cache-based limiter mirroring the
  same number
- `who_can_message` (existing `ProfilePrivacy` field from Phase 3) is
  checked only when *starting* a new conversation, not on every
  subsequent message -- blocking is the continuously-re-checked
  mechanism for cutting off an existing thread; changing your
  contact-permission setting doesn't retroactively kill conversations
  that already exist. This mirrors how `who_can_send_service_requests`
  was already only checked at booking-creation time in Phase 4
- `apps/accounts/services.py` gained one new public function,
  `is_blocked_between` -- a thin wrapper around the existing
  (module-private) `_is_blocked_either_direction`, so `apps.chat` has
  a sanctioned way to consult blocks without reaching into another
  app's private helpers
- Manual smoke-tested end to end via `channels.testing.WebsocketCommunicator`
  against a real local Redis instance (not mocked): connection
  auth/participant/block/status checks, REST<->WS dual delivery, rate
  limiting. One real bug caught along the way: the initial test
  omitted the `Origin` header, which `AllowedHostsOriginValidator`
  correctly rejects (`None` origin isn't allowed unless `ALLOWED_HOSTS`
  contains `"*"`) -- this is real, working behavior, not an app bug,
  but worth knowing: **any non-browser WebSocket client (native
  mobile, custom scripts) must send an `Origin` header matching
  `ALLOWED_HOSTS` or it will be rejected before it ever reaches
  `ChatConsumer.connect()`.**

Explicitly NOT implemented yet (later phases):
- A document/PDF attachment type was never added -- see the
  post-Phase-10 addendum below for when image attachments were added
- Message reporting -- ties into the moderation phase (8), not built
  here
- Typing indicators / presence beyond the existing Phase 3
  `last_seen_at` -- not built
- Group conversations -- `Conversation` is hard-coded to exactly 2
  participants
- Moderation/disputes/audit log (Phase 8)
- Any frontend/UI

## Phase 8 -- Moderation

- `Report` (against a `USER`, `SERVICE`, or `MESSAGE` -- a plain UUID
  `target_id` + `target_type` rather than a `GenericForeignKey`, since
  there are exactly three known target models and all use UUID PKs;
  existence is validated in `services.create_report` at creation time
  since there's no single table a real FK could point to)
- Any authenticated user can file a report; can't report themselves;
  target must actually exist (checked against the real table for that
  `target_type`, including `apps.chat.models.Message` -- so message
  reporting, listed as a Phase 7 gap, is covered from here)
- Staff-only: list/filter reports, resolve (`RESOLVED`/`DISMISSED`,
  can't resolve the same report twice), suspend/ban/reinstate a user
  account, suspend/unsuspend a service listing
- **Suspending or banning an account immediately revokes every active
  session** (reuses the same `_revoke_all_sessions` from Phase 2's
  password-reset flow) -- a moderator action takes effect right away,
  not just on the account's next login attempt. Verified: a logged-in
  user's session is confirmed revoked, and their next login attempt
  is blocked by the existing `AccountStatus != ACTIVE` check in
  `authenticate_login`.
- `AuditLog` (from Phase 5/6) extended with account/listing/report
  actions -- every staff action here writes one, closing the gap its
  own docstring flagged ("moderation actions on content" as a
  documented follow-up)
- **Bug found and fixed while wiring this up**: `suspend_service`
  (Phase 4) accepted a `reason` parameter and silently discarded it --
  never stored, never logged, nowhere a moderator's stated reason for
  suspending someone's listing could be found afterward. Fixed to
  require a non-empty reason and write it to `AuditLog`; the one
  existing Phase 4 test that called it with no reason was updated
  rather than left broken.

Explicitly NOT implemented yet (later phases):
- Any frontend/UI

## Phase 9 -- Security hardening pass

This phase reviewed everything built so far rather than adding new
user-facing features. Real issues found and fixed, not just a
checklist run:

- **`pip-audit` found 62 known vulnerabilities across 5 packages**
  (Django, DRF, Pillow, pytest, daphne) pinned to versions from
  earlier phases. Notably: several Pillow memory-corruption bugs
  (heap overflows in PSD/font/TGA parsing) relevant because Phase 3's
  avatar upload pipeline runs Pillow on user-supplied image bytes, and
  a daphne WebSocket header-injection + unbounded-frame-size DoS
  directly relevant to Phase 7's chat consumer. Bumped Django
  (5.1.3->5.1.15, staying on the 5.1 branch), DRF (3.15.2->3.17.2),
  Pillow (10.4.0->12.3.0), pytest (8.3.3->9.0.3, with pytest-asyncio
  correspondingly bumped 0.24.0->1.4.0 since 0.24.0 caps pytest<9),
  and daphne (4.1.2->4.2.2). Full suite re-run and passing after the
  bump -- this wasn't just a requirements.txt edit.
  **7 vulnerabilities remain**, all Django, all only fixed in the
  5.2.x/6.0.x branches (no 5.1.x backport exists) -- but all seven are
  in subsystems this codebase never uses (HTTP response-caching
  middleware/`cache_page`, `HttpRequest.get_signed_cookie`, and
  GeoDjango/`django.contrib.gis`, confirmed absent via a grep across
  `apps/` and `config/`). Documented here rather than either hidden or
  "fixed" via an unjustified, untested major-version jump.
- **Real privacy gap found and fixed**: `WithdrawalRequest` originally
  stored `payout_destination` as unmasked free text -- persisted raw,
  emailed back to the user, returned via the API, and visible
  unmasked in Django admin. Replaced with the `PayoutAccount` model
  (Phase 6 section above): only a masked last-4 reference is ever
  stored, and a cooldown window applies before a newly-added account
  can be used for a withdrawal.
- **Real robustness bug found and fixed**: `apps.chat.services.broadcast_message`'s
  docstring claimed it "degrades gracefully" if the channel layer is
  unreachable, but the code only checked `channel_layer is None` --
  it never caught the actual connection error from `group_send()`. A
  configured-but-unreachable Redis (the common case: Redis briefly
  down, not "never configured") turned a successfully-persisted
  message send into an unhandled exception. Fixed to actually catch
  and log the failure. Verified with a test that points
  `CHANNEL_LAYERS` at a real Redis backend on a port nothing is
  listening on and confirms `broadcast_message` doesn't raise.
- **Real regression found and fixed**: 4 Phase 5 wallet tests still
  called the self-serve `deposit` endpoint that Phase 6 correctly
  removed in favor of the provider-mediated flow -- nobody had updated
  them, so the suite was silently failing on the old tests. Fixed.
- **Test coverage backfilled for Phase 6 and 7**, which had shipped
  with zero tests despite the code itself being solid: 19 new tests
  for payments (deposit flow, webhook signature verification and
  replay/idempotency, insufficient-balance withdrawal guard, staff-only
  reversal) and a full chat test suite (16 REST tests plus 8 real
  WebSocket tests using `channels.testing.WebsocketCommunicator` --
  connect-time auth/participant/block/status gating, send/receive
  over a live connection, rate limiting). This required adding
  `pytest-asyncio` and an in-memory `CHANNEL_LAYERS` override for the
  test settings module, neither of which existed before.
- 14 new tests for the moderation endpoints built in this phase.
- Confirmed via `grep` that every `AllowAny` permission across the
  codebase is on a genuinely public endpoint (registration, login,
  public profile/discovery, category/listing browse, the
  signature-gated payment webhook) -- none were accidentally left
  open on something that should require auth.
- Re-confirmed production settings still hard-fail at startup if
  `PAYMENT_PROVIDER=stub` (the guard already existed from Phase 6) --
  the stub provider genuinely cannot reach a real deployment.

Explicitly NOT done in this pass (see Known Gaps below for the
larger, pre-existing ones this phase didn't newly introduce or
resolve):
- The Django 5.2/6.0 major-version jump that would close the last 7
  pip-audit findings -- correctly out of scope without room to test
  it, and moot anyway since none of those 7 touch code this project
  runs
- The PostgreSQL-vs-SQLite concurrency-testing gap (bookings, wallet,
  payments) -- still not exercised against real PostgreSQL
- Per-account/per-IP WebSocket connection-count limiting (spec Sec 8)
- Moving transactional email and the Celery-eligible work behind
  actual Celery tasks

## Phase 10 -- Production readiness

- **`Dockerfile`**: multi-stage build (compiler toolchain only in the
  builder stage, slim runtime image), non-root user, a `HEALTHCHECK`
  wired to the new `/healthz/` endpoint. Migrations and
  `collectstatic` are deliberately NOT run automatically by the
  container's entrypoint -- see `DEPLOYMENT.md` for why (a restarting
  container should never silently alter the schema as a side effect).
- **`GET /healthz/`**: checks real database and cache connectivity
  (not a bare "the process is running" check that doesn't verify
  anything), returns `503` if either is down so a load balancer
  actually stops routing to a broken instance. Never reveals *why* a
  dependency failed in the response body -- only that it did. Tested
  both the happy path and the degraded path (pointed `CACHES` at a
  real, unreachable Redis and confirmed a clean `503`, not a crash).
- **`deploy/nginx/app.conf`**: reverse proxy in front of Daphne --
  serves `/static/`/`/media/` directly, proper `Upgrade`/`Connection`
  header handling for the `/ws/` chat endpoints (a plain HTTP proxy
  config silently breaks WebSocket upgrades if these are missing),
  `client_max_body_size` as a hard request-size ceiling enforced
  before Django ever sees the bytes.
- **`SECURE_PROXY_SSL_HEADER`** added to `prod.py` to trust
  `X-Forwarded-Proto` from that same nginx config -- without it,
  `SECURE_SSL_REDIRECT` would redirect-loop once TLS is terminated at
  nginx and Django only ever sees plain HTTP from it. Documented
  in-line why this is only safe because nginx is the sole path to the
  app (never set this if the app is also reachable directly).
- **Structured (JSON) logging** in production (`apps/common/log_formatters.py`)
  -- same fields the dev `verbose` formatter already logs, just
  machine-parseable for CloudWatch/Loki/ELK-style aggregation.
  Verified it produces valid, parseable JSON.
- **Optional Sentry hook** -- entirely a no-op if `SENTRY_DSN` isn't
  set (no import even attempted), `send_default_pii=False` so it never
  becomes another place passwords/tokens/payout details could leak to
  a third-party SaaS. Verified it initializes without error given a
  well-formed (fake) DSN.
- **`docker-compose.prod.yml`**: app + nginx + Postgres + Redis, with
  real healthchecks gating startup order (app won't start before
  Postgres/Redis report healthy, not just "the container exists").
  Kept separate from the existing dev-only `docker-compose.yml`
  (Postgres+Redis only, for running the app directly with
  `manage.py runserver` during development).
- **`deploy/scripts/backup_db.sh`** + `DEPLOYMENT.md`: a working
  `pg_dump`-based backup/restore path with retention, explicitly
  documented as a starting point for self-hosting -- not a substitute
  for a managed database's own automated backups/PITR where one
  exists.
- **`DEPLOYMENT.md`**: first-deploy steps, routine deploy order
  (app up *then* migrate, not the reverse), rollback guidance specific
  to this schema (why UUID PKs make additive migrations safe, and why
  the append-only tables -- `LedgerEntry`/`BookingEvent`/`AuditLog`/
  `PaymentWebhookEvent` -- should never need a migration that alters
  historical rows), and an explicit "what this isn't" section listing
  what a real cloud deployment should add on top (managed DB, CDN/WAF,
  multiple replicas, object storage for media, CI).

Explicitly NOT done in this phase:
- No CI pipeline config (GitHub Actions/GitLab CI/etc.) -- referenced
  in `DEPLOYMENT.md` as something to add, not added
- No actual cloud infrastructure-as-code (Terraform/Pulumi/etc.) --
  this phase covers a single-host Docker Compose deployment, which
  `DEPLOYMENT.md` is explicit about being a starting point, not a
  full cloud-native setup
- Media storage is still a local filesystem volume, fine for one app
  replica, listed in `DEPLOYMENT.md`'s "what this isn't" as needing
  object storage before scaling past one

## Known gaps to revisit going forward

- `two_factor_secret` is stored in plaintext -- should move to a
  field-level-encrypted column (flagged in `apps/accounts/models.py`)
- Transactional emails send synchronously; should move behind a
  Celery task once Celery is wired up, so a slow SMTP call can never
  block a request
- Throttle rates use DRF's simple `N/period` syntax (hour/min/day),
  which can't express an exact 15-minute window -- a custom throttle
  class would be needed for that precision
- The plain `APIView`-based auth/profile endpoints don't auto-generate
  a request/response schema for drf-spectacular (shows as W002
  warnings on `check --deploy`) -- cosmetic, but worth adding explicit
  `serializer_class`/`@extend_schema` annotations before this API is
  exposed as a public developer-facing doc
- Discovery's `general_location` free text is unindexed for
  distance/geo search -- fine at current scale, revisit if the
  provider list grows large enough that `icontains` scans matter
- **True concurrent-request testing needs PostgreSQL, not SQLite.**
  `transition_booking` uses `select_for_update()` for real row-level
  locking, but SQLite's backend doesn't enforce row locks the way
  Postgres does -- an earlier attempt at a genuine two-thread race
  test against the SQLite test DB just deadlocked with "database
  table is locked" rather than demonstrating serialization. That test
  was replaced with a deterministic version that verifies the same
  guard logic (a transition against stale/already-moved-on state is
  rejected) without depending on real concurrency. Before this ships,
  add an integration test that runs against actual PostgreSQL
  (`docker compose`'s `db` service) to verify the row lock holds
  under genuine concurrent connections -- this is explicitly listed
  as a requirement in the original spec's concurrency-testing section
  and isn't fully satisfied yet.
- The autouse cache-clearing fixture (needed so DRF's rate-limit
  counters don't leak between tests) lives in the project-root
  `conftest.py` so it covers every app's test directory -- it was
  originally scoped only under `apps/accounts/tests/` during Phase 2
  and silently didn't apply to `apps/services`/`apps/bookings` until
  this phase's test run surfaced it as a wave of spurious 429s
- The wallet's `select_for_update()` locking has the same SQLite-vs-
  PostgreSQL testing caveat as the booking state machine (see above):
  the idempotency tests here prove the *logic* is correct (a repeated
  request with the same key doesn't double-process), but a genuine
  concurrent-connection race test against real PostgreSQL is still
  owed before this ships, same as bookings' concurrency gap
- `apps.wallet.services.deposit` is now only reachable internally (via
  `payment_services._complete_deposit` after a verified webhook, or
  directly in tests/admin tooling) -- the Phase 5 gap about it being
  publicly callable on the caller's say-so is resolved as of Phase 6
- Withdrawals settle synchronously via the stub provider (`REQUESTED`
  collapses straight to `PROCESSING -> COMPLETED`); a real provider
  integration needs the fuller async `REQUESTED -> risk check ->
  PENDING_REVIEW -> PROCESSING -> COMPLETED` workflow the master spec
  describes -- flagged in `WithdrawalRequest`'s docstring, not solved
  here
- The same SQLite-vs-PostgreSQL concurrency-testing caveat noted above
  for booking/wallet locking applies to the new withdrawal/deposit
  `select_for_update()` paths too -- not re-verified against real
  PostgreSQL this round
- No per-account/per-IP WebSocket connection-count limit yet (spec
  Sec 8 asks for it) -- message *rate* is limited
  (`check_and_increment_ws_rate_limit`), but nothing stops one account
  from opening many simultaneous connections
- `channels-redis` becomes a second Redis consumer alongside
  `django-redis`'s cache backend and Celery's (still-unwired) broker
  use -- fine at current scale on one `REDIS_URL`, but worth splitting
  into separate logical DBs/instances before production load
- Chat attachments are images only (no PDF/document type) -- see the
  post-Phase-10 addendum below for what was added and why the scope
  stopped there

## Post-Phase-10 addendum: backend changes for the frontend's remaining gaps

Three backend changes were needed while closing out frontend gaps
(staff moderation dashboard, session/2FA screens, message attachments,
self-selectable registration role) -- all covered by the backend's own
test suite, not just exercised manually from the frontend:

- **`apps.accounts.services.get_public_profile` now includes
  `is_staff` and `two_factor_enabled`, but only in the response to the
  profile's OWNER.** Every other viewer's response is unchanged. This
  closes a real gap: the frontend previously had no way to know a
  Django superuser was staff (only `role` was exposed anywhere), so a
  superuser who wasn't also `role=ADMIN`/`MODERATOR` couldn't see
  staff-only UI even though the backend would have accepted their
  requests. Two new tests confirm both the owner-sees-it and
  other-viewers-never-see-it halves of this.
- **Chat gained image attachments**: a new `MessageAttachment` model
  (one optional image per message, `OneToOneField` to `Message`), a
  denormalized `has_attachment` boolean on `Message` (needed because
  the existing "body can't be empty" `CheckConstraint` can't reference
  a related table -- this flag is what lets the constraint become
  "body, attachment, or both" instead), and
  `apps.chat.media_utils.process_message_attachment`, which mirrors
  `apps.accounts.media_utils.process_avatar_upload` exactly: verify
  the real file signature with Pillow rather than trusting the
  declared content-type, re-encode server-side to strip EXIF (a chat
  photo taken on-site at a customer's home makes stripped GPS data
  matter *more* here than for an avatar, not less), server-generated
  filename. Attachments go through the REST send-message endpoint
  only -- the WebSocket protocol here is plain JSON text frames, not
  designed for binary upload, so a client sending an image still gets
  live delivery to the other participant (both paths broadcast through
  the same `services.broadcast_message`), just not a live *upload*
  transport. 7 new tests cover valid-image acceptance, non-image
  rejection, oversized-file rejection, and the body-or-attachment
  requirement.
- One real bug caught by the accompanying tests, not shipped
  silently: the new `send_message` parameter was initially named
  `attachment_file` while the serializer field (and therefore the
  `**serializer.validated_data` kwargs the view passes straight
  through) was named `attachment` -- a `TypeError` on the very first
  attachment-upload test, fixed by renaming the service function's
  parameter to match.
- **Registration now accepts a self-selected `role`.** Previously every
  new account was hardcoded to `CUSTOMER` regardless of what the
  frontend sent (`RegisterSerializer` had no `role` field at all), so
  the only way to get a `PROVIDER` account was a direct DB/admin edit.
  `RegisterSerializer.role` is a `ChoiceField` restricted to exactly
  `[CUSTOMER, PROVIDER]` -- not a field validated against the full
  `AccountRole` enum -- so `role=ADMIN` or `role=MODERATOR` in a
  registration request is rejected as a normal 400 validation error,
  never a privilege-escalation path. Three new tests cover the
  default-to-customer case, successfully self-selecting provider, and
  the privileged-role rejection.

## Running it

```bash
cp .env.example .env        # fill in DJANGO_SECRET_KEY at minimum
docker compose up -d        # Postgres + Redis
pip install -r requirements.txt --break-system-packages
python manage.py migrate
python manage.py createsuperuser
python manage.py runserver
```

## Tests

```bash
pytest
```

Tests run against `config.settings.test` (in-memory cache instead of
Redis) so the suite never depends on external infra being up.

## Before merging any phase

```bash
python manage.py check
python manage.py check --deploy
pytest
pip-audit
```

