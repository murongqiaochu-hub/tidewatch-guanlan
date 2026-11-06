// Read-only public Figma SDK exporter. No mutation, private API or node creation.
import { TaskBudget, createSerialQueue, checkCancelled, fail, jsonBytes, sha256, FORMATS, safeFileName, targetPixels, id } from './core.mjs';

const NODE_FIELDS = ['absoluteBoundingBox', 'absoluteRenderBounds', 'absoluteTransform', 'relativeTransform', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'clipsContent', 'isMask', 'maskType', 'fills', 'strokes', 'strokeWeight', 'strokeAlign', 'strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight', 'strokeCap', 'strokeJoin', 'dashPattern', 'cornerRadius', 'topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius', 'effects', 'blendMode', 'characters', 'fontName', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'textAlignHorizontal', 'textAlignVertical', 'textAutoResize', 'paragraphSpacing', 'paragraphIndent', 'textStyleId', 'fillStyleId', 'strokeStyleId', 'effectStyleId', 'gridStyleId', 'layoutGrids', 'exportSettings', 'variantProperties', 'componentProperties', 'componentPropertyReferences'];
const RAW_FIELDS = ['layoutMode', 'layoutSizingHorizontal', 'layoutSizingVertical', 'layoutAlign', 'layoutGrow', 'layoutPositioning', 'primaryAxisSizingMode', 'counterAxisSizingMode', 'primaryAxisAlignItems', 'counterAxisAlignItems', 'itemSpacing', 'counterAxisSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'constraints', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'booleanOperation', 'vectorPaths', 'vectorNetwork', 'boundVariables', 'resolvedVariableModes', 'explicitVariableModes', 'overflowDirection', 'reactions', 'isAsset', 'description', 'key', 'remote', 'componentPropertyDefinitions'];
const STYLE_FIELDS = ['id', 'type', 'name', 'key', 'remote', 'description', 'fontName', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'paragraphSpacing', 'paragraphIndent', 'textCase', 'textDecoration', 'paints', 'effects', 'layoutGrids', 'boundVariables'];
const TEXT_SEGMENT_FIELDS = ['fontName', 'fontSize', 'fontWeight', 'textDecoration', 'textCase', 'lineHeight', 'letterSpacing', 'fills', 'textStyleId', 'fillStyleId', 'paragraphIndent', 'paragraphSpacing', 'listOptions', 'indentation'];
const STYLE_REFS = { textStyleId: 'TEXT', fillStyleId: 'FILL', strokeStyleId: 'FILL', effectStyleId: 'EFFECT', gridStyleId: 'GRID' };
const SDK_QUEUES = new WeakMap();
const SDK_EXPORT_WORKER = createSerialQueue({ capacity: 32 });
function sdkQueue(sdk) {
  if (!SDK_QUEUES.has(sdk)) SDK_QUEUES.set(sdk, createSerialQueue({ capacity: 8 }));
  return SDK_QUEUES.get(sdk);
}

function readField(object, key) {
  try {
    if (!(key in object)) return { state: 'missing' };
    const value = object[key];
    return value === undefined ? { state: 'missing' } : { state: 'known', value };
  } catch { return { state: 'unknown', reason: 'sdk-getter' }; }
}
function buildMeter(budget, key) {
  return {
    add(bytes) { budget.add(key, bytes); },
    token(value) { const bytes = jsonBytes(value).byteLength; budget.add(key, bytes); }
  };
}
// Only plain SDK data is copied; methods and node links are never serialized.
function cloneSDK(value, { sdk, meter, signal }) {
  const classify = v => {
    if (v === sdk.mixed) return { state: 'mixed' };
    if (typeof v === 'symbol') return { state: 'unknown', reason: 'symbol' };
    if (v === undefined) return { state: 'missing' };
    if (typeof v === 'number' && !Number.isFinite(v)) return { state: 'unknown', reason: 'nonfinite' };
    if (typeof v === 'function' || typeof v === 'bigint') return { state: 'unknown', reason: 'non-json' };
    return v;
  };
  const first = classify(value);
  if (first === null || typeof first !== 'object') { meter.token(first); return first; }
  const root = Array.isArray(first) ? [] : {};
  const ancestors = new Set();
  const stack = [{ source: first, target: root, depth: 0, enter: true }];
  while (stack.length) {
    checkCancelled(signal);
    const item = stack.pop();
    if (!item.enter) { ancestors.delete(item.source); continue; }
    if (item.depth > 1024) fail('UNSUPPORTED_DEPTH');
    if (ancestors.has(item.source)) fail('BAD_SCHEMA');
    ancestors.add(item.source); meter.add(2);
    stack.push({ ...item, enter: false });
    const keys = Array.isArray(item.source) ? Array.from({ length: item.source.length }, (_, i) => String(i)) : Object.keys(item.source);
    for (const key of keys) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('BAD_SCHEMA');
      if (!Array.isArray(item.source)) { meter.token(key); meter.add(2); } else meter.add(1);
      let raw; try { raw = item.source[key]; } catch { raw = { state: 'unknown', reason: 'sdk-getter' }; }
      const child = classify(raw);
      if (child !== null && typeof child === 'object') {
        const target = Array.isArray(child) ? [] : {};
        item.target[key] = target;
        stack.push({ source: child, target, depth: item.depth + 1, enter: true });
      } else { item.target[key] = child; meter.token(child); }
    }
  }
  return root;
}
function capture(source, target, keys, context, states) {
  for (const key of keys) {
    const field = readField(source, key);
    if (field.state === 'known') {
      context.meter.token(key); context.meter.add(2);
      target[key] = cloneSDK(field.value, context);
    } else if (field.state === 'unknown') { states[key] = { state: 'unknown', reason: field.reason }; context.meter.token(states[key]); }
  }
}
async function styleReference(styleId, field, context) {
  if (typeof styleId !== 'string' || !styleId) return null;
  const category = STYLE_REFS[field];
  if (!category) return null;
  if (context.styles.has(styleId)) return context.styles.get(styleId);
  checkCancelled(context.signal);
  const unresolved = { id: styleId, category, state: 'unknown' };
  context.styles.set(styleId, unresolved);
  if (typeof context.sdk.getStyleByIdAsync !== 'function') { unresolved.reason = 'sdk-capability'; return unresolved; }
  let style;
  try { style = await context.sdk.getStyleByIdAsync(styleId); } catch { unresolved.reason = 'lookup-failed'; }
  checkCancelled(context.signal);
  if (!style) { unresolved.reason ||= 'not-found'; return unresolved; }
  const dto = { raw: { fieldStates: {} } };
  capture(style, dto, STYLE_FIELDS, context, dto.raw.fieldStates);
  const actualType = dto.type === 'PAINT' ? 'FILL' : dto.type;
  if (!['TEXT', 'FILL', 'EFFECT', 'GRID'].includes(actualType) || dto.id !== styleId) { unresolved.reason = 'type-or-id'; return unresolved; }
  context.styleArrays[actualType].push(dto);
  const result = { id: styleId, category: actualType, state: 'resolved' };
  context.styles.set(styleId, result); return result;
}
async function captureStyleReferences(dto, context) {
  const refs = {};
  for (const field of Object.keys(STYLE_REFS)) {
    if (Object.hasOwn(dto, field)) {
      if (dto[field]?.state) refs[field] = { state: dto[field].state };
      else if (dto[field] === '') refs[field] = { state: 'none' };
      else refs[field] = await styleReference(dto[field], field, context) || { state: 'unknown' };
    }
  }
  if (Object.keys(refs).length) dto.styleReferences = refs;
}
async function componentReference(node, dto, context) {
  let source = node;
  if (dto.type === 'INSTANCE') {
    if (typeof node.getMainComponentAsync !== 'function') { dto.componentReference = { state: 'unknown', reason: 'sdk-capability' }; return; }
    try { source = await node.getMainComponentAsync(); } catch { dto.componentReference = { state: 'unknown', reason: 'lookup-failed' }; return; }
    checkCancelled(context.signal);
    if (!source) { dto.componentReference = { state: 'unknown', reason: 'not-found' }; return; }
  }
  const componentId = readField(source, 'id');
  if (componentId.state !== 'known' || typeof componentId.value !== 'string') { dto.componentReference = { state: 'unknown', reason: 'missing-id' }; return; }
  const cid = componentId.value;
  if (!context.components.has(cid)) {
    const component = { raw: { fieldStates: {} } };
    capture(source, component, ['id', 'type', 'name', 'key', 'remote', 'description', 'variantProperties', 'componentPropertyDefinitions'], context, component.raw.fieldStates);
    context.components.set(cid, component);
  }
  dto.componentReference = { state: 'resolved', id: cid };
}

