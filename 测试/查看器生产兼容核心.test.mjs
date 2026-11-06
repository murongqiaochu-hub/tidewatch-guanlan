import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { serializeFrame } from '../插件/exporter.mjs';
import * as c from '../查看器/core.mjs';

// Entirely synthetic public SDK objects and plain legacy DTOs, not production data.
const identity = { projectId: 'proj_K7-p', designFileId: 'file_Y2', pageId: 'page_a', frameId: 'frame_N9', revisionId: 'rev_4', figmaNodeId: '42:1' };
const bounds = (x = 0, y = 0, width = 100, height = 100) => ({ x, y, width, height });
const node = (id, extra = {}) => ({ id, type: 'RECTANGLE', name: `Synthetic ${id}`, width: 10, height: 10, absoluteTransform: [[1, 0, 0], [0, 1, 0]], ...extra });
const input = (children = [], extra = {}) => ({ contractVersion: 1, frame: node('42:1', { type: 'FRAME', width: 500, height: 400, children }), ...extra });
const normalize = (children, extra) => c.normalizeLayerDoc(input(children, extra), identity);
const approx = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

for (const [label, value, state, expected] of [
  ['zero', 0, 'known', 0], ['false', false, 'known', false], ['empty-string', '', 'known', ''], ['empty-array', [], 'known', []], ['empty-object', {}, 'known', {}],
  ['missing-null', null, 'missing'], ['missing-undefined', undefined, 'missing'], ['legacy-uppercase', 'MIXED', 'mixed'], ['legacy-lowercase', 'mixed', 'mixed'],
  ['legacy-mixed-true', { mixed: true }, 'mixed'], ['legacy-mixed-string', { mixed: 'MIXED' }, 'mixed'], ['legacy-symbol', Symbol('synthetic'), 'mixed'],
  ['producer-mixed', { state: 'mixed' }, 'mixed'], ['producer-unknown', { state: 'unknown', reason: 'sdk-getter' }, 'unknown'], ['producer-missing', { state: 'missing' }, 'missing'],
  ['known-wrapper-zero', { state: 'known', value: 0 }, 'known', 0], ['nonfinite', NaN, 'unknown']
]) test(`field classification / ${label}`, () => { const field = c.fieldState(value); assert.equal(field.state, state); if (state === 'known') assert.deepEqual(field.value, expected); else assert.equal(Object.hasOwn(field, 'value'), false); });

for (const value of [0, false, '', [], {}]) test(`raw.fieldStates unknown overrides placeholder ${JSON.stringify(value)}`, () => {
  const raw = { opacity: value, raw: { fieldStates: { opacity: { state: 'unknown', reason: 'sdk-getter' } } } };
  assert.deepEqual(c.readField(raw, 'opacity'), { state: 'unknown', reason: 'sdk-getter' });
});
for (const state of ['mixed', 'unknown', 'missing']) test(`top-level fieldStates / ${state}`, () => assert.equal(c.readField({ fieldStates: { size: { state, reason: 'explicit' } }, size: 12 }, 'size').state, state));
test('a throwing getter is unknown rather than missing or zero', () => { const raw = {}; Object.defineProperty(raw, 'opacity', { get() { throw Error('synthetic'); } }); assert.deepEqual(c.readField(raw, 'opacity'), { state: 'unknown', reason: 'getter-failed' }); });
test('producer raw metadata does not hide a raw text DTO', () => assert.equal(c.typography({ characters: 'Q', style: { fontSize: 13 }, raw: { fieldStates: {} } }).properties.fontSize.value, 13));

const legacyRuns = [{ start: 0, end: 1, characters: 'A', style: { fontSize: 12 } }, { start: 1, end: 2, characters: 'B', fontSize: 24 }];
for (const source of ['runs', 'textRuns', 'mixedTextRuns', 'style.runs', 'textTable']) test(`text segment source / ${source} / explicit 12 and 24`, () => {
  const raw = { characters: 'AB', style: { fontFamily: 'Synthetic Sans', fontSize: { state: 'mixed' } } };
  if (source === 'style.runs') raw.style.runs = legacyRuns; else raw[source] = legacyRuns;
  const before = JSON.stringify(raw), t = c.typography(raw), segments = c.textSegments(raw);
  assert.equal(segments.source, source); assert.equal(segments.coverage.state, 'complete'); assert.equal(segments.coverage.unit, 'UTF-16'); assert.equal(segments.coverage.covered, 2);
  assert.deepEqual(t.runs.map(run => run.style.fontSize), [12, 24]); assert.equal(t.properties.fontSize.state, 'mixed'); assert.equal(t.properties.fontFamily.value, 'Synthetic Sans'); assert.equal(JSON.stringify(raw), before);
});
for (const runs of [
  [{ characters: 'A', fontSize: 12 }, { characters: '😀', style: { fontSize: 24 } }],
  [{ start: 0, end: 1, fontSize: 12 }, { start: 1, end: 3, fontSize: 24 }],
  [{ start: 0, characters: 'A', style: { fontSize: 12 } }, { start: 1, characters: '😀', style: { fontSize: 24 } }]
]) test(`legacy segment range inference / ${JSON.stringify(runs)}`, () => { const result = c.textSegments({ characters: 'A😀', textTable: runs }); assert.equal(result.coverage.state, 'complete'); assert.deepEqual(result.runs.map(run => [run.start, run.end, run.characters]), [[0, 1, 'A'], [1, 3, '😀']]); });
for (const [label, runs] of [
  ['gap', [{ start: 0, end: 1, fontSize: 12 }, { start: 2, end: 3, fontSize: 12 }]],
  ['overlap', [{ start: 0, end: 2, fontSize: 12 }, { start: 1, end: 3, fontSize: 12 }]],
  ['mismatched-characters', [{ start: 0, end: 3, characters: 'bad', fontSize: 12 }]],
  ['negative', [{ start: -1, end: 3, fontSize: 12 }]], ['outside', [{ start: 0, end: 4, fontSize: 12 }]]
]) test(`UTF-16 coverage rejects ${label} as a concrete global size`, () => { const raw = { characters: 'A😀', textTable: runs }; assert.equal(c.textSegments(raw).coverage.state, 'incomplete'); assert.equal(c.typography(raw).properties.fontSize.state, 'unknown'); });
test('segment unknown never silently falls back to a legacy table', () => { const value = c.textSegments({ characters: 'AB', runs: { state: 'unknown', reason: 'getter' }, textTable: legacyRuns }); assert.equal(value.state, 'unknown'); assert.equal(value.source, 'runs'); assert.equal(value.runs.length, 0); assert.equal(value.coverage.state, 'unknown'); });
test('whole-style unknown is propagated into typography', () => assert.equal(c.typography({ style: { state: 'unknown', reason: 'getter' } }).properties.fontSize.state, 'unknown'));
test('textRunsState unknown retains complete characters but not fabricated runs', () => { const t = c.textSegments({ characters: 'A', textRunsState: { state: 'unknown', reason: 'sdk-capability' } }); assert.equal(t.state, 'unknown'); assert.equal(t.characters.value, 'A'); assert.equal(t.coverage.state, 'unknown'); });
test('unknown font getter metadata propagates when style object lacks the field', () => assert.equal(c.typography({ characters: 'A', raw: { fieldStates: { fontSize: { state: 'unknown', reason: 'sdk-getter' } } } }).properties.fontSize.state, 'unknown'));

