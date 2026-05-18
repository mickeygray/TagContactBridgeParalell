#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-parallel}"
APP_DIR="${APP_DIR:-/opt/tagcontactbridge-parallel}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo parallel-standby" >&2
  exit 1
fi

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

if [[ ! -f "${APP_DIR}/.env" ]]; then
  echo ".env not found at ${APP_DIR}/.env" >&2
  exit 1
fi

set_env "PARALLEL_RC_SUSPENDED" "true"
chown "${APP_USER}:${APP_USER}" "${APP_DIR}/.env"
chmod 600 "${APP_DIR}/.env"

systemctl stop parallel-ngrok || true
systemctl restart parallel-control-plane parallel-ringcentral-cx parallel-outbound-gateway parallel-inbound-gateway

echo "This host is back in standby mode: ngrok stopped, RingCentral suspended."
