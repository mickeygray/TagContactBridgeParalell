# PhoneBurner Lead-Delivery Configuration Handoff

Date: 2026-07-10  
Status: PHASE 6 RUNTIME WIRED; FLAGS REMAIN OFF UNTIL SHADOW + BRUCE CANARY

## What Is Ready

- The provider-neutral decision, persistence, cadence ingestion, PhoneBurner transport, callback capture, outcome drain, shallow refill, and reconciliation paths are implemented and tested.
- `config/lead-delivery-agents.json` contains five disabled agents and the folder pairs Mickey supplied.
- All four lead-delivery switches default off. The control plane now reads them and refuses unsafe flag combinations.
- No PhoneBurner member or duplicate LeadStream ID has been invented; `Pool ID` is the distribution/LeadStream routing folder and `Consumer ID` is the receiving folder.
- Mickey reports the five Blind Pull LeadStreams, dispositions, and appointment-with-date action are configured in PhoneBurner. Bruce Allen is the first canary.
- Every agent has the same dark starting packet policy: target five, with `new_today: 2` and one each from `overnight`, `older_available`, and `follow_up_due`; empty pools fall back through the normal packet order.
- The runtime is wired into control-plane health, protected preview/seed/reconcile controls, startup, and shutdown. No production PhoneBurner contact has been posted by it yet.
- All five agents now share one provider-wide contact-post lane: concurrency one, a six-second minimum start interval (maximum 10 logical starts/minute), heartbeat-renewed cross-process ownership, durable `Retry-After`, callback/refill decoupling after packetization, and PII-free backpressure/circuit counters. This is a practical canary limit, not a discovered PhoneBurner ceiling.

## Monday, July 13 Readiness Verdict

Update, July 12: Mickey authorized a one-shot 07:30 Pacific inventory bridge
before the normal re-up canary. That bridge loads the fixed July-to-snapshot
callable population across the five supplied distribution folders through the
same identity-backed, paced provider lane. It is not the automatic refill
runtime: checked-in agents and normal flags remain dark, posting does not count
an attempt, and the command is dry-run by default with an explicit apply gate.
The temporary exception is specified in section 7.2 of the durable work order.
After the first pass, reconcile the posted identities before enabling normal
shallow refill.

The code path is ready for the staged Phase 6 cutover, but it is not safe to jump directly to all five agents. The running Windows service predates this wiring and the flags remain off until the restart/shadow sequence below. One real PhoneBurner callback must still prove that `x-webhook-key` arrives before actions or refill can be enabled.

A green Monday rollout requires, in order:

1. Read-only verify the five configured Blind Pull folder pairs and Bruce's canary path.
2. Resolve callback authentication and prove one capture-only callback.
3. Start the runtime in shadow mode and run a no-post preview.
4. Enable Bruce only and post one target-five packet with refill still off.
5. Prove callback identity, one exact decrement, DNC/appointment behavior, and a controlled one-to-five refill.
6. Pre-position at most five for each remaining enabled agent; keep all excess weekend inventory in the backend shared pools.

If the one-agent gate does not pass before Monday, keep every new lead-delivery flag and agent entry off. Use the existing/manual PhoneBurner loading process as the sole Monday writer; never run it against the same lead population as the new writer.

## Activation Switch Order

| Stage | `LEAD_DELIVERY_ENABLED` | Callback capture | Actions | Refill | Agent config |
|---|---:|---:|---:|---:|---|
| Current / preparation | false | false | false | false | all disabled |
| Callback canary | false | true | false | false | all disabled |
| Shadow runtime | true | true | false | false | canary configured, posting dark |
| One-agent action canary | true | true | true | false | canary only |
| One-agent refill proof | true | true | true | true | canary only |
| Controlled floor | true | true | true | true | enable one agent at a time |

All four switches are wired. Mickey owns Windows service restarts. A voice-owner cutover needs the named services below because each caches environment/code at process start:

1. `ParallelNginx` after the public signed PhoneBurner callback prefix is added.
2. `ParallelRingCentralCx` after the legacy CX writer switches are set false.
3. `ParallelOutboundGateway` after `LEAD_DELIVERY_ENABLED=true`, so cadence keeps non-voice work but suppresses CX and legacy PhoneBurner voice rounds.
4. `ParallelControlPlane` after the lead-delivery stage flags or enabled-agent configuration change.

