# PhoneBurner Webhook and Disposition Action Matrix

Date: 2026-07-13

## Ruling

PhoneBurner is the agent's call surface. The backend remains the sole owner of lead eligibility, the universal dialed-attempt ledger, retry timing, daily attempt limits, cross-agent fairness, Logics DNC updates, and terminal outcome reporting.

Every completed PhoneBurner call must reach one normalized backend `call_done` path. A disposition button may also perform safe PhoneBurner-local presentation work, but it must not create a second retry clock or silently remove the provider identity the backend needs.

### MVP action mode

The control-plane production default is intentionally `DNC-only` for application-side business actions:

- every exact Call End counts the physical attempt, removes it from current agent capacity, and may trigger the guarded shallow refill;
- retryable PhoneBurner statuses receive the backend timer and exact-contact recirculation;
- DNC and Bad Lead/Bad Number invoke the existing idempotent Logics DNC path;
- appointment is recorded only as a terminal/stat outcome; it performs no backend scheduling action;
- client, appointment, answered, and review outcomes still stop automatic redial according to the normalized terminal/review state.

There is no PhoneBurner appointment-action feature flag or later opt-in path.

## Available PhoneBurner trigger surfaces

| Trigger | Fires when | Useful payload/evidence | Backend use |
|---|---|---|---|
| Contact Displayed | A contact appears in the dialer, before a call | Contact/lead identity | Activity/visibility only; never count a call |
| Call Begin | Each physical call begins; may fire more than once for a multi-number contact | Call ID, dial-session ID, lead/contact identity | Bind the physical call identity; mark in-call; renew agent activity |
| General Call End/Done | The agent dispositions the call | Disposition status, call ID, duration, connected flag, contact and agent data | Universal call completion fallback/normal path |
| Disposition-specific Call End | That exact button is pressed | Same call-end family, with the button's status | Team-wide targeted action; overrides the general Call End destination for that button |
| Manual Webhook | Agent selects Send to Webhook before, during, or after a call | Current contact data/status | Exceptional human escalation or repair only; not ordinary completion |
| Contact Activity Webhook | Selected PhoneBurner activity is logged | Activity code/time, user and contact identity | Secondary signals such as Appointment Scheduled, transfer, inbound activity, email/SMS engagement |
| Email Unsubscribe | A recipient unsubscribes from a PhoneBurner email | Contact identity and unsubscribe evidence | Set application email-channel suppression; do not infer voice DNC |
| SMS Opt Out | A recipient replies STOP | Phone/contact identity and opt-out evidence | Set application SMS-channel suppression across matching records; do not infer voice DNC |
| API dial-session callbacks | An API-created dial session displays, starts, or completes a call | The three callback types plus caller-supplied `custom_data` | Strong correlation when this backend creates the dial session; not assumed for ordinary LeadStream sessions |

PhoneBurner supports multiple comma-separated destinations for Call End/Done only. A disposition-level Call End webhook overrides the account-level Call End webhook. Shared admin disposition sets are therefore the preferred team-wide configuration.

## Required callback routes

```text
POST /api/lead-delivery/phoneburner/contact-displayed
POST /api/lead-delivery/phoneburner/call-begin
POST /api/lead-delivery/phoneburner/call-done
POST /api/lead-delivery/phoneburner/disposition
```

All routes are capture-first, identity-backed, idempotent, and authenticated. They must acknowledge only after durable event capture. Raw PhoneBurner payloads, phone numbers, notes, recordings, and credentials are not persisted in the event ledger.

These four routes exist now. Contact Activity, Manual, Email Unsubscribe, and SMS Opt Out are documented provider capabilities but do not yet have provider-neutral ingress routes in this runtime. They stay off until separate payload/authentication canaries define their safe identity and channel-specific actions.

Current nuance: PhoneBurner's published Contact Displayed shape has contact/lead identity but no unique occurrence identity. The current runtime safely captures that shape as review-only, so it does not yet renew an agent activity lease. Implement a separate observational activity transition for it; do not make a display event eligible to count or complete a call.

## Button matrix

