# RingCentral Attribution Baseline

The parallel workspace now splits RingCentral responsibilities across two services:

- `6101 ringcentral-cx`
  - receives `POST /webhook/ringcentral/session-events`
  - handles the RC validation-token handshake
  - ACKs immediately
  - persists the raw webhook payload as an event
  - schedules delayed attribution processing from telephony session events

- `5001 control-plane`
  - exposes authenticated admin routes for RC status, subscription management, and scoped call-log probes
  - does not receive the webhook directly

Implemented baseline flow:

1. RC account-level telephony session webhook hits `6101`
2. Parallel app extracts terminal candidates:
   - `Disconnected` with no reason
   - `Gone`
3. Candidate is buffered using the configured delay
4. Parallel app fetches `GET /account/~/extension/{extensionId}/call-log`
   - `view=Detailed`
   - `type=Voice`
   - `dateFrom = eventTime - 90s`
   - `perPage=10`
5. Record is matched client-side by `telephonySessionId`
6. Called DID is resolved against `SourceCanonical.trackingNumbers`
7. A durable attribution result event is written:
   - `ringcentral.attribution.resolved`
   - or `ringcentral.attribution.missed`

Current admin routes on `5001`:

- `GET /api/ringcentral/status`
- `POST /api/ringcentral/subscriptions/account-telephony`
- `GET /api/ringcentral/subscriptions`
- `PUT /api/ringcentral/subscriptions/:subscriptionId/renew`
- `DELETE /api/ringcentral/subscriptions/:subscriptionId`
- `GET /api/ringcentral/call-log/:extensionId?telephonySessionId=...&eventTime=...`

This is intentionally a baseline, not the full materialization layer yet.
The next layer should write resolved attribution into the shared contact/case domain instead of stopping at durable events.
