import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync, createInflate } from 'node:zlib';
import { Readable } from 'node:stream';
import { createDemoServer } from '../宿主/demo-server.mjs';

export const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
export async function startHost(t, options = {}) {
  const app = await createDemoServer(options);
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = 'http://127.0.0.1:' + app.server.address().port, token = app.createSession();
  const request = (route, options = {}) => fetch(base + route, { ...options, headers: { Authorization: 'Bearer ' + token, ...(options.method === 'POST' ? { Origin: base } : {}), ...options.headers } });
  return { app, base, token, request };
}
export async function privateFixtureDirectory(t, prefix = '.宿主-') {
  const canonical = await fs.realpath(testRoot), directory = await fs.mkdtemp(path.join(canonical, prefix));
  await fs.chmod(directory, 0o700);
  t.after(async () => {
    const resolved = await fs.realpath(directory);
    assert.equal(resolved, directory); assert.ok(directory.startsWith(canonical + '/' + prefix));
    await fs.rm(directory, { recursive: true });
  });
  return directory;
}
export async function privateFile(file, bytes) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 }); await fs.chmod(path.dirname(file), 0o700);
  const handle = await fs.open(file, 'w', 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.chmod(0o600); } finally { await handle.close(); }
}
function independentCRC(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
export function pngParts(bytes) {
  assert.deepEqual([...bytes.subarray(0, 8)], [137,80,78,71,13,10,26,10]);
  let offset = 8, width, height; const idat = [], kinds = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset), kind = bytes.toString('ascii', offset + 4, offset + 8), payload = bytes.subarray(offset + 8, offset + 8 + length);
    assert.equal(independentCRC(bytes.subarray(offset + 4, offset + 8 + length)), bytes.readUInt32BE(offset + 8 + length));
    kinds.push(kind);
    if (kind === 'IHDR') { width = payload.readUInt32BE(0); height = payload.readUInt32BE(4); assert.equal(payload[8], 8); assert.equal(payload[9], 6); }
    if (kind === 'IDAT') idat.push(payload);
    offset += length + 12;
  }
  assert.equal(offset, bytes.length); assert.equal(kinds[0], 'IHDR'); assert.equal(kinds.at(-1), 'IEND');
  return { width, height, idat };
}
export function decodeSmallPNG(bytes) {
  const parts = pngParts(bytes); assert.ok(parts.width * parts.height <= 2_000_000);
  const rows = inflateSync(Buffer.concat(parts.idat)), stride = parts.width * 4 + 1;
  assert.equal(rows.length, stride * parts.height);
  for (let y = 0; y < parts.height; y++) assert.equal(rows[y * stride], 0);
  return { ...parts, pixel(x, y) { const offset = y * stride + 1 + x * 4; return [...rows.subarray(offset, offset + 4)]; } };
}
export async function sampleLargePNG(bytes, coordinates) {
  const parts = pngParts(bytes), stride = parts.width * 4 + 1, zipper = createInflate();
  const input = Readable.from(parts.idat); input.pipe(zipper);
  let pending = Buffer.alloc(0), y = 0; const pixels = [];
  for await (const chunk of zipper) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    let offset = 0;
    while (pending.length - offset >= stride) {
      assert.equal(pending[offset], 0);
      coordinates.forEach(([x, row], index) => { if (row === y) pixels[index] = [...pending.subarray(offset + 1 + x * 4, offset + 5 + x * 4)]; });
      y++; offset += stride;
    }
    pending = Buffer.from(pending.subarray(offset));
  }
  assert.equal(y, parts.height); assert.equal(pending.length, 0);
  return { ...parts, pixels };
}
