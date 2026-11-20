import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { JeraClient, intentId } from '../scripts/client.mjs';

const root = new URL('../', import.meta.url).pathname;
const cli = resolve(root, 'node_modules/.bin/snapback4');
async function start(dir, extra = []) {
  const child = spawn(cli, ['dev', '--port', '0', '--no-watch', ...extra], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '', stdout = '';
  child.stderr.on('data', data => { stderr += data; });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error(`Server readiness timeout: ${stderr}`)); }, 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${stderr}`)); });
    child.stdout.on('data', data => {
      stdout += data;
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  return { url, async stop() { const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; } };
}
async function account(origin, label, dir) {
  // Test principals are fixtures, not evidence of real ATproto authorization.
  const principal = 'did:plc:' + ({ alice: 'a', operator: 'b', reader: 'c', outsider: 'd' }[label.split('@')[0]]).repeat(24);
  const token = execFileSync(cli, ['token', '--service', 'auth-tests'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const { session } = await new JeraClient(origin, token).request('/auth/session', { principal, days: 1 });
  assert.equal(session.principal, principal);
  assert.ok(session?.token, 'real server must issue a trusted identity session');
  return { principal: session.principal, client: new JeraClient(origin, session.token) };
}
async function denied(promise, code) { await assert.rejects(promise.then(result => { throw Object.assign(new Error(JSON.stringify(result)), { code: 'UNEXPECTED_SUCCESS' }); }), error => { assert.equal(error.code, code, error.message); return true; }); }
const rows = response => response.data;

test('real Snapback: capture, organize, query, isolate, replay and recover', { timeout: 120_000 }, async t => {
  const dir = await mkdtemp(resolve(tmpdir(), 'jera-foundation-'));
  await mkdir(resolve(dir, 'snapback'));
  await copyFile(resolve(root, 'snapback/schema.q'), resolve(dir, 'snapback/schema.q'));
  let server;
  t.after(async () => { if (server) await server.stop(); await rm(dir, { recursive: true, force: true }); });
  server = await start(dir);
  const alice = await account(server.url, 'alice@jera.test', dir);
  const operator = await account(server.url, 'operator@jera.test', dir);
  const reader = await account(server.url, 'reader@jera.test', dir);
  const outsider = await account(server.url, 'outsider@jera.test', dir);
  const config = await (await fetch(server.url + '/auth/config')).json();
  assert.equal(config.password, false);
  assert.equal(config.guests, false);
  await denied(new JeraClient(server.url).request('/auth/signup', { email: 'wrong@example.test', password: 'not a Jera account' }), 'E_AUTH');
  assert.equal((await alice.client.query('currentIdentity')).data.did, alice.principal);
  const a = alice.client, op = operator.client, r = reader.client, out = outsider.client;
  const first = (await a.mutate('createArmillary', { name: 'Studio' })).result;
  const second = (await a.mutate('createArmillary', { name: 'Independent armillary' })).result;
  assert.notEqual(first.id, second.id);
  const mod = (await a.mutate('createModule', { armillary: first.id, name: 'Jera ideas' })).result;
  const privateMod = (await a.mutate('createModule', { armillary: second.id, name: 'Private ideas' })).result;
  await a.mutate('setMember', { module: mod.id, principal: operator.principal, access: 'write' });
  await a.mutate('setMember', { module: mod.id, principal: reader.principal, access: 'read' });
  assert.equal(rows(await op.query('armillariesList', {})).length, 1);
  assert.deepEqual(rows(await out.query('armillariesList', {})), []);
  const original = 'A tentative idea\n:virgo: ♍ ♍︎ ♍️ ᛃ — keep each form.\n  whitespace matters  ';
  const args = { module: mod.id, body: original, source: 'https://example.test/original' };
  const writeId = intentId();
  const artifact = (await a.mutate('capture', args, writeId)).result;
  await a.mutate('capture', args, writeId);
  assert.equal(rows(await a.query('artifactsList', { module: mod.id })).length, 1, 'retry must not duplicate the source');
  assert.equal(rows(await r.query('artifactsList', { module: mod.id }))[0].body, original);
  assert.deepEqual(rows(await out.query('artifactsList', { module: mod.id })), []);
  assert.deepEqual(rows(await op.query('modulesList', { armillary: second.id })), []);
  await denied(r.mutate('capture', args), 'E_RULE');
  await denied(op.mutate('capture', { ...args, module: privateMod.id }), 'E_RULE');
  const task = rows(await op.query('tasksList', { module: mod.id }))[0];
  assert.equal(task.artifact, artifact.id);
  await denied(r.mutate('claim', { task: task.id }), 'E_RULE');
  const claims = await Promise.allSettled([op.mutate('claim', { task: task.id }), a.mutate('claim', { task: task.id })]);
  assert.equal(claims.filter(x => x.status === 'fulfilled').length, 1, 'one worker wins a concurrent claim');
  assert.equal(claims.filter(x => x.status === 'rejected')[0].reason.code, 'NOT_AVAILABLE');
  const winner = claims[0].status === 'fulfilled' ? op : a;
  const loser = winner === op ? a : op;
  await denied(loser.mutate('complete', { task: task.id, title: 'Wrong worker', body: 'Not my claim' }), 'NOT_CLAIMED');
  const node = (await winner.mutate('complete', { task: task.id, title: 'Symbol-aware idea capture', body: 'Investigate exact representation; this is a suggestion.' })).result;
  assert.equal(node.artifact, artifact.id);
  assert.equal(node.author, winner === op ? operator.principal : alice.principal);
  assert.equal(rows(await a.query('artifactsList', { module: mod.id }))[0].body, original);
  assert.equal(rows(await a.query('tasksList', { module: mod.id }))[0].status, 'done');
  await denied(winner.mutate('claim', { task: task.id }), 'NOT_AVAILABLE');
  // Loss of membership must also remove visibility from indexes and work queues.
  await a.mutate('removeMember', { module: mod.id, principal: operator.principal });
  for (const query of ['artifactsList', 'nodesList', 'tasksList', 'edgesList']) assert.deepEqual(rows(await op.query(query, { module: mod.id })), []);
  await a.mutate('setMember', { module: mod.id, principal: operator.principal, access: 'write' });
  const other = (await a.mutate('capture', { ...args, body: 'A second idea' })).result;
  const next = rows(await op.query('tasksList', { module: mod.id })).find(x => x.artifact === other.id);
  await op.mutate('claim', { task: next.id });
  await server.stop(); server = null;
  server = await start(dir, ['--clock-offset', '+6m']);
  for (const c of [a, op, r, out]) c.origin = server.url;
  assert.equal(rows(await a.query('nodesList', { module: mod.id }))[0].id, node.id, 'graph survives a server restart');
  await a.mutate('claim', { task: next.id });
  await denied(op.mutate('complete', { task: next.id, title: 'Late worker', body: 'Stale lease' }), 'NOT_CLAIMED');
  const otherNode = (await a.mutate('complete', { task: next.id, title: 'Second idea', body: 'Connected after recovery' })).result;
  const edge = (await a.mutate('connect', { source: node.id, target: otherNode.id, relation: 'relates', reason: 'Both concern capture' })).result;
  assert.equal(edge.author, alice.principal);
  assert.equal(rows(await r.query('edgesList', { module: mod.id })).length, 1);
  await denied(r.mutate('connect', { source: node.id, target: otherNode.id, relation: 'supports', reason: 'Read-only member' }), 'E_RULE');
  // A read/write grant may be narrowed without changing the original artifact.
  await a.mutate('setMember', { module: mod.id, principal: operator.principal, access: 'read' });
  await denied(op.mutate('capture', args), 'E_RULE');
  assert.equal(rows(await op.query('nodesList', { module: mod.id })).length, 2);
});

test('remembered devices renew across sleep and respect logout, revocation and inactivity on real Snapback', {timeout: 90000}, async t => {
  const { AuthStore } = await import('../auth/store.mjs');
  const { deviceSessions, DAY } = await import('../auth/device-sessions.mjs');
  const dir = await mkdtemp(resolve(tmpdir(), 'jera-device-sessions-'));
  await mkdir(resolve(dir, 'snapback'));
  await copyFile(resolve(root, 'snapback/schema.q'), resolve(dir, 'snapback/schema.q'));
  const storePath = resolve(dir, 'auth.sqlite');
  let store = new AuthStore(storePath);
  let server;
  t.after(async () => { store.close(); if (server) await server.stop(); await rm(dir, { recursive: true, force: true }); });
  server = await start(dir);
  const service = execFileSync(cli, ['token', '--service', 'device-tests', '--days', '365'], {cwd:dir, encoding:'utf8', stdio:['ignore','pipe','pipe']}).trim();
  const did = 'did:plc:' + 'a'.repeat(24);
  const began = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now: began });
  async function advance(days) {
    await server.stop();
    server = await start(dir, ['--clock-offset', '+' + days * 24 + 'h']);
    t.mock.timers.setTime(began + days * DAY);
  }
  const upstream = async (path, token, body) => {
    const response = await fetch(server.url + path, {method:'POST', headers:{authorization:'Bearer ' + token, 'content-type':'application/json'}, body:JSON.stringify(body)});
    const result = await response.json();
    if (!response.ok || result.denied) throw Object.assign(new Error('Backend refusal'), {status: response.status});
    return result;
  };
  const mint = async (principal, days) => (await upstream('/auth/session', service, {principal, kind:'account', days})).session;
  const identity = async token => (await upstream('/q/currentIdentity', token, {args:{}})).data.did;
  const api = () => deviceSessions({store, upstream, check:identity, fail:(message,status) => {throw Object.assign(new Error(message),{status});}});
  let devices = api();
  const phone = await devices.enroll(did, 'ios', mint);
  const web = await devices.enroll(did, 'web', mint);
  const idle = await devices.enroll(did, 'ios', mint);
  const revoked = error => error.status === 401;
  assert.equal(Math.round((phone.session.expiresAt - began) / DAY), 1);
  assert.equal(Math.round((web.session.expiresAt - began) / DAY), 30);
  assert.equal(devices.managed(phone.session.token), true);
  const grant = 'device:' + devices.keyForAccess(phone.session.token);
  store.set('bluesky-grant', grant, did, 90 * DAY);
  assert.notEqual(devices.keyForAccess(phone.session.token), devices.keyForAccess(web.session.token));
  await assert.rejects(identity(phone.deviceCredential), revoked);
  await advance(3);
  store.close();
  store = new AuthStore(storePath);
  devices = api();
  await assert.rejects(identity(phone.session.token), revoked);
  const [first, retry] = await Promise.all([devices.resume(phone.deviceCredential, mint), devices.resume(phone.deviceCredential, mint)]);
  assert.equal(first.session.token, retry.session.token);
  assert.equal('device:' + devices.keyForAccess(first.session.token), grant);
  assert.equal(store.get('bluesky-grant', grant), did);
  assert.equal(await identity(retry.session.token), did);
  // The phone lost the successful response, and the gateway restarted.
  store.close();
  store = new AuthStore(storePath);
  devices = api();
  assert.equal((await devices.resume(phone.deviceCredential, mint)).session.token, first.session.token);
  assert.equal((await devices.resume(web.deviceCredential, mint)).session.token, web.session.token);
  await advance(24);
  const rotated = await devices.resume(web.deviceCredential, mint);
  assert.notEqual(rotated.session.token, web.session.token);
  await assert.rejects(identity(web.session.token), revoked);
  await devices.end(web.deviceCredential);
  await assert.rejects(identity(rotated.session.token), revoked);
  await assert.rejects(devices.resume(web.deviceCredential, mint), revoked);
  await advance(91);
  await assert.rejects(devices.resume(idle.deviceCredential, mint), revoked);
  assert.equal(await identity((await devices.resume(phone.deviceCredential, mint)).session.token), did);
  await advance(95);
  await upstream('/auth/revoke', service, {principal:did});
  await assert.rejects(devices.resume(phone.deviceCredential, mint), revoked);
});
