# CX Appointment Queue Plan

Monday implementation note for replacing post date / callback style controls with scheduled appointments that pause general dialability and fire at the top of the assigned agent's queue.

## Goal

Replace the old callback/post-date workflow with an appointment workflow that is clearer for agents and easier for admins to audit.

The agent should set a specific date, time, and timezone for a prospect. The system stores that appointment against the agent and the lead, pauses normal dialing for that prospect until the appointment, and then places that lead at the top of that agent's CX queue when the appointment time arrives.

## UI Changes

- Remove `Assign to me`.
- Remove `Post Date`.
- Add `Set Appointment`.
- The appointment UI needs:
  - date
  - time
  - timezone
  - optional note/reason if cheap to add

On the CX workspace, show the agent's upcoming appointments in the right-side column area where events currently render. This should be a short operational list, not a full calendar.

Suggested appointment row:

- prospect name
- phone
- appointment local time
- timezone
- source/campaign if available
- status: scheduled, due, fired, released, completed

## Agent Behavior

When an agent sets an appointment:

1. Store the appointment on that user's appointments array.
2. Store the appointment state on the lead / queue record.
3. Pause that prospect from normal/general dialability until the appointment time.
4. Keep the appointment visible to the assigned agent before it fires.
5. At the appointment time, put that prospect at the top of that agent's CX queue with immediate priority.

The appointment should behave like a reserved future queue item. It should not keep showing in the general pool while waiting.

## Admin Behavior

Admins should no longer use a post-date log. Replace that with an appointment log.

The admin appointment log should allow:

- search/filter by agent
- search/filter by prospect
- filter by due date/status
- remove/release an appointment

When an admin removes an appointment:

1. Delete or cancel it from the agent's appointments.
2. Clear the appointment lock from the lead / queue record.
3. Make the lead dialable again according to normal cadence rules.

## Backend Shape

Appointments need to be represented in two places:

1. Agent/user appointment list, for rendering the agent's upcoming schedule.
2. Lead/queue record, for enforcing dialability and queue priority.

Suggested user appointment object:

```json
{
  "appointmentId": "uuid",
  "leadId": "lead-or-cadence-id",
  "caseId": "optional-logics-case-id",
  "cxQueueRecordId": "queue-record-id",
  "agentUserId": "user-id",
  "agentEmail": "agent@example.com",
  "prospectName": "Jane Doe",
  "phone": "5555555555",
  "appointmentAt": "2026-06-01T16:30:00.000Z",
  "appointmentTimezone": "America/Los_Angeles",
  "status": "scheduled",
  "createdAt": "2026-05-29T00:00:00.000Z",
  "createdBy": "agent-or-admin-id",
  "releasedAt": null,
  "releasedBy": null,
  "firedAt": null
}
```

Suggested lead/queue fields:

```json
{
  "appointmentId": "uuid",
  "appointmentAgentUserId": "user-id",
  "appointmentAt": "2026-06-01T16:30:00.000Z",
  "appointmentTimezone": "America/Los_Angeles",
  "appointmentStatus": "scheduled",
  "dialabilityHoldReason": "appointment",
  "dialabilityHoldUntil": "2026-06-01T16:30:00.000Z"
}
```

## Queue Firing Rule

A small scheduler should check for due scheduled appointments.

When an appointment becomes due:

1. Verify it still exists and is still scheduled.
2. Verify the lead has not been DNC'd or otherwise made illegal to dial.
3. Stage the CX queue record for that assigned agent.
4. Set priority to immediate/top-of-queue, mirroring the current successful next-dial queue behavior.
5. Mark the appointment as `fired`.

If the agent is unavailable, keep the appointment in a due/blocked state rather than dumping it into the general pool.

## Dialability Rules

While `appointmentStatus = scheduled` and `appointmentAt` is in the future:

- exclude from general dialability
- exclude from normal cadence pulls
- exclude from other agents' queues
- still show in admin appointment log
- still show in assigned agent appointment list

When released by admin:

- clear appointment fields
- remove from agent appointment list
- restore normal dialability/cadence eligibility

When fired:

- call should be staged for the assigned agent at top priority
- appointment should not be re-fired repeatedly
- the existing answer/no-answer/DNC flow should resolve what happens next

## Important Compatibility Notes

- Preserve the current "next dial" behavior as much as possible. The backend queue staging and immediate priority mechanics are the crisp part of the current workflow.
- Appointment firing should use the same proven queue path as next dial, only with appointment eligibility as the source.
- Appointment holds must not override DNC, state/time gates, or other hard compliance stops.
- Admin release makes the lead eligible again; it does not force an immediate dial unless the normal rules say it should.

## Implementation Checklist

1. Find current `Post Date` and `Assign to me` UI controls.
2. Replace them with `Set Appointment`.
3. Add appointment create/update endpoint.
4. Add appointment release/admin endpoint.
5. Add appointment fields to the lead/cadence/queue model.
6. Add user appointment list storage.
7. Render upcoming appointments in the CX workspace right column.
8. Replace admin post-date log with appointment log.
9. Add due-appointment scheduler.
10. Reuse current CX queue staging logic to place due appointments at immediate priority.
11. Add dialability exclusion for future appointments.
12. Add admin release path that clears the exclusion.
13. Test: set appointment, verify lead disappears from general queue, verify it fires at appointment time.
14. Test: admin release, verify lead becomes dialable again.
15. Test: DNC after appointment is set, verify it never fires.

## Open Decisions

- Whether appointments can be edited after creation or only removed and recreated.
- Whether due appointments should expire after a grace window if the agent is unavailable.
- Whether no-answer on an appointment returns to normal cadence or prompts the agent to reschedule.
- Whether appointment notes should sync to Logics or remain internal only.
