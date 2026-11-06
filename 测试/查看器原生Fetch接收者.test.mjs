import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeDownload } from '../查看器/resources.mjs';

// Browser WebIDL fetch needs its native global receiver. This is a model guard;
// the separate real-Chrome download validates the actual Window implementation.
test('原生下载默认fetch保持global接收者而非NativeDownload实例', async () => {
  const original = globalThis.fetch;
  let calls = 0, handed = null;
  globalThis.fetch = async function (url, options) {
    assert.equal(this, globalThis, 'Do not invoke WebIDL native fetch with a state-machine receiver');
    assert.equal(options.method, 'HEAD'); calls++;
    return { ok: true, status: 200, type: 'basic', url, headers: new Headers({ 'content-type': 'application/zip', 'content-length': '123' }) };
  };
  try {
    const download = new NativeDownload({ baseURL: 'https://own.invalid/', getDescriptor: async () => ({ url: 'https://own.invalid/current.zip', filename: 'current.zip', mime: 'application/zip', byteLength: 123 }), handoff: value => { handed = value; } });
    assert.equal(await download.start({ frameId: 'own-frame', revisionId: 'own-revision', kind: 'zip' }), true);
    assert.equal(calls, 1); assert.equal(handed.filename, 'current.zip');
    assert.equal(download.diagnostics.state, 'notSavedYet'); assert.equal(download.diagnostics.getRequests, 0);
  } finally { globalThis.fetch = original; }
});
