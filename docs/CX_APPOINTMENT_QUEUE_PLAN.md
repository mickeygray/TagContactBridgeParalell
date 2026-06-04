# CX Appointment Queue Plan

Implementation note for moving `Assign to me`, `Post Date`, and callback handling under one appointment-setting workflow.

## Goal

Appointment setting becomes the parent action for reserving a prospect to a specific agent at a specific time.

The agent sets a date, time, and timezone. The system stores a durable appointment, mirrors it onto that agent's appointment list, freezes the prospect out of the general dialer, and then places the prospect at the top of that agent's CX queue when the appointment becomes due.

The important constraint is that this should preserve the current crisp "next dial" behavior. We are changing where the lead comes from, not the queue mechanics that already work.

## Agent UI

Replace the current primary action row shape:

- `Assign to me`
- `Postdate`
- scattered callback/post-date behavior

with one primary `Set Appointment` button.

The modal should include:

- appointment date
- appointment time
- timezone, defaulting to PT/Pacific for the agent display
- compliance-adjusted resolved dial time
- optional note/reason
- optional `Assign to me now` sub-action
- optional `Post-date / Logics hold` sub-action if we still need to write a Logics post-date style status

`Assign to me` and `Postdate` can still exist, but they should be secondary modes inside this modal rather than top-level competing buttons. In practice:

- `Set appointment` creates a future queue reservation.
- `Assign to me now` reserves the current queue item to the agent without a future appointment fire.
- `Post-date / Logics hold` writes the Logics/post-date style hold if needed, but should not be the default CX scheduling concept.

On the CX workspace, render the agent's upcoming appointments in the right-side column where operational events currently render. This should be a compact work list, not a calendar.

Suggested appointment row:

- prospect name
- phone
- appointment time in the agent display timezone
- lead-local timezone if different
- source/campaign if available
- status: scheduled, due, fired, completed, cancelled, released, blocked

## Time And Compliance

Store appointment time as UTC. Display it in PT/Pacific by default because that is how the floor thinks, but validate it against the prospect's local dialability window.

The modal should resolve the selected date/time through the same state/time gate logic as the dialer. That means:

- do not create a callable appointment before 8 AM for California/local-western restricted states
- do not create a callable appointment after Florida's 8 PM cutoff
- do not bypass DNC, blocked state, local quiet hours, holiday blackout, or hard company stop rules
- if the requested time is illegal, show the corrected next legal time before saving

If the user picks "tomorrow 7:30 AM PT" for a California lead, the appointment can be stored, but the callable fire time must be adjusted to the first legal dial moment. The UI should make that visible so agents do not think the system lost the appointment.

## Agent Behavior

When an agent sets an appointment:

1. Create or update the durable appointment record.
2. Mirror a compact appointment object onto that agent's `AgentState.appointments` array.
3. Assign the queue item to the agent who set the appointment.
4. Freeze the prospect out of normal/general dialability until the appointment is resolved.
5. Keep the appointment visible to the assigned agent before it fires.
6. At the appointment time, stage that prospect at the top of that agent's CX queue with immediate priority.
7. After the call result is recorded as answered or no-answer, clear the appointment lock unless the Logics status has changed into a non-dialable state.

The appointment should behave like a reserved future queue item. It should not keep showing in the general pool while waiting.

## Admin Behavior

Replace the admin post-date log with an appointment log. The old post-date hold collection may still exist for finance/payment workflows, but the CX operational view should be appointment-first.

The admin appointment log should allow:

- search/filter by agent
- search/filter by prospect
- filter by due date/status
- edit appointment time if we choose to support edits
- remove/release an appointment

When an admin removes an appointment:

1. Mark the durable appointment as released/cancelled.
2. Remove or mark cancelled in the agent appointment mirror.
3. Clear the appointment lock from the lead/cadence/queue record.
4. Make the lead dialable again only if normal cadence and compliance rules say it is dialable.

## Backend Shape

Appointments should be represented in three places:

1. A canonical appointment collection for admin search, audit, scheduler safety, and retries.
2. A compact `AgentState.appointments[]` mirror for fast agent-side rendering.
3. Lead/cadence/queue metadata for dialability exclusion and top-of-queue firing.

Suggested canonical appointment object:

```json
{
  "appointmentId": "uuid",
  "domain": "TAG",
  "leadCadenceId": "lead-cadence-id",
  "caseId": 12345,
  "cxQueueRecordId": "queue-record-id",
  "agentExtensionId": "101",
  "agentName": "Agent Name",
  "agentEmail": "agent@example.com",
  "prospectName": "Jane Doe",
  "phone": "5555555555",
  "requestedAtLocal": "2026-06-01T09:30:00",
  "requestedTimezone": "America/Los_Angeles",
  "appointmentAt": "2026-06-01T16:30:00.000Z",
  "appointmentTimezone": "America/Los_Angeles",
  "legalDialAt": "2026-06-01T16:30:00.000Z",
  "legalDialTimezone": "America/Los_Angeles",
  "status": "scheduled",
  "note": "Asked for callback after school dropoff",
  "createdAt": "2026-05-29T00:00:00.000Z",
  "createdBy": "agent-or-admin-id",
  "updatedAt": "2026-05-29T00:00:00.000Z",
  "releasedAt": null,
  "releasedBy": null,
  "firedAt": null,
  "resolvedAt": null,
  "resolvedBy": null,
  "resolvedDisposition": null
}
```

Suggested `AgentState.appointments[]` mirror:

