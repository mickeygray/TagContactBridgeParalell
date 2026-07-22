# PhoneBurner Linux Cutover Runbook

Date: 2026-07-17

## Intended ownership

- `parallel-control-plane` on `tagcontactbridge` is the only daytime PhoneBurner lead-delivery owner.
- `DailyDial` is the daytime attempt ledger; `CallLog` is the reporting/metrics projection.
- PhoneBurner Call End callbacks enter through `tag-webhook.ngrok.app` and the canonical `/api/lead-delivery/phoneburner/` routes.
- The Windows `ParallelControlPlane` and its ngrok tunnel stay stopped after cutover.
- Every legacy CX/PhoneBurner voice-writer flag is explicitly `false` on Linux. Defaults are not trusted.
- PhoneBurner `appointment` remains a terminal/stat outcome only.

## Dark deployment

1. Back up every live file that the targeted bundle will replace.
2. Copy only the reviewed control-plane runtime bundle; do not pull or reset the dirty live repository.
3. Preserve `parallel:parallel` ownership.
4. Keep all four `LEAD_DELIVERY_*` activation flags false or absent.
5. Run syntax, module-load, lead-delivery, metrics, and index-definition tests as `parallel`.
6. Do not restart the live control plane during the dark proof unless separately authorized.

## Cutover order

1. Confirm the provider queue is idle and local control-plane health is clean.
2. Mickey stops Windows `ParallelControlPlane` and the Windows tunnel that owns `tag-webhook.ngrok.app`.
3. On Linux, explicitly set every legacy voice-writer flag to `false`.
4. On Linux, set callback capture, lead delivery, actions, and refill to `true`.
5. Enable/start `parallel-tag-webhook-front` and `parallel-tag-webhook-ngrok`.
6. Restart only `parallel-control-plane`.
7. Prove `/health` shows the lead-delivery runtime running with capture/actions/refill enabled and no error/circuit state.
8. Prove the public callback route reaches Linux with a bounded invalid-payload canary that writes nothing.
9. Run read-only folder validation and compare physical Pool/Consumer counts with the ledger.
10. Observe the first exact Call End, DailyDial persistence, and low-water refill before declaring cutover complete.

## CX shutdown boundary

The mandatory shutdown is the writer set enforced by `findArmedLegacyVoiceWriters`; all entries must be explicit false. `parallel-ringcentral-cx` may remain running but inert during the first proof window so unrelated historical/diagnostic reads remain available. Stop and disable that unit only after confirming no remaining recording, coach, or administrative read depends on it.

## Rollback

1. Set Linux `LEAD_DELIVERY_REFILL_ENABLED=false`, then actions/capture/enabled false.
2. Restart only `parallel-control-plane` and verify the runtime is dark.
3. Stop the Linux tag-webhook tunnel before returning the reserved domain to Windows.
4. Restore the backed-up files only if code rollback is required; never reset the live repository broadly.
5. Restart the Windows owner only after Linux is proven dark.

## Set-and-forget proof

- Linux control plane and tag-webhook units are enabled at boot and use `Restart=always`.
- One public tunnel owns the reserved domain.
- No legacy voice writer is armed by value or default.
- Morning launch completes from durable inventory without a full blocking scan.
- Fresh delivery, exact Call Ends, DailyDial writes, low-water refills, 17:00 posting stop, 17:30 folder close, and nightly CallLog projection each show a successful cycle.
- No provider 429, circuit-open state, identity conflict, capped lead with a due time, or terminal lead with a retry timer remains unresolved.
