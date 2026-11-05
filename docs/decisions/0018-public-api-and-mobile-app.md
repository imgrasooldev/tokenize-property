# ADR 0018: Public API (/v1) and the investor mobile app

- Status: Proposed (owner approved the direction on 2026-11-04: "globally recognized standard", BLoC with the repository pattern on both sides, read-only first, Night Glass dark theme with a Daylight-style light theme).
- Builds on: ADR 0001 (stack), ADR 0010 (website integration: the website signs nothing), ADR 0016 (one database role per service), T-030 (investor passkeys and database sessions), the mobile design `docs/design/app/` (49 screens).

## Context

Investors use the website today. A Flutter app for Android and iOS needs a stable, documented API. The API is the product's public contract: it must follow standards a third-party reviewer recognises, never weaken the safety rules the website relies on (the database decides; no keys outside the signing service), and work on the demo server, which has no domain and no TLS (so platform passkeys cannot be bound to it yet).

## Decision

### 1. Contract first

- **OpenAPI 3.1** (`docs/api/openapi.json`) is the source of truth. The service serves it at `GET /v1/openapi.json`; tests validate every response of every operation against it, and the Flutter data layer is written against it.
- **REST over HTTPS, JSON** (RFC 8259), resource names in plural nouns, path versioning `/v1` (breaking changes only in `/v2`; additive changes within `/v1`).
- **Errors:** RFC 9457 Problem Details (`application/problem+json`: `type`, `title`, `status`, `detail`, `instance`, plus `code`); OAuth endpoints answer with the RFC 6749 error object.
- **Data formats:** timestamps RFC 3339 in UTC; money as `{ "amount": "<integer minor units as a string>", "currency": "PKR" }` (ISO 4217, never floats); token units as decimal strings; addresses lower-case `0x` hex.
- **Pagination:** cursor based (`?limit=` 1-100, `?cursor=` opaque), body `{ "data": [...], "next_cursor": "..." | null }` plus an RFC 8288 `Link: <...>; rel="next"` header.
- **Caching:** strong `ETag` and `If-None-Match` (RFC 9110) on reads; `Cache-Control: private, no-store` on every investor resource, `public, max-age=30` on the catalogue.
- **Rate limits:** per token and per address, announced with the IETF `RateLimit-Policy` / `RateLimit` headers; 429 with `Retry-After`.
- **Language:** `Accept-Language: en | ur` selects texts; data never changes with the language.
- **Tracing:** every response carries `X-Request-Id` (echoed if the client sent a valid one).
- **Writes (phase 2):** `Idempotency-Key` header (IETF draft) on every POST that creates something; passkey step-up for money movements.

### 2. Authorisation: OAuth 2.0 Device Authorization Grant

- The app signs in with the **Device Authorization Grant (RFC 8628)**: it asks `POST /v1/oauth/device_authorization` (public client `pt-mobile`, no secret, PKCE not applicable), shows the 8-character user code, and the investor approves it on the website (`/device`) where they are already signed in, with a passkey step-up wherever passkeys are available. This works on the demo server without a domain, and later alongside platform passkeys.
- `POST /v1/oauth/token` issues an opaque **access token** (256-bit random, 15 minutes) and a **refresh token** (256-bit random, 30 days) per **OAuth 2.0 Security BCP (RFC 9700)** / OAuth 2.1: refresh tokens rotate on every use and a reused refresh token revokes the whole token family. Only SHA-256 hashes are stored; the database checks every token on every request (as the website's sessions, T-030). `POST /v1/oauth/revoke` (RFC 7009) signs a device out; the website lists and revokes linked devices.
- Scope phase 1: `read` (the investor's own data and the public catalogue). Nothing in phase 1 can move money or sign anything.
- Tokens are sent as `Authorization: Bearer` (RFC 6750) over TLS in production. Sender-constrained tokens (DPoP, RFC 9449) are a phase 2 hardening.

### 3. Architecture of the API (`backend/packages/public-api`, process `pt-public-api`)

- Layers, each depending only on the next: **routes** (HTTP controllers: parse, validate with zod, map to Problem Details) → **services** (use cases, no SQL, no HTTP) → **repositories** (interfaces in the service layer, PostgreSQL implementations calling `papi.*` functions only). Tests replace repositories with in-memory fakes for unit tests and use a scratch database for integration tests.
- Its own database login `pt_public_api_app` in group `pt_svc_public_api` (ADR 0016) with EXECUTE on schema `papi` functions only: `SECURITY DEFINER` functions that check the token and return only the token owner's data (as `webnotice`/`payweb`). No table access, no other schema.
- Node `node:http` like the other services, bound to 127.0.0.1:4960; nginx exposes it as `/v1/` (no CORS: native clients only).

### 4. The Flutter app (`mobile/`)

- **BLoC** (`flutter_bloc`) for presentation state, **repository pattern** for data, three layers per feature: `data` (API client and DTOs from the OpenAPI contract, repository implementations), `domain` (entities, repository interfaces), `presentation` (blocs, pages, widgets). Dependency injection at the app root; `go_router` for navigation; tokens in the platform keystore (`flutter_secure_storage`), never in shared preferences.
- Themes: **Night Glass** (dark, primary) and a **Daylight-style light theme**, following the system setting with a manual switch; English and Urdu with right-to-left layout; self-hosted font subsets (no font downloads at runtime).
- Quality: `very_good_analysis` lints, `bloc_test` unit tests for every bloc, widget tests per page, repository tests against a fake HTTP client; `flutter analyze` and `flutter test` in CI.

## Consequences

- One more service and schema to operate; the website gains `/device` and a "linked devices" list.
- The demo can be used from a phone over plain HTTP only as a demo (tokens over HTTP are acceptable there exactly as the demo's cookies are; production requires TLS and HSTS).
- Phase 2 (invest, market orders, passkey step-up in the app, DPoP) needs its own amendment.

## Amendment 1 (2026-11-05): phase 2a, investing from the app, confirmed on the website

Owner decision 2026-11-05: "Website pe ab, passkey baad" (confirm on the website now, passkeys in the app later). Migration `0060_public_api_requests.sql` (PR-1..PR-4).

- `POST /v1/me/subscription-requests` (scope `read` plus a live token; body `{offering_id, units}`) creates a **pending request** with an 8-letter confirmation code, valid 15 minutes. It moves no money and reserves nothing. Header `Idempotency-Key` (IETF draft) is required: the same key and body return the same request (200), the same key with another body is 409, a new request is 201. At most 5 pending requests per investor (409); an offering that is not open is 422.
- The investor confirms on the website (`/confirm?code=...`), signed in, through the website's own reservation path: documents accepted, the KYC gate and limits of `offering.web_reserve`, and the passkey step-up `offering.reserve` where the investor has a passkey. The website binds the new subscription to the request only for the same investor, offering and units, or the investor declines it. The app never confirms its own request.
- `GET /v1/me/subscription-requests/{id}` (the app polls it) and `GET /v1/me/subscriptions/{id}` (payment code, trustee collection account and deadline, exactly as the website shows them).
- Passkeys inside the app (WebAuthn with platform passkeys bound to the domain), DPoP and writes without a website step need the production domain and TLS: phase 2b or later.
