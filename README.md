# Jera Snapback

Jera and Ansuz share one Snapback 4 data service. This repository owns its Quarry schema, server-side validation, ATproto OAuth gateways, application record definitions, operation clients for integration tests, and host operations. Jera supplies the private drafts, posts, audiences and module graph. Ansuz supplies the immutable gesture recordings, reader grants and trace validation. A verified DID owns each person's records. All new posts and recordings stay in this application store.

## Run locally

Use Node 24.11 or compatible and npm. Snapback is pinned to 0.4.33, matching both source applications.

```sh
npm ci
npm ci --prefix auth
npm run check
npm test
npm run dev
```

The last command serves the development store on loopback port 4417 from this directory. The check generates the combined client API under `snapback/generated/`. Integration tests create independent disposable stores with synthetic accounts. They cover stable post IDs across the two client libraries, private membership, recording integrity and reader revocation. Auth handoff tests use provider fixtures. The browser and device tests stay with each frontend.

Both clients query the same store using `POST /q/postById` with `{"args":{"id":"<post ID>"}}` and an ordinary authenticated bearer. The schema enforces the viewing account's permissions. An inaccessible record and an absent record both yield a null result. The verified actor can be read through `POST /q/currentIdentity`. Jera sends structured posts through `/records/publish`; Ansuz sends archives through `/m/archive` on the gateway. The gateway validates the payload and attributes it before making a service-authorized mutation.

## Gateway profiles

`npm run auth:jera` and `npm run auth:ansuz` use the same server entry point. Each profile owns its client ID, explicit callback allowlist, signing key, OAuth sessions and browser flow state. The default data address for both is `http://127.0.0.1:4417`. Set `SNAPBACK_ORIGIN` to use a different shared runtime. The gateways listen on loopback ports 4420 and 4433 respectively. Each expects a root-readable or service-user-readable file containing that store's existing `service:atproto-auth` credential, selected by `JERA_SERVICE_TOKEN_FILE` or `ANSUZ_SERVICE_TOKEN_FILE`. Local experiments can mint a test service token with `snapback4 token --service atproto-auth` in the disposable development store. Keep tokens out of source and client configuration.

The externally visible origin and callbacks are set independently through `JERA_PUBLIC_ORIGIN`, `JERA_AUTH_CALLBACKS`, `ANSUZ_PUBLIC_ORIGIN` and `ANSUZ_AUTH_CALLBACKS`. The existing hostnames can front the same data listener while retaining both OAuth client registrations. Each client signs in, checks authority and refreshes against its own gateway. Revocation after a definitive provider failure revokes the DID's Snapback sessions across this store. A client may need to sign in again in both apps. Indexing Bluesky records is opt-in on the Jera gateway and is disabled by default.

## Production migration boundary

The standalone repository is a source extraction. Production started with two independent stores. The Git revision alone cannot move their data or change DNS. The Jera release procedure and preserved Ansuz recovery procedure are in [ops](ops/README.md) and [legacy Ansuz ops](ops/legacy-ansuz/README.md).

1. Take and checksum whole-deployment backups of both stores, their assets and both OAuth directories. Rehearse from copies with a separate machine or isolated ports. Preserve the existing Jera store as the destination so its record IDs remain stable.
2. Inventory every recording's ID, owner DID, digest, timestamps, metadata, file reference and bytes; inventory the grant pairs and every legacy principal. Reconcile each recording by owner plus digest, verify the actual byte hash, and preserve or explicitly map stable references. Unknown owners require an explicit decision. A schema adoption alone cannot copy a record or blob from the second store.
3. Preserve the two OAuth key/state directories independently. Use a fresh service credential from the destination store for the Ansuz gateway; the old store's bearer has no authority there. Expect old Ansuz data sessions to require reauthorization. Mint a new ordinary recorder principal session privately if the archived grants require it. Use the staged [unit](ops/ansuz-shared-auth.service) and [proxy fragment](ops/ansuz-shared.caddy) only after the destination has passed reconciliation. The old and shared Ansuz gateways both reserve port 4433.
4. Before cutover, freeze writes long enough to capture the final source delta, compare both inventories, and rehearse both accounts' authorization and app paths on a restored copy. Verify reading posted records across clients, archive replay, grant removal, logout, and restart. Update the backup program with [the shared version](ops/backup.sh) to cover the second OAuth directory. Keep the old deployment available read-only through the recovery window; any writes after cutover need reconciliation before rerouting.

The combined schema and local gateways can be exercised now. A production data importer, restored-production reconciliation and live account-holder acceptance remain outstanding. Deployment tools and host checks in this tree were inherited from the applications and have not been executed against a live host by this extraction.

Source baselines are [Jera 5157982](https://github.com/studiozojer/jera/tree/5157982fe4bac5aa373c33d373992ec9f506db2b) and [Ansuz 6bab409](https://github.com/studiozojer/ansuz/tree/6bab4094b7959f8871ee73546eb63d2ecda2bbcf).