```json
{
  "appointmentId": "uuid",
  "domain": "TAG",
  "caseId": 12345,
  "leadCadenceId": "lead-cadence-id",
  "cxQueueRecordId": "queue-record-id",
  "prospectName": "Jane Doe",
  "phone": "5555555555",
  "appointmentAt": "2026-06-01T16:30:00.000Z",
  "appointmentTimezone": "America/Los_Angeles",
  "status": "scheduled",
  "sourceName": "LD Custom",
  "note": "Asked for callback after school dropoff"
}
```

Suggested lead/queue metadata:

```json
{
  "appointmentId": "uuid",
  "appointmentAgentExtensionId": "101",
  "appointmentAt": "2026-06-01T16:30:00.000Z",
  "appointmentTimezone": "America/Los_Angeles",
  "appointmentStatus": "scheduled",
  "dialabilityHoldReason": "appointment",
  "dialabilityHoldUntil": "2026-06-01T16:30:00.000Z"
}
```

The current `CxDialQueue` model already has useful fields for this:

- `assignment.extensionId`
- `state`
- `releaseAt`
- `priorityScore`
- `metadata`

Likely queue representation while waiting:

```json
{
  "state": "paused",
  "releaseAt": "2026-06-01T16:30:00.000Z",
  "priorityScore": 1000,
  "assignment": {
    "extensionId": "101",
    "assignedAt": "2026-05-29T00:00:00.000Z"
  },
  "metadata": {
    "actionKey": "appointment:uuid",
    "appointmentId": "uuid",
    "dialabilityHoldReason": "appointment"
  }
}
```

Likely queue representation when due:

```json
{
  "state": "ready",
  "releaseAt": "2026-06-01T16:30:00.000Z",
  "priorityScore": 1000,
  "assignment": {
    "extensionId": "101"
  },
  "metadata": {
    "actionKey": "appointment:uuid",
    "appointmentId": "uuid",
    "queueReason": "appointment-due"
  }
}
```

## Queue Firing Rule

A scheduler should check for due scheduled appointments at least once per minute.

When an appointment becomes due:

1. Verify it still exists and is still scheduled.
2. Verify the lead has not been DNC'd, blocked, sold, made inactive, or otherwise made illegal to dial.
3. Re-run the time/state dialability gate using the appointment's legal dial time.
4. Stage or update the CX queue record for the assigned agent.
5. Set priority to immediate/top-of-queue, mirroring the current successful next-dial queue behavior.
6. Mark the appointment as `fired`.
7. Keep the appointment in the agent list as due/fired until answered/no-answer resolves it.

If the agent is unavailable, keep the appointment in a due/blocked state rather than dumping it into the general pool. It should remain visible to the agent/admin until it is handled or released.

## Resolution Rules

When the agent records:

- `Answered`: mark appointment completed, clear queue/lead appointment lock, then let status/disposition decide future dialability.
- `No Answer`: mark appointment completed/no-answer, clear appointment lock, then let normal cadence rules decide whether the lead can re-enter.
- `DNC`: cancel/resolve appointment, clear future appointment firing, and apply normal DNC suppression.
- Logics status changed to non-dialable: cancel/resolve appointment and do not re-enter the queue.

This keeps the appointment as a scheduling reservation, not a permanent ownership claim.

## Dialability Rules

While `appointmentStatus = scheduled` and `appointmentAt` is in the future:

- exclude from general dialability
- exclude from normal cadence pulls
- exclude from other agents' queues
- still show in admin appointment log
- still show in assigned agent appointment list

When released by admin:

- clear appointment fields
- remove or cancel the agent appointment mirror
- restore normal dialability/cadence eligibility

When fired:

- call should be staged for the assigned agent at top priority
- appointment should not be re-fired repeatedly
- existing answer/no-answer/DNC flow resolves what happens next

## Compatibility Notes

- Preserve the current "next dial" behavior as much as possible. The backend queue staging and immediate priority mechanics are the valuable part of the current workflow.
- Appointment firing should use the same proven queue path as next dial, only with appointment eligibility as the source.
- Appointment holds must not override DNC, state/time gates, Logics terminal statuses, or other hard compliance stops.
- Admin release makes the lead eligible again; it does not force an immediate dial unless normal rules say it should.
- The existing `PostDateHold` flow can remain for payment/status review while we migrate the agent-facing queue workflow to appointments.

## Implementation Checklist

1. Add canonical appointment model/repository.
2. Add `AgentState.appointments[]` compact mirror.
3. Add appointment create/update/release endpoints.
4. Add appointment fields/metadata to queue/cadence updates.
5. Replace top-level CX `Assign to me` and `Postdate` buttons with `Set Appointment`.
6. Add appointment modal with appointment, assign-now, and post-date/logics-hold modes.
7. Render upcoming appointments in the CX workspace right column.
8. Replace admin post-date operational view with appointment log.
9. Add due-appointment scheduler.
10. Reuse current CX queue staging logic to place due appointments at immediate priority.
11. Add dialability exclusion for future appointments.
12. Add admin release path that clears the exclusion.
13. Wire answer/no-answer/DNC resolution to complete/cancel appointment locks.
14. Test: set appointment, verify lead disappears from general queue, verify it fires at appointment time.
15. Test: no-answer after appointment, verify appointment clears and normal rules resume.
16. Test: admin release, verify lead becomes dialable again only through normal rules.
17. Test: DNC/status change after appointment is set, verify it never fires.

## Open Decisions

- Whether appointments can be edited after creation or only removed and recreated.
- Whether due appointments should expire after a grace window if the agent is unavailable.
- Whether no-answer on an appointment returns to normal cadence immediately or asks the agent to reschedule first.
- Whether appointment notes should sync to Logics or remain internal only.
- Whether `Assign to me now` should create an appointment record with no future fire, or stay as a queue-only operation inside the modal.
