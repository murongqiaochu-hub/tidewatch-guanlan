// Per-writer session journals. clientStorage has no atomic CAS: this is a
// discoverable recovery log, NOT a lock or a cross-window publish coordinator.
import { fail, record } from './core.mjs';

export function createPendingJournalStore(storage, legacyKey, writerId) {
  if (typeof legacyKey !== 'string' || !legacyKey || typeof writerId !== 'string' || !/^[A-Za-z0-9_-]{16,200}$/.test(writerId)) fail('BAD_SCHEMA');
  const prefix = `${legacyKey}.journal.`;
  const ownKey = `${prefix}${writerId}`;
  let ownsKey = false;
  const required = () => {
    if (!storage || typeof storage.getAsync !== 'function' || typeof storage.setAsync !== 'function' || typeof storage.keysAsync !== 'function') fail('SDK_CAPABILITY_MISSING');
  };
  return {
    ownKey,
    async list() {
      required();
      let keys;
      try { keys = await storage.keysAsync(); } catch { fail('SDK_READ_FAILED'); }
      if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string')) fail('SDK_READ_FAILED');
      const selected = [...new Set(keys.filter(key => key.startsWith(prefix)))].sort();
      const entries = [];
      try {
        const legacy = await storage.getAsync(legacyKey);
        if (legacy !== undefined && legacy !== null) entries.push({ key: legacyKey, value: legacy, legacy: true });
        for (const key of selected) {
          const value = await storage.getAsync(key);
          // A disappearing key must not hide a possibly unresolved session.
          if (value === undefined || value === null) fail('SDK_READ_FAILED');
          entries.push({ key, value, legacy: false });
        }
      } catch (error) { if (error?.code) throw error; fail('SDK_READ_FAILED'); }
      return entries;
    },
    async write(value) {
      required();
      if (!record(value)) fail('BAD_SCHEMA');
      try {
        // Detect a pre-existing writer ID. This check is not atomic; callers must
        // supply independent cryptographically random IDs, not use it as a lock.
        if (!ownsKey && (await storage.getAsync(ownKey)) !== undefined) fail('BUSY');
        await storage.setAsync(ownKey, value);
        ownsKey = true;
      } catch (error) { if (error?.code) throw error; fail('SDK_READ_FAILED'); }
    }
  };
}
