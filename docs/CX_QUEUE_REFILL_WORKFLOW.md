# CX Queue Refill — End-State Workflow

This is the prescriptive implementation playbook for the queue-pool +
aged-overflow rewrite. Replaces the current per-family `targetOpen` +
`dailyMax` model with a priority-stack refill driven by a green-only
`routeCampaigns` subscription and shared blue/red reservoirs.

**Scope of change**: refill logic + agent policy fields + cooldown
values. **Out of scope**: claim/complete/cancel mutation paths,
assignment logic, agent presence handling, LeadCadence promotion. None
of those get touched.

Greppable anchors already in place:
```
grep -rn "TODO(ld-queue-split)" packages/ apps/
```
That returns 4 sites — those are the producer + filter + orchestrator
+ policy points this workflow finishes.

---

## End-state behavior in one paragraph

Each agent has a **green-only `routeCampaigns` allowlist** on their queue
policy (empty / null = "see every green," back-compat for existing
agents) and a **single `totalOpen` budget** (e.g. 25 slots). Refill fills
that budget by **priority stack**: try fresh-day1 matching the agent's
routeCampaigns first, then fresh-day2to10 with **no route filter**, then
aged with **no route filter**. Blue and red are shared pools. Aged drains
opportunistically when green/blue cannot fill the budget. Per-lead pacing
is enforced by cooldowns:
**90 min** for green, blue, and aged. Per-family `dailyMax`
becomes belt-and-suspenders or deprecated; cooldown is the real
limiter. Optional v2: **weeklyMax = 2** on aged as a hard per-lead
ceiling.

---

## The pool model

```
Pool A (e.g. LD CUSTOM agents):
  routeCampaigns = ["ld-custom"]
  totalOpen      = 25

  Refill priority:
    1. fresh-day1 with routeCampaignKey ∈ ["ld-custom"]
       ↓ (when those are all in cooldown / out of dialable inventory)
    2. fresh-day2to10 with no route filter (shared blue)
       ↓ (same)
    3. aged — NO routeCampaignKey filter (shared red overflow)

Pool B (e.g. LD GENERAL agents):
  routeCampaigns = ["ld-general"]
  totalOpen      = 25
  (same green filter; blue/red remain shared)

Default Pool (existing agents, no override):
  routeCampaigns = null   → no green filter, sees every green
  totalOpen      = 25     (or sum of legacy fresh+day2to15+aged target)

Optional Pool C (e.g. aged-focused evening shift):
  routeCampaigns = []     → same as null, no green filter
  totalOpen      = 15
  Disable green via policy if you want a red/blue-only agent.
```

The "as needed not on refill" property emerges from step 3 having NO
reserved capacity. Aged only flows in when 1 and 2 yielded fewer than
`totalOpen` dialable items.

---

## Files + functions to change

All sites except (5) and (6) are already TODO-anchored.

| # | File | Function | What to change |
|---|---|---|---|
| 1 | [packages/shared-services/src/cxQueuePolicyService.js](../packages/shared-services/src/cxQueuePolicyService.js) | `resolveAccountQueuePolicy` | Add `routeCampaigns: string[] \| null` and `totalOpen: number` fields on the returned policy. Read from `account.cxQueuePolicy.routeCampaigns` and `.totalOpen`. Empty/null `routeCampaigns` = "see all green" (back-compat). Fall back `totalOpen` to `(fresh.targetOpen + day2to15.targetOpen + aged.targetOpen)` if absent. |
| 2 | [packages/shared-services/src/cxQueuePolicyService.js](../packages/shared-services/src/cxQueuePolicyService.js) | `QUEUE_FAMILY_POLICIES` | Bump `cooldownMinutes`: fresh-day1 15→90, fresh-day2to10 25→90, aged 60→stays-or-higher. Optionally set `aged.dailyMax = null` (let cooldown + overflow logic pace it). Optionally add `weeklyMax: 2` on aged. |
| 3 | [packages/shared-services/src/cxWorkspaceService.js](../packages/shared-services/src/cxWorkspaceService.js) | `maybeRefillCxQueueForAgent` | Switch from per-family parallel refills to a **single priority stack** that fills up to `totalOpen`. Pseudocode below. |
| 4 | [packages/shared-services/src/cxWorkspaceService.js](../packages/shared-services/src/cxWorkspaceService.js) | `materializeQueueSupplyForAgent` + the day2to15/aged materializers it calls | Accept a `routeCampaigns` array for green only. Day2to15 and aged always run with no route filter because blue/red are shared. |
| 5 | [packages/shared-services/src/cxQueuePolicyService.js](../packages/shared-services/src/cxQueuePolicyService.js) | `resolveQueueDialability` | (Only if implementing `weeklyMax`) add a weekly-cap gate: if `policy.weeklyMax != null` and `item.weeklyPlacedWeekKey === currentWeekKey && item.weeklyPlacedCalls >= weeklyMax` → block with reason `"weekly-cap-reached"`. |
| 6 | [packages/shared-services/src/cxQueuePolicyService.js](../packages/shared-services/src/cxQueuePolicyService.js) | `buildCallAttemptPatch` | (Only with weeklyMax) increment `weeklyPlacedCalls` mirroring the existing daily increment; stamp `weeklyPlacedWeekKey`. |
| 7 | [packages/shared-models/src/CxDialQueue.js](../packages/shared-models/src/CxDialQueue.js) | schema | (Only with weeklyMax) add `weeklyPlacedWeekKey: { type: String, default: null, index: true }` and `weeklyPlacedCalls: { type: Number, default: 0 }`. |
| 8 | Admin UI policy editor | — | Expose `routeCampaigns` multi-select + `totalOpen` single number. Hide or deprecate per-family `targetOpen` fields. |

