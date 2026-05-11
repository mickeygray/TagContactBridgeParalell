# Refactor + followup notes

Things worth considering, grouped by urgency. Honest assessment — some are
real concerns you should tackle, some are architectural nits I noticed but
would leave alone. Priority tags:

- 🔴 **Before you scale past the first couple of users**
- 🟡 **Worth doing once real traffic is flowing**
- 🟢 **Nice-to-have / purely architectural**

---

## Security

### 🔴 Verify OTP email delivery end-to-end before flipping preview off
Wired but untested. First time you set `AUTH_OTP_PREVIEW=false` you're
trusting a code path that's never run. Test with a single seed admin email,
then flip for everyone. If SendGrid auth / sender reputation / DNS fails,
nobody can log in. Keep preview=true until you've seen one real email land.

### 🔴 Webhook signatures are weak on external paths
Today `5001`'s legacy `/sms/inbound` + `/ringcentral/session-events` accept
either the `INTERNAL_SERVICE_SECRET` or `EXTERNAL_WEBHOOK_SECRET` via header
match. That's fine for internal relays (6101 → 5001) but **not** for real
third-party webhooks — providers typically HMAC-sign the body. If you open
these to Twilio / Stripe / Drop / etc. directly, implement per-provider
signature verification (body + shared secret → HMAC SHA256 → compare to
their signature header). RingCentral already does this in the 6101 path.

### 🟡 JWT is hand-rolled, not standard
`packages/shared-auth/src/index.js` signs with `crypto.createHmac("sha256")`
then base64url. Works, but not a real JWT — anything expecting standard JWT
(Auth0, cross-service inspection tools, SSO) would reject it. Swap to
`jsonwebtoken` when you need interop. Non-urgent.

### 🟡 PAT + SSH private keys in `.env` → backup exposure surface
Your control-plane `.env` holds GitHub PATs, SendGrid API keys, RC JWT, etc.
If this file gets backed up to an unintended location, everything leaks at
once. Consider: move secrets to AWS Secrets Manager / Doppler / 1Password
Secrets Automation. Load at startup, never on disk. Post-prod.

### 🟢 Rate limiter is per-process
`createRateLimiter` is an in-memory Map. If you ever run two control-plane
replicas behind a load balancer, limits reset per replica (effectively 2x
the ceiling). Fine at current scale. When you scale horizontally, port to
Redis or Mongo-backed counters.

---

## Architecture

### 🟡 Two write paths through the system
Some mutations go through the event ledger + worker (`createControlPlaneEvent`,
processed in-process). Others write directly to Mongo + record a workflow
stage (CX commands, client commands, deploys). Long-term this is
confusion-prone — which should new commands follow? Pick one as canonical
and migrate the other, or write a decision doc explaining when to use
which. Suggested: event-ledger for anything async/retryable; direct writes
for synchronous one-shots.

### 🟡 FE types vs. BE response shapes — no single source of truth
`apps/web-client/src/lib/api/types.ts` is hand-maintained to mirror what
`shared-services/frontendReadService.js` returns. We've already been bitten
by drift twice (leads/leadsReported, cancel signature). Options:
- Generate TS types from a runtime contract (shared-contracts package)
- Adopt Zod schemas on the BE and infer TS types from them on the FE
- Or at minimum: write a contract test that spins up the BE and checks
  each route returns the shape the FE expects
Zod is my preference — one schema per response, used as validator on the
BE and type source on the FE.

### 🟡 `shared-services/src/index.js` is a 340+ line barrel
Every service is required + re-exported. Any change forces anything that
requires the barrel to re-parse everything. Splitting into domain barrels
(`services/read`, `services/commands`, `services/intake`, etc.) would
reduce require-time and make it easier to see what each app actually uses.

### 🟢 Single-company identifier scope is documented, not enforced
Every model with a globally-unique key has a comment saying "if a second
RC/CallRail/Logics is added, this becomes company-scoped." When that day
comes, the mechanical change is straightforward but finding every spot is
tedious. If acquisition / multi-tenancy ever becomes likely, consider
proactively making the keys `{company, ...}` now with a migration.

### 🟢 Control-plane is a single choke point
Everything goes through 5001. Architecturally correct, operationally a
SPOF. When you care about uptime: stand up a second replica behind a
health-checked load balancer, and make sure the in-process worker has a
leader-election pattern (otherwise two replicas both process the same
event). Post-prod consideration.

---

## Observability

