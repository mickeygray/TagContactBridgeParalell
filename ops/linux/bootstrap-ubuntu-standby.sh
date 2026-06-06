#!/usr/bin/env bash
set -euo pipefail

APP_USER="${APP_USER:-parallel}"
APP_DIR="${APP_DIR:-/opt/tagcontactbridge-parallel}"
REPO_URL="${REPO_URL:-git@github.com:mickeygray/TagContactBridgeParalell.git}"
BRANCH="${BRANCH:-master}"
NODE_MAJOR="${NODE_MAJOR:-24}"
MONGO_IMAGE="${MONGO_IMAGE:-mongo:8}"
INCLUDE_LOCAL_MONGO="${INCLUDE_LOCAL_MONGO:-false}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash $0" >&2
  exit 1
fi

step() { echo; echo "=== $* ==="; }
ok() { echo "  [ok] $*"; }
warn() { echo "  [warn] $*"; }

step "Base packages"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y \
  ca-certificates curl gnupg git build-essential nginx ufw fail2ban \
  docker.io unzip lsb-release

step "Node.js ${NODE_MAJOR}.x"
curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh
DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
node --version
npm --version

step "ngrok"
curl -fsSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc \
  | tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com bookworm main" \
  | tee /etc/apt/sources.list.d/ngrok.list >/dev/null
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ngrok
ngrok version || true

step "Firewall"
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
systemctl enable --now fail2ban
ok "UFW enabled for SSH/HTTP/HTTPS"

step "App user and GitHub deploy key"
if ! id "${APP_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${APP_USER}"
fi
install -d -m 700 -o "${APP_USER}" -g "${APP_USER}" "/home/${APP_USER}/.ssh"
if [[ ! -f "/home/${APP_USER}/.ssh/github_parallel" ]]; then
  sudo -H -u "${APP_USER}" ssh-keygen -t ed25519 -N "" \
    -C "parallel-ubuntu-standby" \
    -f "/home/${APP_USER}/.ssh/github_parallel"
fi
cat >"/home/${APP_USER}/.ssh/config" <<EOF
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/github_parallel
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
chown "${APP_USER}:${APP_USER}" "/home/${APP_USER}/.ssh/config"
chmod 600 "/home/${APP_USER}/.ssh/config"

echo
echo "If clone fails, add this as a READ-ONLY GitHub deploy key:"
echo "Repo: mickeygray/TagContactBridgeParalell -> Settings -> Deploy keys"
echo
cat "/home/${APP_USER}/.ssh/github_parallel.pub"
echo

step "Clone or update repo"
mkdir -p "$(dirname "${APP_DIR}")"
chown "${APP_USER}:${APP_USER}" "$(dirname "${APP_DIR}")"
if [[ -d "${APP_DIR}/.git" ]]; then
  sudo -H -u "${APP_USER}" bash -lc "cd '${APP_DIR}' && git fetch origin && git checkout '${BRANCH}' && git pull --ff-only origin '${BRANCH}'"
else
  if sudo -H -u "${APP_USER}" ssh -T git@github.com 2>&1 | grep -qi "successfully authenticated"; then
    ok "GitHub deploy key is accepted"
  else
    warn "GitHub key may not be accepted yet. If clone fails, add the deploy key above and rerun this script."
  fi
  sudo -H -u "${APP_USER}" git clone --branch "${BRANCH}" "${REPO_URL}" "${APP_DIR}"
fi

if [[ "${INCLUDE_LOCAL_MONGO}" == "true" ]]; then
  step "MongoDB container"
  systemctl enable --now docker
  mkdir -p /var/lib/parallel-mongo
  if docker ps -a --format '{{.Names}}' | grep -qx parallel-mongo; then
    docker start parallel-mongo >/dev/null
  else
    docker run -d \
      --name parallel-mongo \
      --restart unless-stopped \
      -p 127.0.0.1:27017:27017 \
      -v /var/lib/parallel-mongo:/data/db \
      "${MONGO_IMAGE}" >/dev/null
  fi
  ok "MongoDB is listening on 127.0.0.1:27017"
else
  step "MongoDB container"
  ok "Skipping local MongoDB; app uses Atlas via MONGO_URI"
fi

step "Install helper commands"
install -m 0755 "${APP_DIR}/ops/linux/deploy-standby.sh" /usr/local/bin/parallel-deploy
install -m 0755 "${APP_DIR}/ops/linux/go-live-linux.sh" /usr/local/bin/parallel-go-live
install -m 0755 "${APP_DIR}/ops/linux/standby-linux.sh" /usr/local/bin/parallel-standby

step "Systemd services"
cat >/etc/systemd/system/parallel-control-plane.service <<EOF
[Unit]
Description=Parallel control-plane
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node apps/control-plane/src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/parallel-inbound-gateway.service <<EOF
[Unit]
Description=Parallel inbound gateway
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node apps/inbound-gateway/src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/parallel-outbound-gateway.service <<EOF
[Unit]
Description=Parallel outbound gateway
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node apps/outbound-gateway/src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/parallel-ringcentral-cx.service <<EOF
[Unit]
Description=Parallel RingCentral CX
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node apps/ringcentral-cx/src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/parallel-ai-bus.service <<EOF
[Unit]
Description=Parallel AI bus (7000)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node apps/ai-bus/src/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/parallel-barge.service <<EOF
[Unit]
Description=Parallel barge / voicemail-drop service (7335)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
# Barger monitors + fallback wav are data-driven via .env:
#   EX_BARGE_MONITORS=987,1101,1102,1103,1104,1105,1106   (pre-warm all monitors at boot)
#   EX_BARGE_WAV=runtime/audio/drop-message.raw           (fallback voicemail)
# The registration health loop self-heals any monitor whose SIP socket drops.
ExecStart=/usr/bin/node scripts/ex-barge-button.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat >/etc/systemd/system/parallel-ngrok.service <<EOF
[Unit]
Description=Parallel ngrok tunnel
After=network-online.target parallel-control-plane.service nginx.service
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
Group=${APP_USER}
WorkingDirectory=${APP_DIR}
Environment=NODE_ENV=production
ExecStart=/usr/bin/node scripts/run-ngrok.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable parallel-control-plane parallel-inbound-gateway parallel-outbound-gateway parallel-ringcentral-cx parallel-ai-bus parallel-barge
systemctl disable parallel-ngrok >/dev/null 2>&1 || true
ok "App services enabled; ngrok service is installed but disabled/manual"

step "Nginx"
cp "${APP_DIR}/ops/nginx/parallel.conf" /etc/nginx/conf.d/parallel.conf
nginx -t
systemctl enable --now nginx
systemctl reload nginx
ok "Nginx loaded parallel.conf on port 81"

step "Next"
if [[ ! -f "${APP_DIR}/.env" ]]; then
  warn ".env is not present yet. Copy it from the Windows machine before starting the app."
  echo "After copying .env, run:"
  echo "  sudo parallel-deploy"
else
  echo "Running first deploy because .env already exists..."
  /usr/local/bin/parallel-deploy
fi
