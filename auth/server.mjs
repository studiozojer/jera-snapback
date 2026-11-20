import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { NodeOAuthClient, requestLocalLock } from '@atproto/oauth-client-node';
import { JoseKey } from '@atproto/jwk-jose';
import { AuthStore } from './store.mjs';
import { createHandler } from './service.mjs';
import { createAccountSearch } from './accounts.mjs';
import { createPublicIndexer, indexTransport } from './public-index.mjs';

const profile = process.argv[2] ?? 'jera';
if (!['jera', 'ansuz'].includes(profile)) throw new Error('Select the jera or ansuz gateway.');
const jera = profile === 'jera';
const name = jera ? 'Jera' : 'Ansuz';
const setting = key => process.env[profile.toUpperCase() + '_' + key];
const snapbackOrigin = process.env.SNAPBACK_ORIGIN ?? setting('SNAPBACK_ORIGIN') ?? 'http://127.0.0.1:4417';

process.umask(0o077);
const directory = resolve(setting('AUTH_DATA') ?? (jera ? '.local/auth' : '.local/ansuz-auth'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const publicOrigin = setting('PUBLIC_ORIGIN') ?? (jera ? 'https://snapback.jera.ink' : 'https://ansuz.jera.ink');
const callbacks = (setting('AUTH_CALLBACKS') ?? (jera ? 'studio.zojer.jera.exact:/oauth' : 'studio.zojer.ansuz:/oauth')).split(',');
const keyPath = resolve(directory, 'signing-key.json');
let key;
try { key = await JoseKey.fromJWK(await readFile(keyPath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  key = await JoseKey.generate(['ES256'], `${profile}-1`);
  await writeFile(keyPath, JSON.stringify(key.privateJwk), { mode: 0o600, flag: 'wx' });
}
const store = new AuthStore(resolve(directory, 'auth.sqlite'));
const client = new NodeOAuthClient({
  clientMetadata: {
    client_id: `${publicOrigin}/oauth/client-metadata.json`, client_name: name,
    redirect_uris: [`${publicOrigin}/oauth/callback`], scope: 'atproto',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], application_type: 'web',
    token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_signing_alg: 'ES256',
    dpop_bound_access_tokens: true, jwks_uri: `${publicOrigin}/oauth/jwks.json`,
  },
  keyset: [key], requestLock: requestLocalLock, stateStore: store.sdk('oauth-state', 10 * 60000), sessionStore: store.sdk('oauth-session'),
});
const serviceToken = (await readFile(setting('SERVICE_TOKEN_FILE') ?? resolve(directory, 'service-token'), 'utf8')).trim();
if (!serviceToken) throw new Error('Missing Snapback service token.');
const server = createServer(createHandler({ profile, client, store, publicOrigin, callbacks, serviceToken,
  searchAccounts: createAccountSearch({ pdsOrigin: setting('PDS_ORIGIN') ?? 'https://pds.jera.ink', searchBluesky: true }),
  snapbackOrigin }));
server.requestTimeout = 30000; server.headersTimeout = 10000;
server.listen(Number(process.env.PORT ?? (jera ? 4420 : 4433)), '127.0.0.1', () => console.log(`${name} ATproto authorization ready on loopback.`));
if (jera && process.env.JERA_ENABLE_BLUESKY_INDEX === '1') {
  const publicIndexer = createPublicIndexer({
    request: indexTransport(snapbackOrigin, serviceToken),
    resolveIdentity: (did, options) => client.identityResolver.resolve(did, options),
  });
  const indexTick = () => publicIndexer.tick().catch(() => console.error('Public index storage unavailable; retrying on the next tick.'));
  indexTick();
  const indexTimer = setInterval(indexTick, 60000); indexTimer.unref();
}
const timer = setInterval(() => store.prune(), 60000); timer.unref();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { store.close(); process.exit(0); }));