Do not restart a service merely for PhoneBurner admin/folder edits.

## Cadence And Legacy Voice Ownership

Keep the cadence collection, control-plane worker, outbound worker, SMS, email, RVM, and hygiene work on. The new runtime rereads the same cadence source. When `LEAD_DELIVERY_ENABLED=true`, the outbound cadence sweep omits CX actions and already-queued CX rounds drain as owned no-ops; non-voice rounds continue.

Before enabling the new owner, explicitly set these default-on writers false:

```text
RC_CX_CADENCE_WORKER_ENABLED=false
RC_CX_FRESH_HOT_LANE_ENABLED=false
RC_CX_FRESH_HOT_LANE_IMMEDIATE_ENABLED=false
CX_APPOINTMENT_WORKER_ENABLED=false
CX_ACCOUNT_ACTIVE_CALL_WATCHER_ENABLED=false
```

Also keep every other legacy delivery switch false, including PhoneBurner rotation, pacing/bulk/morning builders, CX first-touch/appointment lanes, Boring dialer/webhook actions, and caller-ID rotation. The control plane refuses to start lead delivery if any known legacy voice writer is armed. Do not run `scripts/run-cx-direct-four-agent-incremental.cmd`.

Weekend intake is not posted with a stateless round robin. The runtime ingests it into shared pools, applies persisted fairness, and pre-positions only the exact shallow deficit (target five) for an explicitly enabled agent. A pre-position does not manufacture agent activity; ordinary automatic refill still requires recent PhoneBurner evidence.

The initial source has no authoritative provider-neutral overnight snapshot key. It therefore does not fabricate `overnight` membership: those callable rows use `older_available` and still fill packets through deterministic allowance fallback. The runtime can go live this way; overnight weighting remains a named follow-up once a real snapshot input exists.

## Provider Post Operating Limit

Leave `LEAD_DELIVERY_PROVIDER_POST_MIN_INTERVAL_MS` unset for the initial canary.
The runtime default is 6,000 ms, and the control-plane wiring refuses a value
below 1,000 ms. At the default:

- one logical contact create may start every six seconds;
- no two logical creates run concurrently;
- five simultaneous one-to-five refills become one 20-contact stream lasting
  about two minutes;
- the estimated 3-5 contacts/minute floor load has roughly two-times service
  headroom;
- a bounded adapter replay can make a second physical POST within one logical
  turn, so the worst retry envelope remains near 20 physical POSTs/minute;
- HTTP 429 stops that packet, durably pauses the one shared lane, and retains the
  exact item/external ID for a later retry rather than converting it to a terminal
  delivery failure. Callback completion never sleeps through the cooldown. The
  runtime tick retries already-packetized work automatically after cooldown or
  restart, even with refill disabled; it never claims new deficit work through
  that recovery path.

Do not raise this by stress-testing the live account. Adjust only after observing
queue depth/age, request latency, any 429/503 responses, and guidance from
PhoneBurner. Pacing smooths bursts; it does not reduce total daily consumption.
At 3-5 creates/minute for eight hours, expected volume is 1,440-2,400/day.
PhoneBurner publishes monthly UI import allowances but does not state whether
REST-created contacts consume them. Confirm that account/quota behavior with
PhoneBurner before the controlled floor stage; deleting contacts is not assumed
to restore allowance.

## What Mickey Creates Per Agent

Repeat this exact setup for each agent who may eventually be enabled:

1. Create one unique distribution folder for that agent.
2. Create one different, unique receiving folder for that agent.
3. Create one Blind Pull LeadStream:
   - source/distribution folder = that agent's distribution folder;
   - receiving folder = that agent's receiving folder;
   - recipient mode = Blind, not Preview;
   - recipient = that agent only.
4. Attach the dialer preset the agent will use.
5. Disable PhoneBurner recycling initially. The backend two-hour timer will own second and third attempts.
6. Do not reuse a historical Mickey test folder or share either folder with another agent.

Owner/member and separate LeadStream IDs are optional verification metadata. PhoneBurner's contact-create route permits the authenticated owner to be used when no owner field is supplied, and the distribution folder is the LeadStream routing identity. Never invent per-agent owner IDs merely to satisfy configuration.

## Disposition Labels

Use a small, controlled set. The current normalizer understands these families:

