# AWS MVP Deploy Runbook — 2026-07-09

The Ubuntu box went down overnight. Goal: get an MVP of the app back up on AWS ASAP, **4001 (intake)
first**, whole stack if feasible. This is a **redeploy, not a rebuild** — Mongo is Atlas (up), and the
code is safe in git.

## Situation (verified)

- **Source of truth:** git `origin/release/0.2.0-alpha` @ `6608fb1` (2026-07-08 17:55), local in sync.
  Deploy from git. Box's old uncommitted hotfixes were ai-bus/coach files — not intake — so 4001 is complete.
- **Database:** MongoDB **Atlas** (`mongodb+srv://tagcontactbridge.w8boh…`) — cloud, up, reachable. No data
  migration. New instance's egress IP must be added to the **Atlas network allowlist** or it can't connect.
- **Stack:** npm-workspaces monorepo (`apps/*`, `packages/*`), npm (`package-lock.json`), Node 18+ (pin 20 LTS).
  Backend apps are plain `node` (no build step); web-client is a Vite build. No Docker / IaC / CI today — bare VM + systemd.
- **`.env`:** present in the repo root (~100–200 active vars) — the gating artifact. Must confirm it's the
  **production** env (RingCentral/RingCX creds, Atlas URI, `INTERNAL_SERVICE_SECRET`, webhook secrets, all `CX_*` flags).
- **Apps + ports** (all bind 127.0.0.1, override `SERVICE_BIND_HOST`): web-client 3001 · control-plane 5001 ·
  **inbound-gateway 4001** · outbound-gateway 4002 · ringcentral-cx 6101 · ai-bus 7000.

## 4001 = inbound-gateway (the intake front door)

A **public webhook receiver**: website forms, LD vendors, affiliates, Facebook/Instagram/TikTok lead-gen,
landing pages, Lexis mailer → writes straight to Atlas, creates Logics cases, fire-and-forgets the CX
forward to 6101 (so it runs standalone). Meta/TikTok require valid **HTTPS**. Deploying the node process is
the easy half; **public TLS ingress + repointing every lead source** is the operational half.

## Target: single EC2 lift-and-shift (NOT containers/IaC for the MVP)

Mirror the Ubuntu box: one EC2 (Ubuntu 22.04) + Node + git clone + `.env` + systemd + nginx/TLS. Containers,
ECS, Terraform, Secrets Manager, CI/CD are **Phase 4 hardening**, wrong tool for "ASAP after an outage."
On a single VM, **"all together" is barely more than "4001 alone"** — same setup, you just start more units.

## Phase 0 — Prereqs (gates; on Mickey)

- [ ] **AWS access** — account + credentials usable from this machine (AWS CLI configured), OR Mickey launches
      the EC2 in the console and hands over the SSH key.
- [ ] **`.env`** — confirm the repo-root `.env` is production-current (or supply the box's).
- [ ] **Domain/DNS** — a domain/subdomain we control (e.g. `intake.<domain>`) to point at the instance for TLS.
- [ ] **Atlas allowlist** — edit access to add the EC2's Elastic IP.

## Phase 1 — Stand up 4001 on EC2

1. Launch EC2 (Ubuntu 22.04, t3.small/medium). Allocate an **Elastic IP**. Security group: SSH from our IP only;
   443 public (webhooks); 80 public (certbot only).
2. Add the Elastic IP to the **Atlas network allowlist**.
3. Install Node 20 LTS, git, nginx, certbot.
4. `git clone` the repo, `git checkout release/0.2.0-alpha`, `npm ci` (installs workspaces).
5. Place the `.env` (scp; never in git). Set `SERVICE_BIND_HOST=127.0.0.1`, `INBOUND_GATEWAY_PORT=4001`, `NODE_ENV=production`.
6. **Verify Atlas reachability** (a one-shot connect test) before starting the service.
7. Start `inbound-gateway` under **systemd** (restart-on-failure), `node apps/inbound-gateway/src/server.js`.
8. nginx: public **443 (certbot TLS on `intake.<domain>`) → 127.0.0.1:4001**, exposing only the webhook paths.
9. Health check: `GET https://intake.<domain>/health` returns ok.

## Phase 2 — Cut over intake (restore lead flow)

10. **Repoint each lead source** to the new endpoint — FB app webhook, TikTok webhook, each LD vendor postback,
    affiliate postbacks, web-form action URLs. (Some are ours; some go through the vendor. This is the real long pole.)
11. Prove end-to-end: a test lead POST → Mongo row created → Logics case created → (if the rest is up) CX queue.

## Phase 3 — Bring up the rest (all-together)

12. On the same instance, start control-plane (5001), outbound-gateway (4002), ringcentral-cx (6101), ai-bus (7000)
    as systemd units; build + serve web-client (3001 / behind nginx). Internal calls stay on localhost.
13. Set the `CX_*` flags to the **Required Flag Shape** from `CX_FINAL_PUSH_AUDIT_GUIDE_2026-07-08.md`
    (bulk/first-touch/appt enabled, queue maps, Sean-test off, morning-builder only on the dialing owner, retry=90).
14. **One-owner check** — exactly one box owns CX lifecycle writes. The old box is down; this becomes the owner.
    Confirm nothing else is writing CX state.
15. Verify the dialing path (RingCX connectivity, a test dial) + the audit's Minimum Test Proof.

## Phase 4 — Hardening (later, explicitly NOT MVP)

Dockerize, Terraform/IaC, AWS Secrets Manager for the env, CI/CD (GitHub Actions), autoscaling, monitoring/alarms,
and resiliency beyond a single instance. The MVP is a single-instance restore — same single-point-of-failure the
box was — acceptable to get the floor back, tracked for the durable rebuild.

## Risks / notes

- **The `.env` is the make-or-break artifact** — without the real secrets nothing validates. Confirm first.
- **Atlas allowlist** — dead-simple to forget; the service just hangs on connect until the EIP is added.
- **Webhook repoints (Phase 2)** gate actual lead flow; deploying 4001 without them = a healthy service getting no leads.
- **Single instance = single point of failure** (same as the box). MVP-restore, not the resilient rebuild.
- **Security:** 4001 is internet-facing — lock the security group, rely on the in-code webhook-secret validation,
  consider WAF/known-partner-IP allowlisting in Phase 4.
- **No AWS resource gets created without Mickey's explicit go + confirmed credentials.**
