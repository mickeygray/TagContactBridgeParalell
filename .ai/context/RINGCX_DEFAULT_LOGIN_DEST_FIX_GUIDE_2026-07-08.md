# RingCX defaultLoginDest Fix Guide - 2026-07-08

Purpose: hand this to a local coding agent to verify or complete the Chris/off-hook login destination fix without drifting into the working dial path.

## Plain-English Problem

RingCX has two different phone-shaped fields with different expected formats:

- `defaultLoginDest`: the phone session / off-hook login destination. RingCX accepts a bare 10-digit DID or a SIP URI. It rejects E.164 values like `+1...`.
- `manualOutboundDefaultCallerIdE164`: outbound caller ID. This field wants E.164.

The outage class is caused when `defaultLoginDest` is written with the caller-ID shape. The agent can look healthy in the app queue, but RingCX cannot establish the off-hook phone session, so dialing appears stuck or frozen.

## Scope

Fix only the login destination formatting boundary.

Do not normalize every phone helper in the repo. Do not unify all phone formatting in this work order. Do not touch the working lead-dial path.

## Current Local Tree Status

The current local tree already appears to include Part A of this fix:

- `normalizeRingcxLoginDest` exists in `packages/shared-integrations/src/ringcxVoiceClient.js`.
- It is exported from `ringcxVoiceClient.js`.
- `scripts/rcx-ex-deskphone-test.js` uses it when creating or patching RingCX agents.
- `tests/cx-bulk-load/ringcxLoginDestNormalizer.test.js` pins the expected behavior.

Still verify this before declaring the work done. The tree is very dirty and may not match the executor's branch.

## Required Behavior

`normalizeRingcxLoginDest(value)` must:

- Return bare 10 digits for E.164 or 11-digit US inputs.
- Return bare 10 digits unchanged when already valid.
- Return SIP-looking destinations unchanged.
- Return `null` for empty values.

Examples:

- `+1...5982` -> `...5982` as a 10-digit DID.
- `1...5982` -> `...5982` as a 10-digit DID.
- `sip:agent@pbx.example.com` -> unchanged.
- Empty/null -> `null`.

## Do Not Touch

These paths are intentionally fenced:

- `normalizeRingcxPhone`: leave its behavior alone. The working manual dial path uses it.
- `sanitizeUsPhone` / `toE164`: leave caller-ID and RingOut formatting alone.
- `placeManualCall`: do not change destination/caller-ID behavior as part of this fix.
- `manualOutboundDefaultCallerIdE164`: keep E.164.
- Bulk queue extern IDs (`cxbl`, lane IDs, appointment IDs): unrelated.
- Poller / terminal drain / wrap queue: unrelated.

The common failure mode here is a "helpful" cleanup that makes caller ID and login destination share one formatter. That is wrong for RingCX.

## Part A - Required Code Verification

1. Confirm the SIP-safe wrapper exists:

   - File: `packages/shared-integrations/src/ringcxVoiceClient.js`
   - Expected export: `normalizeRingcxLoginDest`

2. Confirm every write to `defaultLoginDest` in provisioning/repair tooling uses the wrapper.

   Start with:

   - `scripts/rcx-ex-deskphone-test.js`

   Then search the repo:

   ```powershell
   rg -n "defaultLoginDest" packages apps scripts tests -g "*.js" -g "*.ts" -g "*.tsx"
   ```

3. Add or preserve tests:

   - File: `tests/cx-bulk-load/ringcxLoginDestNormalizer.test.js`
   - Must include:
     - E.164 strips to bare 10-digit.
     - Bare 10-digit passes through.
     - 11-digit leading-1 strips to 10.
     - SIP URI passes through unchanged.
     - Empty/null return `null`.
     - Fence test proving `normalizeRingcxPhone` was not changed.

4. Run:

   ```powershell
   node --test tests/cx-bulk-load/ringcxLoginDestNormalizer.test.js
   ```

## Part A - Data Remediation Is Required

Code alone does not fix an agent whose RingCX record already has a malformed `defaultLoginDest`.

For the affected agent:

1. Read the RingCX agent record.
2. Confirm `defaultLoginDest` is malformed E.164 or otherwise not accepted by RingCX.
3. Patch only that field to the SIP-safe normalized value.
4. Preserve caller-ID fields exactly as they are unless Mickey explicitly asks otherwise.
5. Read the agent back and confirm:
   - `defaultLoginDest` is bare 10 digits or SIP.
   - `manualOutboundDefaultCallerIdE164` is still E.164 if present.
   - `allowOffHook` remains true.

Do not print full phone numbers in logs or handoff text. Mask to last four.

## Part B - Optional Self-Heal Repair

Do not implement Part B unless Mickey explicitly authorizes it.

Current self-heal behavior in `packages/shared-services/src/ringcxAgentSelfHealService.js` can early-return when `allowOffHook` is already true. That means it may not repair a malformed `defaultLoginDest` on an already-enabled agent.

If authorized, extend self-heal so it can patch both:

- `allowOffHook !== true`
- malformed `defaultLoginDest`

Rules for Part B:

- Use `normalizeRingcxLoginDest`.
- Do not overwrite SIP values.
- Do not overwrite caller-ID fields.
- Log before/after as masked metadata only.
- Preserve existing cooldown behavior.
- Add tests for:
  - already-enabled + valid login dest => no patch
  - already-enabled + E.164 login dest => patch login dest only
  - not-enabled + valid login dest => patch `allowOffHook` only
  - not-enabled + E.164 login dest => patch both

## Verification Bar

Minimum local verification:

```powershell
node --test tests/cx-bulk-load/ringcxLoginDestNormalizer.test.js
node --check packages/shared-integrations/src/ringcxVoiceClient.js
node --check scripts/rcx-ex-deskphone-test.js
```

If Part B is implemented, also run the relevant self-heal tests or add a focused test before merging.

## Acceptance Criteria

This work is complete when:

- New RingCX agent writes cannot put E.164 into `defaultLoginDest`.
- Existing affected agent records are manually remediated or a clearly authorized self-heal path remediates them.
- Caller ID formatting remains untouched.
- The login-dest normalizer tests pass.
- No queue, poller, terminal drain, or caller-ID behavior changes are mixed into this patch.
