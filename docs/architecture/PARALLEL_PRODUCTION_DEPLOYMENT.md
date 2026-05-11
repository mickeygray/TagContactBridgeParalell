# Parallel Production Deployment Plan

Status: active cutover work.

The current production shape is:

```text
ngrok
  -> nginx :81
    -> control-plane :5001
      -> inbound-gateway :4001
      -> outbound-gateway :4002
      -> ringcentral-cx :6101
```

`5001` is the edge owner. It serves the built SPA shell and owns the public app-facing routes. nginx should mirror that public surface instead of inventing a different one.

## Public routes

These are the public routes the edge must preserve:

- `/`
- `/login`
- `/api/auth/send-code`
- `/api/auth/verify-code`
- `/api/auth/logout`
- `/api/*`
- `/api/inbound/*`
- `/api/recordings/play/*`
- `/fb/webhook`
- `/tt/webhook`
- `/lead-contact`
- `/lead-contact/pre-ping`
- `/test-lead`
- `/sms/inbound`

## Services

Production expects these NSSM services:

- `ParallelControlPlane`
- `ParallelInboundGateway`
- `ParallelOutboundGateway`
- `ParallelRingCentralCx`
- `ParallelBlogger`

The web client is served from the control-plane's built output, so `3001` is dev-only and should not be part of the production service map.

## Required environment

Before cutover, set:

- `WEB_CLIENT_ORIGINS`
- `EXTERNAL_WEBHOOK_SECRET` or `INTERNAL_SERVICE_SECRET`
- `CALLRAIL_WEBHOOK_SECRET`
- `FB_APP_SECRET` or tenant-scoped `TAG_FB_APP_SECRET` / `WYNN_FB_APP_SECRET`
- `TT_CLIENT_SECRET` or `TIKTOK_SIGNING_KEY`
- `NGROK_DOMAIN`
- `NODE_ENV=production`

## Preflight

Run:

```powershell
cd C:\Users\Admin\Code\TagContactBridgeParallel
npm run check:cutover
```

## Cutover order

1. Build the web client.
2. Validate nginx with `nginx -t`.
3. Reload nginx.
4. Restart `5001`, `4001`, `4002`, and `6101`.
5. Start or restart ngrok so it points at `:81`.
6. Verify:
   - `/`
   - `/login`
   - `/api/inbound/demo`
   - `/sms/inbound`
   - `/fb/webhook`
   - `/tt/webhook`
7. Point one real source at Parallel.
8. Watch for 24 hours before widening traffic.

## Notes

- `run-ngrok.js` already flips to `:81` automatically in production mode.
- `parallel.conf` is now expected to route the app surface as it exists today.
- Provider HMAC verification is wired in at the app layer; nginx must preserve request bodies and should not try to reinterpret the public route map.