for (const [unit, amount, key, value] of [['PIXELS', 28.5, 'lineHeightPx', 28.5], ['PERCENT', 150, 'lineHeightPercent', 150], ['AUTO', 0, 'lineHeightUnit', 'AUTO']]) {
  for (const representation of ['numeric', 'object']) test(`lineHeight / ${representation} / ${unit}`, () => {
    const style = representation === 'numeric' ? { lineHeight: amount, lineHeightUnit: unit } : { lineHeight: { unit, ...(unit === 'AUTO' ? {} : { value: amount }) } };
    const t = c.typography({ style }); assert.equal(t.properties[key].value, value); assert.equal(t.properties.lineHeightUnit.value, unit);
  });
}
for (const unit of ['PIXELS', 'PERCENT']) test(`numeric letter spacing retains explicit ${unit} unit`, () => { const t = c.typography({ style: { letterSpacing: 2, letterSpacingUnit: unit } }); assert.equal(t.properties.letterSpacing.value, 2); assert.equal(t.properties.letterSpacingUnit.value, unit); });
test('mixed summary does not copy first run when base has no concrete size', () => { const t = c.typography({ characters: 'AB', textTable: legacyRuns }); assert.equal(t.properties.fontSize.state, 'mixed'); assert.equal(t.runs[0].style.fontSize, 12); assert.equal(t.runs[1].style.fontSize, 24); });

const rotatedBounds = bounds(70, 0, 30, 100), rotate = [[0, -1, 100], [1, 0, 0]];
const aabbOnly = (id, extra = {}) => ({ id, type: 'RECTANGLE', name: id, absoluteTransform: rotate, absoluteBoundingBox: rotatedBounds, ...extra });
test('P0 rotated 90 degree AABB without local dimensions stays at 70,0,30,100', () => { const raw = aabbOnly('42:2'), before = JSON.stringify(raw), d = normalize([raw]), n = d.all[1]; assert.deepEqual(n.bounds, rotatedBounds); assert.equal(n.local, null); assert.equal(n.geometrySource, 'absolute-bounds'); assert.equal(n.precision, 'bounds'); assert.equal(c.hitTest(d, { x: 80, y: 50 }).node, n); assert.notEqual(c.hitTest(d, { x: 5, y: 10 })?.node, n); assert.deepEqual(n.matrix, [0, 1, -1, 0, 100, 0]); assert.equal(JSON.stringify(raw), before); });
test('explicit 100x30 local dimensions permit transforming geometry once', () => { const n = normalize([aabbOnly('42:2', { width: 100, height: 30 })]).all[1]; assert.deepEqual(n.bounds, rotatedBounds); assert.deepEqual(n.local, bounds(0, 0, 100, 30)); assert.equal(n.precision, 'geometry'); });
test('one missing dimension is not substituted with world AABB size', () => { const n = normalize([aabbOnly('42:2', { width: 100 })]).all[1]; assert.equal(n.local, null); assert.deepEqual(n.bounds, rotatedBounds); });
test('producer unknown local dimension forces original world AABB fallback', () => { const n = normalize([aabbOnly('42:2', { width: 100, height: 30, raw: { fieldStates: { height: { state: 'unknown' } } } })]).all[1]; assert.equal(n.local, null); assert.deepEqual(n.bounds, rotatedBounds); });
test('nested geometry DTO preserves its AABB rather than rotating its dimensions twice', () => { const n = normalize([{ id: '42:2', type: 'RECTANGLE', geometry: { absoluteTransform: rotate, absoluteBoundingBox: rotatedBounds } }]).all[1]; assert.deepEqual(n.bounds, rotatedBounds); });
for (const mode of ['clip', 'mask']) test(`AABB fallback ${mode} keeps its original world boundary`, () => {
  const child = node('42:4', { width: 200, height: 200 });
  const children = mode === 'clip' ? [aabbOnly('42:3', { type: 'FRAME', clipsContent: true, children: [child] })] : [aabbOnly('42:3', { isMask: true }), child];
  const d = normalize(children); assert.equal(c.hitTest(d, { x: 80, y: 50 }).node.figmaNodeId, '42:4'); assert.notEqual(c.hitTest(d, { x: 10, y: 10 })?.node.figmaNodeId, '42:4'); assert.equal(c.hitTest(d, { x: 80, y: 50 }).precision, 'bounds');
});
test('AABB-only measurements do not claim local width', () => { const m = c.measurements(normalize([aabbOnly('42:2')]).all[1]); assert.equal(m.state, 'known'); assert.equal(m.localWidth, null); assert.equal(m.localState, 'missing'); assert.deepEqual(m.bounds, rotatedBounds); });

