const levels = new Set([64, 256, 1024, 2048]);
const framePattern = /^frame-\d+$/;
const revisionPattern = /^revision-\d+-(?:current|old)$/;
function check(condition, message) { if (!condition) throw new TypeError(message); }

// This module performs metadata HEADs, never decodes or downloads a whole
// source image. Actual image GET scheduling belongs to the viewer owner.
export function createBrowserAdapter({ baseUrl = globalThis.location?.origin, fetchImpl = globalThis.fetch } = {}) {
  const base = new URL(baseUrl);
  check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, 'Same-origin adapter base');
  if (globalThis.location) check(base.origin === globalThis.location.origin, 'Browser adapter must be same-origin');
  const urlFor = route => {
    const url = new URL(route, base);
    check(url.origin === base.origin && !url.username && !url.password, 'Adapter URL origin'); return url.href;
  };
  async function request(route, { signal, method = 'GET', body } = {}) {
    const response = await fetchImpl(urlFor(route), { method, signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store', ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    if (!response.ok) throw new Error('Synthetic host HTTP ' + response.status);
    return response;
  }
  async function json(route, options = {}) {
    const response = await request(route, options);
    check(response.headers.get('content-type')?.split(';')[0] === 'application/json', 'Adapter JSON MIME');
    const length = Number(response.headers.get('content-length'));
    check(Number.isSafeInteger(length) && length > 0 && length <= 8 * 1024 * 1024, 'Adapter JSON budget');
    return response.json();
  }
  function identity(frameId, revisionId) {
    check(framePattern.test(frameId) && revisionPattern.test(revisionId) && revisionId.split('-')[1] === frameId.slice(6), 'Frame/revision ownership');
  }
  function asset(assetId, options) {
    identity(options.frameId, options.revisionId);
    check(assetId === options.frameId + '.' + options.revisionId, 'Asset/frame/revision ownership');
  }
  async function metadata(route, signal, image = true) {
    const response = await request(route, { method: 'HEAD', signal });
    const mime = response.headers.get('content-type')?.split(';')[0], byteLength = Number(response.headers.get('content-length'));
    check(Number.isSafeInteger(byteLength) && byteLength > 0, 'Actual asset byteLength');
    const result = { url: urlFor(route), mime, byteLength };
    if (image) {
      const width = Number(response.headers.get('x-fixture-width')), height = Number(response.headers.get('x-fixture-height'));
      check(['image/png', 'image/jpeg'].includes(mime) && Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0, 'Actual PNG dimensions');
      Object.assign(result, { width, height });
    }
    return { result, headers: response.headers };
  }
  const adapter = {
    async createDemoSession({ signal } = {}) { return json('/api/demo/session', { method: 'POST', body: {}, signal }); },
    async listFrames({ signal } = {}) { return (await json('/api/frames', { signal })).frames; },
    async listRevisions(frameId, { signal } = {}) {
      check(framePattern.test(frameId), 'Frame ID');
      return (await json('/api/frames/' + encodeURIComponent(frameId) + '/revisions', { signal })).revisions;
    },
    async loadRevision(frameId, revisionId, { signal } = {}) {
      identity(frameId, revisionId);
      const data = await json('/api/frames/' + frameId + '/document?revision=' + encodeURIComponent(revisionId), { signal });
      check(data.identity?.frameId === frameId && data.identity?.revisionId === revisionId && Array.isArray(data.assets) && data.assets.every(a => a.byteLength > 0), 'Revision metadata identity');
      return data;
    },
    async getPreview(assetId, options) {
      asset(assetId, options); check(levels.has(options.maxDimension), 'Preview dimension');
      return (await metadata('/api/fixture-images/' + options.frameId + '/' + options.revisionId + '/preview/' + options.maxDimension, options.signal)).result;
    },
    async getNativeTile(assetId, options) {
      asset(assetId, options);
      check(options.tileSize === 512 && Number.isSafeInteger(options.x) && options.x >= 0 && Number.isSafeInteger(options.y) && options.y >= 0, 'Native tile indices');
      return (await metadata('/api/fixture-images/' + options.frameId + '/' + options.revisionId + '/tile/' + options.x + '_' + options.y, options.signal)).result;
    },
    async loadAsset(assetId, options) {
      asset(assetId, options);
      return (await metadata('/api/assets/' + encodeURIComponent(assetId), options.signal)).result;
    },
    async getSliceDownloadUrl(frameId, revisionId, { kind, sliceId, signal } = {}) {
      identity(frameId, revisionId); check(kind === 'zip' || kind === 'slice', 'Download kind');
      if (kind === 'slice') check(['slice-owned-svg', 'slice-owned-png'].includes(sliceId), 'Slice ID');
      const query = new URLSearchParams({ frame: frameId, revision: revisionId, ...(kind === 'slice' ? { sliceId } : {}) });
      const { result, headers } = await metadata('/api/demo/' + (kind === 'zip' ? 'zip' : 'slice') + '?' + query, signal, false);
      const filename = headers.get('content-disposition')?.match(/filename="([\w.-]+)"/)?.[1];
      check(filename && (kind === 'zip' ? result.mime === 'application/zip' : ['image/png', 'image/svg+xml'].includes(result.mime)), 'Download actual metadata');
      return { ...result, filename };
    }
  };
  adapter.previewAsset = (assetId, options) => adapter.getPreview(assetId, options);
  return adapter;
}

export async function startDemoBrowser(windowObject = window, documentObject = document) {
  const container = documentObject.getElementById('inspector-root');
  if (!container) throw new Error('Synthetic inspector mount missing');
  const adapter = createBrowserAdapter({ baseUrl: windowObject.location.origin });
  await adapter.createDemoSession();
  const { mountInspector } = await import('../查看器/index.mjs');
  const route = windowObject.location.pathname.match(/^\/viewer\/r\/(frame-\d+)$/);
  const initialRevisionId = new URL(windowObject.location.href).searchParams.get('revision') || undefined;
  const inspector = mountInspector(container, { adapter, initialFrameId: route?.[1], initialRevisionId });
  windowObject.ownedInspector = inspector; // Explicit synthetic diagnostics only.
  await inspector.ready; return inspector;
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  startDemoBrowser().catch(error => {
    const container = document.getElementById('inspector-root');
    if (container) container.textContent = '合成宿主加载失败：' + error.message;
  });
}
