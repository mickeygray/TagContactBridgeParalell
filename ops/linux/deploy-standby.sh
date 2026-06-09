#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-parallel}"
APP_DIR="${APP_DIR:-/opt/tagcontactbridge-parallel}"
BRANCH="${BRANCH:-master}"
LOCK_FILE="${LOCK_FILE:-/var/lock/parallel-deploy.lock}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo parallel-deploy" >&2
  exit 1
fi

exec 9>"${LOCK_FILE}"
flock -n 9 || {
  echo "Another deploy is already running." >&2
  exit 1
}

step() { echo; echo "=== $* ==="; }
ok() { echo "  [ok] $*"; }

restart_if_active() {
  local svc="$1"
  if systemctl is-active --quiet "${svc}"; then
    systemctl restart "${svc}"
  fi
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

set_env_if_missing() {
  local key="$1"
  local value="$2"
  local file="${APP_DIR}/.env"
  if ! grep -qE "^${key}=" "${file}"; then
    printf '\n%s=%s\n' "${key}" "${value}" >>"${file}"
  fi
}

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "Repo not found at ${APP_DIR}. Run bootstrap first." >&2
  exit 1
fi

if [[ ! -f "${APP_DIR}/.env" ]]; then
  echo ".env not found at ${APP_DIR}/.env. Copy it from the active host first." >&2
  exit 1
fi

step "Pull latest code"
sudo -H -u "${APP_USER}" bash -lc "cd '${APP_DIR}' && git fetch --prune origin && git checkout '${BRANCH}' && git reset --hard 'origin/${BRANCH}'"

step "Install dependencies and build"
sudo -H -u "${APP_USER}" bash -lc "cd '${APP_DIR}' && npm ci && bash ops/linux/repair-runtime-permissions.sh && npm run build:web"

step "Linux-safe env overrides"
set_env "NODE_ENV" "production"
set_env "SERVICE_BIND_HOST" "127.0.0.1"
set_env "AUTH_OTP_PREVIEW" "false"
set_env "NGROK_BIN" "$(command -v ngrok)"
set_env "NGROK_FORWARD_PORT" "81"
set_env "NGROK_PARALLEL_FORWARD_PORT" "81"
set_env_if_missing "PARALLEL_RC_SUSPENDED" "true"
if ! grep -qE "^MONGO_URI=mongodb(\\+srv)?://" "${APP_DIR}/.env"; then
  echo "MONGO_URI is missing. Copy the real Atlas .env before deploying; refusing to default to local Mongo." >&2
  exit 1
fi
chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
chmod 600 "${APP_DIR}/.env"
ok ".env is ready; existing PARALLEL_RC_SUSPENDED value was preserved if present"

step "Nginx"
cp "${APP_DIR}/ops/nginx/parallel.conf" /etc/nginx/conf.d/parallel.conf
nginx -t
systemctl reload nginx

step "Restart app services"
systemctl restart parallel-control-plane parallel-inbound-gateway parallel-outbound-gateway parallel-ringcentral-cx parallel-ai-bus parallel-barge
restart_if_active parallel-live-coach-grpc
restart_if_active parallel-tag-webhook-front
restart_if_active parallel-tag-webhook-ngrok
sleep 4
systemctl --no-pager --full status parallel-control-plane parallel-inbound-gateway parallel-outbound-gateway parallel-ringcentral-cx parallel-ai-bus parallel-barge >/dev/null
ok "systemd services are running"

step "Health checks"
curl -fsS http://127.0.0.1:5001/health >/dev/null
curl -fsS http://127.0.0.1:4001/health >/dev/null
curl -fsS http://127.0.0.1:4002/health >/dev/null
curl -fsS http://127.0.0.1:6101/health >/dev/null
curl -fsS http://127.0.0.1:7000/health >/dev/null
curl -fsS http://127.0.0.1:81/ >/dev/null
ok "local health checks passed"

echo
echo "Deploy complete. This box is warm. ngrok services remain manual/off unless you start them."

