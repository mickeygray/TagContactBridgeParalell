# Ubuntu Nginx Cutover Notes

Use `ops/nginx/parallel.conf` as the canonical routing block. It currently
listens on `81` for the Windows/ngrok shape; for direct Ubuntu hosting, the
same locations should sit behind normal `80`/`443` TLS server blocks.

## Required local services

All app services should bind only to loopback:

- control-plane: `127.0.0.1:5001`
- inbound-gateway: `127.0.0.1:4001`
- outbound-gateway: `127.0.0.1:4002`
- ringcentral-cx: `127.0.0.1:6101`

The built web app is served by control-plane from `apps/web-client/build`, so
production Nginx can route the app shell and `/api` to `parallel_cp` on `5001`.

## Ubuntu install flow

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx

sudo cp ops/nginx/parallel.conf /etc/nginx/conf.d/parallel.conf
sudo nginx -t
sudo systemctl reload nginx
```

For direct HTTPS hosting, change the copied config before reload:

- `listen 81;` -> `listen 80;`
- `server_name localhost tagcontactbridge.ngrok.app;` -> your real hostnames
- run `sudo certbot --nginx -d <hostname>`
- confirm certbot preserves the `location /api/sales-trainer/` block before
  the generic `location /api/` block

## Must-keep Nginx rules

- `/api/sales-trainer/` must bypass the main `auth_request` gate. The trainer
  has its own OTP/allowlist middleware, and the main app auth gate would block
  trainer-only users before they can verify OTP.
- `client_max_body_size 32m` must apply to `/api/sales-trainer/` for Whisper
  mic uploads.
- `/api/recordings/play/` must stay public at Nginx and HMAC-gated in the app,
  with buffering disabled for range audio playback.
- `/lead-contact`, `/fb/webhook`, `/tt/webhook`, `/sms/inbound`, and the
  `/webhook/*` routes stay public at Nginx and verify at the app layer.
- Generic `/api/` stays behind `auth_request /auth-check`.

## Production env values that must match Nginx

```bash
NODE_ENV=production
SERVICE_BIND_HOST=127.0.0.1
WEB_CLIENT_ORIGINS=https://<hostname>
CONTROL_PLANE_BASE_URL=http://127.0.0.1:5001
RC_WEBHOOK_BASE_URL=https://<hostname>
NGROK_DOMAIN=          # empty if fully off ngrok
AUTH_OTP_PREVIEW=false
```

## Cutover checks

```bash
npm run build:web
node --check apps/control-plane/src/server.js
node --check apps/control-plane/src/routes/salesTrainer.js
node --check packages/shared-services/src/taxResolutionSalesTrainerService.js
sudo nginx -t
curl -i http://127.0.0.1:5001/api/health
curl -i https://<hostname>/api/sales-trainer/auth/check
curl -i https://<hostname>/api/auth/me
```

Expected unauthenticated responses:

- `/api/sales-trainer/auth/check`: `401` JSON from trainer auth
- `/api/auth/me`: `401` JSON from main auth

