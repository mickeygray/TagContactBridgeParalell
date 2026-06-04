# 2026-06-02 5 PM Patch Queue

- Logics activity review email: attach the filtered/generated CSV outputs from our scraper, not the raw Logics activity report. Include the generated document-upload notice sheet and suspended-status sheet for the daily ALL-domain run, sent to the configured internal recipients.
- CX next-lead safeguard: keep the optimistic next-lead handoff in the queued/unconfirmed lane unless RingCX returns an actual UII/session id or explicit `confirmedCall`. Do not stage the next lead from `activeCallCapture.ok` alone.
- CX appointments: patch appointment model/repository/service/routes, agent appointment modal, admin appointment list by agent, appointment queue holds, release, and due-appointment worker.
- Aged DNC / dormant cadence cleanup: active-only aged checkpoint backfill/daily sweep, first 30-day checkpoint on new active intakes, and dormant LeadCadence cleanup/reawakening script.
- NCOA mailbox: patch the mailbox check command/docs and enable the live hourly check via env during patch.
- Green queue access: add Chris Bolt and Brad Hansen to the same fresh-priority queue policy as the other green-enabled agents.
- Payment reconcile indexes: include the new `CaseProfile` and `PaymentLedger` indexes with the patch.
- OpenAI image defaults: replace stale `gpt-image-2` defaults/references with `gpt-image-1`.

Do not include the live-coach/gRPC/realtime one-off experiments in this patch.
