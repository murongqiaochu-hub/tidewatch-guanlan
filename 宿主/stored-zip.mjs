import { createHash } from 'node:crypto';

const table = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
  table[n] = c >>> 0;
}
export function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = table[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function storedZip(entries) {
  if (!Array.isArray(entries) || entries.length > 65535) throw new RangeError('ZIP32 entry budget');
  const locals = [], directory = [], names = new Set(); let offset = 0;
  for (const entry of entries) {
    if (typeof entry.name !== 'string' || !entry.name || entry.name.startsWith('/') || entry.name.includes('\\') || entry.name.split('/').some(p => !p || p === '.' || p === '..') || names.has(entry.name)) throw new TypeError('Unsafe or duplicate ZIP entry');
    names.add(entry.name);
    const name = Buffer.from(entry.name, 'utf8'), bytes = Buffer.from(entry.bytes);
    if (name.length > 65535 || bytes.length > 0xffffffff) throw new RangeError('ZIP32 size');
    const crc = crc32(bytes), local = Buffer.alloc(30), central = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(33, 12); // Reproducible 1980-01-01, stored original bytes.
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt32LE((0o100600 << 16) >>> 0, 38); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, bytes); directory.push(central, name); offset += local.length + name.length + bytes.length;
    if (offset > 0xffffffff) throw new RangeError('ZIP32 offset');
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, central, end]);
}
