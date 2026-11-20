# Ansuz recording service operations

These are the original, separate-service operations retained for backup and recovery through cutover. Relative paths in the instructions refer to [the source layout at extraction](https://github.com/studiozojer/ansuz/tree/6bab409/recordings). The shared service is described in [the backend guide](../../README.md).

The existing Jera VPS hosts an independent **Ansuz** Snapback service at `https://ansuz.jera.ink`. Jera's endpoint, identity service, PDS and database remain separate.

| Item | Location |
| --- | --- |
| Runtime and authored schema | `/opt/ansuz-recordings` |
| Whole durable deployment, including file assets | `/var/lib/ansuz-recordings/deployment` |
| Service and OS account | `ansuz-recordings` |
| Snapback loopback listener | `127.0.0.1:4431` |
| ATproto service / listener | `ansuz-atproto-auth` / `127.0.0.1:4433` |
| OAuth state, signing key and service credential | `/var/lib/ansuz-recordings/auth` |
| Caddy fragment | `/etc/caddy/ansuz-recordings.caddy` |
| Nightly backup | `ansuz-recordings-backup.timer`, 04:40 UTC plus up to five minutes |
| Backup archives, checksums, 14-day retention | `/var/backups/ansuz-recordings` |
| Restore drill | Temporary deployment on `127.0.0.1:4432` |

Node 24.11.0 and Snapback 0.4.33 are installed privately with a pinned npm lockfile and checked Node archive checksum. The service runs unprivileged, with its own writable directory and a 1 GiB memory ceiling. Caddy uses `tls force_automate` to distinguish the endpoint from the PDS wildcard policy. Only HTTPS is public; development persona headers are stripped.

Copy `../package.json`, `../package-lock.json`, `../snapback/schema.q`, `../auth/` and this directory's scripts/unit files into the corresponding paths under `/opt/ansuz-recordings`. Exclude node_modules, development stores and credentials. For a fresh machine, first run `install-vps.sh` to install the isolated runtime and base service, then `install-auth.sh`. For this existing deployment, run `bash /opt/ansuz-recordings/install-auth.sh`. It installs pinned OAuth dependencies, previews schema adoption, makes an on-host backup, adopts without destructive flags, preserves rows, retires legacy user/guest/dev sessions, and starts the separate auth service. `install-proxy.py` applies only the dedicated proxy fragment and rolls back on health-check failure. Confirm Ansuz `/auth/config` reports password and guests false, `/oauth/health` succeeds, public `/auth/session` is refused, and Jera/PDS remain healthy.

`backup.sh` stops both Ansuz services, snapshots the complete `deployment` and `auth` directories, checksums the archive, and restarts Snapback before auth, including on an archive failure. A maintenance lock prevents overlapping deployments/backups. `restore-check.py` makes a synthetic trusted-DID probe, takes a snapshot, restores into a temporary directory, authenticates using the restored server credential, and checks the exact trace checksum. It never replaces live state. This proves storage and key custody, not real OAuth approval.

The 2026-11-01 UTC migration inventory found six synthetic/agent password accounts and no human password accounts. All rows were preserved; no email-to-DID mapping was inferred. Old reader grants remain historical rows and do not become grants to the new operator principal. Users choose the new grant explicitly. `issue-reader.py` issues that ordinary machine session; keep its private file and the server-only minting token distinct. See the parent README for renewal/import.

Backups are private account data. Same-VPS backups do not survive loss of that VPS. An off-host snapshot has not been copied: automatic approval review requires explicit approval for exporting private account state and recordings to this Mac. That optional approval is pending; scheduled off-host replication is not installed. For recovery, preserve the damaged deployment first, verify the selected archive checksum, restore the whole directory separately, validate it with the pinned runtime, then explicitly select the recovery point. Do not restore only `store.sqlite`, omit `assets/`, or lose the accompanying OAuth store and signing key. Pre-auth snapshots do not contain the new OAuth directory; inspect the recovery point before use.

The validated archive release routes public `/m/archive` to the auth service. Only `service:atproto-auth` may insert recording rows, including through alternate Snapback write transports. Deploy `auth/archive.mjs`, `auth/trace.mjs`, `auth/service.mjs`, `snapback/schema.q` and the proxy fragment together. The gateway authenticates the ordinary account and copies validated bytes into a service-owned asset before archival. Existing rows and assets remain readable. The 2026-11-01 deployment passed direct-write denial, metadata mismatch rejection, verified-owner binding and exact authenticated-byte checks using a synthetic account; restore point `20261101T094053Z.tar.gz` passed its authenticated checksum drill.
