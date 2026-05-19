# RingEX live monitor one-off

Standalone bridge for the temporary EX-based live call monitor. It does not run
under NSSM and does not require nginx/control-plane/ngrok restarts.

## What it does

- Registers AI Monitor extension `987` as a headless RingEX softphone.
- Optionally attaches that device to an agent's live call with RingEX
  supervision.
- Captures incoming PCMU/8000 audio packets.
- Chunks audio into short WAV uploads for `gpt-4o-mini-transcribe`.
- Sends recent transcript chunks to Claude for compact live agent advice.
- Shows transcript/advice on a local dashboard.
- Optionally pushes advice into an existing Trainer UI session.

## Smoke test only

```powershell
npm run rc:live-monitor -- --supervisor-ext 987 --timeout-sec 10
```

Expected result: the script resolves AI Monitor, registers the softphone, waits,
then exits cleanly.

## Live test against an agent

Start this before or during the call. With `--supervise`, it waits up to 120
seconds for an active call on that agent before attaching:

```powershell
npm run rc:live-monitor -- --supervise --agent-ext <agentExtensionNumber> --supervisor-ext 987 --supervise-wait-sec 120
```

Open the dashboard:

```text
http://127.0.0.1:7331/
```

Useful knobs:

```powershell
npm run rc:live-monitor -- --supervise --agent-ext 101 --supervisor-ext 987 --chunk-sec 2 --coach-every-sec 10
```

For the first mixed-audio test, leave speaker labels on. The one-off pushes the
raw `gpt-4o-mini-transcribe` text to the dashboard first, then a Haiku pass
updates that same row with `agent`, `prospect`, `system`, or `unknown`. This is
logical separation only; the EX supervision leg is still one mixed audio stream.

## Optional public dashboard

EX audio does not need ngrok. Only use this if someone needs to view the
temporary dashboard from another machine during a test:

```powershell
ngrok http 7331
```

## Optional Trainer UI bridge

If a Trainer session is already open and you have its session id:

```powershell
npm run rc:live-monitor -- --supervise --agent-ext 101 --supervisor-ext 987 --session-id <trainerSessionId>
```

The one-off will POST coach snapshots to control-plane with
`INTERNAL_SERVICE_SECRET`/`SALES_TRAINER_BRIDGE_SECRET`.

## Output

Each run writes local-only files under:

```text
runtime/ex-live-monitor-oneoff/
```

This includes `events.ndjson`, `transcripts.ndjson`, full raw `.pcmu` audio,
and per-chunk `.pcmu` files. Add `--write-wav-chunks` if WAV chunks are needed
for debugging.
