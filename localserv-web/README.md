# Euphoria -- React frontend

A React SPA for the Euphoria marketplace API (see the sibling `localserv/`
Django project -- the backend's internal folder/package names weren't
renamed, only user-facing text; see the rebrand note below). Built with
Vite + React + React Router -- deliberately no UI kit and no
data-fetching/state library, to keep the dependency surface
small for a project this size.

## Running it

```bash
npm install
cp .env.example .env.local   # Vite convention; adjust VITE_API_BASE if needed
npm run dev
```

The backend must be running separately (see `localserv/README.md`) and must
have this app's origin in its `CORS_ALLOWED_ORIGINS` -- the backend's
`.env.example` already defaults that to `http://localhost:5173` (Vite's
default port).

**One backend change was needed for this frontend to work at all**: a
`GET /api/accounts/csrf/` endpoint that forces Django to set the `csrftoken`
cookie. Without it, a pure-API session has no CSRF cookie until *something*
triggers `django.middleware.csrf.get_token()` -- Django doesn't do this
automatically just because `SessionAuthentication` is in use. `AuthContext`
calls this once on app load, before anything else.

## Architecture

- **`src/api/`** -- one module per backend domain (`accounts.js`,
  `services.js`, `bookings.js`, `wallet.js`, `chat.js`, `moderation.js`),
  all built on `client.js`'s `apiFetch`, which handles credentials, the
  CSRF header, and JSON encoding/decoding in one place.
- **`src/context/AuthContext.jsx`** -- the single source of truth for "who
  is logged in." Normalizes on one profile shape everywhere: login and the
  2FA challenge endpoints return a *different*, thinner user shape
  (`UserPublicSerializer` on the backend) than `GET profile/me/` does, so
  both `login()` and `completeMfaLogin()` immediately re-fetch the full
  profile rather than trusting the login response's user object directly.
  This was a real bug caught before shipping, not a hypothetical.
- **`src/hooks/useChatSocket.js`** -- WebSocket lifecycle for one
  conversation. Session auth over WS relies on the browser sending the
  session cookie during the HTTP upgrade handshake automatically; no token
  in the URL. `ConversationView` falls back to REST `sendMessage` if the
  socket isn't connected, so sending never hard-depends on the socket.
- **Design tokens** in `src/styles/tokens.css` -- a warm sage/ochre
  palette and Fraunces+IBM Plex Sans type pairing, chosen specifically to
  avoid the generic-SaaS cream/terracotta/Inter look.

## What's built

- Auth: register, email verification, login (+ TOTP 2FA challenge step),
  logout, password reset request/confirm, 2FA setup/disable, active
  session list with per-device and log-out-everywhere-else revocation
- Profile: view/edit own profile, avatar upload, privacy settings, view
  another user's public profile, provider discovery/search
- Services: public browse/search, listing detail with booking + "message
  provider", provider's own listings (create/edit/publish/archive)
