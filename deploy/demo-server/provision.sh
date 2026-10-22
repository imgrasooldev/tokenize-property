#!/usr/bin/env bash
# One-time OS setup for the private IP demo server (Ubuntu 24.04). Run as root:
#   sudo bash deploy/demo-server/provision.sh
# Installs: swap, firewall (22 + 80 only), Node.js 24, PostgreSQL 18 (PGDG), Python, nginx,
# Temurin JDK 25 (checksum-verified) and Foundry 1.8.5. LOCAL DEV KEYS ONLY on this server.
set -euo pipefail

APP_USER=ubuntu
APP=/home/$APP_USER/property-token
JDK_URL=https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jdk_x64_linux_hotspot_25.0.4.1_1.tar.gz
FOUNDRY_URL=https://github.com/foundry-rs/foundry/releases/download/v1.8.5/foundry_v1.8.5_linux_amd64.tar.gz

export DEBIAN_FRONTEND=noninteractive

echo "== swap (4 GB RAM box: 4 Besu validators + PostgreSQL + Next.js)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -q vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/99-pt.conf

echo "== packages"
apt-get update -q
apt-get install -yq ca-certificates curl gnupg unzip git python3 python-is-python3 nginx ufw jq

echo "== Node.js 24 (NodeSource, signed apt repo)"
if ! node -v 2>/dev/null | grep -q '^v24'; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -q && apt-get install -yq nodejs
fi

echo "== PostgreSQL 18 (PGDG, signed apt repo); the packaged cluster is not used"
if [ ! -x /usr/lib/postgresql/18/bin/postgres ]; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt noble-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -q && apt-get install -yq postgresql-18
  # Our own cluster (backend/scripts/pg.py, 127.0.0.1:5433) replaces the default one.
  pg_dropcluster --stop 18 main 2>/dev/null || true
  systemctl disable --now postgresql 2>/dev/null || true
fi

echo "== Temurin JDK 25 (SHA-256 checked against the publisher's file)"
if [ ! -d /opt/jdk-25 ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/jdk.tgz" "$JDK_URL"
  curl -fsSL -o "$tmp/jdk.sha" "$JDK_URL.sha256.txt"
  (cd "$tmp" && echo "$(cut -d' ' -f1 jdk.sha)  jdk.tgz" | sha256sum -c -)
  mkdir -p /opt/jdk-25 && tar -xzf "$tmp/jdk.tgz" -C /opt/jdk-25 --strip-components=1
  rm -rf "$tmp"
fi

echo "== Foundry 1.8.5 (same version as development)"
if [ ! -x /home/$APP_USER/.foundry/bin/forge ]; then
  tmp=$(mktemp -d)
  curl -fsSL -o "$tmp/foundry.tgz" "$FOUNDRY_URL"
  sudo -u $APP_USER mkdir -p /home/$APP_USER/.foundry/bin
  tar -xzf "$tmp/foundry.tgz" -C /home/$APP_USER/.foundry/bin
  chown -R $APP_USER:$APP_USER /home/$APP_USER/.foundry
  rm -rf "$tmp"
fi

echo "== firewall: SSH and HTTP only (chain RPC, PostgreSQL, console stay on 127.0.0.1)"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw --force enable >/dev/null

echo "== nginx: port 80 -> website on 127.0.0.1:3100"
cp "$APP/deploy/demo-server/nginx.conf" /etc/nginx/sites-available/property-token
ln -sf /etc/nginx/sites-available/property-token /etc/nginx/sites-enabled/property-token
rm -f /etc/nginx/sites-enabled/default
bash "$APP/deploy/demo-server/publish-mockups.sh"
nginx -t && systemctl reload nginx

echo "== systemd units"
cp "$APP"/deploy/demo-server/pt-*.service "$APP"/deploy/demo-server/pt-*.timer /etc/systemd/system/
mkdir -p /etc/pt   # flags; e.g. touch /etc/pt/demo-market.enabled turns on the demo-market timer
systemctl daemon-reload
systemctl enable pt-stack pt-web pt-console pt-indexer pt-signer pt-kyc pt-bank-payees pt-outbox pt-offboarding pt-admin >/dev/null

echo "== CI deploy key: forced command, can only run update.sh for a commit on main"
install -o $APP_USER -g $APP_USER -m 0755 "$APP/deploy/demo-server/ci-entry.sh" /home/$APP_USER/pt-ci-entry.sh
CI_PUB="$APP/deploy/demo-server/ci-deploy.pub"
AK=/home/$APP_USER/.ssh/authorized_keys
if [ -f "$CI_PUB" ] && ! grep -q pt-ci-deploy "$AK"; then
  echo "command=\"/home/$APP_USER/pt-ci-entry.sh\",restrict $(cat "$CI_PUB")" >> "$AK"
fi

echo "provision done"
