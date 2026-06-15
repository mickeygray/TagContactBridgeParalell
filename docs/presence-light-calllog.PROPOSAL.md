# Proposal: light-source contact/call capture, with the call log as a single reconciliation pass

**Status:** proposal for review. Nothing built. Verified against code via a 4-lens read (file:line below).
**Ask (restated):** capture call events for real (non-bridge) calls from the *light* presence API to drive ROI + client-contact events for mail / aged leads, and run *one* heavy call-log reconciliation against all of it — instead of the call log being the per-call primary source.

---

## 1. What's confirmed about the two pipelines

**The call log IS the heavy path (premise confirmed).** The dominant cost is the **hourly account-wide CDR sweep** — `runRingCentralCallLogSweep` (`ringcentralCallLogSweepService.js:42-186`) hits `/account/~/call-log?view=Detailed`, 65-min sliding window, 100/page up to 1000 rows, every hour, in RC's **Medium/Heavy** rate-limit group (429 risk). Compounded by per-call recording download + Whisper/Claude scoring (`hourlyCallLogHygieneService.js:808-911`) and a nightly Mongo source-backfill. CallLog has **four writers**: (1) EX resolver on presence webhooks, (2) the hourly sweep, (3) the CX disposition path, (4) nightly backfill. **Only writer (2) is the heavy account-wide API** — that's the one this proposal targets; 1/3/4 stay.

**The reconciliation pattern already exists.** The CX-disposition path writes a *stub* CallLog (caseId set, `sourceName` null) keyed by `(domain, telephonySessionId)`, and `callLogSourceBackfillService` fills attribution later from `LeadCadence`/`MasterProspectIndex` (`callLogSourceBackfillService.js:1-40`). "Write light now, enrich later, dedupe on telephonySessionId" is **already how CX calls work** — this proposal generalizes it.

---

## 2. The hard constraint that reshapes the idea

**Presence alone cannot attribute OUTBOUND calls.** The presence `activeCall` payload carries `sessionId`, `telephonySessionId`, `direction`, `startTime`, and — for **inbound** — the caller `from` number (`ringcentralExService.js:181-198`). But for **outbound**, `to` is the agent extension / null, **not the dialed customer number** (`ringcentralExService.js:181-198`, confirmed). Mail/aged work is mostly outbound dialing → presence can't tag those to a lead. Also: presence has **no real call-end timestamp/duration** — `lastCallEndedAt` is the *observation* time the webhook fired (`ringcentralExService.js:417-420`), so duration is a proxy.

**The fix:** the light source for outbound is the **`CallSession`** we create at dial time (`dialService.placeCall`) — *we* dialed the number, so we already hold it, plus `telephonySessionId`, agent, and `caseId` from the dial context — correlated with **presence** for connect/disconnect timing. So:

| Call type | Light source for the number | Timing |
|---|---|---|
| **Outbound** (mail/aged dials) | `CallSession.phoneNumber` (we dialed it) | presence connect→NoCall via `telephonySessionId` |
| **Inbound** | presence `activeCall.from` | presence connect→NoCall |

Net: **light capture = CallSession ⊕ presence**, joined on `telephonySessionId`. Presence is the timing/heartbeat; CallSession is the identity for outbound.

---

## 3. Proposed change

**(a) Light contact-event capture.** On dial (`CallSession` placing/connected) and presence connect, upsert a CallLog stub keyed by `(domain, telephonySessionId)` carrying: agent/extensionId, the phone (CallSession for outbound, presence `from` for inbound), direction, startTime, platform, `caseId` if known, observed-end on the `NoCall` transition, and `attributionPending:true`. This is the existing stub pattern, extended to every non-bridge call (non-bridge = inverse of `isLikelyCxBridgeExCall`, `agentAvailabilityService.js:439-462`, deterministic, no CallLog needed).

**(b) Real client-contact events (the actual ROI upgrade).** Emit "case `X` contacted by agent `A` at `T`" → append to `CaseProfile.contactActivityIds` in real time (`caseProfilePromotionService.js:192`). **Today, mail ROI "contacted" is inferred from CaseProfile+PaymentLedger at nightly close** (`vendorNightlyEmailService.js:562-710`) — it literally cannot tell "agent contacted then paid" from "paid with no contact." This capture closes that gap and is the highest-value, lowest-risk slice.