export async function serializeFrame(sdk, frame, { budget = new TaskBudget(), signal, cryptoAPI = globalThis.crypto, digest = sha256 } = {}) {
  if (readField(frame, 'type').value !== 'FRAME') fail('BAD_SCHEMA');
  if (sdk.skipInvisibleInstanceChildren === true) fail('SDK_CAPABILITY_MISSING');
  const frameId = id(readField(frame, 'id').value);
  const key = `building:${frameId}`;
  const context = { sdk, signal, meter: buildMeter(budget, key), styles: new Map(), styleArrays: { TEXT: [], FILL: [], EFFECT: [], GRID: [] }, components: new Map() };
  const root = {};
  const seen = new Set();
  const stack = [{ node: frame, dto: root, depth: 0 }];
  try {
    context.meter.add(128);
    while (stack.length) {
      checkCancelled(signal);
      const { node, dto, depth } = stack.pop();
      if (depth > 1024) fail('UNSUPPORTED_DEPTH');
      const nid = id(readField(node, 'id').value);
      if (seen.has(nid)) fail('BAD_SCHEMA');
      seen.add(nid);
      dto.raw = { fieldStates: {} }; context.meter.add(48);
      capture(node, dto, ['id', 'type', 'name', ...NODE_FIELDS], context, dto.raw.fieldStates);
      if (typeof dto.type !== 'string' || typeof dto.name !== 'string') fail('SDK_READ_FAILED');
      for (const field of ['absoluteBoundingBox', 'absoluteTransform', 'relativeTransform']) {
        if (!Object.hasOwn(dto, field) && !Object.hasOwn(dto.raw.fieldStates, field)) dto.raw.fieldStates[field] = { state: 'missing' };
      }
      capture(node, dto.raw, RAW_FIELDS, context, dto.raw.fieldStates);
      await captureStyleReferences(dto, context);
      if (dto.type === 'TEXT') {
        dto.style = {};
        for (const field of ['fontName', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'letterSpacing', 'textCase', 'textDecoration', 'textAlignHorizontal', 'textAlignVertical']) if (Object.hasOwn(dto, field)) dto.style[field] = dto[field];
        context.meter.token(dto.style);
        if (typeof node.getStyledTextSegments !== 'function') {
          dto.textRunsState = { state: 'unknown', reason: 'sdk-capability' };
        } else {
          let runs;
          try { runs = node.getStyledTextSegments(TEXT_SEGMENT_FIELDS); } catch { dto.textRunsState = { state: 'unknown', reason: 'sdk-getter' }; }
          checkCancelled(signal);
          if (runs) {
            if (!Array.isArray(runs)) fail('SDK_READ_FAILED');
            dto.textRuns = cloneSDK(runs, context);
            let expected = 0;
            for (const run of dto.textRuns) {
              if (!Number.isSafeInteger(run.start) || run.start !== expected || !Number.isSafeInteger(run.end) || run.end < run.start || typeof run.characters !== 'string' || run.characters !== dto.characters?.slice(run.start, run.end)) fail('SDK_READ_FAILED');
              expected = run.end;
              await captureStyleReferences(run, context);
            }
            if (expected !== dto.characters?.length) fail('SDK_READ_FAILED');
          }
        }
      }
      if (['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(dto.type)) await componentReference(node, dto, context);
      const childField = readField(node, 'children');
      if (childField.state === 'unknown') fail('SDK_READ_FAILED');
      if (childField.state === 'known') {
        if (!Array.isArray(childField.value)) fail('SDK_READ_FAILED');
        context.meter.add(14 + childField.value.length * 2); dto.children = childField.value.map(() => ({}));
        for (let i = childField.value.length - 1; i >= 0; i--) stack.push({ node: childField.value[i], dto: dto.children[i], depth: depth + 1 });
      }
    }
    const layerDoc = { contractVersion: 1, frame: root, styles: context.styleArrays, components: [...context.components.values()] };
    const bytes = jsonBytes(layerDoc);
    budget.set(key, bytes.byteLength);
    const hash = await digest(bytes, cryptoAPI, signal);
    budget.release(key); budget.set(`layerDoc:${frameId}`, bytes.byteLength);
    return { layerDoc, bytes, sha256: hash };
  } catch (error) { budget.release(key); throw error; }
}

function dimension(node, key) {
  const field = readField(node, key);
  if (field.state !== 'known' || typeof field.value !== 'number' || !Number.isFinite(field.value) || field.value < 0) fail('BAD_DIMENSIONS');
  return field.value;
}
function rasterGeometry(node, settings) {
  // Absolute-bounds exports rasterize the axis-aligned box, not the node's local size.
  // Explicit content-only crop has an unknowable exact target; validate its actual header and cap below.
  if (settings.useAbsoluteBounds !== true) return { width: dimension(node, 'width'), height: dimension(node, 'height') };
  const field = readField(node, 'absoluteBoundingBox');
  const box = field.value;
  if (field.state !== 'known' || !box || typeof box !== 'object' || Array.isArray(box)) fail('BAD_DIMENSIONS');
  const geometry = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const coordinate = readField(box, key);
    if (coordinate.state !== 'known' || typeof coordinate.value !== 'number' || !Number.isFinite(coordinate.value) ||
        (['width', 'height'].includes(key) && coordinate.value < 0)) fail('BAD_DIMENSIONS');
    geometry[key] = coordinate.value;
  }
  return { width: geometry.width, height: geometry.height };
}
export function validateExportSettings(settings) {
  if (!settings || !FORMATS[settings.format]) fail('BAD_FORMAT');
  const allowed = ['format', 'contentsOnly', 'useAbsoluteBounds', 'suffix', 'colorProfile'];
  if (['PNG', 'JPG'].includes(settings.format)) allowed.push('constraint');
  if (settings.format === 'SVG') allowed.push('svgOutlineText', 'svgIdAttribute', 'svgSimplifyStroke');
  if (Object.keys(settings).some(k => !allowed.includes(k))) fail('BAD_SCHEMA');
  if (settings.constraint && (!['SCALE', 'WIDTH', 'HEIGHT'].includes(settings.constraint.type) || Object.keys(settings.constraint).some(k => !['type', 'value'].includes(k)) || !Number.isFinite(settings.constraint.value) || settings.constraint.value <= 0)) fail('BAD_SCHEMA');
  for (const key of ['contentsOnly', 'useAbsoluteBounds', 'svgOutlineText', 'svgIdAttribute', 'svgSimplifyStroke']) if (key in settings && typeof settings[key] !== 'boolean') fail('BAD_SCHEMA');
  if (settings.suffix !== undefined && (typeof settings.suffix !== 'string' || settings.suffix.length > 128)) fail('BAD_SCHEMA');
  if (settings.colorProfile !== undefined && !['DOCUMENT', 'SRGB', 'DISPLAY_P3_V4'].includes(settings.colorProfile)) fail('BAD_SCHEMA');
  return settings;
}
export function rasterDimensions(bytes, format) {
  if (!(bytes instanceof Uint8Array)) fail('BAD_BYTES');
  if (format === 'PNG') {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 33 || signature.some((n, i) => bytes[i] !== n) || String.fromCharCode(...bytes.subarray(12, 16)) !== 'IHDR') fail('BAD_BYTES');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(8) !== 13) fail('BAD_BYTES');
    const width = view.getUint32(16); const height = view.getUint32(20);
    if (!width || !height) fail('BAD_BYTES');
    return { width, height };
  }
  if (format === 'JPG') {
    if (bytes[0] !== 255 || bytes[1] !== 216) fail('BAD_BYTES');
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) fail('BAD_BYTES');
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) fail('BAD_BYTES');
      const length = bytes[offset] * 256 + bytes[offset + 1];
      if (length < 2 || offset + length > bytes.length) fail('BAD_BYTES');
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        if (length < 8) fail('BAD_BYTES');
        const height = bytes[offset + 3] * 256 + bytes[offset + 4]; const width = bytes[offset + 5] * 256 + bytes[offset + 6];
        if (!width || !height) fail('BAD_BYTES'); return { width, height };
      }
      offset += length;
    }
  }
  fail('BAD_BYTES');
}
export function exportAsset(node, settings, options = {}) {
  return SDK_EXPORT_WORKER.run(() => exportAssetPhysical(node, settings, options), { signal: options.signal });
}
async function exportAssetPhysical(node, settings, { budget = new TaskBudget(), signal, cryptoAPI = globalThis.crypto, digest = sha256, assetKey = 'export', role = 'slice' } = {}) {
  checkCancelled(signal); validateExportSettings(settings);
  const nodeId = id(readField(node, 'id').value);
  if (typeof node.exportAsync !== 'function') fail('SDK_CAPABILITY_MISSING');
  const raster = ['PNG', 'JPG'].includes(settings.format);
  let scale = null; let target = null;
  if (raster) {
    const { width, height } = rasterGeometry(node, settings);
    const constraint = settings.constraint || { type: 'SCALE', value: 1 };
    scale = constraint.type === 'SCALE' ? constraint.value : constraint.value / (constraint.type === 'WIDTH' ? width : height);
    const bounds = targetPixels(width, height, scale);
    // contentsOnly may crop transparent pixels: there is no trustworthy exact predicted rectangle.
    // Enforce the pixel cap against the returned raster rather than an uncropped rectangle.
    target = settings.contentsOnly === true ? null : bounds;
    if (target && target.width * target.height > 64 * 1024 * 1024) fail('BAD_DIMENSIONS');
  }
  // Never race away from this promise: cancellation retains the physical SDK slot.
  let bytes;
  try { bytes = await node.exportAsync(settings); } catch { checkCancelled(signal); fail('SDK_EXPORT_FAILED'); }
  checkCancelled(signal);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) fail('BAD_BYTES');
  budget.set(assetKey, bytes.byteLength);
  if (raster) {
    const actual = rasterDimensions(bytes, settings.format);
    if (!Number.isSafeInteger(actual.width * actual.height) || actual.width * actual.height > 64 * 1024 * 1024) fail('BAD_DIMENSIONS');
    if (target && (actual.width !== target.width || actual.height !== target.height)) fail('SDK_DIMENSION_MISMATCH');
    if (!target) target = actual;
  } else if (settings.format === 'PDF') {
    if (String.fromCharCode(...bytes.subarray(0, 5)) !== '%PDF-') fail('BAD_BYTES');
  } else if (settings.format === 'SVG') {
    const head = String.fromCharCode(...bytes.subarray(0, 4096));
    if (!/<svg(?:\s|>)/.test(head)) fail('BAD_BYTES');
  }
  const hash = await digest(bytes, cryptoAPI, signal);
  const format = FORMATS[settings.format];
  return {
    descriptor: { nodeId, role, format: settings.format, mime: format.mime, byteLength: bytes.byteLength, sha256: hash, fileName: safeFileName(`${readField(node, 'name').value || 'node'}${settings.suffix || ''}`, nodeId, format.extension), scale, target, settings: { ...settings } },
    bytes
  };
}
// Sections are containers, not boards. Share one traversal for discovery and
// admission, stopping at Frames/Groups and retaining SDK page-space geometry.
function collectSectionFrames(source, reason) {
  if (!Array.isArray(source)) fail('SDK_READ_FAILED');
  const frames = []; const excluded = []; const frameIds = new Set();
  const sections = new Map(); const ancestors = new Set();
  const walk = (nodes, depth) => {
    if (depth > 1024) fail('UNSUPPORTED_DEPTH');
    let hasFrame = false;
    for (const node of nodes) {
      const type = readField(node, 'type').value;
      if (type === 'FRAME') {
        const fid = id(readField(node, 'id').value);
        if (!frameIds.has(fid)) { frameIds.add(fid); frames.push(node); }
        hasFrame = true; continue;
      }
      if (type === 'SECTION') {
        if (ancestors.has(node)) fail('SDK_READ_FAILED');
        if (sections.has(node)) { hasFrame = sections.get(node) || hasFrame; continue; }
        const children = readField(node, 'children');
        if (children.state !== 'known' || !Array.isArray(children.value)) fail('SDK_READ_FAILED');
        ancestors.add(node);
        const found = walk(children.value, depth + 1);
        ancestors.delete(node); sections.set(node, found);
        if (found) { hasFrame = true; continue; }
        excluded.push({ id: readField(node, 'id').value, type, reason: 'section-without-frame' });
        continue;
      }
      excluded.push({ id: readField(node, 'id').value, type, reason });
    }
    return hasFrame;
  };
  walk(source, 0);
  return { frames, excluded };
}
export function eligibleFrames(sdk, scope = 'selection') {
  if (!['selection', 'page'].includes(scope)) fail('BAD_SCHEMA');
  const page = sdk.currentPage;
  const result = collectSectionFrames(scope === 'selection' ? page.selection : page.children, scope === 'page' ? 'not-top-level-frame' : 'not-selected-frame');
  return { pageId: id(page.id), ...result, scope };
}
// A page-to-frame chain may contain Sections only, never other Frames/Groups.
export function topLevelFrameSet(sdk) {
  return new Set(collectSectionFrames(sdk.currentPage.children, 'not-top-level-frame').frames);
}
export function createExporter(sdk, { queue = sdkQueue(sdk), cryptoAPI = globalThis.crypto, digest = sha256 } = {}) {
  const run = (frames, { signal, scale = 1, includeSlices = true, budget = new TaskBudget(), chunkCapacity = 16, onChunk = async () => {}, onProgress = () => {} } = {}) => queue.run(async () => {
    if (!Array.isArray(frames) || !frames.length) fail('NO_FRAMES');
    if (!Number.isSafeInteger(chunkCapacity) || chunkCapacity < 1 || chunkCapacity > 64) fail('BAD_SCHEMA');
    const seen = new Set(); for (const frame of frames) { const fid = id(frame.id); if (seen.has(fid)) fail('DUPLICATE_FRAME'); seen.add(fid); if (frame.type !== 'FRAME') fail('BAD_SCHEMA'); }
    const results = [];
    let chunk = [];
    for (let index = 0; index < frames.length; index++) {
      checkCancelled(signal);
      const frame = frames[index];
      const serialized = await serializeFrame(sdk, frame, { budget, signal, cryptoAPI, digest });
      const assets = [await exportAsset(frame, { format: 'PNG', constraint: { type: 'SCALE', value: scale }, useAbsoluteBounds: true }, { budget, signal, cryptoAPI, digest, assetKey: `${frame.id}:preview`, role: 'preview' })];
      if (includeSlices) {
        const stack = [frame];
        while (stack.length) {
          checkCancelled(signal);
          const node = stack.pop();
          const settings = readField(node, 'exportSettings');
          if (settings.state === 'unknown') fail('SDK_READ_FAILED');
          if (settings.state === 'known') {
            if (!Array.isArray(settings.value)) fail('SDK_READ_FAILED');
            for (let j = 0; j < settings.value.length; j++) assets.push(await exportAsset(node, settings.value[j], { budget, signal, cryptoAPI, digest, assetKey: `${frame.id}:slice:${node.id}:${j}`, role: 'slice' }));
          }
          const children = readField(node, 'children');
          if (children.state === 'unknown') fail('SDK_READ_FAILED');
          if (children.state === 'known') for (let j = children.value.length - 1; j >= 0; j--) stack.push(children.value[j]);
        }
      }
      const exported = assets.filter(a => a.descriptor.role === 'slice').map(a => a.descriptor);
      const transform = serialized.layerDoc.frame.absoluteTransform ?? null;
      const contentHash = await digest(jsonBytes([serialized.sha256, assets[0].descriptor.sha256, exported, transform]), cryptoAPI, signal);
      const result = { ...serialized, figmaNodeId: frame.id, preview: assets[0].descriptor, exports: exported, assets, contentHash };
      results.push(result); chunk.push(result);
      onProgress({ done: index + 1, total: frames.length, sourceBytes: budget.used });
      if (chunk.length === chunkCapacity || index + 1 === frames.length) { await onChunk(chunk, { signal, round: Math.floor(index / chunkCapacity), total: frames.length }); checkCancelled(signal); chunk = []; }
    }
    return { frames: results, budget: budget.snapshot(), chunkCapacity };
  }, { signal });
  return {
    exportFrames: run,
    exportSelection(options = {}) { const eligible = eligibleFrames(sdk, options.scope || 'selection'); return run(eligible.frames, options).then(result => ({ ...result, eligibility: { scope: eligible.scope, pageId: eligible.pageId, excluded: eligible.excluded, count: eligible.frames.length } })); },
    queue
  };
}
