// Independently authored from behavior contract v1; no prior implementation input.
export const CONTRACT_SHA = '7aad90bcec1b3f99fa7d5f0794343372b33e5b7f3ef94e8f9061f73af65411d6';
export const LIMITS = Object.freeze({ stage: 160, physical: 2, pixels: 64 * 1024 * 1024, encoded: 80 * 1024 * 1024, native: 96 });
export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o ?? {}, k);
export const finite = value => typeof value === 'number' && Number.isFinite(value);
export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export function numberText(value, places = 4) {
  if (!finite(value)) return '未知';
  const rounded = Number(value.toFixed(places));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}
export function fieldState(value, present = value !== undefined) {
  if (!present || value === undefined || value === null) return { state: 'missing' };
  if (value && typeof value === 'object' && ['mixed', 'unknown', 'missing'].includes(value.state)) return { state: value.state, ...(typeof value.reason === 'string' ? { reason: value.reason } : {}) };
  if (value === 'mixed' || value === 'MIXED' || value?.mixed === true || value?.mixed === 'MIXED' || typeof value === 'symbol') return { state: 'mixed' };
  if (value && typeof value === 'object' && value.state === 'known' && has(value, 'value')) return fieldState(value.value);
  if (typeof value === 'number' && !finite(value)) return { state: 'unknown', reason: 'nonfinite' };
  return { state: 'known', value };
}
export function readField(object, key) {
  try {
    for (const states of [object?.fieldStates, object?.raw?.fieldStates]) {
      if (has(states, key)) { const declared = fieldState(states[key]); if (declared.state !== 'known') return declared; }
    }
    return fieldState(object?.[key], has(object, key));
  } catch { return { state: 'unknown', reason: 'getter-failed' }; }
}
// Producer DTO.raw is metadata, whereas a normalized node.raw is the full DTO.
const sourceNode = value => value?.raw && has(value, 'key') && has(value, 'figmaNodeId') && has(value, 'matrix') ? value.raw : value ?? {};
export function affine(value) {
  if (Array.isArray(value) && value.length === 2 && value.every(row => Array.isArray(row) && row.length === 3)) {
    const out = [value[0][0], value[1][0], value[0][1], value[1][1], value[0][2], value[1][2]];
    return out.every(finite) ? out : null;
  }
  return Array.isArray(value) && value.length === 6 && value.every(finite) ? [...value] : null;
}
export function multiply(a, b) {
  return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
}
export function inverse(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!finite(det) || Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}
export function transformPoint(m, point) { return { x: m[0] * point.x + m[2] * point.y + m[4], y: m[1] * point.x + m[3] * point.y + m[5] }; }
export function rect(value) {
  if (!value || !['x', 'y', 'width', 'height'].every(k => finite(value[k])) || value.width < 0 || value.height < 0) return null;
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}
export function corners(bounds, matrix = IDENTITY) {
  const { x, y, width: w, height: h } = bounds;
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }].map(p => transformPoint(matrix, p));
}
export function enclosing(points) {
  if (!points.length || points.some(p => !finite(p.x) || !finite(p.y))) return null;
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
export function contains(bounds, p) { return !!bounds && p.x >= bounds.x && p.x <= bounds.x + bounds.width && p.y >= bounds.y && p.y <= bounds.y + bounds.height; }
export function intersects(a, b) { return !!a && !!b && a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y; }
export function unionBounds(bounds) {
  const good = bounds.filter(Boolean);
  return enclosing(good.flatMap(b => corners(b)));
}
export function polygonContains(points, point) {
  if (!Array.isArray(points) || points.length < 3) return false;
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    const cross = (point.y - a.y) * (b.x - a.x) - (point.x - a.x) * (b.y - a.y);
    if (Math.abs(cross) < 1e-8 && point.x >= Math.min(a.x, b.x) && point.x <= Math.max(a.x, b.x) && point.y >= Math.min(a.y, b.y) && point.y <= Math.max(a.y, b.y)) return true;
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
export function revisionIdentity(input = {}, frame = {}) {
  const identity = {};
  for (const key of ['projectId', 'designFileId', 'pageId', 'frameId', 'revisionId', 'figmaNodeId']) identity[key] = input[key] == null ? null : String(input[key]);
  identity.figmaNodeId ??= frame.id == null ? null : String(frame.id);
  return Object.freeze(identity);
}
export function directoryKey(record) { return JSON.stringify(['frame', record.projectId ?? null, record.designFileId ?? null, record.pageId ?? null, String(record.frameId ?? record.id ?? '')]); }
export function revisionKey(identity) { return JSON.stringify(['revision', ...['projectId', 'designFileId', 'pageId', 'frameId', 'revisionId'].map(k => identity[k] ?? null)]); }
export function normalizeDirectory(input) {
  const list = Array.isArray(input) ? input : input?.frames;
  if (!Array.isArray(list)) throw new TypeError('画板目录必须是数组');
  const seen = new Set();
  return list.map((raw, i) => {
    const id = raw.frameId ?? raw.id;
    if (id == null || String(id) === '') throw new TypeError(`画板 ${i} 缺少稳定平台ID`);
    const record = { ...raw, frameId: String(id), name: typeof raw.name === 'string' ? raw.name : '未命名画板', bounds: rect(raw.bounds ?? raw.absoluteBoundingBox ?? raw), raw };
    record.key = directoryKey(record);
    if (seen.has(record.key)) throw new TypeError(`重复平台画板ID：${record.frameId}`);
    seen.add(record.key);
    return record;
  });
}
export function normalizeRevisions(input) {
  const list = Array.isArray(input) ? input : input?.revisions;
  if (!Array.isArray(list)) throw new TypeError('版本目录必须是数组');
  const seen = new Set();
  return list.map(raw => {
    const id = raw.revisionId ?? raw.id;
    if (id == null || seen.has(String(id))) throw new TypeError('版本ID缺失或重复');
    seen.add(String(id));
    return { ...raw, revisionId: String(id), raw };
  });
}
function nodeGeometry(raw, parentMatrix, notes) {
  const geo = raw.geometry && typeof raw.geometry === 'object' ? { ...raw, ...raw.geometry } : raw;
  const known = key => { const field = readField(geo, key); return field.state === 'known' ? field.value : null; };
  const bbox = rect(known('absoluteBoundingBox'));
  const width = known('width'), height = known('height');
  const absolute = affine(known('absoluteTransform')), relative = affine(known('relativeTransform'));
  let matrix = absolute ?? (relative ? multiply(parentMatrix, relative) : null);
  if (!matrix) {
    if (bbox) matrix = [1, 0, 0, 1, bbox.x, bbox.y];
    else if (finite(known('x')) && finite(known('y'))) {
      const angle = finite(known('rotation')) ? known('rotation') * Math.PI / 180 : 0;
      matrix = multiply(parentMatrix, [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), known('x'), known('y')]);
    } else { matrix = [...parentMatrix]; notes.push('缺少矩阵/坐标，位置未获证实'); }
    if (bbox && finite(known('rotation')) && known('rotation') !== 0) notes.push('只有旋转与轴对齐bounds，轮廓使用包围盒近似');
  }
  // World AABB dimensions are not local dimensions: never transform them twice.
  const local = finite(width) && width >= 0 && finite(height) && height >= 0 ? { x: 0, y: 0, width, height } : null;
  if (!local) notes.push(bbox ? '缺少局部尺寸；保留原世界bounds降级，不再次变换AABB' : '缺少尺寸');
  const polygon = local && Array.isArray(geo.polygon) && geo.polygon.length >= 3 && geo.polygon.every(p => finite(p.x) && finite(p.y)) ? geo.polygon.map(p => ({ x: p.x, y: p.y })) : null;
  const preciseType = ['FRAME', 'GROUP', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'RECTANGLE', 'TEXT', 'ELLIPSE'].includes(raw.type);
  const rounded = (finite(raw.cornerRadius) && raw.cornerRadius > 0) || Array.isArray(raw.rectangleCornerRadii) && raw.rectangleCornerRadii.some(n => finite(n) && n > 0);
  if (!polygon && (!preciseType || rounded)) notes.push('复杂/圆角轮廓仅包围盒命中，不是精确路径');
  const unsupportedMask = raw.isMask === true && raw.maskType !== 'VECTOR';
  if (unsupportedMask) notes.push('遮罩仅几何/bounds近似，不模拟alpha/luminance遮罩');
  return { matrix, inverse: inverse(matrix), local, polygon, bounds: polygon ? enclosing(polygon.map(p => transformPoint(matrix, p))) : local ? enclosing(corners(local, matrix)) : bbox, geometrySource: local ? 'local' : bbox ? 'absolute-bounds' : 'missing', precision: local && !unsupportedMask && (polygon || preciseType && !rounded && !notes.length) ? 'geometry' : 'bounds' };
}
export function normalizeLayerDoc(input, suppliedIdentity = {}) {
  if (!input || input.contractVersion !== 1 || input.frame?.type !== 'FRAME' || !Array.isArray(input.frame.children)) throw new TypeError('需要LayerDoc contractVersion:1与FRAME.children数组');
  const identity = revisionIdentity(suppliedIdentity, input.frame);
  const warnings = Object.entries(identity).filter(([, value]) => value === null).map(([key]) => `身份字段缺失：${key}`);
  const prefix = JSON.stringify(['node', identity.projectId, identity.designFileId, identity.pageId, identity.frameId]);
  const idCounts = new Map();
  const all = [], byKey = new Map();
  function visit(raw, parent, path, inheritedClips = [], inheritedMasks = []) {
    const notes = [];
    const figmaNodeId = raw.id == null ? null : String(raw.id);
    const idPart = figmaNodeId ?? `path:${path.join('.')}`;
    const count = idCounts.get(idPart) ?? 0;
    idCounts.set(idPart, count + 1);
    if (!figmaNodeId) notes.push('缺少平台节点ID；路径键不保证跨版本稳定');
    if (count) notes.push('节点ID重复；使用路径消歧');
    const key = `${prefix}:${JSON.stringify(idPart)}${count ? `:${path.join('.')}` : ''}`;
    const geometry = nodeGeometry(raw, parent?.matrix ?? IDENTITY, notes);
    const visibilityState = readField(raw, 'visible'), maskState = readField(raw, 'isMask'), clipState = readField(raw, 'clipsContent');
    if (visibilityState.state === 'unknown' || visibilityState.state === 'mixed') notes.push(`visible状态${visibilityState.state}；未把占位false当已知隐藏`);
    const node = { key, figmaNodeId, name: typeof raw.name === 'string' ? raw.name : '未命名图层', type: raw.type ?? 'UNKNOWN', raw, parent, depth: path.length, children: [], visible: !(visibilityState.state === 'known' && visibilityState.value === false) && (parent?.visible ?? true), visibilityState, opacity: readField(raw, 'opacity'), clips: [...inheritedClips], masks: [...inheritedMasks], isMask: maskState.state === 'known' && maskState.value === true, notes, ...geometry };
    all.push(node); byKey.set(key, node);
    const clips = clipState.state === 'known' && clipState.value === true ? [...inheritedClips, node] : inheritedClips;
    let masks = inheritedMasks;
    for (const [i, child] of (Array.isArray(raw.children) ? raw.children : []).entries()) {
      const next = visit(child, node, [...path, i], clips, masks);
      node.children.push(next);
      if (next.isMask) masks = [...inheritedMasks, next];
    }
    return node;
  }
  const frame = visit(input.frame, null, []);
  const styles = {};
  for (const kind of ['TEXT', 'FILL', 'EFFECT', 'GRID']) {
    const field = readField(input.styles, kind), value = field.value;
    styles[kind] = { ...field, state: field.state === 'known' && !Array.isArray(value) ? 'unknown' : field.state, items: field.state === 'known' && Array.isArray(value) ? value : [] };
  }
  const componentField = readField(input, 'components');
  return { contractVersion: 1, identity, key: revisionKey(identity), frame, all, byKey, styles, components: componentField.state === 'known' && Array.isArray(componentField.value) ? componentField.value : [], componentsState: componentField.state === 'known' && !Array.isArray(componentField.value) ? 'unknown' : componentField.state, warnings, raw: input };
}
const referenceCategories = Object.freeze({ textStyleId: 'TEXT', fillStyleId: 'FILL', strokeStyleId: 'FILL', effectStyleId: 'EFFECT', gridStyleId: 'GRID' });
function referenceLocality(value) {
  const remote = readField(value, 'remote');
  return remote.state === 'known' && remote.value === true ? 'remote' : remote.state === 'known' && remote.value === false ? 'local' : 'unknown';
}
function referenceField(object, key) {
  const field = readField(object, key);
  if (field.state === 'known') return field.value;
  try {
    const value = object?.[key];
    return value && typeof value === 'object' ? { ...value, ...field } : field;
  } catch { return field; }
}
function resolveReference(reference, fallback, items) {
  const raw = reference ?? fallback;
  const field = fieldState(raw);
  const id = typeof raw === 'string' ? raw : typeof raw?.id === 'string' ? raw.id : typeof raw?.componentId === 'string' ? raw.componentId : null;
  const result = { state: field.state, locality: 'unknown', ...(id ? { id } : {}), raw };
  if (raw?.state === 'none' || raw === '') return { ...result, state: 'none' };
  if (field.state !== 'known') return { ...result, ...(field.reason ? { reason: field.reason } : {}) };
  if (!id) return { ...result, state: 'unknown', reason: 'missing-reference-id' };
  const matches = items.filter(item => readField(item, 'id').value === id);
  if (matches.length !== 1) return { ...result, state: 'unknown', reason: matches.length ? 'duplicate-reference-id' : 'not-found' };
  const value = matches[0];
  return { ...result, state: 'resolved', value, locality: referenceLocality(value) };
}
function componentReferenceCandidate(raw) {
  for (const field of ['componentReference', 'mainComponent', 'componentId', 'componentKey']) {
    if (readField(raw, field).state !== 'missing') return { field, reference: referenceField(raw, field), lookup: field === 'componentKey' ? 'key' : 'id' };
  }
  const self = readField(raw, 'id');
  if (['COMPONENT', 'COMPONENT_SET'].includes(raw.type) && self.state === 'known' && typeof self.value === 'string') return { field: 'self', reference: { id: self.value }, lookup: 'id' };
  return { field: null, reference: { state: 'missing' }, lookup: 'id' };
}
function resolveComponentCandidate(candidate, components) {
  const { reference, lookup } = candidate;
  if (lookup !== 'key' || fieldState(reference).state !== 'known' || reference === '') return resolveReference(reference, undefined, components);
  const key = typeof reference === 'string' ? reference : typeof reference?.key === 'string' ? reference.key : null;
  const result = { state: 'unknown', locality: 'unknown', raw: reference, ...(key ? { key } : {}) };
  if (!key) return { ...result, reason: 'missing-component-key' };
  const matches = components.filter(item => readField(item, 'key').value === key);
  if (matches.length !== 1) return { ...result, reason: matches.length ? 'duplicate-component-key' : 'not-found' };
  const id = readField(matches[0], 'id');
  if (id.state !== 'known' || typeof id.value !== 'string' || !id.value) return { ...result, reason: 'component-key-missing-id' };
  // A key may identify an entry, but only its real stable ID may identify the result.
  return { ...resolveReference({ id: id.value }, undefined, components), key, raw: reference };
}
export function componentContext(node) {
  const context = [], seen = new Set();
  for (let current = node; current && !seen.has(current); current = current.parent) {
    seen.add(current);
    const raw = sourceNode(current);
    if (!['INSTANCE', 'COMPONENT', 'COMPONENT_SET'].includes(current.type ?? raw.type)) continue;
    const candidate = componentReferenceCandidate(raw), reference = candidate.reference, state = fieldState(reference);
    const id = candidate.lookup === 'id' ? typeof reference === 'string' ? reference : typeof reference?.id === 'string' ? reference.id : null : null;
    const componentKey = candidate.lookup === 'key' && typeof reference === 'string' ? reference : null;
    context.push({ key: current.key ?? null, figmaNodeId: current.figmaNodeId ?? (typeof raw.id === 'string' ? raw.id : null), type: raw.type, componentId: id, ...(componentKey ? { componentKey } : {}), referenceState: state.state !== 'known' ? state.state : reference?.state ?? (id || componentKey ? candidate.field === 'self' ? 'self' : 'referenced' : 'missing'), locality: candidate.field === 'self' ? referenceLocality(raw) : 'unknown' });
  }
  return context.reverse();
}
export function resolveNodeReferences(doc, node) {
  const raw = sourceNode(node), source = doc?.all && doc?.raw ? doc.raw : doc ?? {};
  const refs = readField(raw, 'styleReferences');
  const styles = Object.entries(referenceCategories).map(([field, category]) => {
    const supplied = refs.state === 'known' ? readField(refs.value, field) : refs;
    const tableField = readField(source.styles, category), table = tableField.value;
    const items = tableField.state === 'known' ? Array.isArray(table) ? table : Array.isArray(table?.items) ? table.items : [] : [];
    const reference = refs.state === 'known' && supplied.state !== 'missing' ? referenceField(refs.value, field) : supplied.state !== 'missing' ? supplied : undefined;
    const result = resolveReference(reference, referenceField(raw, field), items);
    if (reference?.category && reference.category !== category) { delete result.value; return { field, category, ...result, state: 'unknown', locality: 'unknown', reason: 'category-mismatch' }; }
    if (result.reason === 'not-found' && tableField.state !== 'known') result.reason = `style-table-${tableField.state}`;
    return { field, category, ...result };
  });
  let componentTable = readField(source, 'components');
  // Only a missing raw directory may fall back to a valid normalized directory.
  // Explicit unknown/mixed raw state remains authoritative over placeholder arrays.
  if (componentTable.state === 'missing' && doc !== source && !['unknown', 'mixed'].includes(doc?.componentsState)) componentTable = readField(doc, 'components');
  const components = componentTable.state === 'known' && Array.isArray(componentTable.value) ? componentTable.value : [];
  const component = resolveComponentCandidate(componentReferenceCandidate(raw), components);
  let variants = readField(raw, 'variants');
  if (variants.state === 'known' && Array.isArray(variants.value)) variants = { state: 'known', value: variants.value.map(item => resolveReference(item, undefined, components)) };
  else if (variants.state === 'missing') variants = readField(raw, 'variantProperties');
  let overrides = readField(raw, 'overrides');
  if (overrides.state === 'missing') overrides = readField(raw, 'instanceOverrides');
  if (overrides.state === 'missing') overrides = readField(raw, 'componentProperties');
  const context = componentContext(node).map(entry => {
    if ((!entry.componentId && !entry.componentKey) || ['mixed', 'unknown', 'missing'].includes(entry.referenceState)) return entry;
    const resolved = resolveComponentCandidate({ reference: entry.componentKey ?? { id: entry.componentId }, lookup: entry.componentKey ? 'key' : 'id' }, components);
    return { ...entry, componentId: resolved.id ?? entry.componentId, referenceState: resolved.state, locality: resolved.locality };
  });
  return { styles, component, variants, overrides, context };
}
export function geometryContains(node, worldPoint) {
  if (!node.local) return node.geometrySource === 'absolute-bounds' && contains(node.bounds, worldPoint);
  if (!node.inverse) return false;
  const p = transformPoint(node.inverse, worldPoint);
  if (node.polygon) return polygonContains(node.polygon, p);
  if (node.type === 'ELLIPSE' && node.precision === 'geometry') {
    const { width: w, height: h } = node.local;
    return w > 0 && h > 0 && ((p.x - w / 2) / (w / 2)) ** 2 + ((p.y - h / 2) / (h / 2)) ** 2 <= 1 + 1e-10;
  }
  return contains(node.local, p);
}
export function hitTest(doc, point, { includeMasks = false } = {}) {
  if (!finite(point?.x) || !finite(point?.y)) return null;
  for (let i = doc.all.length - 1; i >= 0; i--) {
    const node = doc.all[i];
    if (!node.visible || node.isMask && !includeMasks || !geometryContains(node, point)) continue;
    const constraints = [...node.clips, ...node.masks];
    if (constraints.some(item => !item.visible || !geometryContains(item, point))) continue;
    const approximate = node.precision === 'bounds' || constraints.some(item => item.precision === 'bounds');
    return { node, precision: approximate ? 'bounds' : 'geometry', notes: [...node.notes, ...constraints.flatMap(c => c.precision === 'bounds' ? [`${c.isMask ? '遮罩' : '裁剪'} ${c.name}：包围盒近似`] : [])] };
  }
  return null;
}
export function measurements(node) {
  if (!node.local) return node.bounds ? { state: 'known', localWidth: null, localHeight: null, localState: 'missing', bounds: node.bounds, corners: corners(node.bounds), precision: 'bounds', mode: 'world-axis-aligned-bounds' } : { state: 'missing' };
  const points = corners(node.local, node.matrix);
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return { state: 'known', localWidth: node.local.width, localHeight: node.local.height, transformedWidth: distance(points[0], points[1]), transformedHeight: distance(points[1], points[2]), bounds: node.bounds, corners: points, precision: node.precision };
}
export function spacing(first, second) {
  const a = first?.bounds ?? first, b = second?.bounds ?? second;
  if (!rect(a) || !rect(b)) return { state: 'missing' };
  const horizontalGap = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
  const verticalGap = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
  return { state: 'known', mode: 'world-axis-aligned-bounds', horizontalGap, verticalGap, overlapX: horizontalGap < 0, overlapY: verticalGap < 0, left: b.x - a.x, top: b.y - a.y, right: b.x + b.width - a.x - a.width, bottom: b.y + b.height - a.y - a.height };
}
function nodeAncestors(node) {
  const result = [], seen = new Set();
  for (let current = node; current && !seen.has(current); current = current.parent) { seen.add(current); result.push(current); }
  return result;
}
export function measureBetween(first, second, { root, ancestor } = {}) {
  const a = rect(first?.bounds ?? first), b = rect(second?.bounds ?? second), base = spacing(first, second);
  if (!a || !b) return { state: 'missing', precision: 'bounds', mode: 'world-axis-aligned-bounds' };
  const chainA = nodeAncestors(first), chainB = new Set(nodeAncestors(second));
  const common = ancestor ?? chainA.find(item => chainB.has(item)) ?? null;
  const sharedRoot = chainA.at(-1) && chainB.has(chainA.at(-1)) ? chainA.at(-1) : null;
  const rootNode = root ?? sharedRoot;
  const reference = value => {
    const r = rect(value?.bounds ?? value);
    if (!r) return { state: 'missing' };
    if (r.width === 0 || r.height === 0) return { state: 'unknown', reason: 'zero-reference-dimension', key: value?.key ?? null, figmaNodeId: value?.figmaNodeId ?? null, bounds: r };
    return { state: 'known', unit: '%', key: value?.key ?? null, figmaNodeId: value?.figmaNodeId ?? null, bounds: r, horizontalGap: base.horizontalGap / r.width * 100, verticalGap: base.verticalGap / r.height * 100, left: base.left / r.width * 100, right: base.right / r.width * 100, top: base.top / r.height * 100, bottom: base.bottom / r.height * 100 };
  };
  const encloses = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
  const firstContainsSecond = encloses(a, b), secondContainsFirst = encloses(b, a);
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const relation = firstContainsSecond && secondContainsFirst ? 'equal' : firstContainsSecond ? 'contains' : secondContainsFirst ? 'inside' : base.horizontalGap < 0 && base.verticalGap < 0 ? 'overlap' : intersects(a, b) ? 'touching' : 'separate';
  return { ...base, precision: 'bounds', relation, containment: { firstContainsSecond, secondContainsFirst }, overlap: { width, height, area: width * height }, gapX: Math.max(0, base.horizontalGap), gapY: Math.max(0, base.verticalGap), distance: Math.hypot(Math.max(0, base.horizontalGap), Math.max(0, base.verticalGap)), percentRoot: reference(rootNode), percentAncestor: reference(common), warnings: ['世界AABB测距；非路径最短距离，旋转/复杂轮廓可能存在偏差'] };
}
export function viewport(value = {}) {
  return { x: finite(value.x) ? value.x : 0, y: finite(value.y) ? value.y : 0, scale: clamp(finite(value.scale) && value.scale > 0 ? value.scale : 1, 0.0001, 64), width: finite(value.width) && value.width >= 0 ? value.width : 0, height: finite(value.height) && value.height >= 0 ? value.height : 0 };
}
export function worldToScreen(v, p) { return { x: p.x * v.scale + v.x, y: p.y * v.scale + v.y }; }
export function screenToWorld(v, p) { return { x: (p.x - v.x) / v.scale, y: (p.y - v.y) / v.scale }; }
export function zoomAt(value, point, factor) {
  const v = viewport(value);
  if (!finite(point?.x) || !finite(point?.y) || !finite(factor) || factor <= 0) return v;
  const world = screenToWorld(v, point), scale = clamp(v.scale * factor, 0.0001, 64);
  const x = point.x - world.x * scale, y = point.y - world.y * scale;
  return finite(x) && finite(y) ? { ...v, scale, x, y } : v;
}
export function pan(value, dx, dy) { const v = viewport(value); return finite(dx) && finite(dy) ? viewport({ ...v, x: v.x + dx, y: v.y + dy }) : v; }
export function fit(value, bounds, padding = 40, scale = null) {
  const v = viewport(value);
  if (!rect(bounds)) return v;
  const p = finite(padding) && padding >= 0 ? padding : 40;
  const nextScale = scale == null ? clamp(Math.min(Math.max(1, v.width - p * 2) / Math.max(1e-9, bounds.width), Math.max(1, v.height - p * 2) / Math.max(1e-9, bounds.height)), 0.0001, 64) : viewport({ scale }).scale;
  const x = v.width / 2 - (bounds.x + bounds.width / 2) * nextScale, y = v.height / 2 - (bounds.y + bounds.height / 2) * nextScale;
  return finite(x) && finite(y) ? { ...v, scale: nextScale, x, y } : v;
}
export function resizeViewport(value, width, height) {
  const old = viewport(value), next = viewport({ ...old, width, height });
  const center = screenToWorld(old, { x: old.width / 2, y: old.height / 2 });
  const x = next.width / 2 - center.x * next.scale, y = next.height / 2 - center.y * next.scale;
  return finite(x) && finite(y) ? { ...next, x, y } : next;
}
export function visibleWorld(v) { const a = screenToWorld(v, { x: 0, y: 0 }); return { ...a, width: v.width / v.scale, height: v.height / v.scale }; }
// Paint/image eligibility is untruncated metadata, not a DOM/interaction budget.
export function visibleMetadata(directory, v) { const world = visibleWorld(viewport(v)); return directory.filter(item => intersects(item.bounds, world)); }
export function visibleFrames(directory, v, limit = LIMITS.stage) {
  const world = visibleWorld(viewport(v)), center = { x: world.x + world.width / 2, y: world.y + world.height / 2 };
  return directory.filter(item => intersects(item.bounds, world)).sort((a, b) => Math.hypot(a.bounds.x + a.bounds.width / 2 - center.x, a.bounds.y + a.bounds.height / 2 - center.y) - Math.hypot(b.bounds.x + b.bounds.width / 2 - center.x, b.bounds.y + b.bounds.height / 2 - center.y)).slice(0, Math.max(0, Math.min(LIMITS.stage, limit)));
}
const typographyKeys = ['fontFamily', 'fontPostScriptName', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight', 'lineHeightPx', 'lineHeightPercent', 'lineHeightUnit', 'letterSpacing', 'letterSpacingUnit', 'textAlignHorizontal', 'textAlignVertical', 'textCase', 'textDecoration'];
function typographyStyle(style = {}) {
  const state = fieldState(style);
  if (state.state !== 'known') return Object.fromEntries(typographyKeys.map(key => [key, state]));
  if (!style || typeof style !== 'object') return {};
  const out = { ...style };
  for (const key of [...typographyKeys, 'fontName', 'fills', 'textStyleId', 'fillStyleId']) {
    const field = readField(style, key);
    if (field.state !== 'known' && (has(style, key) || field.state !== 'missing')) out[key] = field;
  }
  // Sidecars have become explicit values above; inheriting their getter-failure flags
  // into an overriding run would incorrectly hide that run's known font size.
  delete out.raw; delete out.fieldStates;
  const font = readField(style, 'fontName');
  if (font.state !== 'known' && font.state !== 'missing') { out.fontFamily = font; out.fontStyle = font; }
  else if (font.value && typeof font.value === 'object') {
    const family = readField(font.value, 'family'), fontStyle = readField(font.value, 'style');
    if (!has(out, 'fontFamily')) out.fontFamily = family.state === 'known' ? family.value : family;
    if (!has(out, 'fontStyle')) out.fontStyle = fontStyle.state === 'known' ? fontStyle.value : fontStyle;
  }
  const height = readField(style, 'lineHeight');
  if (height.state !== 'known' && height.state !== 'missing') {
    for (const key of ['lineHeightPx', 'lineHeightPercent', 'lineHeightUnit']) out[key] = height;
  } else if (height.state === 'known') {
    const unit = typeof height.value === 'object' ? readField(height.value, 'unit') : readField(style, 'lineHeightUnit');
    const amount = typeof height.value === 'object' ? readField(height.value, 'value') : height;
    out.lineHeightPx = undefined; out.lineHeightPercent = undefined;
    out.lineHeightUnit = unit.state === 'known' ? unit.value : unit.state === 'missing' ? { state: 'unknown', reason: 'line-height-unit' } : unit;
    if (unit.value === 'PIXELS') out.lineHeightPx = amount.state === 'known' ? amount.value : amount;
    else if (unit.value === 'PERCENT') out.lineHeightPercent = amount.state === 'known' ? amount.value : amount;
  } else if (!has(out, 'lineHeightUnit')) {
    if (finite(out.lineHeightPx)) out.lineHeightUnit = 'PIXELS';
    else if (finite(out.lineHeightPercent)) out.lineHeightUnit = 'PERCENT';
  }
  const letter = readField(style, 'letterSpacing');
  if (letter.state === 'known' && letter.value && typeof letter.value === 'object') { const unit = readField(letter.value, 'unit'); out.letterSpacingUnit = unit.state === 'known' ? unit.value : unit; }
  return out;
}
function textBase(raw) {
  const fields = {};
  for (const key of [...typographyKeys, 'fontName']) {
    const field = readField(raw, key);
    if (field.state === 'known') fields[key] = field.value;
    else if (field.state !== 'missing') fields[key] = field;
  }
  const style = readField(raw, 'style');
  return { ...typographyStyle(fields), ...typographyStyle(style.state === 'known' ? style.value : style.state === 'missing' ? {} : style) };
}
export function textSegments(nodeOrRaw) {
  const raw = sourceNode(nodeOrRaw), characters = readField(raw, 'characters'), base = textBase(raw), warnings = [];
  const length = characters.state === 'known' && typeof characters.value === 'string' ? characters.value.length : null;
  let selected = { state: 'missing' }, source = null;
  for (const [name, owner, key] of [['runs', raw, 'runs'], ['textRuns', raw, 'textRuns'], ['mixedTextRuns', raw, 'mixedTextRuns'], ['style.runs', raw.style, 'runs'], ['textTable', raw, 'textTable']]) {
    const field = readField(owner, key);
    if (field.state !== 'missing' || has(owner, key)) { selected = field; source = name; break; }
  }
  if (source === null) {
    const status = readField(raw, 'textRunsState');
    if (status.state !== 'missing') selected = status.state === 'known' ? fieldState(status.value) : status;
  }
  const list = selected.state === 'known' && Array.isArray(selected.value) ? selected.value : [];
  if (selected.state === 'known' && !Array.isArray(selected.value)) { selected = { state: 'unknown', reason: 'runs-not-array' }; warnings.push('文本段不是数组'); }
  const gaps = [], overlaps = [], intervals = [];
  let cursor = 0, invalid = false;
  const runs = list.map((run, index) => {
    if (!run || typeof run !== 'object') { invalid = true; warnings.push(`文本段${index}不是DTO`); return { start: null, end: null, characters: null, style: base, raw: run }; }
    const piece = readField(run, 'characters'), string = piece.state === 'known' && typeof piece.value === 'string' ? piece.value : null;
    const start = has(run, 'start') ? run.start : cursor;
    const end = has(run, 'end') ? run.end : string !== null && Number.isSafeInteger(start) ? start + string.length : null;
    const valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= start && (length === null || end <= length);
    if (!valid) { invalid = true; warnings.push(`文本段${index}的UTF-16范围无效`); }
    else {
      intervals.push([start, end]); cursor = end;
      if (length !== null && string !== null && string !== characters.value.slice(start, end)) { invalid = true; warnings.push(`文本段${index}的characters与UTF-16范围不符`); }
    }
    const supplied = readField(run, 'style');
    const style = { ...base, ...typographyStyle(run), ...typographyStyle(supplied.state === 'known' ? supplied.value : supplied.state === 'missing' ? {} : supplied) };
    return { ...run, start, end, characters: string ?? (valid && length !== null ? characters.value.slice(start, end) : null), style, raw: run };
  });
  let covered = 0, edge = 0;
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    if (start > edge) gaps.push({ start: edge, end: start });
    if (start < edge) overlaps.push({ start, end: Math.min(edge, end) });
    covered += Math.max(0, end - Math.max(start, edge)); edge = Math.max(edge, end);
  }
  if (length !== null && edge < length && source !== null) gaps.push({ start: edge, end: length });
  const implicit = source === null && selected.state === 'missing';
  const coverageState = length === null ? 'unknown' : implicit ? 'complete' : selected.state !== 'known' ? 'unknown' : !invalid && !gaps.length && !overlaps.length && covered === length ? 'complete' : 'incomplete';
  if (gaps.length) warnings.push('文本段UTF-16 coverage存在缺口');
  if (overlaps.length) warnings.push('文本段UTF-16 coverage存在重叠');
  return { state: selected.state === 'known' ? 'known' : selected.state, source, characters, runs, coverage: { state: coverageState, unit: 'UTF-16', length, covered: implicit && length !== null ? length : covered, gaps, overlaps }, warnings, ...(selected.reason ? { reason: selected.reason } : {}) };
}
export function typography(nodeOrRaw) {
  const raw = sourceNode(nodeOrRaw), segments = textSegments(raw), base = textBase(raw), properties = {};
  for (const key of typographyKeys) {
    const value = readField(base, key);
    if (!segments.runs.length) { properties[key] = value; continue; }
    const states = segments.runs.map(run => readField(run.style, key));
    const equal = states.every(s => s.state === states[0].state && JSON.stringify(s.value) === JSON.stringify(states[0].value));
    if (value.state === 'mixed' || !equal) properties[key] = { state: 'mixed' };
    else if (value.state === 'unknown') properties[key] = value;
    else if (segments.coverage.state !== 'complete' && states[0].state === 'known') properties[key] = { state: 'unknown', reason: segments.coverage.state === 'incomplete' ? 'incomplete-utf16-coverage' : 'unknown-utf16-coverage' };
    else properties[key] = states[0];
  }
  return { characters: segments.characters, properties, runs: segments.runs, rawStyle: raw.style, coverage: segments.coverage, warnings: segments.warnings, source: segments.source };
}
export function color(value, format = 'hex') {
  const field = fieldState(value);
  if (field.state !== 'known' || !field.value || !['r', 'g', 'b'].every(k => readField(field.value, k).state === 'known' && finite(readField(field.value, k).value))) return null;
  value = field.value;
  const alpha = readField(value, 'a');
  if (alpha.state !== 'missing' && (alpha.state !== 'known' || !finite(alpha.value))) return null;
  const r = clamp(readField(value, 'r').value, 0, 1), g = clamp(readField(value, 'g').value, 0, 1), b = clamp(readField(value, 'b').value, 0, 1), a = alpha.state === 'known' ? clamp(alpha.value, 0, 1) : 1;
  const bytes = [r, g, b, a].map(n => Math.round(n * 255));
  if (format === 'hex' || format === 'hexa') return `#${bytes.slice(0, format === 'hexa' || a !== 1 ? 4 : 3).map(n => n.toString(16).padStart(2, '0')).join('')}`;
  if (format === 'rgb') return `rgb(${bytes[0]} ${bytes[1]} ${bytes[2]}${a === 1 ? '' : ` / ${numberText(a, 6)}`})`;
  if (format === 'rgba') return `rgba(${bytes[0]}, ${bytes[1]}, ${bytes[2]}, ${numberText(a, 6)})`;
  if (format !== 'hsl' && format !== 'hsla') throw new TypeError('颜色格式仅hex/hexa/rgb/rgba/hsl/hsla');
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), delta = hi - lo, light = (hi + lo) / 2;
  let hue = 0;
  if (delta) { hue = hi === r ? ((g - b) / delta) % 6 : hi === g ? (b - r) / delta + 2 : (r - g) / delta + 4; hue = (hue * 60 + 360) % 360; }
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * light - 1));
  if (format === 'hsla') return `hsla(${numberText(hue, 4)}, ${numberText(saturation * 100, 4)}%, ${numberText(light * 100, 4)}%, ${numberText(a, 6)})`;
  return `hsl(${numberText(hue, 4)} ${numberText(saturation * 100, 4)}% ${numberText(light * 100, 4)}%${a === 1 ? '' : ` / ${numberText(a, 6)}`})`;
}
export function paintColor(paint, format = 'hex') {
  if (paint?.type !== 'SOLID' || readField(paint, 'color').state !== 'known') return null;
  const alpha = readField(paint.color, 'a'), opacity = readField(paint, 'opacity');
  if (![alpha, opacity].every(field => field.state === 'missing' || field.state === 'known' && finite(field.value))) return null;
  return color({ ...paint.color, a: (alpha.state === 'known' ? alpha.value : 1) * (opacity.state === 'known' ? opacity.value : 1) }, format);
}
export function displayValue(value, { unit = 'px', density = 1, rounding = 'none', remBase = 16, platform = 'web', precision = 4, emBase, rpxBase } = {}) {
  const target = String(unit).toLowerCase(), system = String(platform).toLowerCase();
  if (!['px', 'em', 'rem', 'pt', 'dp', 'rpx', '%', 'number'].includes(target)) throw new TypeError('未知显示单位');
  if (!['web', 'ios', 'android'].includes(system)) throw new TypeError('platform必须是Web/iOS/Android');
  if (!['round', 'ceil', 'floor', 'none'].includes(rounding) || !Number.isInteger(precision) || precision < 0 || precision > 12) throw new TypeError('无效精度/rounding');
  if (!finite(density) || density <= 0) throw new TypeError('density必须为有限正数');
  const field = fieldState(value), warnings = [], suffix = target === 'number' ? '' : target;
  if (field.state !== 'known') return { ...field, unit: target, text: ({ mixed: '混合', unknown: '未知', missing: '缺失' })[field.state], warnings };
  if (!finite(field.value)) return { state: 'unknown', reason: 'not-numeric', unit: target, text: '未知', warnings };
  let converted = field.value;
  if (target === 'rem' || target === 'em') {
    const base = target === 'em' ? emBase ?? remBase : remBase;
    if (!finite(base) || base <= 0) throw new TypeError('rem/em基准必须为有限正数');
    if (target === 'em' && emBase === undefined) warnings.push('未给emBase，使用显式remBase作为em基准');
    converted /= base;
  } else if (target === 'dp' || target === 'pt' && system !== 'web') converted /= density;
  else if (target === 'pt') converted *= 72 / 96;
  else if (target === 'rpx') {
    if (!finite(rpxBase) || rpxBase <= 0) return { state: 'unknown', reason: 'rpx-base-required', sourceValue: field.value, unit: target, text: '未知', warnings: ['rpx需显式源画布宽度rpxBase，不猜视口'] };
    converted = converted * 750 / rpxBase;
  }
  if (!finite(converted)) return { state: 'unknown', reason: 'conversion-overflow', sourceValue: field.value, unit: target, text: '未知', warnings };
  if (rounding !== 'none') {
    // Decimal exponent shifting avoids 1.005 * 100 = 100.499999... artifacts.
    const shift = (number, places) => { const [mantissa, exponent = '0'] = String(number).split('e'); return Number(`${mantissa}e${Number(exponent) + places}`); };
    const scaled = shift(converted, precision);
    if (finite(scaled)) { const rounded = rounding === 'round' ? Math.sign(scaled) * Math.round(Math.abs(scaled)) : Math[rounding](scaled); converted = shift(rounded, -precision); }
  }
  if (Object.is(converted, -0)) converted = 0;
  return { state: 'known', value: converted, unit: target, text: `${converted}${suffix}`, sourceValue: field.value, warnings };
}
export function cssLength(value, settings = {}) {
  if (!finite(value)) return null;
  const unit = settings.unit ?? 'px';
  if (!['px', 'em', 'rem', 'pt'].includes(unit)) throw new TypeError('CSS长度仅px/em/rem/pt；dp/rpx只用于displayValue');
  return displayValue(value, { ...settings, unit, platform: 'web', precision: settings.precision ?? 6, rounding: settings.rounding ?? 'round' }).text;
}
function gradient(paint, format, warnings, raw = {}) {
  const stops = paint.gradientStops, opacity = readField(paint, 'opacity');
  if (!Array.isArray(stops) || stops.length < 2 || stops.some(s => !finite(s.position) || !color(s.color, format))) { warnings.push('渐变stop缺失'); return null; }
  if (opacity.state !== 'missing' && (opacity.state !== 'known' || !finite(opacity.value))) { warnings.push('渐变opacity未知/混合，未输出伪造CSS'); return null; }
  const handles = paint.gradientHandlePositions;
  if (paint.type === 'GRADIENT_DIAMOND') { warnings.push('GRADIENT_DIAMOND未支持精确CSS；diamond不能伪装radial'); return null; }
  if (!Array.isArray(handles) || handles.length < 2 || handles.some(p => !finite(p?.x) || !finite(p?.y))) { warnings.push(`渐变${paint.type}未支持精确CSS：方向/handles缺失`); return null; }
  const width = readField(raw, 'width'), height = readField(raw, 'height');
  const localSizeKnown = width.state === 'known' && height.state === 'known' && finite(width.value) && width.value > 0 && finite(height.value) && height.value > 0;
  const w = localSizeKnown ? width.value : 1, h = localSizeKnown ? height.value : 1;
  const dx = (handles[1].x - handles[0].x) * w, dy = (handles[1].y - handles[0].y) * h, size = Math.hypot(dx, dy);
  if (paint.type === 'GRADIENT_LINEAR' && dx && dy && !localSizeKnown) { warnings.push('斜向linear渐变缺少已知局部宽高，不能猜1:1比例生成方向'); return null; }
  if (!size) { warnings.push('渐变handles退化，未输出伪造CSS'); return null; }
  let offset = 0, scale = 1;
  if (paint.type === 'GRADIENT_LINEAR') {
    const ux = dx / size, uy = dy / size, extent = Math.abs(w * ux) + Math.abs(h * uy);
    offset = (((handles[0].x - 0.5) * w * ux + (handles[0].y - 0.5) * h * uy) + extent / 2) / extent;
    scale = size / extent;
  }
  const text = stops.map(s => `${color({ ...s.color, a: (finite(s.color.a) ? s.color.a : 1) * (opacity.state === 'known' ? opacity.value : 1) }, format)} ${numberText((offset + s.position * scale) * 100)}%`).join(', ');
  const angle = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;
  if (paint.type === 'GRADIENT_LINEAR') return `linear-gradient(${numberText(angle)}deg, ${text})`;
  const center = `${numberText(handles[0].x * 100)}% ${numberText(handles[0].y * 100)}%`;
  if (paint.type === 'GRADIENT_RADIAL') {
    if (handles.length < 3) { warnings.push('GRADIENT_RADIAL未支持精确CSS：缺第二椭圆轴'); return null; }
    const ux = handles[1].x - handles[0].x, uy = handles[1].y - handles[0].y, vx = handles[2].x - handles[0].x, vy = handles[2].y - handles[0].y;
    const aligned = Math.abs(uy) < 1e-9 && Math.abs(vx) < 1e-9, swapped = Math.abs(ux) < 1e-9 && Math.abs(vy) < 1e-9;
    const rx = aligned ? Math.abs(ux) : swapped ? Math.abs(vx) : 0, ry = aligned ? Math.abs(vy) : swapped ? Math.abs(uy) : 0;
    if (!rx || !ry) { warnings.push('GRADIENT_RADIAL旋转/斜切椭圆未支持精确CSS，已省略'); return null; }
    return `radial-gradient(ellipse ${numberText(rx * 100)}% ${numberText(ry * 100)}% at ${center}, ${text})`;
  }
  if (paint.type === 'GRADIENT_ANGULAR') {
    if (handles.length >= 3) {
      const vx = (handles[2].x - handles[0].x) * w, vy = (handles[2].y - handles[0].y) * h;
      if (Math.abs(dx * vx + dy * vy) > size * Math.hypot(vx, vy) * 1e-6 || Math.abs(size - Math.hypot(vx, vy)) > size * 1e-6 || dx * vy - dy * vx <= 0) { warnings.push('GRADIENT_ANGULAR非正交/非等轴/反向变换未支持精确CSS'); return null; }
    }
    return `conic-gradient(from ${numberText(angle)}deg at ${center}, ${text})`;
  }
  warnings.push(`渐变${paint.type}未支持精确CSS`); return null;
}
export function generateCSS(nodeOrRaw, settings = {}) {
  let raw = sourceNode(nodeOrRaw), scope = { type: 'node' };
  const declarations = [], warnings = [];
  if (has(settings, 'runIndex')) {
    const segments = textSegments(raw), index = settings.runIndex, run = Number.isSafeInteger(index) && index >= 0 ? segments.runs[index] : null;
    if (!run || !Number.isSafeInteger(run.start) || !Number.isSafeInteger(run.end) || run.start < 0 || run.end < run.start) return { declarations, text: '', warnings: ['runIndex无有效UTF-16文本段'], limits: ['runIndex无有效UTF-16文本段'], precision: 'partial', settings: { ...settings }, scope: { type: 'text-run', index } };
    scope = { type: 'text-run', index, start: run.start, end: run.end, unit: 'UTF-16' };
    const style = { ...run.style }; delete style.runs;
    const segmentFills = readField(style, 'fills'), globalFills = readField(raw, 'fills');
    const fills = segmentFills.state === 'missing' ? globalFills : segmentFills;
    raw = { type: 'TEXT', characters: run.characters ?? '', style, fills: fills.state === 'known' ? fills.value : fills };
    if (segments.coverage.state !== 'complete') warnings.push(`整串coverage ${segments.coverage.state}；当前CSS仅对应显式局部文本段，不是全局样式`);
  }
  const unit = settings.unit ?? 'px', remBase = settings.remBase ?? 16, format = settings.colorFormat ?? 'hex';
  // CSS itself never receives display-only dp/rpx units.
  cssLength(1, { ...settings, unit, remBase }); color({ r: 0, g: 0, b: 0 }, format);
  const add = (name, value) => { if (value !== null && value !== undefined) declarations.push([name, String(value)]); };
  const length = n => cssLength(n, { ...settings, unit, remBase });
  for (const [key, property] of [['width', 'width'], ['height', 'height'], ['cornerRadius', 'border-radius']]) { const field = readField(raw, key); if (field.state === 'known' && finite(field.value) && field.value >= 0) add(property, length(field.value)); }
  const radii = readField(raw, 'rectangleCornerRadii');
  if (radii.state === 'known' && Array.isArray(radii.value) && radii.value.length === 4 && radii.value.every(value => finite(value) && value >= 0)) add('border-radius', radii.value.map(length).join(' '));
  const opacity = readField(raw, 'opacity'), visibility = readField(raw, 'visible');
  if (opacity.state === 'known' && finite(opacity.value)) add('opacity', numberText(opacity.value, 6));
  if (visibility.state === 'known' && visibility.value === false) add('visibility', 'hidden');
  const fills = readField(raw, 'fills');
  if (fills.state === 'known' && Array.isArray(fills.value)) {
    const active = fills.value.filter(p => p && p.visible !== false);
    const background = [], solids = [], blends = [];
    const blendModes = { NORMAL: 'normal', MULTIPLY: 'multiply', SCREEN: 'screen', OVERLAY: 'overlay', DARKEN: 'darken', LIGHTEN: 'lighten', COLOR_DODGE: 'color-dodge', COLOR_BURN: 'color-burn', HARD_LIGHT: 'hard-light', SOFT_LIGHT: 'soft-light', DIFFERENCE: 'difference', EXCLUSION: 'exclusion', HUE: 'hue', SATURATION: 'saturation', COLOR: 'color', LUMINOSITY: 'luminosity' };
    for (const paint of active) {
      if (paint.type === 'SOLID') {
        const result = paintColor(paint, format);
        if (result) { solids.push(result); if (settings.multiFill === true) background.push(`linear-gradient(${result}, ${result})`); }
        else warnings.push('填充颜色/opacity缺失或未知');
      } else if (paint.type?.startsWith('GRADIENT_')) { const result = gradient(paint, format, warnings, raw); if (result) background.push(result); }
      else warnings.push(`填充${paint.type ?? '未知'}不输出伪造CSS`);
      const blend = readField(paint, 'blendMode');
      if (blend.state === 'missing') blends.push('normal');
      else if (blend.state === 'known' && blendModes[blend.value]) blends.push(blendModes[blend.value]);
      else { blends.push('normal'); warnings.push(`填充blendMode ${blend.value ?? blend.state}未支持精确CSS`); }
    }
    if (active.length === 1 && solids.length === 1) add(raw.type === 'TEXT' ? 'color' : 'background-color', solids[0]);
    else if (background.length === active.length && background.length) {
      const reverse = settings.paintOrder !== 'top-first';
      add('background-image', (reverse ? [...background].reverse() : background).join(', '));
      if (blends.some(blend => blend !== 'normal')) add('background-blend-mode', (reverse ? [...blends].reverse() : blends).join(', '));
      if (raw.type === 'TEXT') { add('background-clip', 'text'); add('-webkit-background-clip', 'text'); add('color', 'transparent'); }
    } else if (active.length > 1) warnings.push('多层混合填充无法无损表达为单一CSS，已省略；启用multiFill可分层输出受支持paint');
  } else warnings.push(`fills：${({ mixed: '混合', unknown: '未知', missing: '缺失' })[fills.state] ?? '非数组'}`);
  const strokeField = readField(raw, 'strokes'), dash = readField(raw, 'dashPattern'), alignment = readField(raw, 'strokeAlign');
  const strokes = strokeField.state === 'known' && Array.isArray(strokeField.value) ? strokeField.value.filter(s => s && s.visible !== false) : null;
  if (strokes?.length === 1 && strokes[0].type === 'SOLID') {
    const c = paintColor(strokes[0], format);
    let borderStyle = 'solid';
    if (dash.state === 'known' && Array.isArray(dash.value) && dash.value.length) {
      if (dash.value.every(value => finite(value) && value >= 0) && dash.value.some(value => value > 0)) { borderStyle = 'dashed'; warnings.push(`dashPattern [${dash.value.join(', ')}]保留源长度；CSS dashed仅近似，不能控制每段dash/gap`); }
      else { borderStyle = null; warnings.push('dashPattern无效，未伪造实线'); }
    } else if (dash.state !== 'missing' && !(dash.state === 'known' && Array.isArray(dash.value))) { borderStyle = null; warnings.push(`dashPattern ${dash.state}，未伪造实线`); }
    if (c && borderStyle) { add('border-color', c); add('border-style', borderStyle); }
    if (readField(raw, 'strokeWeight').state === 'known' && finite(raw.strokeWeight)) add('border-width', length(raw.strokeWeight));
    const edgeKeys = ['strokeTopWeight', 'strokeRightWeight', 'strokeBottomWeight', 'strokeLeftWeight'];
    for (const [i, key] of edgeKeys.entries()) if (readField(raw, key).state === 'known' && finite(raw[key])) add(`border-${['top', 'right', 'bottom', 'left'][i]}-width`, length(raw[key]));
    if (alignment.state === 'known' && alignment.value === 'INSIDE' && raw.type !== 'TEXT') add('box-sizing', 'border-box');
    else if (alignment.state !== 'missing') warnings.push(`描边对齐${alignment.value ?? alignment.state}不能由CSS border无损复现；内/外/居中几何保留在stroke元数据`);
    if (raw.type && !['RECTANGLE', 'FRAME', 'COMPONENT', 'INSTANCE', 'TEXT'].includes(raw.type)) warnings.push('非矩形路径描边仅CSS border近似，不是原路径stroke');
    if (raw.type === 'TEXT') warnings.push('文字描边不能由CSS border无损复现');
  } else if (strokes?.length) warnings.push('多层/非实色/复杂内外描边未输出伪造CSS');
  else if (!['known', 'missing'].includes(strokeField.state)) warnings.push(`strokes：${strokeField.state}，未输出具体描边`);
  if (raw.type === 'TEXT' || has(raw, 'characters')) {
    const t = typography(raw), p = t.properties;
    const known = key => p[key]?.state === 'known' ? p[key].value : null;
    const family = known('fontFamily');
    if (typeof family === 'string') add('font-family', JSON.stringify(family).replaceAll('<', '\\3c '));
    if (finite(known('fontSize'))) add('font-size', length(known('fontSize')));
    if (finite(known('fontWeight')) && known('fontWeight') >= 1 && known('fontWeight') <= 1000) add('font-weight', known('fontWeight'));
    else if (known('fontWeight') !== null) warnings.push('fontWeight超出CSS 1–1000范围，已省略');
    if (typeof known('fontStyle') === 'string' && /italic|oblique/i.test(known('fontStyle'))) add('font-style', /oblique/i.test(known('fontStyle')) ? 'oblique' : 'italic');
    if (known('lineHeightUnit') === 'AUTO') add('line-height', 'normal');
    else if (finite(known('lineHeightPx'))) add('line-height', length(known('lineHeightPx')));
    else if (finite(known('lineHeightPercent'))) add('line-height', numberText(known('lineHeightPercent') / 100, 6));
    const ls = known('letterSpacing'), lsUnit = known('letterSpacingUnit');
    if (finite(ls) && lsUnit === 'PERCENT') add('letter-spacing', `${numberText(ls / 100, 6)}em`);
    else if (finite(ls) && (lsUnit === 'PIXELS' || p.letterSpacingUnit.state === 'missing')) add('letter-spacing', length(ls));
    else if (ls && finite(ls.value) && ls.unit === 'PIXELS') add('letter-spacing', length(ls.value));
    else if (ls && finite(ls.value) && ls.unit === 'PERCENT') add('letter-spacing', `${numberText(ls.value / 100, 6)}em`);
    else if (ls !== null) warnings.push('letterSpacing单位未知/未支持，已省略而非猜px');
    const align = known('textAlignHorizontal');
    if (typeof align === 'string' && ['LEFT', 'RIGHT', 'CENTER', 'JUSTIFIED'].includes(align)) add('text-align', align === 'JUSTIFIED' ? 'justify' : align.toLowerCase());
    const decoration = { NONE: 'none', UNDERLINE: 'underline', STRIKETHROUGH: 'line-through' }[known('textDecoration')];
    if (decoration) add('text-decoration-line', decoration);
    const textCase = { UPPER: 'uppercase', LOWER: 'lowercase', ORIGINAL: 'none' }[known('textCase')];
    if (textCase) add('text-transform', textCase);
    else if (known('textCase') !== null) warnings.push(`textCase ${known('textCase')}未支持精确CSS`);
    for (const [key, value] of Object.entries(p)) if (value.state === 'mixed' || value.state === 'unknown') warnings.push(`${key}：${value.state === 'mixed' ? '混合' : '未知'}，未生成具体值`);
    warnings.push(...t.warnings);
  }
  const effects = readField(raw, 'effects');
  if (effects.state === 'known' && Array.isArray(effects.value)) {
    const shadows = [], textShadows = [], filters = [], backdrops = [];
    for (const effect of effects.value.filter(e => e && e.visible !== false)) {
      const radius = readField(effect, 'radius');
      if (['DROP_SHADOW', 'INNER_SHADOW'].includes(effect.type) && finite(effect.offset?.x) && finite(effect.offset?.y) && radius.state === 'known' && finite(radius.value) && radius.value >= 0 && color(effect.color, format)) {
        if (raw.type === 'TEXT') {
          if (effect.type === 'INNER_SHADOW') { warnings.push('文字INNER_SHADOW未支持精确CSS；不会伪装box-shadow'); continue; }
          if (finite(effect.spread) && effect.spread !== 0) warnings.push('文字shadow spread无法由text-shadow表达，已明确省略spread');
          textShadows.push(`${length(effect.offset.x)} ${length(effect.offset.y)} ${length(radius.value)} ${color(effect.color, format)}`);
        } else shadows.push(`${effect.type === 'INNER_SHADOW' ? 'inset ' : ''}${length(effect.offset.x)} ${length(effect.offset.y)} ${length(radius.value)}${finite(effect.spread) ? ` ${length(effect.spread)}` : ''} ${color(effect.color, format)}`);
        if (effect.blendMode && effect.blendMode !== 'NORMAL') warnings.push(`shadow blendMode ${effect.blendMode}不能由CSS shadow逐层无损表达`);
      } else if (['LAYER_BLUR', 'BACKGROUND_BLUR'].includes(effect.type) && radius.state === 'known' && finite(radius.value) && radius.value >= 0) {
        (effect.type === 'LAYER_BLUR' ? filters : backdrops).push(`blur(${length(radius.value)})`);
        if (effect.blurType && effect.blurType !== 'NORMAL') warnings.push(`blurType ${effect.blurType}未支持精确CSS；当前为标准blur近似`);
      } else warnings.push(`效果${effect.type ?? '未知'}不输出伪造CSS`);
    }
    if (shadows.length) add('box-shadow', shadows.join(', '));
    if (textShadows.length) add('text-shadow', textShadows.join(', '));
    if (filters.length) add('filter', filters.join(' '));
    if (backdrops.length) { add('backdrop-filter', backdrops.join(' ')); warnings.push('background blur依赖宿主背后内容及浏览器backdrop-filter支持'); }
  } else if (effects.state !== 'missing') warnings.push(`effects：${effects.state}，未输出伪造效果`);
  const absolute = readField(raw, 'absoluteTransform'), relative = readField(raw, 'relativeTransform');
  const a = absolute.state === 'known' ? affine(absolute.value) : absolute.state === 'missing' && relative.state === 'known' ? affine(relative.value) : null;
  if (a) { add('transform-origin', '0 0'); add('transform', `matrix(${a.map(n => numberText(n, 8)).join(', ')})`); warnings.push('matrix平移为CSS px；绝对/相对坐标语境须由使用者匹配'); }
  return { declarations, text: declarations.map(([key, value]) => `${key}: ${value};`).join('\n'), warnings, limits: [...warnings], precision: warnings.length ? 'partial' : 'css-properties', stroke: { dashPattern: dash, align: alignment, paints: strokeField }, scope, settings: { ...settings, unit, remBase, colorFormat: format } };
}
export function previewLevel(displayPixels) {
  if (!finite(displayPixels) || displayPixels <= 64) return 64;
  if (displayPixels <= 256) return 256;
  if (displayPixels <= 1024) return 1024;
  return 2048;
}
export function nativeTilePlan(asset, bounds, v, max = LIMITS.native) {
  if (!rect(bounds) || bounds.width <= 0 || bounds.height <= 0 || !Number.isSafeInteger(asset?.width) || !Number.isSafeInteger(asset?.height) || asset.width <= 0 || asset.height <= 0) return [];
  const world = visibleWorld(v);
  const x0 = clamp((world.x - bounds.x) / bounds.width * asset.width, 0, asset.width), y0 = clamp((world.y - bounds.y) / bounds.height * asset.height, 0, asset.height);
  const x1 = clamp((world.x + world.width - bounds.x) / bounds.width * asset.width, 0, asset.width), y1 = clamp((world.y + world.height - bounds.y) / bounds.height * asset.height, 0, asset.height);
  if (x1 <= x0 || y1 <= y0) return [];
  const items = [], size = 512, cap = finite(max) ? Math.floor(clamp(max, 0, LIMITS.native)) : 0;
  const minX = Math.floor(x0 / size), maxX = Math.ceil(x1 / size) - 1, minY = Math.floor(y0 / size), maxY = Math.ceil(y1 / size) - 1;
  const cx = (x0 + x1) / 1024, cy = (y0 + y1) / 1024, centerX = clamp(Math.floor(cx), minX, maxX), centerY = clamp(Math.floor(cy), minY, maxY);
  const push = (x, y) => { if (x >= minX && x <= maxX && y >= minY && y <= maxY) items.push({ x, y, tileSize: size, width: Math.min(size, asset.width - x * size), height: Math.min(size, asset.height - y * size) }); };
  // Enumerate bounded center rings instead of allocating every tile of a huge image.
  for (let radius = 0; radius <= cap && items.length < cap; radius++) {
    if (!radius) { push(centerX, centerY); continue; }
    for (let x = centerX - radius; x <= centerX + radius; x++) { push(x, centerY - radius); push(x, centerY + radius); }
    for (let y = centerY - radius + 1; y < centerY + radius; y++) { push(centerX - radius, y); push(centerX + radius, y); }
    if (centerX - radius <= minX && centerX + radius >= maxX && centerY - radius <= minY && centerY + radius >= maxY) break;
  }
  return items.sort((a, b) => Math.hypot(a.x + 0.5 - cx, a.y + 0.5 - cy) - Math.hypot(b.x + 0.5 - cx, b.y + 0.5 - cy)).slice(0, cap);
}
