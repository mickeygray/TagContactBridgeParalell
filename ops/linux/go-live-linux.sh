#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-parallel}"
APP_DIR="${APP_DIR:-/opt/tagcontactbridge-parallel}"
DOMAIN="${DOMAIN:-}"
SKIP_DEPLOY="${SKIP_DEPLOY:-0}"
TUNNEL_TIMEOUT_SEC="${TUNNEL_TIMEOUT_SEC:-90}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo parallel-go-live" >&2
  exit 1
fi

step() { echo; echo "=== $* ==="; }
ok() { echo "  [ok] $*"; }
warn() { echo "  [warn] $*"; }

read_env() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { value=$0; sub("^[^=]*=", "", value) } END { print value }' "${APP_DIR}/.env" | tail -n 1
}

set_env() {
  local key="$1"
  local value="$2"
  local file="${APP_DIR}/.env"
  if grep -qE "^${key}=" "${file}"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "${file}"
  else
    printf '\n%s=%s\n' "${key}" "${value}" >>"${file}"
  fi
}

node_json_field() {
  local url="$1"
  local expr="$2"
  node -e '
    const [url, expr] = process.argv.slice(1);
    fetch(url).then(r => {
      if (!r.ok) throw new Error(`${url} -> ${r.status}`);
      return r.json();
    }).then(j => {
      const value = expr.split(".").reduce((acc, key) => acc && acc[key], j);
      if (value == null) process.exit(2);
      console.log(value);
    }).catch(err => {
      console.error(err.message);
      process.exit(1);
    });
  ' "$url" "$expr"
}

if [[ ! -f "${APP_DIR}/.env" ]]; then
  echo ".env not found at ${APP_DIR}/.env" >&2
  exit 1
fi

if [[ -z "${DOMAIN}" ]]; then
  DOMAIN="$(read_env NGROK_DOMAIN)"
fi
DOMAIN="${DOMAIN#https://}"
DOMAIN="${DOMAIN#http://}"
DOMAIN="${DOMAIN%/}"
if [[ -z "${DOMAIN}" ]]; then
  DOMAIN="tagcontactbridge.ngrok.app"
fi

step "Pre-flight"
ok "domain: https://${DOMAIN}"
if [[ "${SKIP_DEPLOY}" != "1" ]]; then
  /usr/local/bin/parallel-deploy
else
  warn "Skipping deploy because SKIP_DEPLOY=1"
fi

step "Confirm local runtime while RC is still suspended"
local_id="$(node_json_field "http://127.0.0.1:5001/api/client/runtime" "runtime.runtimeId")"
ok "local runtime: ${local_id}"

step "Start ngrok"
systemctl restart parallel-ngrok
sleep 3
systemctl is-active --quiet parallel-ngrok
ok "parallel-ngrok service is active"

deadline=$((SECONDS + TUNNEL_TIMEOUT_SEC))
while (( SECONDS < deadline )); do
  if curl -fsS http://127.0.0.1:4040/api/tunnels 2>/dev/null | grep -q "https://${DOMAIN}"; then
    ok "local ngrok API reports https://${DOMAIN}"
    break
  fi
  sleep 2
done

if (( SECONDS >= deadline )); then
  echo "Timed out waiting for ngrok tunnel. The old host may still own ${DOMAIN}." >&2
  exit 1
fi

if systemctl list-unit-files --type=service | grep -q '^parallel-tag-webhook-ngrok.service'; then
  step "Start tag-webhook ngrok"
  systemctl restart parallel-live-coach-grpc parallel-tag-webhook-front parallel-tag-webhook-ngrok
  sleep 3
  systemctl is-active --quiet parallel-live-coach-grpc
  systemctl is-active --quiet parallel-tag-webhook-front
  systemctl is-active --quiet parallel-tag-webhook-ngrok
  ok "live coach gRPC/front/tag-webhook ngrok services are active"
fi

step "Confirm public domain reaches this box"
public_id="$(node_json_field "https://${DOMAIN}/api/client/runtime" "runtime.runtimeId")"
if [[ "${public_id}" != "${local_id}" ]]; then
  echo "Public runtime mismatch. local=${local_id} public=${public_id}. Refusing to flip RC." >&2
  exit 1
fi
ok "public runtime matches local runtime: ${public_id}"

step "Flip RingCentral live"
set_env "PARALLEL_RC_SUSPENDED" "false"
chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
chmod 600 "${APP_DIR}/.env"
ok "PARALLEL_RC_SUSPENDED=false"

step "Restart RC-touching services"
systemctl restart parallel-control-plane parallel-ringcentral-cx parallel-outbound-gateway parallel-inbound-gateway parallel-ai-bus parallel-barge
if systemctl is-active --quiet parallel-live-coach-grpc; then systemctl restart parallel-live-coach-grpc; fi
if systemctl is-active --quiet parallel-tag-webhook-front; then systemctl restart parallel-tag-webhook-front; fi
if systemctl is-active --quiet parallel-tag-webhook-ngrok; then systemctl restart parallel-tag-webhook-ngrok; fi
sleep 5
systemctl is-active --quiet parallel-control-plane
systemctl is-active --quiet parallel-ringcentral-cx
systemctl is-active --quiet parallel-outbound-gateway
systemctl is-active --quiet parallel-inbound-gateway
systemctl is-active --quiet parallel-ai-bus
ok "app services restarted"

step "Post-cutover checks"
curl -fsS "https://${DOMAIN}/api/client/runtime" >/dev/null
curl -fsS http://127.0.0.1:5001/health >/dev/null
curl -fsS http://127.0.0.1:6101/health >/dev/null
curl -fsS http://127.0.0.1:7000/health >/dev/null
ok "cutover checks passed"

echo
echo "Cutover complete. This Ubuntu host is public and RingCentral is live."
echo "Rollback if needed: sudo parallel-standby"