const styles = { TEXT: [{ id: 's_text', name: 'Synthetic type', fontSize: 12, remote: false }], FILL: [{ id: 's_fill', paints: [], remote: true }], EFFECT: [{ id: 's_effect', effects: [], remote: false }], GRID: [{ id: 's_grid', layoutGrids: [], remote: false }] };
const components = [{ id: 'c_local', name: 'Synthetic component', remote: false }, { id: 'c_remote', name: 'External synthetic', remote: true }];
for (const [field, category, id] of [['textStyleId', 'TEXT', 's_text'], ['fillStyleId', 'FILL', 's_fill'], ['strokeStyleId', 'FILL', 's_fill'], ['effectStyleId', 'EFFECT', 's_effect'], ['gridStyleId', 'GRID', 's_grid']]) {
  for (const kind of ['producer', 'legacy']) test(`style reference / ${kind} / ${field}`, () => { const raw = kind === 'producer' ? { styleReferences: { [field]: { state: 'resolved', id, category } } } : { [field]: id }; const d = normalize([node('42:2', raw)], { styles, components }); const result = c.resolveNodeReferences(d, d.all[1]).styles.find(item => item.field === field); assert.equal(result.state, 'resolved'); assert.equal(result.category, category); assert.equal(result.id, id); assert.equal(result.value, styles[category].find(item => item.id === id)); assert.equal(result.locality, id === 's_fill' ? 'remote' : 'local'); });
}
for (const [label, raw, state] of [['missing', {}, 'missing'], ['none', { textStyleId: '' }, 'none'], ['unknown-id', { textStyleId: 'not-here' }, 'unknown'], ['mixed', { textStyleId: { state: 'mixed' } }, 'mixed'], ['getter', { raw: { fieldStates: { textStyleId: { state: 'unknown', reason: 'sdk-getter' } } } }, 'unknown'], ['producer-lookup', { styleReferences: { textStyleId: { state: 'unknown', reason: 'lookup-failed' } } }, 'unknown']]) test(`reference state / ${label}`, () => { const result = c.resolveNodeReferences({ styles }, raw).styles.find(item => item.field === 'textStyleId'); assert.equal(result.state, state); assert.equal(result.locality, 'unknown'); if (state !== 'resolved') assert.equal(Object.hasOwn(result, 'value'), false); });
test('style reference cannot resolve against the wrong classification', () => assert.equal(c.resolveNodeReferences({ styles }, { textStyleId: 's_fill' }).styles[0].state, 'unknown'));
test('duplicate style IDs remain ambiguous', () => assert.equal(c.resolveNodeReferences({ styles: { TEXT: [{ id: 'same' }, { id: 'same' }] } }, { textStyleId: 'same' }).styles[0].reason, 'duplicate-reference-id'));
for (const key of ['componentReference', 'mainComponent']) for (const id of ['c_local', 'c_remote']) test(`component lookup / ${key} / ${id}`, () => { const ref = c.resolveNodeReferences({ components }, { [key]: { id, state: 'resolved' } }).component; assert.equal(ref.state, 'resolved'); assert.equal(ref.value.id, id); assert.equal(ref.locality, id === 'c_local' ? 'local' : 'remote'); });
test('legacy variants array resolves each component by ID', () => { const result = c.resolveNodeReferences({ components }, { variants: ['c_local', { id: 'c_remote' }, { id: 'absent' }] }).variants; assert.equal(result.state, 'known'); assert.deepEqual(result.value.map(item => item.state), ['resolved', 'resolved', 'unknown']); assert.deepEqual(result.value.map(item => item.locality), ['local', 'remote', 'unknown']); });
test('unresolved mainComponent is not fabricated from inline display name', () => { const result = c.resolveNodeReferences({ components: [] }, { mainComponent: { id: 'absent', name: 'Not a local declaration', remote: false } }); assert.equal(result.component.state, 'unknown'); assert.equal(result.component.locality, 'unknown'); });
test('context is computed by ancestor stable IDs, not same display names', () => { const d = normalize([node('42:2', { type: 'INSTANCE', name: 'same', componentReference: { id: 'c_local', state: 'resolved' }, children: [node('42:3', { type: 'INSTANCE', name: 'same', componentReference: { id: 'c_remote', state: 'resolved' }, children: [node('42:4')] })] })], { components }); const result = c.resolveNodeReferences(d, d.all[3]); assert.deepEqual(result.context.map(item => item.figmaNodeId), ['42:2', '42:3']); assert.deepEqual(result.context.map(item => item.componentId), ['c_local', 'c_remote']); assert.deepEqual(result.context.map(item => item.locality), ['local', 'remote']); assert.ok(result.context.every(item => d.byKey.has(item.key))); });

async function pluginFixture({ failedComponent = false, failedStyle = false } = {}) {
  const mixed = Symbol('synthetic-sdk-mixed');
  const text = node('42:2', { type: 'TEXT', characters: 'A😀', fontName: { family: 'Synthetic Sans', style: 'Regular' }, fontSize: mixed, lineHeight: { unit: 'PERCENT', value: 150 }, letterSpacing: { unit: 'PERCENT', value: 2 }, textStyleId: 's_text', fillStyleId: 's_fill', getStyledTextSegments() { return [{ start: 0, end: 1, characters: 'A', fontSize: 12, textStyleId: 's_text' }, { start: 1, end: 3, characters: '😀', fontSize: 24, textStyleId: 's_text' }]; } });
  Object.defineProperty(text, 'opacity', { enumerable: true, get() { throw Error('synthetic getter'); } });
  const instance = node('42:3', { type: 'INSTANCE', getMainComponentAsync: async () => { if (failedComponent) throw Error('synthetic component lookup'); return { id: 'c_remote', type: 'COMPONENT', name: 'Remote synthetic', remote: true, variantProperties: { State: 'On' } }; } });
  const sdk = { mixed, getStyleByIdAsync: async id => { if (failedStyle) throw Error('synthetic style lookup'); return id === 's_text' ? { ...styles.TEXT[0], type: 'TEXT' } : { ...styles.FILL[0], type: 'PAINT' }; } };
  return serializeFrame(sdk, input([text, instance]).frame, { cryptoAPI: webcrypto });
}
test('new Plugin.serializeFrame -> normalize -> fields -> typography -> classified refs end to end', async () => {
  const { layerDoc, bytes, sha256 } = await pluginFixture(); const d = c.normalizeLayerDoc(layerDoc, identity), t = c.typography(d.all[1]), refs = c.resolveNodeReferences(d, d.all[1]);
  assert.ok(bytes.byteLength > 0); assert.match(sha256, /^[a-f0-9]{64}$/); assert.equal(c.readField(d.all[1].raw, 'fontSize').state, 'mixed'); assert.equal(c.readField(d.all[1].raw, 'opacity').state, 'unknown');
  assert.equal(t.properties.fontSize.state, 'mixed'); assert.deepEqual(t.runs.map(run => run.style.fontSize), [12, 24]); assert.equal(t.coverage.state, 'complete'); assert.equal(t.coverage.length, 3); assert.equal(t.properties.lineHeightPercent.value, 150);
  assert.equal(refs.styles.find(item => item.field === 'textStyleId').value.fontSize, 12); assert.equal(refs.styles.find(item => item.field === 'fillStyleId').locality, 'remote'); assert.equal(c.resolveNodeReferences(d, d.all[2]).component.locality, 'remote');
});
test('public plugin failed component lookup survives viewer normalization as unknown', async () => { const { layerDoc } = await pluginFixture({ failedComponent: true }); const d = c.normalizeLayerDoc(layerDoc, identity); const ref = c.resolveNodeReferences(d, d.all[2]).component; assert.equal(ref.state, 'unknown'); assert.equal(ref.reason, 'lookup-failed'); assert.equal(ref.locality, 'unknown'); });
test('public plugin failed style lookup remains unknown, not a local record', async () => { const { layerDoc } = await pluginFixture({ failedStyle: true }); const d = c.normalizeLayerDoc(layerDoc, identity); const ref = c.resolveNodeReferences(d, d.all[1]).styles[0]; assert.equal(ref.state, 'unknown'); assert.equal(ref.reason, 'lookup-failed'); assert.equal(layerDoc.styles.TEXT.length, 0); });

