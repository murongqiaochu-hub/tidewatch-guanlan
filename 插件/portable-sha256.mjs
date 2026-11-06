// Independently implemented from FIPS 180-4 sections 4.1.2, 4.2.2, 5 and 6.2.
// Fixed auxiliary memory: eight state words, 64 schedule words and one 64-byte tail.
// Input blocks are read in place, including Uint8Array subviews; no input-sized copy.
const K = new Uint32Array([
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
]);
const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));
async function portableDigest(bytes, yieldTask) {
  const h = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w = new Uint32Array(64), tail = new Uint8Array(64);
  const compress = (input, offset) => {
    for (let i = 0; i < 16; i++) { const p = offset + i * 4; w[i] = (input[p] << 24) | (input[p+1] << 16) | (input[p+2] << 8) | input[p+3]; }
    for (let i = 16; i < 64; i++) {
      const x = w[i-15], y = w[i-2];
      w[i] = (w[i-16] + (rotate(x,7) ^ rotate(x,18) ^ (x >>> 3)) + w[i-7] + (rotate(y,17) ^ rotate(y,19) ^ (y >>> 10))) >>> 0;
    }
    let a=h[0], b=h[1], c=h[2], d=h[3], e=h[4], f=h[5], g=h[6], z=h[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (z + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      z=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
    }
    h[0]=(h[0]+a)>>>0; h[1]=(h[1]+b)>>>0; h[2]=(h[2]+c)>>>0; h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0; h[5]=(h[5]+f)>>>0; h[6]=(h[6]+g)>>>0; h[7]=(h[7]+z)>>>0;
  };
  let offset = 0, blocks = 0;
  while (offset + 64 <= bytes.length) {
    compress(bytes, offset); offset += 64;
    // A real task boundary, not a microtask-only Promise.resolve loop.
    if (++blocks % 1024 === 0) await yieldTask();
  }
  const remaining = bytes.length - offset;
  for (let i = 0; i < remaining; i++) tail[i] = bytes[offset+i];
  tail[remaining] = 0x80;
  if (remaining >= 56) { compress(tail, 0); tail.fill(0); }
  // Encode the 64-bit bit length as two big-endian words without 32-bit truncation.
  const length = new DataView(tail.buffer);
  length.setUint32(56, Math.floor(bytes.length / 0x20000000), false);
  length.setUint32(60, (bytes.length * 8) >>> 0, false);
  compress(tail, 0);
  const output = new ArrayBuffer(32), view = new DataView(output);
  for (let i = 0; i < 8; i++) view.setUint32(i * 4, h[i], false);
  return output;
}
export function createDigestProvider(cryptoAPI, { yieldTask = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
  if (typeof yieldTask !== 'function') throw new TypeError('Digest task scheduler required');
  const nativeSubtle = cryptoAPI?.subtle;
  const nativeDigest = typeof nativeSubtle?.digest === 'function' ? nativeSubtle.digest : null;
  return {
    // Entropy always belongs to the supplied native crypto object. No random fallback.
    getRandomValues: typeof cryptoAPI?.getRandomValues === 'function' ? cryptoAPI.getRandomValues.bind(cryptoAPI) : undefined,
    subtle: { async digest(algorithm, bytes) {
      if (algorithm !== 'SHA-256' || !(bytes instanceof Uint8Array)) throw new TypeError('Only SHA-256 Uint8Array input is supported');
      // Never catch native failures and silently substitute a different implementation.
      if (nativeDigest) return nativeDigest.call(nativeSubtle, algorithm, bytes);
      return portableDigest(bytes, yieldTask);
    } }
  };
}
