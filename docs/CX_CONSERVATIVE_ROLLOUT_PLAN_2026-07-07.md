# CX Conservative Rollout Plan - Draft 0 (2026-07-07)

This is the first rollout sketch after the successful local lane interrupt drill:
`20260707221903`.

Observed proof from that drill:
- Normal Mickey bulk queue loaded and kept advancing.
- First-touch lane dispatched to the mapped first-touch campaign.
- Appointment lane dispatched to the mapped appointment campaign.
- Appointment skew was 13s, inside the -5s/+45s acceptance window.
- The old appointment worker did not wipe the first-touch ownership stamp after the
  ownership guard patch.

This proves the serving boundary. It does not yet prove broad rollout, because lane
consumption and several floor-safety pieces are still deliberately unfinished.

## Rollout Posture

Default stance: one agent, one lane, one timed window, with flags off before and after.

No full-roster maps with lane flags on until:
- F2 lane consumption exists: a terminal `cxft-*` call releases `firstTouchPending`, and
  lane answered calls can enter the wrap/card path correctly.
- The wrap resolve route reports effect failures back to the client.
- Appointment creation is timezone-explicit from the UI.
- Mickey has made the Logics transient-vs-confirmed failure ruling.
- The floor break/resume check has been observed with a human.
- We have one clean one-agent canary with logs, RingCX evidence, and no UI ownership loss.

## Phase 0 - Lock The Local Proof

Goal: make today's proof reproducible.

Steps:
- Cleanup drill tag `20260707221903` after Mickey is done observing the UI.
- Clear any published lane copies from the test RingCX campaigns.
- Re-run one clean local interrupt drill after cleanup.
- Save the exact verdict block and the matching control-plane log markers:
  `cx.alpha.firsttouch.dispatched`, `cx.alpha.appt.dispatched`,
  `control-plane.cx_first_touch.dispatch.tick`,
  `control-plane.cx_appt_lane.dispatch.tick`.
- Confirm the UI side with human notes: modal appeared only with a real call, middle
  section projected the lane call, bulk stayed usable behind it, and modal dismissed.

Exit bar:
- Drill passes twice after the ownership patch.
- First-touch row keeps `metadata.firstTouchDispatch`.
- Appointment row gets `rcxDispatch`.
- Bulk session current remains `cxbl-*`; lane externs never become bulk current.

## Phase 1 - Flags-Off Deploy Shape

Goal: put the code/config shape in place without changing agent behavior.

Steps:
- Deploy/restart with lane maps present but `CX_FIRST_TOUCH_ENABLED=false` and
  `CX_APPT_LANE_ENABLED=false`.
- Confirm dispatcher ticks are inert or skipped.
- Confirm normal bulk, wrap cards, and appointments behave exactly as before.
- Confirm no real scheduled appointments were dispatched by the lane dispatcher.

Exit bar:
- No `cx.alpha.firsttouch.dispatched` or `cx.alpha.appt.dispatched` logs while flags are off.
- Existing bulk/wrap drills remain green.

Rollback:
- Leave both flags false. No data migration is required.

## Phase 2 - One-Agent Appointment Canary

Recommended first live lane: appointment, one agent only.

Why: appointment timing is easy to observe, campaign volume is tiny, and every dispatch has
an expected time. This is safer than opening the first-touch intake drip broadly.

Setup:
- Pick one canary agent who is actively supervised.
- Configure `CX_APPT_QUEUE_MAP` with only that agent.
- Confirm their appointment campaign priority is above regular bulk.
- Keep `CX_FIRST_TOUCH_ENABLED=false`.
- Enable `CX_APPT_LANE_ENABLED=true` only for the canary window.

Run:
- Use one synthetic appointment first.
- Then allow one real low-risk scheduled appointment if Mickey approves.
- Watch RingCX active calls, Mongo appointment row, control-plane logs, and the UI modal.

Pass:
- Appointment dispatches to the canary campaign at the scheduled moment.
- UI shows appointment lane only after UII exists.
- Bulk current is not stolen.
- The canary can disposition from the lane controls, or the expected gap is documented if
  consumption is still not enabled.

Stop:
- Modal appears without a live call.
- Any non-canary appointment dispatches.
- Bulk current changes to `cxapt-*`.
- Appointment row dispatches more than 45s late or early.

Rollback:
- Set `CX_APPT_LANE_ENABLED=false`.
- Remove non-test queued copies from the canary appointment campaign if needed.

## Phase 3 - One-Agent First-Touch Canary

Goal: prove hot new leads can interrupt the bulk queue without poisoning the family pool.

