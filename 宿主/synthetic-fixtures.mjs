import { createDeflate } from 'node:zlib';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';

// New procedural fixtures; no external design, screenshot or upstream data.
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function checksum(bytes) {
  let n = 0xffffffff;
  for (const byte of bytes) {
    n ^= byte;
    for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ ((n & 1) ? 0xedb88320 : 0);
  }
  return (n ^ 0xffffffff) >>> 0;
}
function pngPiece(kind, payload) {
  const tag = Buffer.from(kind, 'ascii');
  const result = Buffer.alloc(payload.length + 12);
  result.writeUInt32BE(payload.length, 0); tag.copy(result, 4); payload.copy(result, 8);
  result.writeUInt32BE(checksum(Buffer.concat([tag, payload])), result.length - 4);
  return result;
}
export function samplePixel(x, y, width, height, seed = 0) {
  let rgba = [22 + (seed * 7) % 24, 32 + (seed * 11) % 24, 49 + (seed * 13) % 24, 255];
  const u = x / width, v = y / height;
  if (u > .035 && u < .965 && v > .08 && v < .92) rgba = [226, 234, 244, 255];
  if (u > .08 && u < .43 && v > .17 && v < .62) rgba = [39 + seed % 9, 118, 153, 255];
  if (u > .49 && u < .9 && v > .17 && v < .32) rgba = [236, 168, 74, 255];
  if (u > .49 && u < .9 && v > .39 && v < .62) rgba = [82, 151, 110, 255];
  if (u > .08 && u < .9 && v > .71 && v < .84) rgba = [85, 102, 140, 255];
  if (x < 32 && y < 32) rgba = [140, 70, 180, 128];
  return rgba;
}
export async function makeProceduralPng(width, height, { sourceWidth = width, sourceHeight = height, offsetX = 0, offsetY = 0, seed = 0, scaled = false, onEncodedBytes = () => {} } = {}) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > 64_000_000) throw new RangeError('Fixture image budget');
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const compressed = [];
  // The formula only changes at these horizontal bands. Immutable row reuse
  // preserves every RGBA sample while avoiding a 55MP per-pixel rescan.
  const rowCache = new Map();
  async function* rows() {
    for (let y = 0; y < height; y++) {
      const sy = scaled ? Math.min(sourceHeight - 1, Math.floor(y * sourceHeight / height)) : offsetY + y;
      const v = sy / sourceHeight;
      const key = [v > .08 && v < .92, v > .17 && v < .62, v > .17 && v < .32, v > .39 && v < .62, v > .71 && v < .84, sy < 32].join(':');
      let row = rowCache.get(key);
      if (!row) {
        row = Buffer.allocUnsafe(width * 4 + 1); row[0] = 0;
        for (let x = 0; x < width; x++) {
          const sx = scaled ? Math.min(sourceWidth - 1, Math.floor(x * sourceWidth / width)) : offsetX + x;
          row.set(samplePixel(sx, sy, sourceWidth, sourceHeight, seed), 1 + x * 4);
        }
        rowCache.set(key, row);
      }
      yield row;
    }
  }
  const zipper = createDeflate({ level: 4 });
  const input = Readable.from(rows()); input.on('error', error => zipper.destroy(error)); input.pipe(zipper);
  let encodedBytes = 57; onEncodedBytes(encodedBytes);
  try {
    for await (const bytes of zipper) {
      const piece = pngPiece('IDAT', bytes); encodedBytes += piece.length;
      onEncodedBytes(encodedBytes); compressed.push(piece);
    }
  } finally { input.destroy(); zipper.destroy(); }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngPiece('IHDR', header), ...compressed, pngPiece('IEND', Buffer.alloc(0))]);
}
const colour = (r, g, b) => ({ type: 'SOLID', color: { r, g, b }, opacity: 1, visible: true });
function node(id, type, name, x, y, width, height, extra = {}) {
  return { id, type, name, visible: true, opacity: 1, absoluteBoundingBox: { x, y, width, height }, absoluteTransform: [[1,0,x],[0,1,y]], ...extra };
}
export function makeLayerDoc(frame, revisionId) {
  const b = frame.bounds, x = b.x, y = b.y;
  const nested = node(frame.frameId + ':group', 'FRAME', '嵌套裁切', x + 580, y + 270, 240.5, 165.75, { clipsContent: true, fills: [colour(.2,.4,.7)], children: [
    node(frame.frameId + ':clip-child', 'RECTANGLE', '越界矩形', x + 720, y + 310, 200, 130, { fills: [colour(.9,.4,.3)] })
  ] });
  const text = node(frame.frameId + ':text', 'TEXT', '混合文本', x + 90.25, y + 590.5, 330.5, 72.25, {
    characters: '独立 Inspector / 数值可核对', style: { fontFamily: 'system-ui', fontSize: 22, fontWeight: 400, lineHeightPx: 32, letterSpacing: 0 },
    runs: [{ start: 0, end: 2, style: { fontSize: 22, fontWeight: 700, fills: [colour(.1,.2,.3)] } }, { start: 2, end: 28, style: { fontSize: 18, fontWeight: 400, letterSpacing: .25 } }],
    mixed: { fontSize: true, fontWeight: true }
  });
  const rotated = node(frame.frameId + ':rotate', 'RECTANGLE', '旋转与翻转', x + 440, y + 460, 135, 90, {
    absoluteTransform: [[-.866025403784,.5,x + 530],[.5,.866025403784,y + 460]], fills: [colour(.7,.2,.6)], strokeWeight: 1.5, cornerRadius: 8
  });
  const children = [
    node(frame.frameId + ':card-a', 'RECTANGLE', '重复名称', x + 96.125, y + 136.75, 420.5, 360.25, { fills: [colour(.12,.46,.6)], cornerRadius: 12, effects: [{ type: 'DROP_SHADOW', visible: true, radius: 8, offset: { x: 0, y: 4 }, color: { r: 0, g: 0, b: 0, a: .2 } }] }),
    node(frame.frameId + ':card-b', 'RECTANGLE', '重复名称', x + 588, y + 136, 492, 120, { fills: [colour(.92,.65,.29)], strokeTopWeight: 1, strokeRightWeight: 2, strokeBottomWeight: 3, strokeLeftWeight: 4 }),
    nested, text, rotated,
    node(frame.frameId + ':hidden', 'RECTANGLE', '隐藏层', x + 10, y + 10, 60, 60, { visible: false }),
    node(frame.frameId + ':mask', 'ELLIPSE', '遮罩边界示例', x + 910, y + 480, 100, 100, { isMask: true }),
    node(frame.frameId + ':boolean', 'BOOLEAN_OPERATION', '布尔形状近似', x + 920, y + 485, 100, 100, { booleanOperation: 'SUBTRACT', children: [] })
  ];
  if (revisionId.endsWith('old')) children[0].name = '历史内容：不能混用当前';
  return { contractVersion: 1, frame: node(frame.figmaNodeId, 'FRAME', frame.name, x, y, b.width, b.height, { children }), styles: { TEXT: [], FILL: [], EFFECT: [], GRID: [] }, components: [{ id: 'self-component', name: '自造组件', description: '仅合成兼容样例' }], fixtureScope: 'procedural illustration; not SDK output / precise text raster' };
}
export function createFixtureCatalog(count = 1100) {
  const frames = Array.from({ length: count }, (_, i) => {
    const giant = i === 2;
    const bounds = giant ? { x: 2700.125, y: -600.875, width: 24531.875, height: 2282.125 } : { x: (i % 20) * 1400 - 150.125, y: Math.floor(i / 20) * 1000 - 84.875, width: 1200.5, height: 800.25 };
    return { id: 'frame-' + i, frameId: 'frame-' + i, projectId: 'project-owned', designFileId: 'design-' + i % 2, pageId: 'page-' + i % 3, figmaNodeId: i + ':101', revisionId: 'revision-' + i + '-current', name: i < 2 ? '同名画板' : giant ? '24k 自造原生源' : '合成画板 ' + (i + 1), bounds, x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, seed: i % 13, previewAsset: { assetId: 'frame-' + i + '.revision-' + i + '-current', role: 'preview', width: Math.max(1, Math.round(bounds.width)), height: Math.max(1, Math.round(bounds.height)), mime: 'image/png', byteLength: 0, byteLengthStatus: 'unknown-until-authorized-HEAD' } };
  });
  return { frames, assetSize(frame) { return { width: Math.max(1, Math.round(frame.width)), height: Math.max(1, Math.round(frame.height)) }; }, revisions(frameId) {
    const frame = frames.find(f => f.frameId === frameId); if (!frame) return [];
    return [{ id: frame.revisionId, revisionId: frame.revisionId, frameId, publishedAt: '2026-10-15T00:00:00Z', name: '当前合成修订' }, { id: 'revision-' + frameId.slice(6) + '-old', revisionId: 'revision-' + frameId.slice(6) + '-old', frameId, publishedAt: '2026-10-14T00:00:00Z', name: '历史合成修订' }];
  }, document(frameId, revisionId) {
    const frame = frames.find(f => f.frameId === frameId); if (!frame) throw new RangeError('Unknown fixture frame');
    if (!this.revisions(frameId).some(r => r.revisionId === revisionId)) throw new RangeError('Revision does not belong to fixture frame');
    return makeLayerDoc(frame, revisionId);
  } };
}
