// Only the gateway holds the long-lived Snapback family. A device gets a
// separate random credential and a limited-lifetime data bearer. Checking that
// family keeps Snapback logout-all and administrator revocation authoritative,
// even when the last data bearer has expired.
import { createHash, randomBytes } from 'node:crypto';

export const DAY = 86_400_000;
const hash = value => createHash('sha256').update(value).digest('hex');
const policies = {
  ios: { idle: 90, access: 1, renewBefore: DAY / 2 },
  web: { idle: 30, access: 30, renewBefore: 7 * DAY },
};

export function deviceSessions({ store, upstream, check, fail, now = Date.now }) {
  const jobs = new Map();
  function withDevice(credential, operation, fn) {
    if (!credential || !/^[A-Za-z0-9_-]{43}$/.test(credential)) fail('Sign in again.', 401);
    const key = hash(credential);
    const pending = jobs.get(key);
    if (pending?.operation === operation) return pending.job;
    const job = (pending?.job ?? Promise.resolve()).catch(() => {}).then(() => fn(key));
    jobs.set(key, { operation, job });
    return job.finally(() => { if (jobs.get(key)?.job === job) jobs.delete(key); });
  }
  async function close(session) {
    try { await upstream('/auth/logout', session.token, {}); }
    catch (error) { if (error.status !== 401) throw error; }
  }
  function save(key, device) {
    const { idle } = policies[device.platform];
    store.set('device', key, device, idle * DAY);
    store.set('device-access', hash(device.access.token), true, Math.max(1, device.access.expiresAt - now()));
  }
  function validate(session, did) {
    if (!session?.token || session.principal !== did || !Number.isFinite(session.expiresAt) || session.expiresAt <= now())
      fail('Invalid account session.', 502);
    return session;
  }
  return {
    managed(token) { return Boolean(token && store.get('device-access', hash(token))); },
    async enroll(did, platform, mint) {
      const { idle, access } = policies[platform];
      const anchor = validate(await mint(did, 2 * idle), did);
      try {
        const session = validate(await mint(did, access), did);
        const credential = randomBytes(32).toString('base64url');
        save(hash(credential), { did, platform, anchor, access: session });
        return { session, deviceCredential: credential, deviceExpiresAt: now() + idle * DAY };
      } catch (error) { await close(anchor); throw error; }
    },
    resume(credential, mint) {
      return withDevice(credential, 'resume', async key => {
        const device = store.get('device', key);
        if (!device || device.ending) fail('Device authorization ended. Sign in again.', 401);
        const { did, platform } = device;
        const { idle, access, renewBefore } = policies[platform];
        if (await check(device.anchor.token) !== did) fail('Device account changed.', 401);
        async function verify(session) {
          const { data } = await upstream('/q/currentIdentity', session.token, { args: {} });
          if (data?.did !== did) fail('Could not verify the device account.', 503);
        }
        async function retirePrevious() {
          if (!device.retiring) return;
          await close(device.retiring);
          delete device.retiring;
          save(key, device);
        }
        async function replace(field, days) {
          // Mint before retiring. Losing an upstream refresh response would
          // otherwise strand an active installation with a spent bearer.
          const next = validate(await mint(did, days), did);
          try { await verify(device.anchor); }
          catch (error) { await close(next); throw error; }
          device.retiring = device[field];
          device[field] = next;
          save(key, device);
          await retirePrevious();
        }
        await retirePrevious();
        if (device.access.expiresAt > now()) await verify(device.access);
        if (device.anchor.expiresAt - now() <= idle * DAY) await replace('anchor', 2 * idle);
        if (device.access.expiresAt - now() <= renewBefore) await replace('access', access);
        save(key, device);
        return { session: device.access, deviceExpiresAt: now() + idle * DAY };
      });
    },
    end(credential) {
      return withDevice(credential, 'end', async key => {
        const device = store.get('device', key);
        if (!device) return;
        // Fence renewals before network I/O. A retry can finish either
        // upstream logout after an interrupted request or gateway restart.
        save(key, { ...device, ending: true });
        await Promise.all([device.anchor, device.access, device.retiring].filter(Boolean).map(close));
        store.del('device', key);
      });
    },
  };
}