Setup:
- `CX_FIRST_TOUCH_QUEUE_MAP` contains only the canary agent.
- `CX_FIRST_TOUCH_ENABLED=true`.
- `CX_APPT_LANE_ENABLED=false` unless the appointment canary is already clean.
- Use a controlled source or synthetic intake route first.

Run:
- Inject one synthetic first-touch lead.
- Confirm it publishes as `cxft-*`.
- Confirm the modal/middle section shows first-touch identity only after UII.
- Confirm normal bulk keeps advancing after the interruption.

Pass:
- `cxft-*` never becomes bulk current.
- The first-touch ownership stamp remains until consumption owns its release.
- No legacy/manual appointment code rewrites the first-touch row.
- No non-canary agent receives a lane call.

Stop:
- First-touch row loses `firstTouchDispatch`.
- Normal bulk reserves a `firstTouchPending` row.
- UI shows stale lane identity after the call is gone.

Rollback:
- Set `CX_FIRST_TOUCH_ENABLED=false`.
- Clear the first-touch campaign queue.

## Phase 4 - One-Agent Combined Canary

Goal: repeat today's local interrupt proof with one real supervised agent.

Rules:
- One agent only.
- Both maps contain only that agent.
- Both flags on only for the test window.
- Normal bulk queue must already be running.

Run:
- Work 5-10 normal bulk calls.
- Trigger one first-touch interruption.
- Trigger one appointment interruption.
- Continue the bulk queue after both.

Pass:
- Both lane calls surface correctly in the UI.
- The agent can return to bulk without refresh.
- No orphaned `cxbl`, `cxft`, or `cxapt` active calls remain.
- Drain/terminal logs match the expected current state.

## Phase 5 - Small Roster Expansion

Only after the one-agent combined canary passes.

Expansion shape:
- 2 agents for one half-day.
- 3-5 agents for one supervised day.
- Full roster only after a clean multi-agent day.

Before each expansion:
- Verify every agent's RingCX dial group has absolute campaign priority enabled.
- Appointment campaign priority > first-touch campaign priority > regular bulk campaign.
- Confirm the maps include only agents participating in that stage.
- Confirm each agent has a break/resume procedure that does not rely on refresh magic.

Multi-agent pass:
- Round-robin distribution is visible and fair enough.
- No agent receives another agent's appointment.
- Unmapped agents are skipped loudly and never borrowed.
- Support can identify every active call by extern prefix:
  `cxbl-*` normal bulk, `cxft-*` first touch, `cxapt-*` appointment.

## Phase 6 - Full Roster Candidate

Full roster is a release candidate only after:
- One-agent appointment canary passes.
- One-agent first-touch canary passes.
- Combined canary passes.
- Multi-agent canary passes.
- F2 lane consumption is proven live.
- Floor Gate 2 clean inventory and Gate 7 break/resume are closed.
- Rollback has been rehearsed once.

Full rollout should start at the beginning of a supervised day, not late afternoon.

## Operational Monitors

During any canary, watch:
- Control-plane lane logs:
  `cx.alpha.firsttouch.dispatched`, `cx.alpha.appt.dispatched`,
  `control-plane.cx_first_touch.dispatch.tick`,
  `control-plane.cx_appt_lane.dispatch.tick`.
- Active-call watcher lane recognition and registry behavior.
- Bulk session current and last outcome.
- Appointment rows: `status`, `appointmentAt`, `rcxDispatch`, `cxQueueRecordId`.
- First-touch rows: `firstTouchPending`, `firstTouchDispatch`, `firstTouchExternId`.
- RingCX active calls and lead copies by extern prefix.
- UI symptoms: modal timing, middle-section projection, stale identity, jumpiness.

## Minimum Rollback

The basic rollback is flag-only:

```text
CX_FIRST_TOUCH_ENABLED=false
CX_APPT_LANE_ENABLED=false
```

Then Mickey restarts the relevant local/live service. Do not rely on deleting data as the
first rollback. Data cleanup is second:
- Clear canary test campaign lead copies in RingCX.
- Cleanup drill-tagged Mongo rows/appointments.
- Leave normal bulk rows alone unless Mickey explicitly asks to drain them.

## Open Questions For Mickey

- Which agent is the first real canary?
- Do we launch appointment lane before first-touch lane, or keep both local-only until F2
  consumption is done?
- What is the maximum acceptable appointment skew for real floor use: keep +45s, tighten
  to +30s, or use a per-campaign tolerance?
- Should first-touch live drip be business-hours only from day one, with overnight handled
  exclusively by the planned loader?
- What exact support window is acceptable for the first one-agent canary?