**(c) Demote the hourly sweep to a reconciliation pass.** Once most rows already exist as stubs, the account-wide CDR sweep stops being the *primary writer* and becomes the **single correction/audit pass**: reconcile against stubs by `telephonySessionId`, fill only what CDR uniquely has (precise duration, source via resolver, recording URIs), and catch calls the app never initiated. Run it **delta-only / less frequently / off-hours** → the heavy-API volume drop. This is the "one call log check against all of that."

---

## 4. What still REQUIRES the call log (cannot be light-sourced)

- **Source/campaign attribution** beyond dial-time knowledge — CallRail / DID / `legs[]` for inbound source, `mailPieceKey`, LD-family `routeCampaignKey` split (`callAttributionResolverService.js:204-889`). Note this is already a Mongo join + resolver, **not** the heavy API, so presence doesn't reduce that load anyway.
- **Precise duration / talk-time** (presence end is a proxy).
- **Recordings + scoring.**
- **Calls the app didn't initiate** (manual RC-app dials, transfers, non-agent legs) — no CallSession, no usable presence number → still need the sweep. **This is why the sweep can be demoted, not removed.**

---

## 5. Reconciliation keys (confirmed supportable)

- **Primary:** `(domain, telephonySessionId)` unique (`CallLog.js:294`) — presence *and* CallSession both carry `telephonySessionId`, so stub↔CDR upserts are idempotent.
- **Fallback:** `normalizedPhone` (10-digit) + time window for phone-rescue (`callLogRepository.js:90-96`, `callLogSourceBackfillService.js:330-399`).
- **Ledger sync:** `(domain, telephonySessionId)` (`CallLedger.js:74`) — the atomic convergence point.
- **Match tolerance** for clock skew (±30-60s) is a **design choice**, not inherited (`ringcentralAttributionService.js:24-32` is an API-fetch window, not a dedupe rule).

---

## 6. Staged rollout (money-critical → shadow-validate before demoting anything)

1. **Shadow capture** — write the CallSession⊕presence stubs in parallel, do **not** change the sweep. Diff stub coverage vs the CDR sweep output; measure what fraction of non-bridge calls the light path actually catches (esp. outbound through our dialer vs manual).
2. **Contact events** — ship (b): real `contacted` events into `CaseProfile.contactActivityIds` + nightly ROI upgrade. Additive, reversible, high value.
3. **Demote the sweep** — only after shadow proves parity: switch the sweep to delta/reconciliation cadence behind a flag, with the full hourly sweep one env-flip away.

---

## 7. Risks / open questions (self-critique)

- **The outbound-number premise depends on dials going through our dialer.** Manual agent dials from the RC app have neither presence's number nor a CallSession → uncatchable by the light path. **Must quantify the manual-vs-dialer split before assuming big savings** — this is the load-bearing unknown and I have **not** measured it.
- **Duration is a proxy** from presence. Fine for "contacted yes/no + approx"; not fine if ROI needs billing-grade talk-time → then the CDR reconciliation must still fill duration, shrinking the win.
- **The cost win is specifically the account-wide CDR API sweep**, not the whole pipeline. Source attribution + scoring loads are unchanged.
- **No account-wide real-time call-end subscription exists today** — presence is per-agent (30s poll + webhooks); it covers calls our agents are a party to, not the full account distribution.
- **This touches money-critical reporting** — hence the shadow-first staging; do not demote the sweep on faith.

---

## 8. Recommendation

Sequence by value/risk: **start with (b) contact-events in shadow** — it delivers the "contacted → paid" ROI we don't have today and validates the CallSession⊕presence capture, with zero risk to the existing call log. Treat the sweep-demotion (the cost saving) as a *later* phase gated on proven shadow parity. Before committing, measure the **manual-vs-dialer outbound fraction** — that number decides how much the sweep can actually shrink.