```text
No Answer
Voicemail / Left Message
Busy / Busy Signal / Busy Phone
Congestion
Intercept
DNC / Do Not Call
Bad Lead / Bad Number / Wrong Number
Appointment
Appointment Needs Time
Client
Answered
```

Any new or misspelled label is retained in `review`; it is never guessed into a business outcome.

## Callback Paths

The route base is:

```text
https://<current-tag-webhook-host>/api/lead-delivery/phoneburner
```

Use the source-specific path:

```text
Contact Displayed  -> /contact-displayed
Call Begin         -> /call-begin
General Call Done  -> /call-done
Disposition hook   -> /disposition
```

The disposition hook is normalized to the same `call_done` event identity, so two hooks cannot create two outcomes for the same provider call.

Authentication contract:

```text
header name = x-webhook-key
header value = existing LEAD_WEBHOOK_SECRET
```

Do not paste the secret into this document, chat, a query string, request body, callback URL, or PhoneBurner folder metadata.

Important: PhoneBurner's public documentation does not establish that callback configuration can send a custom header. First confirm that the PhoneBurner UI can configure `x-webhook-key`. If it cannot, stop and report that fact; do not work around it by putting the secret in the URL. If it can, Codex will temporarily set `LEAD_DELIVERY_CALLBACK_CAPTURE_ENABLED=true`, Mickey will restart the named Windows service, and one test-agent callback will prove the header arrives. Capture-only processing still performs no lead, Logics, appointment, or refill action.

First-party documentation check (2026-07-10):

- PhoneBurner's `POST /rest/1/dialsession` callback schema documents only `callback_type` and a full callback URL; it documents no custom-header or signature field: <https://www.phoneburner.com/developer/route_list>.
- PhoneBurner's Call End setup guide instructs the user to paste a URL into the webhook field and likewise documents no header/signature control: <https://support.phoneburner.com/hc/en-us/articles/39011166673556-Call-End-Done-Webhook>.

If the live UI confirms there is no header facility, that is a material authentication decision, not a reason to smuggle a credential into a query string. The recommended clean fallback for approval is: treat callback intake as untrusted, use a high-entropy per-attempt external lead identity, and require asynchronous PhoneBurner API readback to verify the provider call before any outcome, Logics, appointment, or refill effect. A relay that can add a header is the operational alternative, but it introduces another runtime owner. Neither fallback is enabled or assumed by the current code.

## Values To Return To Codex

The five folder pairs are recorded. Return the remaining fields below once per agent. IDs may be supplied in the workspace or chat, but never include an OAuth token, password, or webhook secret. Include folder IDs again only to correct the Pool/distribution or Consumer/receiving mapping.

```text
agentKey =
displayName =
initiallyEnabled = false

ownerIdentityKind = memberId | username | authenticated-owner
phoneBurnerMemberId =
phoneBurnerUsername =

distributionFolderId =
receivingFolderId =
leadStreamId = # optional admin label; distributionFolderId is the runtime route

subscribedPools = []
  # Supply the exact array of allowed pools, for example:
  # ["new_today", "overnight", "follow_up_due"]

packetAllowances =
  new_today:
  overnight:
  older_available:
  follow_up_due:
```

Also confirm whether these approved defaults remain unchanged:

```text
providerBufferTarget = 5
refillAtOrBelow = 1
freshReservationRange = 3
freshReservationMinutes = 15
activeEvidenceMinutes = 10
maxPendingFreshReservations = 1
```

## What Codex Does After The Values Arrive

1. Keep every agent `enabled: false` until Bruce's live-write gate; optional owner/LeadStream metadata may remain blank.
2. Run the configuration validator:
   - no blank required folder identity;
   - zero or one optional owner identity;
   - unique distribution and receiving folders;
   - unique LeadStream;
   - valid pool subscriptions and integer allowances;
   - fixed 15-minute fresh deadline.
3. Use the PhoneBurner adapter for read-only verification of each supplied distribution and receiving folder.
4. Verify the LeadStream ID, source folder, receiving folder, and Blind recipient in PhoneBurner admin; the public adapter does not claim a documented LeadStream-configuration read endpoint.
5. Prove `x-webhook-key` arrival with one signed test callback.
6. Advance only the designated Mickey/test agent to the controlled canary. All other agents remain disabled.

No Windows service restart is needed merely to create the PhoneBurner objects or return their IDs. If a later configuration change requires a Windows service restart, Mickey performs it after Codex names the exact service and reason.