- Bookings: full escrow state machine UI -- accept/decline, fund from
  wallet, start/complete work, release payment, cancel-with-refund,
  dispute, staff dispute resolution (gated on the shared `isStaff()`
  helper -- role OR the backend's `is_staff` flag, see below), leave a
  review, event history
- Wallet: balance, instant-complete deposit (stub provider, matches the
  backend's current state), payout accounts (masked, with the cooldown
  surfaced in the UI), withdrawal requests
- Chat: conversation list with unread counts, live messaging over
  WebSocket with a REST fallback, image attachments (upload + inline
  display, sent over REST since file uploads don't fit the plain-text WS
  protocol this app uses -- the resulting message still broadcasts live
  to the other participant), edit/delete own messages, mark read
- Reporting: a reusable report button/form usable from a listing or a
  profile
- **Staff moderation dashboard** (`/moderation`, staff-only): report
  queue filterable by status, resolve/dismiss with a note, and inline
  quick actions (suspend/ban a reported user, suspend a reported
  listing) without leaving the queue

## Explicitly NOT built (by design, not oversight)

- **No moderator-facing message content view.** The moderation dashboard
  shows `(message)` as the target label for a `MESSAGE`-type report
  rather than the message text itself -- reviewing the actual content of
  a reported message still requires Django admin. Fetching and
  displaying arbitrary message content from a moderation screen felt
  like it deserved its own careful pass (audit logging of who viewed
  what, etc.) rather than being bolted on here.
- **No listing-unsuspend action from the moderation dashboard itself**
  (only from `/services/mine` if you're the owner, or the API/admin
  directly) -- suspending is the action a report resolution actually
  needs; lifting one is a separate, less time-pressured workflow that
  didn't get a dashboard button this pass.
- **Message attachments are images only** -- no PDF/document attachment
  type, matching the backend (`MessageAttachment` wraps an `ImageField`
  and runs the same Pillow signature-verification + EXIF-stripping
  pipeline as avatars; anything that isn't a genuine image is rejected).

## Backend changes made alongside this frontend work

Three real gaps required backend changes, not just frontend code -- all
are covered by the backend's own test suite, not just exercised manually:

- `apps.accounts.services.get_public_profile` now includes `is_staff`
  and `two_factor_enabled` in the response, but **only when the viewer
  is the profile's owner** -- never for any other viewer. Without this,
  the frontend had no way to know a superuser was staff (only `role`
  was exposed) or whether 2FA was currently on.
- Chat gained a `MessageAttachment` model (one optional image per
  message), a `has_attachment` flag on `Message` so the existing
  "body can't be empty" database constraint could be relaxed to
  "body, attachment, or both" without a cross-table constraint, and a
  `apps.chat.media_utils.process_message_attachment` pipeline mirroring
  avatar processing exactly (signature verification via Pillow,
  re-encode to strip EXIF, random server-side filename).
- Registration now accepts a self-selected `role` (`CUSTOMER` or
  `PROVIDER` only -- restricted at the `ChoiceField` level, so
  `role=ADMIN` is a normal validation error, never a privilege
  escalation path). Previously every account was hardcoded to
  `CUSTOMER` no matter what the frontend sent; `Register.jsx` now has a
  two-option role picker.

## Rebrand: Localserv → Euphoria

The app is now named **Euphoria** in every user-facing surface: nav
brand, page title, `package.json`, and the backend's TOTP issuer name
(shown in a user's authenticator app during 2FA setup --
`apps.accounts.services.start_2fa_setup`). Internal backend
folder/package names (`localserv/`, `config/`, etc.) were deliberately
left alone -- renaming those has zero user-facing effect and would
only add risk for no benefit.

New visual identity, built entirely through `src/styles/tokens.css`
so it cascades everywhere automatically:
- **Color**: deep plum ink (`#2a1b3d`) on a pale lilac-white
  background, with a vibrant magenta-pink accent (`#e63e7c`) --
  chosen specifically to avoid both the previous warm-ochre
  marketplace look and the generic purple-to-pink gradient cliché.
- **Type**: swapped the display font from Fraunces (a cozy,
  marketplace-appropriate serif) to **Sora** (a modern, more
  energetic sans) for headings; body text stays IBM Plex Sans.
- **Shape**: corner radius bumped from 4px to 10px across every
  card/button/input -- a rounder, friendlier feel to match the more
  social tone of the rename.
- **Bug caught while doing this**: `components.css` had several
  hover-state and alert-border colors hardcoded as raw hex rather
  than derived from tokens (leftover from before the token system
  covered every color). These didn't update with the palette change
  and would have shown the old ochre/brick tones on hover and around
  alert boxes. Found by grepping for hex literals after the token
  swap, not caught by build or lint (neither checks for this) --
  fixed to match the new palette's hues.

**What this rebrand explicitly did NOT change**: the interaction
model. Messaging is still reached through a listing or a profile, not
an open discovery/DM surface -- see the product-level discussion this
rebrand came out of before extending it further in that direction.

## Styling & responsiveness

- Nav collapses to a hamburger menu (`.navbar__toggle` /
  `.navbar__links--open`) below 800px -- previously the six nav links
  plus brand plus user menu had no mobile treatment at all and would
  have crowded or overflowed on a phone-width screen.
- `.row--between` wraps instead of overflowing below 640px, and page
  padding shrinks slightly -- both applied globally, not per-page.
- The chat attachment button uses a real inline SVG (`PaperclipIcon` in
  `src/components/icons.jsx`) instead of a 📷 emoji glyph, with an
  `aria-label` since the button lost its text content.
- Not done in this pass: no visual/pixel testing was performed --
  everything here is verified by `npm run build`/`lint` and code
  review, not by rendering in a browser (no browser tool is available
  in this environment). Treat the responsive breakpoints as a
  reasonable first pass, not cross-device-verified.

## Verification performed

- `npm run build` and `npm run lint` (oxlint) both clean throughout,
  including after this round of additions.
- Every API call's URL and field names were cross-referenced directly
  against the Django serializers/views/urls, not written from memory of
  the API "shape" -- and this caught three real bugs before they'd have
  shown up as runtime errors: `URLSearchParams` stringifying `undefined`
  query values into the literal string `"undefined"`, the
  login-response-vs-profile shape mismatch described in Architecture,
  and a parameter-name mismatch (`attachment` vs `attachment_file`)
  between the new chat serializer and service function that unit tests
  caught immediately.
- A live integration pass against the running backend (registration,
  email verification, login, `profile/me`, listing creation) confirmed
  every response shape used above matches what the code expects,
  including discovering that **Django rotates the CSRF cookie on login**
  -- confirming `apiFetch`'s decision to re-read the `csrftoken` cookie
  fresh on every request (rather than caching it once) was the right
  call, not just a stylistic preference.
- WebSocket chat and the full booking/wallet round trip were verified by
  contract cross-reference and the backend's own test suite (including
  7 new tests for message attachments specifically -- valid image
  accepted, non-image rejected, oversized file rejected, body-or-
  attachment-required enforced), but not re-run live end-to-end from
  this frontend in this pass -- worth doing before shipping if this
  goes further.