### Refill pseudocode (the heart of the change)

```js
async function maybeRefillCxQueueForAgent(context, agentExtensionId, visibleQueueItems = []) {
  const policy = resolveAccountQueuePolicy(context.account);
  if (!policy.enabled) return { skipped: true, reason: "policy-disabled" };

  const currentOpen = countClaimableInVisible(visibleQueueItems, agentExtensionId);
  const totalOpen = policy.totalOpen;
  let deficit = Math.max(totalOpen - currentOpen, 0);
  if (deficit <= 0) return { ok: true, skipped: true, reason: "target-met" };

  const routeCampaigns = policy.routeCampaigns || null;
  const filled = [];

  // Step 1 — green stream, route-filtered
  const greenBatch = await refillFamily({
    context, agentExtensionId,
    queueFamily: "fresh-day1",
    routeCampaigns,                  // null = no filter
    deficit,
    claimMinutes: getFamilyClaimMinutes("fresh-day1"),
  });
  filled.push(greenBatch);
  deficit -= greenBatch.assigned;
  if (deficit <= 0) return summarize(filled);

  // Step 2 - blue stream, shared
  const blueBatch = await refillFamily({
    context, agentExtensionId,
    queueFamily: "fresh-day2to10",
    routeCampaigns: null,
    deficit,
    claimMinutes: getFamilyClaimMinutes("fresh-day2to10"),
  });
  filled.push(blueBatch);
  deficit -= blueBatch.assigned;
  if (deficit <= 0) return summarize(filled);

  // Step 3 - aged overflow, shared
  const agedBatch = await refillFamily({
    context, agentExtensionId,
    queueFamily: "aged",
    routeCampaigns: null,             // KEY: aged is pool-agnostic
    deficit,
    claimMinutes: getFamilyClaimMinutes("aged"),
  });
  filled.push(agedBatch);

  return summarize(filled);
}
```

Each step calls a thin wrapper around the existing
`refillQueueFamilyForAgent` + `materializeQueueSupplyForAgent` plumbing —
no new transport, no new repository methods. Just a single new arg
threaded through.

---

## Phased rollout

### Phase 1 — Pool filter only (1-2 hours of work)

Land the `routeCampaigns` filter for green only. Don't touch cooldowns
or daily caps. Don't change the per-family targetOpen budget.

This is exactly the TODO(ld-queue-split) work we already breadcrumbed.
Result: LD CUSTOM agents get LD CUSTOM greens, LD GENERAL agents get
LD GENERAL greens, and everyone shares blue/red once those leads age.
Throughput math is the same as today — this is purely about first-touch
ownership.

### Phase 2 — Aged-as-overflow + single totalOpen (4-5 hours)

Switch refill to the priority stack. Drop per-family targetOpen in
favor of single `totalOpen`. Aged becomes opportunistic with no
routeCampaign filter. Per-family `dailyMax` stays for now as
belt-and-suspenders.

Result: agents who burn through their green ownership and the shared
blue pool start pulling aged automatically. Throughput on aged jumps from "1/day/agent" to
"whatever there's slack for." The 6,800 aged inventory starts draining.

### Phase 3 — Cooldown bump (10 min of work)

`cooldownMinutes` 15 → 90 for fresh-day1, 25 → 90 for fresh-day2to10.
Optionally drop or relax aged `dailyMax` since the cooldown becomes
the natural pacer.

Result: agents stop re-cycling the same 5 leads. Forces refill to
pull untouched leads sooner. Unique-leads-touched-per-day jumps
significantly.

### Phase 4 — Weekly cap on aged (optional, 1-2 hours)

Add `weeklyMax: 2` to aged policy + the two new fields on
CxDialQueue + the dialability gate + the attempt patch increment.

Result: a per-aged-lead hard ceiling that doesn't depend on agent
behavior. Belt-and-suspenders for contact fatigue.

### Phase 5 — Deprecate per-family targetOpen (cleanup)