### 🔴 Logs go to stdout, nowhere structured
`runtime.logger` writes to stdout. Under NSSM that goes to a rotating log
file but there's no central aggregation, no search, no alerts. Minimum:
ship to CloudWatch Logs. Better: Loki / Datadog / Honeycomb with structured
fields. Critical for real production — if SMS inbound breaks at 2am you'll
want search, not a console scrollback.

### 🔴 No metrics / alerts
There's no Prometheus / StatsD / equivalent. You have no signal for:
- Event processing lag
- Failed handlers
- OTP send failures
- GitHub deploy dispatch failures
- Mongo slow queries
A minimal counter + a dashboard that alerts on "events pending > 100 for
> 5 minutes" would catch most real outages.

### 🟡 No error tracking
Unhandled rejections, boundary catches, 500s — they log but don't ping
anyone. Sentry / Rollbar drop-in: ~15 minutes per service. Saves you from
finding out about a crash the next morning.

### 🟡 Tests are non-existent
`scripts/smoke-test.js` is `node --check` (syntax validation only). No unit
tests, no integration tests. Every refactor is effectively a manual
regression. Minimum worth writing: integration tests for each 5001 command
endpoint (hit the route, assert status + response shape + workflow record
created). ~1 day to scaffold with supertest + a test Mongo.

---

## Developer experience

### 🟡 No env validator
Missing env vars only crash at the point of use. A startup preflight that
reads every env key the service touches and fails fast with a clear message
would save debugging time. `zod` schemas work well here.

### 🟡 BE is plain JS, FE is strict TS
FE catches shape/type bugs at compile. BE doesn't. The cross-boundary bugs
we hit (leads field, cancel signature, missing targetKey) would have been
compile-time errors if the BE was TS. Migration is real work but pays off
forever. Even JSDoc `@type` annotations on service functions would help.

### 🟡 Workspaces fetch a lot
Many workspaces use 5-15s staleTime + auto-refetch. Ten workspaces open
per admin = steady polling load. Worth:
- Consolidating to a single `/api/read/workspace/:domain/:workspace` endpoint
- Or implementing SSE from control-plane so invalidation is push-based
Premature today; watch Mongo CPU as you grow.

### 🟢 CXWorkspace is 700+ lines, 5 tabs
Could split into `<CxTodayTab>` / `<CxCommunicationsTab>` / etc., each
lazy-loaded. Low priority — it works fine; just uglier to navigate the
code.

### 🟢 Confirm-by-typing pattern only in Deploy
Nice UX invariant. Could reuse for other destructive actions (DNC,
disable-admin, large-audience campaign dispatches). Low-hanging polish.

---

## Product gaps

### 🟡 No audit log UI
Every mutation writes a `WorkflowRecord(family=deploy|cx|client|...)` with
`actorEmail`. Today you query it via `/api/workflows?family=...`, no UI.
A "Recent activity" page in admin that shows who did what when — filterable
by user / family / time range — is probably 2-3 hours of work and very
valuable for operator handoffs + incident review.

### 🟡 Session expiry has no UX
12-hour JWT TTL. No warning at T-5m. User's in the middle of a form at
midnight, clicks save, gets bounced to login, loses data. Add: a hook that
checks expiry every minute, shows a toast at T-5m, and auto-refreshes the
token if they're active.

### 🟡 Password recovery for non-seed admins doesn't exist
Seed admins are hardcoded and can't be locked out. Other admins? If they
lose access to their email, they can't log in and there's no recovery
flow. Before you invite external users, decide: hard-lockout, backup codes,
or admin-can-force-reset.

### 🟢 No "impersonate user" flow
Admins can view any domain but can't see the world exactly as a specific
CX user sees it. For triage / onboarding it'd help. Non-urgent.

### 🟢 Dispatch "re-queue existing list" doesn't exist
Flagged earlier. Today `/api/dispatch/queue` always builds a new list.
Adding an id-scoped `POST /api/dispatch/:id/queue` would enable the
"repeat this exact campaign" flow. Low priority until a campaign actually
needs replaying.

---

## Summary — if I were prioritizing for you

If I had a week to harden this before opening it to real traffic:

1. Ship OTP email through SendGrid in prod config (1 hour including a
   real test send).
2. Wire logs to CloudWatch or similar (½ day).
3. Add error tracking — Sentry DSN in each service (1 hour).
4. Write integration tests for every 5001 command endpoint (1 day).
5. Move secrets out of `.env` into a secret manager (½ day).
6. Build the audit log UI (2-3 hours).

That's about 3 days of work and closes every 🔴. The 🟡 and 🟢 items can
wait until real-world wear tells you which ones matter.