for (const platform of ['Web', 'iOS', 'Android']) for (const unit of ['px', 'em', 'rem', 'pt', 'dp', 'rpx']) test(`display unit / ${platform} / ${unit}`, () => {
  const result = c.displayValue(48, { platform, unit, density: 3, remBase: 16, emBase: 12, rpxBase: 375 });
  const expected = { px: 48, em: 4, rem: 3, pt: platform === 'Web' ? 36 : 16, dp: 16, rpx: 96 }[unit];
  assert.equal(result.state, 'known'); assert.equal(result.value, expected); assert.equal(result.text, `${expected}${unit}`); assert.equal(result.sourceValue, 48);
});
for (const [rounding, positive, negative] of [['round', 1.24, -1.23], ['ceil', 1.24, -1.23], ['floor', 1.23, -1.24], ['none', 1.239, -1.231]]) test(`rounding / ${rounding} / signed precision`, () => {
  assert.equal(c.displayValue(1.239, { rounding, precision: 2 }).value, positive); assert.equal(c.displayValue(-1.231, { rounding, precision: 2 }).value, negative);
});
test('none preserves full input precision rather than silently rounding to four places', () => assert.equal(c.displayValue(1.1234567890123, { precision: 0, rounding: 'none' }).text, '1.1234567890123px'));
test('display conversion does not leak negative zero', () => assert.equal(c.displayValue(-0.001, { rounding: 'ceil', precision: 0 }).text, '0px'));
test('rpx never guesses a viewport or canvas width', () => { const value = c.displayValue(20, { unit: 'rpx' }); assert.equal(value.state, 'unknown'); assert.equal(value.reason, 'rpx-base-required'); });
test('em fallback is explicit and warned, not an undisclosed font-size guess', () => { const result = c.displayValue(32, { unit: 'em', remBase: 16 }); assert.equal(result.value, 2); assert.match(result.warnings.join(' '), /emBase/); });
for (const settings of [{ density: 0 }, { density: NaN }, { unit: 'rem', remBase: 0 }, { unit: 'em', emBase: -1 }, { platform: 'unknown' }, { precision: 15 }, { rounding: 'truncate' }, { unit: 'invalid' }]) test(`invalid display settings / ${JSON.stringify(settings)}`, () => assert.throws(() => c.displayValue(1, settings), TypeError));
for (const state of ['mixed', 'unknown', 'missing']) test(`display preserves ${state}`, () => { const result = c.displayValue({ state, reason: 'synthetic' }, { unit: 'rem' }); assert.equal(result.state, state); assert.equal(Object.hasOwn(result, 'value'), false); });
test('display false is known nonnumeric, not converted to zero', () => assert.equal(c.displayValue(false).reason, 'not-numeric'));
for (const unit of ['px', 'rem', 'em', 'pt']) test(`standard CSS length / ${unit}`, () => { const expected = { px: '24px', rem: '1.5rem', em: '2em', pt: '18pt' }[unit]; assert.equal(c.cssLength(24, { unit, remBase: 16, emBase: 12 }), expected); });
for (const unit of ['dp', 'rpx']) test(`display-only ${unit} is never emitted as invalid CSS`, () => assert.throws(() => c.generateCSS({ width: 12 }, { unit }), /displayValue/));
test('CSS precision settings are applied after conversion without mutating geometry', () => { const raw = { width: 21.39, height: 7.35, fills: [] }, before = JSON.stringify(raw); const result = c.generateCSS(raw, { unit: 'rem', remBase: 16, rounding: 'floor', precision: 2 }); assert.match(result.text, /width: 1.33rem;/); assert.match(result.text, /height: 0.45rem;/); assert.equal(JSON.stringify(raw), before); });

for (const [format, expected] of [['hex', '#ff000080'], ['hexa', '#ff000080'], ['rgb', 'rgb(255 0 0 / 0.5)'], ['rgba', 'rgba(255, 0, 0, 0.5)'], ['hsl', 'hsl(0 100% 50% / 0.5)'], ['hsla', 'hsla(0, 100%, 50%, 0.5)']]) test(`color format / ${format}`, () => assert.equal(c.color({ r: 1, g: 0, b: 0, a: 0.5 }, format), expected));
test('hexa always has an explicit opaque alpha byte', () => assert.equal(c.color({ r: 0, g: 1, b: 0 }, 'hexa'), '#00ff00ff'));
test('paint opacity unknown does not become opaque', () => assert.equal(c.paintColor({ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: { state: 'unknown' } }), null));

