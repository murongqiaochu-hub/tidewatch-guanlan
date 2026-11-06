import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { makeProceduralPng } from './synthetic-fixtures.mjs';
function httpProblem(status, message) { const error = new Error(message); error.httpStatus = status; return error; }

const ownDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
export const codecDependency = Object.freeze({ binary: '/usr/bin/vips', verifiedVersion: '8.14.1', scope: 'synthetic preview PNG-to-JPEG only', bundled: false, commercialLicenseCleared: false });
export const codecDiagnostics = { activeChildren: 0, childrenPeak: 0, temporaryDirectoriesActive: 0, temporaryDirectoriesCreated: 0, temporaryDirectoriesRemoved: 0 };
export function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw httpProblem(500, 'Synthetic codec did not return a complete JPEG');
  let offset = 2;
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 255) throw httpProblem(500, 'JPEG marker');
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (length < 8 || bytes[offset + 2] !== 8) throw httpProblem(500, 'JPEG SOF precision');
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  throw httpProblem(500, 'JPEG actual dimensions missing');
}
async function privateWrite(file, bytes) {
  const fd = await fs.open(file, 'wx', 0o600);
  try { await fd.chmod(0o600); await fd.writeFile(bytes); await fd.chmod(0o600); } finally { await fd.close(); }
}
async function physicalConvert(input, output, home) {
  await new Promise((resolve, reject) => {
    // No shell, arbitrary input URL/flags, PATH lookup, inherited credentials,
    // child detach or copied vendor library. The child lives inside the lane.
    const child = spawn('/usr/bin/vips', ['jpegsave', input, output, '--Q', '82', '--strip', '--background', '255 255 255'], {
      stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: '/usr/bin:/bin', HOME: home, LANG: 'C', VIPS_CONCURRENCY: '1', VIPS_DISC_THRESHOLD: '64m' }
    });
    let error, timedOut = false, stderrBytes = 0, killTimer, physicallySpawned = false;
    child.once('spawn', () => { physicallySpawned = true; codecDiagnostics.activeChildren++; codecDiagnostics.childrenPeak = Math.max(codecDiagnostics.childrenPeak, codecDiagnostics.activeChildren); });
    child.stderr.on('data', bytes => { stderrBytes += bytes.length; if (stderrBytes > 16 * 1024) child.kill('SIGTERM'); });
    child.once('error', value => { error = value; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); killTimer = setTimeout(() => child.kill('SIGKILL'), 1000); }, 10_000);
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (physicallySpawned) codecDiagnostics.activeChildren--;
      if (error || code !== 0 || timedOut) reject(httpProblem(error?.code === 'ENOENT' ? 503 : timedOut ? 504 : 500, error?.code === 'ENOENT' ? 'Synthetic JPEG codec unavailable (NOT_BUNDLED)' : 'Synthetic JPEG codec physically failed'));
      else resolve();
    });
  });
}
export async function generateSyntheticRaster(width, height, options = {}) {
  const png = await makeProceduralPng(width, height, options);
  if (options.outputMime !== 'image/jpeg') return png;
  if (width > 2048 || height > 2048 || width * height > 4 * 1024 * 1024) throw httpProblem(400, 'Synthetic codec preview pixel budget');
  const canonicalOwn = await fs.realpath(ownDirectory), tempRoot = path.join(canonicalOwn, '.合成编解码');
  await fs.mkdir(tempRoot, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  if ((await fs.lstat(tempRoot)).isSymbolicLink() || await fs.realpath(tempRoot) !== tempRoot) throw httpProblem(500, 'Synthetic codec path rejected');
  await fs.chmod(tempRoot, 0o700);
  const temporary = await fs.mkdtemp(path.join(tempRoot, '图像-')); await fs.chmod(temporary, 0o700);
  codecDiagnostics.temporaryDirectoriesActive++; codecDiagnostics.temporaryDirectoriesCreated++;
  const input = path.join(temporary, 'own.png'), output = path.join(temporary, 'preview.jpg');
  try {
    await privateWrite(input, png); await privateWrite(output, Buffer.alloc(0));
    await physicalConvert(input, output, temporary);
    if ((await fs.lstat(output)).isSymbolicLink() || await fs.realpath(output) !== output) throw httpProblem(500, 'Synthetic codec output path rejected');
    const fd = await fs.open(output, 'r'); let jpeg;
    try {
      await fd.chmod(0o600); const stat = await fd.stat();
      if (stat.size < 4 || stat.size > 4 * 1024 * 1024) throw httpProblem(507, 'Synthetic JPEG encoded output budget');
      options.onEncodedBytes?.(png.length + stat.size); // Reserve before reading.
      jpeg = await fd.readFile();
    } finally { await fd.close(); }
    const actual = jpegDimensions(jpeg);
    if (actual.width !== width || actual.height !== height) throw httpProblem(500, 'Synthetic codec dimension mismatch');
    options.onEncodedBytes?.(png.length + jpeg.length);
    return jpeg;
  } finally {
    // Delete only the exact nonce directory created by this call, after child
    // close. Never free the generation lane before conversion/cleanup settles.
    if (await fs.realpath(temporary) !== temporary || path.dirname(temporary) !== tempRoot || !path.basename(temporary).startsWith('图像-')) throw httpProblem(500, 'Synthetic temp cleanup rejected');
    await fs.rm(temporary, { recursive: true });
    codecDiagnostics.temporaryDirectoriesActive--; codecDiagnostics.temporaryDirectoriesRemoved++;
  }
}
