# RingCentral Call Log Cutover

## Target State

Parallel uses `ControlPlaneCallLog` as the materialized source of truth for RingCentral calls.

Runtime writers:

- RingCentral CX/session webhooks call `resolveInboundCallSource`.
- The hourly native account call-log sweep calls `runRingCentralCallLogSweep`.

Runtime readers:

- `/api/read-ringcentral/call-log/:domain` reads `ControlPlaneCallLog` by default.
- Hourly call-stat metrics build `DailyCallStat` from `ControlPlaneCallLog`.
- The attribution loop uses `ControlPlaneCallLog` for the RingCentral signal.

Legacy `rb_contactactivities` remains available only as a temporary backfill/fallback path.

## Cutover Flags

Keep these defaults for Parallel cutover:

```env
HOURLY_CALL_LOG_NATIVE_SWEEP_ENABLED=true
HOURLY_CALL_LOG_NATIVE_SWEEP_DEFAULT_DOMAIN=WYNN
CALL_LOG_LEGACY_READS_ENABLED=false
HOURLY_METRICS_REFRESH_PREFER_LEGACY_CONTACT_ACTIVITIES=false
```

Keep the legacy mirror enabled while shadow-verifying:

```env
HOURLY_CALL_LOG_HYGIENE_MIRROR_LEGACY_CONTACT_ACTIVITIES=true
```

After a clean shadow window, flip it off:

```env
HOURLY_CALL_LOG_HYGIENE_MIRROR_LEGACY_CONTACT_ACTIVITIES=false
```

## Operating Path

1. Restart Parallel so the native sweep and call-log reader defaults are live.
2. Run one hourly sweep with native sweep enabled and legacy mirror still enabled.
3. Compare today's `ControlPlaneCallLog` count against the RingCentral account call log for the same LA window.
4. Verify the call-log UI and hourly metrics show calls sourced from `control-plane-calllog`.
5. Disable the legacy contact activity mirror.
6. Stop the legacy app's RingCentral poller after one clean business-hours shadow window.

Do not disable the old app itself until lead intake, CX dialing, and nightly summaries have passed the live test window.