const red = { type: 'SOLID', color: { r: 1, g: 0, b: 0 } }, blue = { type: 'SOLID', color: { r: 0, g: 0, b: 1 } };
const stops = [{ position: 0, color: { r: 1, g: 0, b: 0 } }, { position: 1, color: { r: 0, g: 0, b: 1 } }];
const grad = (type, handles) => ({ type, gradientStops: stops, gradientHandlePositions: handles });
test('multiFill true outputs both solid layers and preserves declared bottom-first order', () => { const raw = { fills: [red, blue] }, before = JSON.stringify(raw); const result = c.generateCSS(raw, { multiFill: true }); assert.match(result.text, /background-image: linear-gradient\(#0000ff, #0000ff\), linear-gradient\(#ff0000, #ff0000\);/); assert.equal(JSON.stringify(raw), before); });
test('multiFill top-first order is explicit rather than silently reversed', () => assert.match(c.generateCSS({ fills: [red, blue] }, { multiFill: true, paintOrder: 'top-first' }).text, /background-image: linear-gradient\(#ff0000, #ff0000\), linear-gradient\(#0000ff, #0000ff\)/));
test('multiFill supports actual solid and linear gradient composition', () => { const result = c.generateCSS({ fills: [red, grad('GRADIENT_LINEAR', [{ x: 0, y: 0 }, { x: 1, y: 0 }])] }, { multiFill: true }); assert.match(result.text, /linear-gradient\(90deg/); assert.match(result.text, /linear-gradient\(#ff0000, #ff0000\)/); });
test('unsupported image layer does not get silently dropped from a partial composite', () => { const result = c.generateCSS({ fills: [red, { type: 'IMAGE', imageHash: 'synthetic' }] }, { multiFill: true }); assert.doesNotMatch(result.text, /background-image/); assert.match(result.warnings.join(' '), /IMAGE/); });
test('known paint blend modes follow the same CSS layer order', () => { const result = c.generateCSS({ fills: [red, { ...blue, blendMode: 'MULTIPLY' }] }, { multiFill: true }); assert.match(result.text, /background-blend-mode: multiply, normal;/); });
test('text multiFill clips actual gradient layers to glyphs', () => { const result = c.generateCSS({ type: 'TEXT', characters: 'AB', fills: [red, blue] }, { multiFill: true }); assert.match(result.text, /background-clip: text;/); assert.match(result.text, /color: transparent;/); });
test('linear gradient uses explicit non-square local aspect ratio', () => { const result = c.generateCSS({ width: 200, height: 100, fills: [grad('GRADIENT_LINEAR', [{ x: 0.5, y: 0.5 }, { x: 1, y: 1 }])] }); assert.match(result.text, /linear-gradient\(116.5651deg/); assert.match(result.text, /#ff0000 50%, #0000ff 100%/); });
test('radial gradient supports explicit axis-aligned elliptical handles', () => { const result = c.generateCSS({ fills: [grad('GRADIENT_RADIAL', [{ x: 0.3, y: 0.4 }, { x: 0.8, y: 0.4 }, { x: 0.3, y: 0.65 }])] }); assert.match(result.text, /radial-gradient\(ellipse 50% 25% at 30% 40%, #ff0000 0%, #0000ff 100%\)/); });
test('radial rotated or skewed ellipse is explicitly unsupported, not pretended precise', () => { const result = c.generateCSS({ fills: [grad('GRADIENT_RADIAL', [{ x: 0.5, y: 0.5 }, { x: 1, y: 1 }, { x: 0.1, y: 1 }])] }); assert.doesNotMatch(result.text, /radial-gradient/); assert.match(result.warnings.join(' '), /旋转\/斜切/); });
test('angular gradient maps to real CSS conic, not radial', () => { const result = c.generateCSS({ width: 100, height: 100, fills: [grad('GRADIENT_ANGULAR', [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }])] }); assert.match(result.text, /conic-gradient\(from 90deg at 50% 50%/); assert.doesNotMatch(result.text, /radial/); });
test('angular skewed transform has an explicit unsupported limit', () => { const result = c.generateCSS({ fills: [grad('GRADIENT_ANGULAR', [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 1, y: 1 }])] }); assert.equal(result.text, ''); assert.match(result.warnings.join(' '), /非正交/); });
test('diamond gradient has a clear warning and no counterfeit CSS', () => { const result = c.generateCSS({ fills: [grad('GRADIENT_DIAMOND', [{ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0.5, y: 1 }])] }); assert.equal(result.text, ''); assert.match(result.warnings.join(' '), /DIAMOND.*未支持/); assert.equal(result.precision, 'partial'); assert.deepEqual(result.limits, result.warnings); });

for (const [unit, value, expected] of [['AUTO', 0, 'normal'], ['PIXELS', 27, '27px'], ['PERCENT', 145, '1.45']]) test(`numeric text CSS lineHeight ${unit}`, () => assert.match(c.generateCSS({ type: 'TEXT', characters: 'A', fills: [], style: { lineHeight: value, lineHeightUnit: unit } }).text, new RegExp(`line-height: ${expected.replace('.', '\\.')};`)));
for (const [unit, expected] of [['PIXELS', '2px'], ['PERCENT', '0.02em']]) test(`numeric text CSS letterSpacing ${unit}`, () => assert.match(c.generateCSS({ type: 'TEXT', characters: 'A', fills: [], style: { letterSpacing: 2, letterSpacingUnit: unit } }).text, new RegExp(`letter-spacing: ${expected.replace('.', '\\.')};`)));
test('unknown letterSpacing unit does not turn numeric amount into pixels', () => { const result = c.generateCSS({ type: 'TEXT', characters: 'A', fills: [], style: { letterSpacing: 2, letterSpacingUnit: { state: 'unknown' } } }); assert.doesNotMatch(result.text, /letter-spacing/); assert.match(result.warnings.join(' '), /letterSpacing/); });
for (const [decoration, expected] of [['UNDERLINE', 'underline'], ['STRIKETHROUGH', 'line-through'], ['NONE', 'none']]) test(`text decoration / ${decoration}`, () => assert.match(c.generateCSS({ type: 'TEXT', characters: 'A', fills: [], style: { textDecoration: decoration, fontWeight: 550 } }).text, new RegExp(`text-decoration-line: ${expected};`)));
test('numeric variable font weight is not coerced to a named font style', () => assert.match(c.generateCSS({ type: 'TEXT', characters: 'A', fills: [], style: { fontWeight: 550 } }).text, /font-weight: 550;/));

const shadow = { type: 'DROP_SHADOW', offset: { x: -2, y: 3 }, radius: 4, spread: 0, color: { r: 0, g: 0, b: 0, a: 0.5 } };
test('text drop shadow uses text-shadow, not a rectangular box-shadow', () => { const result = c.generateCSS({ type: 'TEXT', characters: 'A', fills: [], effects: [shadow] }); assert.match(result.text, /text-shadow: -2px 3px 4px #00000080;/); assert.doesNotMatch(result.text, /box-shadow/); });
test('text spread limitation is reported explicitly', () => { const result = c.generateCSS({ type: 'TEXT', characters: 'A', fills: [], effects: [{ ...shadow, spread: 2 }] }); assert.match(result.warnings.join(' '), /spread/); assert.doesNotMatch(result.text, /4px 2px/); });
test('text inner shadow is not misrepresented as box-shadow', () => { const result = c.generateCSS({ type: 'TEXT', characters: 'A', fills: [], effects: [{ ...shadow, type: 'INNER_SHADOW' }] }); assert.doesNotMatch(result.text, /shadow:/); assert.match(result.warnings.join(' '), /INNER_SHADOW/); });
for (const [type, property] of [['LAYER_BLUR', 'filter'], ['BACKGROUND_BLUR', 'backdrop-filter']]) test(`CSS blur / ${type}`, () => assert.match(c.generateCSS({ fills: [], effects: [{ type, radius: 7.5 }] }).text, new RegExp(`${property}: blur\\(7.5px\\);`)));
test('unknown blur radius cannot be fabricated from zero/default', () => { const result = c.generateCSS({ fills: [], effects: [{ type: 'LAYER_BLUR', radius: { state: 'unknown' } }] }); assert.doesNotMatch(result.text, /blur\(/); assert.match(result.warnings.join(' '), /LAYER_BLUR/); });
for (const align of ['INSIDE', 'CENTER', 'OUTSIDE']) test(`stroke alignment metadata and limitations / ${align}`, () => { const raw = { type: 'RECTANGLE', fills: [], strokes: [red], strokeWeight: 2, strokeAlign: align, dashPattern: [3, 2] }; const result = c.generateCSS(raw); assert.equal(result.stroke.align.value, align); assert.deepEqual(result.stroke.dashPattern.value, [3, 2]); assert.match(result.text, /border-style: dashed;/); assert.match(result.warnings.join(' '), /dashPattern.*近似/); if (align === 'INSIDE') assert.match(result.text, /box-sizing: border-box;/); else assert.match(result.warnings.join(' '), /描边对齐/); });
test('multiple strokes never collapse silently into a single border', () => { const result = c.generateCSS({ fills: [], strokes: [red, blue], strokeWeight: 2, strokeAlign: 'OUTSIDE' }); assert.doesNotMatch(result.text, /border-color/); assert.match(result.warnings.join(' '), /多层.*内外/); });
test('mixed dashPattern cannot silently produce an invented solid border', () => { const result = c.generateCSS({ fills: [], strokes: [red], dashPattern: { state: 'mixed' } }); assert.doesNotMatch(result.text, /border-style/); assert.match(result.warnings.join(' '), /dashPattern mixed/); });

for (const normalized of [false, true]) test(`runIndex CSS retains independent 12 and 24 sizes / normalized=${normalized}`, () => { const raw = node('42:2', { type: 'TEXT', characters: 'AB', textTable: legacyRuns, style: { fontSize: { state: 'mixed' } }, fills: [red], effects: [shadow] }), target = normalized ? normalize([raw]).all[1] : raw; const before = JSON.stringify(raw); const first = c.generateCSS(target, { runIndex: 0 }), second = c.generateCSS(target, { runIndex: 1 }); assert.match(first.text, /font-size: 12px;/); assert.match(second.text, /font-size: 24px;/); assert.doesNotMatch(first.text, /width:|transform:|shadow:/); assert.deepEqual(second.scope, { type: 'text-run', index: 1, start: 1, end: 2, unit: 'UTF-16' }); assert.doesNotMatch(c.generateCSS(target).text, /font-size:/); assert.equal(JSON.stringify(raw), before); });
test('runIndex out of range is explicit and produces no arbitrary fallback CSS', () => { const result = c.generateCSS({ characters: 'AB', textTable: legacyRuns }, { runIndex: 100 }); assert.equal(result.text, ''); assert.match(result.warnings.join(' '), /runIndex/); });

for (const [label, a, b, relation] of [
  ['separate', bounds(0, 0, 10, 10), bounds(15, 20, 10, 10), 'separate'], ['overlap', bounds(0, 0, 10, 10), bounds(5, 5, 10, 10), 'overlap'], ['touching', bounds(0, 0, 10, 10), bounds(10, 0, 10, 10), 'touching'], ['contains', bounds(0, 0, 20, 20), bounds(2, 3, 5, 6), 'contains'], ['inside', bounds(2, 3, 5, 6), bounds(0, 0, 20, 20), 'inside'], ['equal', bounds(-2.5, 3, 5, 6), bounds(-2.5, 3, 5, 6), 'equal']
]) test(`world bounds measurement / ${label}`, () => { const result = c.measureBetween(a, b); assert.equal(result.state, 'known'); assert.equal(result.relation, relation); assert.equal(result.precision, 'bounds'); assert.equal(result.mode, 'world-axis-aligned-bounds'); assert.match(result.warnings[0], /非路径最短距离/); });
test('bounds diagonal distance is explicit AABB separation, not contour distance', () => { const result = c.measureBetween(bounds(0, 0, 10, 10), bounds(13, 14, 10, 10)); assert.equal(result.gapX, 3); assert.equal(result.gapY, 4); assert.equal(result.distance, 5); });
test('bounds overlap exports actual intersection area', () => { const result = c.measureBetween(bounds(0, 0, 10, 10), bounds(5, 6, 10, 10)); assert.deepEqual(result.overlap, { width: 5, height: 4, area: 20 }); });
test('percent root and nearest common ancestor are computed from normalized parent IDs', () => { const d = normalize([node('42:2', { type: 'GROUP', width: 100, height: 80, children: [node('42:3', { width: 20, height: 10 }), node('42:4', { absoluteTransform: [[1, 0, 30], [0, 1, 20]] })] })]); const result = c.measureBetween(d.all[2], d.all[3]); assert.equal(result.percentRoot.state, 'known'); assert.equal(result.percentRoot.key, d.frame.key); assert.equal(result.percentAncestor.key, d.all[1].key); approx(result.percentRoot.horizontalGap, 2); approx(result.percentAncestor.horizontalGap, 10); });
test('percent division by a zero-width root is unknown, never Infinity', () => { const result = c.measureBetween(bounds(), bounds(5, 6), { root: bounds(0, 0, 0, 10) }); assert.equal(result.percentRoot.state, 'unknown'); assert.equal(result.percentRoot.reason, 'zero-reference-dimension'); });
test('missing measurement geometry is explicit, not zero spacing', () => assert.equal(c.measureBetween({}, bounds()).state, 'missing'));

test('base style getter-failure sidecar does not hide explicit known run sizes', () => { const t = c.typography({ characters: 'AB', style: { fontSize: 0, raw: { fieldStates: { fontSize: { state: 'unknown', reason: 'getter' } } } }, textTable: legacyRuns }); assert.deepEqual(t.runs.map(run => c.readField(run.style, 'fontSize').value), [12, 24]); assert.equal(t.properties.fontSize.state, 'mixed'); });
test('decimal half-away round is stable at 1.005 rather than binary multiplication artifacts', () => { assert.equal(c.displayValue(1.005, { rounding: 'round', precision: 2 }).value, 1.01); assert.equal(c.displayValue(-1.005, { rounding: 'round', precision: 2 }).value, -1.01); });
test('a raw producer DTO with parent metadata is not mistaken for a normalized wrapper', () => assert.equal(c.typography({ parent: 'synthetic-parent-id', raw: { fieldStates: {} }, style: { fontSize: 14 } }).properties.fontSize.value, 14));
test('unknown partial fontName family is unknown rather than silently missing', () => assert.equal(c.typography({ style: { fontName: { family: { state: 'unknown', reason: 'getter' }, style: 'Regular' } } }).properties.fontFamily.state, 'unknown'));
test('unknown letterSpacing object unit stays unknown', () => assert.equal(c.typography({ style: { letterSpacing: { value: 3, unit: { state: 'unknown' } } } }).properties.letterSpacingUnit.state, 'unknown'));
test('runs cannot claim whole-text font size when characters and coverage are unknown', () => assert.equal(c.typography({ runs: [{ start: 0, end: 3, fontSize: 12 }] }).properties.fontSize.state, 'unknown'));
test('unknown reference preserves its explicit ID for UI without resolving from a matching record', () => { const result = c.resolveNodeReferences({ styles }, { styleReferences: { textStyleId: { id: 's_text', state: 'unknown', reason: 'getter' } } }).styles[0]; assert.equal(result.id, 's_text'); assert.equal(result.state, 'unknown'); assert.equal(result.locality, 'unknown'); assert.equal(Object.hasOwn(result, 'value'), false); });
test('unknown component reference context cannot become local via a matching ID table', () => { const d = normalize([node('42:2', { type: 'INSTANCE', componentReference: { id: 'c_local', state: 'unknown', reason: 'getter' }, children: [node('42:3')] })], { components }); const result = c.resolveNodeReferences(d, d.all[2]); assert.equal(result.context[0].componentId, 'c_local'); assert.equal(result.context[0].referenceState, 'unknown'); assert.equal(result.context[0].locality, 'unknown'); });
test('category mismatch never returns a known value from the wrong declared reference', () => { const result = c.resolveNodeReferences({ styles }, { styleReferences: { textStyleId: { id: 's_text', category: 'FILL', state: 'resolved' } } }).styles[0]; assert.equal(result.reason, 'category-mismatch'); assert.equal(result.state, 'unknown'); assert.equal(Object.hasOwn(result, 'value'), false); });
test('unknown classified style table cannot resolve a placeholder ID array', () => { const d = normalize([node('42:2', { textStyleId: 's_text' })], { styles: { TEXT: styles.TEXT, raw: { fieldStates: { TEXT: { state: 'unknown' } } } } }); assert.equal(d.styles.TEXT.state, 'unknown'); assert.equal(d.styles.TEXT.items.length, 0); assert.equal(c.resolveNodeReferences(d, d.all[1]).styles[0].state, 'unknown'); });
test('unknown components table cannot resolve placeholder local components', () => { const d = normalize([node('42:2', { mainComponent: 'c_local' })], { components, raw: { fieldStates: { components: { state: 'unknown', reason: 'getter' } } } }); assert.equal(d.componentsState, 'unknown'); assert.equal(d.components.length, 0); assert.equal(c.resolveNodeReferences(d, d.all[1]).component.state, 'unknown'); });
test('unknown opacity/visibility placeholders are omitted from CSS', () => { const raw = { opacity: 0, visible: false, fills: [], raw: { fieldStates: { opacity: { state: 'unknown' }, visible: { state: 'unknown' } } } }; const result = c.generateCSS(raw); assert.doesNotMatch(result.text, /opacity:|visibility:/); });
test('unknown visibility placeholder false is not treated as verified hidden geometry', () => { const d = normalize([node('42:2', { visible: false, raw: { fieldStates: { visible: { state: 'unknown' } } } })]); assert.equal(d.all[1].visible, true); assert.equal(d.all[1].visibilityState.state, 'unknown'); assert.match(d.all[1].notes.join(' '), /未把占位false/); });
test('unknown color channel cannot fabricate a concrete swatch', () => assert.equal(c.color({ r: 0, g: 1, b: 0, raw: { fieldStates: { r: { state: 'unknown' } } } }), null));
test('unknown alpha cannot fabricate opacity one', () => assert.equal(c.color({ r: 0, g: 1, b: 0, a: { state: 'unknown' } }), null));
test('diagonal gradient does not guess missing local dimensions as a square', () => { const result = c.generateCSS({ fills: [grad('GRADIENT_LINEAR', [{ x: 0, y: 0 }, { x: 1, y: 1 }])] }); assert.equal(result.text, ''); assert.match(result.warnings.join(' '), /局部宽高/); });
test('public serialized supplementary UTF-16 run can generate scoped CSS without corrupting coverage', async () => { const { layerDoc } = await pluginFixture(); const d = c.normalizeLayerDoc(layerDoc, identity), result = c.generateCSS(d.all[1], { runIndex: 1 }); assert.match(result.text, /font-size: 24px;/); assert.deepEqual(result.scope, { type: 'text-run', index: 1, start: 1, end: 3, unit: 'UTF-16' }); assert.doesNotMatch(c.generateCSS(d.all[1]).text, /font-size:/); });
test('public serializeFrame remote getter failures remain resolved identity but unknown locality', async () => {
  const style = { id: 's_remoteGetter', type: 'TEXT', name: 'Synthetic', fontSize: 12 }; const component = { id: 'c_remoteGetter', type: 'COMPONENT', name: 'Synthetic' };
  for (const value of [style, component]) Object.defineProperty(value, 'remote', { enumerable: true, get() { throw Error('synthetic remote getter'); } });
  const text = node('42:2', { type: 'TEXT', characters: '', fontSize: 12, textStyleId: style.id, getStyledTextSegments() { return []; } });
  const instance = node('42:3', { type: 'INSTANCE', getMainComponentAsync: async () => component });
  const result = await serializeFrame({ mixed: Symbol('mixed'), getStyleByIdAsync: async () => style }, input([text, instance]).frame, { cryptoAPI: webcrypto });
  const d = c.normalizeLayerDoc(result.layerDoc, identity), sr = c.resolveNodeReferences(d, d.all[1]).styles[0], cr = c.resolveNodeReferences(d, d.all[2]).component;
  for (const ref of [sr, cr]) { assert.equal(ref.state, 'resolved'); assert.equal(ref.locality, 'unknown'); assert.equal(c.readField(ref.value, 'remote').state, 'unknown'); }
});
test('all new pure helpers leave deeply frozen synthetic DTOs untouched', () => {
  const freeze = value => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
  const raw = freeze(input([node('42:2', { type: 'TEXT', characters: 'AB', textTable: legacyRuns, fills: [red, blue], textStyleId: 's_text' })], { styles, components }));
  const before = JSON.stringify(raw), d = c.normalizeLayerDoc(raw, identity); c.textSegments(d.all[1]); c.typography(d.all[1]); c.resolveNodeReferences(d, d.all[1]); c.generateCSS(d.all[1], { multiFill: true, runIndex: 1 }); c.measureBetween(d.frame, d.all[1]); assert.equal(JSON.stringify(raw), before);
});

test('legacy componentId exact UI fixture resolves actual component name without inventing local status', () => {
  const directory = { styles: { TEXT: [] }, components: [{ id: 'component-known', name: '按钮组件实际名' }] };
  const result = c.resolveNodeReferences(directory, { type: 'INSTANCE', componentId: 'component-known' }).component;
  assert.equal(result.state, 'resolved'); assert.equal(result.id, 'component-known'); assert.equal(result.value.name, '按钮组件实际名'); assert.equal(result.locality, 'unknown');
});
test('legacy componentKey resolves exact key to real canonical ID and remote status', () => {
  const entry = { id: 'canonical-component', key: 'synthetic-component-key', name: 'Synthetic key entry', remote: true };
  const result = c.resolveNodeReferences({ components: [entry] }, { type: 'INSTANCE', componentKey: entry.key }).component;
  assert.equal(result.state, 'resolved'); assert.equal(result.id, entry.id); assert.equal(result.key, entry.key); assert.equal(result.value, entry); assert.equal(result.locality, 'remote');
});
for (const field of ['componentReference', 'mainComponent']) for (const state of ['unknown', 'mixed']) test(`explicit ${field} ${state} cannot be overwritten by componentId/key fallback`, () => {
  const entry = { id: 'component-known', key: 'synthetic-component-key', remote: false };
  const raw = { type: 'INSTANCE', [field]: { state, reason: 'synthetic-unresolved' }, componentId: entry.id, componentKey: entry.key };
  const result = c.resolveNodeReferences({ components: [entry] }, raw).component;
  assert.equal(result.state, state); assert.equal(result.locality, 'unknown'); assert.equal(Object.hasOwn(result, 'value'), false);
});
test('componentReference getter-failure sidecar blocks otherwise known componentId fallback', () => {
  const raw = { type: 'INSTANCE', componentId: 'component-known', raw: { fieldStates: { componentReference: { state: 'unknown', reason: 'sdk-getter' } } } };
  assert.equal(c.resolveNodeReferences({ components: [{ id: 'component-known', remote: false }] }, raw).component.state, 'unknown');
});
test('explicit missing primary references allow the componentId fallback', () => {
  const raw = { type: 'INSTANCE', componentReference: { state: 'missing' }, mainComponent: { state: 'missing' }, componentId: 'component-known' };
  assert.equal(c.resolveNodeReferences({ components: [{ id: 'component-known' }] }, raw).component.state, 'resolved');
});
test('explicit unknown componentId is not skipped to a known componentKey', () => {
  const raw = { type: 'INSTANCE', componentId: { state: 'unknown' }, componentKey: 'synthetic-key' };
  assert.equal(c.resolveNodeReferences({ components: [{ id: 'component-known', key: 'synthetic-key' }] }, raw).component.state, 'unknown');
});
test('a known unmatched componentId never silently substitutes a different component via key', () => {
  const raw = { type: 'INSTANCE', componentId: 'unmatched-id', componentKey: 'synthetic-key' };
  const result = c.resolveNodeReferences({ components: [{ id: 'different-id', key: 'synthetic-key' }] }, raw).component;
  assert.equal(result.state, 'unknown'); assert.equal(result.id, 'unmatched-id'); assert.equal(Object.hasOwn(result, 'value'), false);
});
test('duplicate component keys remain ambiguous rather than selecting the first record', () => {
  const result = c.resolveNodeReferences({ components: [{ id: 'one', key: 'same-key' }, { id: 'two', key: 'same-key' }] }, { componentKey: 'same-key' }).component;
  assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'duplicate-component-key'); assert.equal(Object.hasOwn(result, 'value'), false);
});
test('component key without a canonical record ID cannot invent stable identity', () => {
  const result = c.resolveNodeReferences({ components: [{ key: 'synthetic-key', name: 'Not an ID' }] }, { componentKey: 'synthetic-key' }).component;
  assert.equal(result.state, 'unknown'); assert.equal(result.reason, 'component-key-missing-id');
});
test('normalized componentId ancestor metadata resolves by the same directory', () => {
  const d = normalize([node('42:2', { type: 'INSTANCE', componentId: 'component-known', children: [node('42:3')] })], { components: [{ id: 'component-known', remote: false }] });
  const result = c.resolveNodeReferences(d, d.all[2]); assert.equal(result.context[0].componentId, 'component-known'); assert.equal(result.context[0].referenceState, 'resolved'); assert.equal(result.context[0].locality, 'local');
});
test('normalized componentKey ancestor metadata uses the real ID rather than the key as ID', () => {
  const d = normalize([node('42:2', { type: 'INSTANCE', componentKey: 'synthetic-key', children: [node('42:3')] })], { components: [{ id: 'component-known', key: 'synthetic-key', remote: true }] });
  const result = c.resolveNodeReferences(d, d.all[2]); assert.equal(result.context[0].componentKey, 'synthetic-key'); assert.equal(result.context[0].componentId, 'component-known'); assert.equal(result.context[0].referenceState, 'resolved'); assert.equal(result.context[0].locality, 'remote');
});
test('missing raw directory may use a valid normalized components directory', () => {
  const entry = { id: 'component-known', remote: false }, normalizedDirectory = { all: [], raw: {}, components: [entry], componentsState: 'known' };
  const result = c.resolveNodeReferences(normalizedDirectory, { componentId: entry.id }).component; assert.equal(result.state, 'resolved'); assert.equal(result.value, entry);
});
test('explicit unknown raw components directory blocks a normalized placeholder fallback', () => {
  const directory = { all: [], raw: { components: { state: 'unknown' } }, components: [{ id: 'component-known', remote: false }], componentsState: 'known' };
  const result = c.resolveNodeReferences(directory, { componentId: 'component-known' }).component; assert.equal(result.state, 'unknown'); assert.equal(Object.hasOwn(result, 'value'), false);
});
test('componentId/key lookup preserves frozen input and does not infer identity from names', () => {
  const entry = Object.freeze({ id: 'component-known', key: 'synthetic-key', name: 'Same name' }), directory = Object.freeze({ components: Object.freeze([entry]) });
  const raw = Object.freeze({ type: 'INSTANCE', componentKey: 'synthetic-key' }); const before = JSON.stringify({ directory, raw });
  assert.equal(c.resolveNodeReferences(directory, raw).component.state, 'resolved'); assert.equal(c.resolveNodeReferences(directory, { componentKey: 'Same name' }).component.state, 'unknown'); assert.equal(JSON.stringify({ directory, raw }), before);
});


