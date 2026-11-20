#!/bin/bash
# Run as root on the selected VPS after copying this directory and schema.q
# into /opt/ansuz-recordings. Does not edit the reverse proxy.
set -euo pipefail
cd /opt/ansuz-recordings
exec 9>/run/lock/ansuz-recordings-maintenance.lock
flock -n 9 || { echo 'Another Snapback maintenance operation is running.' >&2; exit 1; }
if ! id ansuz-recordings >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/ansuz-recordings --shell /usr/sbin/nologin ansuz-recordings
fi
install -d -o ansuz-recordings -g ansuz-recordings -m 0700 /var/lib/ansuz-recordings
bash runtime.sh
export PATH="/opt/ansuz-recordings/runtime/bin:$PATH"
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
./node_modules/.bin/snapback4 --version
# Preserve the deployment directory: deploy performs adoption; never reset it.
runuser -u ansuz-recordings -- ./node_modules/.bin/snapback4 deploy /var/lib/ansuz-recordings/deployment --check
# PrivateTmp isolates the service's local adoption socket. Stop for adoption;
# preserve the existing store and restart the previous service on failure.
was_active=0
if systemctl is-active --quiet ansuz-recordings; then
  was_active=1
  systemctl stop ansuz-recordings
fi
restart_previous() { if [ "$was_active" = 1 ]; then systemctl start ansuz-recordings; fi; }
trap restart_previous EXIT
runuser -u ansuz-recordings -- ./node_modules/.bin/snapback4 deploy /var/lib/ansuz-recordings/deployment
install -m 0644 ansuz-recordings.service /etc/systemd/system/ansuz-recordings.service
install -m 0644 ansuz-recordings-backup.service /etc/systemd/system/ansuz-recordings-backup.service
install -m 0644 ansuz-recordings-backup.timer /etc/systemd/system/ansuz-recordings-backup.timer
systemctl daemon-reload
systemctl enable --now ansuz-recordings.service ansuz-recordings-backup.timer
systemctl restart ansuz-recordings.service
trap - EXIT
for attempt in {1..30}; do
  if curl --silent --fail http://127.0.0.1:4431/auth/config >/dev/null; then
    echo 'Ansuz recordings is ready on loopback port 4431.'
    exit 0
  fi
  sleep 1
done
journalctl -u ansuz-recordings -n 20 --no-pager
exit 1
