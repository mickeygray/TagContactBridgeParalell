#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/tagcontactbridge-parallel}"

if [[ ! -d "${APP_DIR}" ]]; then
  echo "App directory not found: ${APP_DIR}" >&2
  exit 1
fi

cd "${APP_DIR}"

# Some patch paths extract npm-owned files from Windows-created archives, which
# can flatten executable bits. Keep the known runtime binaries executable.
chmod +x node_modules/.bin/* 2>/dev/null || true
chmod +x node_modules/7zip-bin/7x.sh 2>/dev/null || true
chmod +x node_modules/7zip-bin/linux/*/7za 2>/dev/null || true

if [[ -x node_modules/7zip-bin/linux/x64/7za ]]; then
  node_modules/7zip-bin/linux/x64/7za >/dev/null 2>&1 || true
fi

echo "Runtime executable permissions repaired for ${APP_DIR}"