Once Phase 2 is proven stable, remove the per-family `targetOpen`
references from the admin UI and migrate any remaining agent records
to use `totalOpen` as the sole budget. The legacy reads in
`resolveAccountQueuePolicy` get retired.

---

## What stays exactly as-is

- `cxDialQueueRepository` — no changes to the read/write methods.
- Claim / complete / cancel paths (`claimNextCxQueueItem`,
  `completeCxQueueItem`, `cancelCxQueueItem`). Buckets are a
  refill-time concept, not a mutation-time concept.
- The aging boost in `getCxQueueServeRank` (cxQueueFairnessService.js).
  Plays cleanly with the new model — within each family at refill
  time, untouched-longer leads bubble up first.
- The hourly fairness caps in `cxQueueFairnessService`. Still apply.
  With 90-min cooldown, they rarely bind on individual leads anyway.
- The today-dials rollup and call-review dashboard. Both read
  CxDialQueue / CallLog directly and are unaffected by routing
  changes. The dashboard's per-agent panels keep working through
  the new model.
- LD intake (`normalizeLdLeadPayload`). Already stamps
  `routeCampaignKey = "ld-custom" | "ld-general"` at ingest. No
  change.
- MasterProspectIndex. Stays as the index; not part of the dial
  pipeline.

---

## Concrete migration / sanity checks

After Phase 1:
- Set one canary agent's `routeCampaigns = ["ld-custom"]`. Watch
  their next green refill — should pull only LD CUSTOM-stamped green
  items. Blue/red should still be shared. The today-dials rollup
  endpoint should reflect their activity normally.

After Phase 2:
- Watch the dashboard's "Calls today" panel for an agent in a pool.
  Expect to see a mix of fresh + day2to10 + (occasionally) aged
  in their call list. If aged never appears, the overflow gate
  isn't firing — check the deficit math.

After Phase 3:
- Re-run `scripts/diagnose-throughput.js` (and the dialability
  variant). Expect `dailyPlacedCalls` distribution on ready items
  to shift: fewer items with 4-5 calls, more items with 1-2 calls.
  Unique leads touched per day should climb noticeably.

After Phase 4 (if shipped):
- Confirm aged items can hit `weekly-cap-reached` reason on
  dialability checks once they accumulate 2 touches in a single
  PT week.

---

## Knobs / env overrides to expose

So the policy can be tuned without redeploys:

| Env var | Purpose | Default |
|---|---|---|
| `RC_CX_FRESH_COOLDOWN_MINUTES` | green cooldown | 90 |
| `RC_CX_DAY2TO15_COOLDOWN_MINUTES` | blue cooldown | 90 |
| `RC_CX_AGED_COOLDOWN_MINUTES` | red cooldown | 90 |
| `RC_CX_AGED_WEEKLY_MAX` | weekly per-aged-lead cap (Phase 4) | 2 |
| `RC_CX_TOTAL_OPEN_DEFAULT` | fallback totalOpen when policy doesn't set it | 25 |
| `RC_CX_AGED_OVERFLOW_ENABLED` | feature flag for the Step 3 fallback | true |
| `RC_CX_DRAIN_BEFORE_REFILL_ENABLED` | existing flag; keeping for backout | true |

All of these read in `cxQueuePolicyService.js` already follows an
env-override-or-default pattern — additions are tiny.

---

## What this fixes (concretely, against today's data)

- **6,800 aged inventory stuck**: drains opportunistically when pools
  go cold. With 10 agents averaging even 3 aged touches/day each, that's
  30/day = 226 days to cycle. Not great but realistic; without this
  change it's effectively infinite under `dailyMax=1`.
- **1,026 untouched ready leads while agents have 280+ empty slots**:
  cooldown bump (Phase 3) is the direct fix. Agents can't recycle the
  same 5 leads, so the next refill pulls untouched ones.
- **278 unique leads dialed today across 5 agents**: with pool routing
  + cooldown bump + 10 agents fully ramped, this should rise to
  500-700 unique/day on the same call volume.
- **The LD CUSTOM / LD GENERAL queue split**: ships in Phase 1.
  Two agent groups, each focused on their own bucket, both able to
  reach into aged when their primary slows.

---

## Don't do these things

- Don't add a "promote MPI to LeadCadence" step. MPI fills gaps; it
  isn't a gating layer for the dial queue.
- Don't carve out reserved aged slots in `totalOpen`. The whole point
  is aged is opportunistic — reserving capacity defeats it.
- Don't touch the claim/complete/cancel paths. They work; the bucket
  routing is purely refill-time.
- Don't add a separate aged-queue model. Aged is the same CxDialQueue
  rows, just queried without the routeCampaign filter when surfaced.
- Don't lower `targetOpen` to compensate for the cooldown bump until
  data confirms it's needed. Bigger packs are fine when cooldown is
  the pacer.