| Button/status | PhoneBurner-local behavior | Backend result | Redial rule |
|---|---|---|---|
| No Answer | Status; Next Contact | Record completed attempt | Eligible after two hours if under daily cap |
| Voicemail / Left Message | Send selected voicemail if desired; status; Next Contact | Record completed attempt | Eligible after two hours if under daily cap |
| Busy Signal | Status; Next Contact | Record completed attempt | Eligible after two hours if under daily cap |
| Congestion | Status; Next Contact | Record explicit congestion outcome | Eligible after two hours if under daily cap |
| Intercept | Status; Next Contact | Record explicit intercept outcome | Eligible after two hours if under daily cap |
| Bad Number / Wrong Number / Bad Lead | Status; optional safe folder/tag; webhook | One idempotent Logics DNC/bad-lead action | Terminal |
| Do Not Call | PhoneBurner DNC protection plus status; webhook | One idempotent Logics DNC action | Terminal |
| Appointment | Status; webhook | Record one terminal appointment outcome for reporting; perform no scheduling action | Terminal |
| Client | Status; webhook | Stop dialing; optionally add a Logics client/retained action after business ruling | Terminal |
| Answered / Needs Review | Status; webhook | Record answered/review and hold for stronger disposition | Never automatically retry |
| Explicit Follow-Up | Status; require a date if used; webhook | Persist an explicit follow-up only when exact date/time evidence is captured | Backend timer only |
| Send to Webhook | No automatic status assumption | Manual repair/escalation event | No state change without an explicit action contract |

## Preset constraints

1. Use one shared Dialing Set and one shared Live Answer Set for the floor.
2. Put the backend disposition webhook on every ordinary completion button. Do not rely only on each agent's personal general Call End setting.
3. Use exact stable status strings from the matrix. The visible label may be friendlier, but the status is the integration contract.
4. Set ordinary results to `Next Contact`. `Next Number` can create multiple physical `call_done` events for one contact and therefore requires a separate decision about whether the three-per-day cap counts calls or contacted leads.
5. Disable PhoneBurner recycling and ordinary PhoneBurner follow-up timers. The backend owns the two-hour clock and exact-contact recirculation.
6. Do not delete the contact or phone number from a button. DNC can use PhoneBurner's own DNC protection, but the provider contact identity must remain available for audit and idempotency.
7. Folder moves and tags may be used for agent-facing organization only. They are not eligibility truth.
8. Do not use Transfer to User for ordinary balancing. Backend exact-ID placement owns cross-agent routing.
9. Keep `Connected Call` accurate for PhoneBurner reporting, but backend outcome routing uses the explicit disposition and physical call identity rather than trusting that flag alone.

## Permanent appointment boundary

PhoneBurner Call End does not expose a dependable appointment instant. The
backend therefore records Appointment only as a terminal/stat outcome. It does
not parse appointment date/time fields, create application appointments or
Logics tasks, schedule wake timers, or swap agent Pools.

## MVP authentication ruling

At Mickey's direction on 2026-07-13, PhoneBurner callback intake is temporarily unauthenticated because the provider configuration did not establish reliable custom-header delivery. Capture still defaults off, validates a bounded payload, deduplicates provider occurrences, and requires exact stored provider identity before any action. No query-string or body secret is used. Restore a provider-compatible authentication boundary after the live flow is proven.

## Required canary sequence

Run these against the test contact/preset, one at a time:

1. Contact Displayed.
2. Call Begin.
3. No Answer disposition.
4. Voicemail disposition.
5. Bad Number disposition.
6. DNC disposition.
7. Appointment disposition, proving terminal/stat-only behavior.
8. Client.
9. One unknown/test disposition to prove review behavior.
10. Manual Send to Webhook, if retained.
11. Email unsubscribe, if PhoneBurner email is enabled.
12. SMS STOP opt-out, if PhoneBurner SMS is enabled.

For each event prove: authentication, HTTP 200, exact provider contact/call/lead identity, durable single capture, expected normalization, duplicate replay safety, correct local state, correct downstream action, and absence of PII in logs.

## Open decisions

- Whether `Client` should only stop dialing or also invoke an existing Logics retained/client transition.
- Whether multi-number `Next Number` attempts count separately toward the daily maximum. Until decided, use `Next Contact`.
- Whether PhoneBurner's appointment activity includes an authoritative instant and timezone.
- Whether Contact Activity and Manual webhooks can send the required custom authentication header.
- Exact safe payload contracts and authenticated ingress routes for Contact Activity, Manual, Email Unsubscribe, and SMS Opt Out.
- A non-call-mutating Contact Displayed activity transition; the current occurrence-identity guard correctly prevents it from changing call attempts.
