# Nginx + ngrok Cutover Checklist

This is the current cutover shape for Parallel.

## Target edge

- `ngrok` terminates at `nginx :81`
- `nginx` routes to the app's real public surface
- `5001` is the edge owner for:
  - SPA shell
  - `/api/auth/*`
  - `/api/*`
  - `/api/inbound/*`
  - `/fb/webhook`
  - `/tt/webhook`
  - `/lead-contact`
  - `/lead-contact/pre-ping`
  - `/test-lead`
  - `/sms/inbound`

## Required services

These must all be up for the public URL to behave correctly:

- `ParallelControlPlane`
- `ParallelInboundGateway`
- `ParallelOutboundGateway`
- `ParallelRingCentralCx`

## Required environment

- `WEB_CLIENT_ORIGINS`
- `EXTERNAL_WEBHOOK_SECRET` or `INTERNAL_SERVICE_SECRET`
- `CALLRAIL_WEBHOOK_SECRET`
- `FB_APP_SECRET` or tenant-specific `*_FB_APP_SECRET`
- `TT_CLIENT_SECRET` or `TIKTOK_SIGNING_KEY`
- `NGROK_DOMAIN`

## Preflight

Run:

```powershell
cd C:\Users\Admin\Code\TagContactBridgeParallel
npm run check:cutover
```

## Cutover order

1. Build the web client:

```powershell
npm run build:web
```

2. Validate nginx:

```powershell
cd C:\tools\nginx-1.29.6
.\nginx.exe -t
```

3. Reload nginx:

```powershell
.\nginx.exe -s reload
```

4. Restart the Parallel services that own the edge:

- `5001`
- `4001`
- `4002`
- `6101`

5. Start or restart ngrok so it points at `:81`.

6. Verify public routing:

- `GET /`
- `GET /login`
- `POST /api/inbound/demo`
- `POST /sms/inbound`
- `POST /fb/webhook`
- `POST /tt/webhook`

7. Point one real tracking number or one real webhook source at Parallel.

8. Watch for 24 hours before broadening traffic.

## Known non-blockers

- Full CX queue scoping polish
- CX live-dial outcome finality
- Scheduled blasts
- Batch-contact perfection
- Broader reporting parity gaps
