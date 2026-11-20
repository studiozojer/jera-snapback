#!/bin/bash
# Run after staging auth/, schema and unit files under /opt/ansuz-recordings.
# Existing data remains in place; no ownership is inferred from emails.
set -euo pipefail
umask 077
cd /opt/ansuz-recordings
export PATH="/opt/ansuz-recordings/runtime/bin:$PATH"
(cd auth && npm ci --omit=dev --ignore-scripts --no-audit --no-fund)
chown -R ansuz-recordings:ansuz-recordings auth/node_modules
runuser -u ansuz-recordings -- ./node_modules/.bin/snapback4 deploy /var/lib/ansuz-recordings/deployment --check
# A consistent on-host backup precedes adoption; do not copy private data away.
bash backup.sh
exec 9>/run/lock/ansuz-recordings-maintenance.lock
flock -n 9
install -d -o ansuz-recordings -g ansuz-recordings -m 0700 /var/lib/ansuz-recordings/auth
auth_was_active=0
if systemctl is-active --quiet ansuz-atproto-auth; then auth_was_active=1; fi
systemctl stop ansuz-atproto-auth 2>/dev/null || true
systemctl stop ansuz-recordings
restart_previous() { systemctl start ansuz-recordings; if [ "$auth_was_active" = 1 ]; then systemctl start ansuz-atproto-auth; fi; }
trap restart_previous EXIT
runuser -u ansuz-recordings -- ./node_modules/.bin/snapback4 deploy /var/lib/ansuz-recordings/deployment
if [ ! -s /var/lib/ansuz-recordings/auth/service-token ]; then
  runuser -u ansuz-recordings -- ./node_modules/.bin/snapback4 token --service atproto-auth --release /var/lib/ansuz-recordings/deployment > /var/lib/ansuz-recordings/auth/service-token
  chown ansuz-recordings:ansuz-recordings /var/lib/ansuz-recordings/auth/service-token
  chmod 0600 /var/lib/ansuz-recordings/auth/service-token
fi
systemctl start ansuz-recordings
for attempt in {1..30}; do
  if curl --silent --fail http://127.0.0.1:4431/auth/config >/dev/null; then break; fi
  sleep 1
done
curl --silent --fail http://127.0.0.1:4431/auth/config >/dev/null
trap - EXIT
# Password sessions cannot keep acting after the identity migration. Preserve
# their records for deliberate attribution; never infer an ATproto account.
python3 - <<'PY'
import json, pathlib, sqlite3, urllib.request
root = pathlib.Path('/var/lib/ansuz-recordings')
token = (root/'auth/service-token').read_text().strip()
c = sqlite3.connect('file:'+str(root/'deployment/store.sqlite')+'?mode=ro', uri=True)
principals = [row[0] for row in c.execute("select distinct principal from _sessions where principal like 'user:%' or principal like 'guest:%' or principal like 'dev:%'")]
for principal in principals:
 req = urllib.request.Request('http://127.0.0.1:4431/auth/revoke', data=json.dumps({'principal':principal}).encode(), headers={'Content-Type':'application/json','Authorization':'Bearer '+token}, method='POST')
 with urllib.request.urlopen(req, timeout=15) as res: assert res.status == 200
print('Retired legacy session principals:', len(principals), '; stored records preserved.')
PY
install -m 0644 ansuz-atproto-auth.service /etc/systemd/system/ansuz-atproto-auth.service
systemctl daemon-reload
systemctl enable --now ansuz-atproto-auth
systemctl restart ansuz-atproto-auth
for attempt in {1..30}; do
  if curl --silent --fail http://127.0.0.1:4433/oauth/health >/dev/null; then break; fi
  sleep 1
done
curl --silent --fail http://127.0.0.1:4433/oauth/health
python3 install-proxy.py
