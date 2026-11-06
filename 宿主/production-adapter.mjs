// New same-origin browser adapter; no synthetic sessions, fixture IDs or credentials.
const levels = new Set([64, 256, 1024, 2048])
const validId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value)
const check = (condition, message) => { if (!condition) throw new TypeError(message) }
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
function filename(header, fallback) {
  const encoded = header?.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)
  let value = fallback
  if (encoded) { try { value = decodeURIComponent(encoded[1].trim()) } catch { throw new TypeError('下载文件名编码无效') } }
  else { const plain = header?.match(/filename\s*=\s*"([^"]*)"/i); if (plain) value = plain[1] }
  return String(value).replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, 220) || fallback
}

export function createProductionAdapter({ context, baseURL = globalThis.location?.origin,
  fetchImpl = globalThis.fetch?.bind(globalThis), windowObject = globalThis.window, requestTimeoutMs = 60000 } = {}) {
  const base = new URL(baseURL)
  check(['http:', 'https:'].includes(base.protocol) && !base.username && !base.password && base.pathname === '/' && !base.search && !base.hash, '必须使用无凭据同源根地址')
  if (windowObject?.location) check(base.origin === windowObject.location.origin, '生产适配器不能跨源')
  check(context && validId(context.projectId) && validId(context.designFileId) && typeof fetchImpl === 'function', '生产上下文或传输能力无效')
  let currentContext = { ...context }, frameDirectory = new Map()
  const snapshots = new Map()
  const makeURL = value => {
    const url = new URL(value, base)
    check(url.origin === base.origin && !url.username && !url.password && !url.hash && url.href.length <= 8192 && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/viewer/')), '拒绝非同源资源地址')
    return url.href
  }
  async function boundedRequest(route, { signal, method = 'GET', json = true } = {}) {
    const controller = new AbortController(), abort = () => controller.abort(signal?.reason)
    if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(new DOMException('请求超时', 'TimeoutError')), requestTimeoutMs)
    let reader
    try {
      const response = await fetchImpl(makeURL(route), { method, signal: controller.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
      if (!response.ok) throw Object.assign(new Error(`生产接口拒绝请求：HTTP ${response.status}`), { status: response.status })
      check(response.type !== 'opaque', '拒绝不透明响应')
      if (response.url) makeURL(response.url)
      if (!json) return response
      check(response.headers.get('content-type')?.split(';')[0].trim() === 'application/json', '接口返回非JSON格式')
      const limit = route.startsWith('/api/inspector/frames/') ? 65 * 1024 * 1024 : 8 * 1024 * 1024
      const length = response.headers.get('content-length')
      check(length && /^\d+$/.test(length) && Number.isSafeInteger(Number(length)) && Number(length) > 0 && Number(length) <= limit, 'JSON响应长度无效或超过预算')
      check(response.body?.getReader, 'JSON响应缺少有界流能力')
      reader = response.body.getReader(); const chunks = []; let bytes = 0
      while (true) {
        const part = await reader.read(); if (part.done) break
        bytes += part.value.byteLength; check(bytes <= limit && bytes <= Number(length), 'JSON实际流超过声明或预算'); chunks.push(part.value)
      }
      check(bytes === Number(length), 'JSON实际流长度不完整')
      const all = new Uint8Array(bytes); let offset = 0
      for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.byteLength }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(all))
    } catch (error) { try { await reader?.cancel() } catch { /* Hold this request until its stream cancellation settles. */ } throw error }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); reader?.releaseLock() }
  }
  async function metadata(route, signal, image = true) {
    const response = await boundedRequest(route, { signal, method: 'HEAD', json: false })
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(), raw = response.headers.get('content-length')
    check(raw && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0, '资源必须有实际完整字节长度')
    const result = { url: makeURL(route), mime, byteLength: Number(raw) }
    if (image) {
      const width = Number(response.headers.get('x-heron-preview-width')), height = Number(response.headers.get('x-heron-preview-height'))
      check(['image/jpeg', 'image/png'].includes(mime) && Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0, '生产衍生物缺少真实格式或尺寸')
      Object.assign(result, { width, height })
    }
    return { result, response }
  }
  const identity = options => check(validId(options?.frameId) && validId(options?.revisionId), '画板或版本身份无效')
  const ownership = (assetId, options) => {
    identity(options); check(validId(assetId), '资源身份无效')
    const snapshot = snapshots.get(`${options.frameId}/${options.revisionId}`), frame = frameDirectory.get(options.frameId)
    const known = snapshot && [...snapshot.assets, ...snapshot.slices].some(asset => asset.assetId === assetId)
    check(known || frame && frame.revisionId === options.revisionId && frame.previewAsset?.assetId === assetId, '资源不属于选定画板版本')
  }
  const adapter = {
    get context() { return currentContext },
    async listFrames({ signal, designFileId } = {}) {
      if (designFileId !== undefined) check(validId(designFileId), '文件身份无效')
      const query = designFileId ? '?designFileId=' + encodeURIComponent(designFileId) : ''
      const data = await boundedRequest(`/api/inspector/projects/${encodeURIComponent(currentContext.projectId)}/directory${query}`, { signal })
      check(data.projectId === currentContext.projectId && Array.isArray(data.frames), '项目轻目录身份不符')
      for (const row of data.frames) check(validId(row.frameId) && row.projectId === currentContext.projectId && validId(row.designFileId) && validId(row.pageId) && validId(row.revisionId), '目录中出现无效身份')
      const groups = data.groups === undefined ? [] : data.groups
      check(Array.isArray(groups) && groups.length <= 1000, '项目分组目录无效')
      for (const group of groups) check(validId(group.id) && validId(group.projectId) && group.projectId === currentContext.projectId && typeof group.name === 'string' && group.name.length <= 128, '项目分组身份无效')
      frameDirectory = new Map(data.frames.map(row => [row.frameId, row])); currentContext = { ...currentContext, permissions: data.permissions }
      Object.defineProperty(data.frames, 'groups', { value: groups, enumerable: false });
      if (designFileId) {
        check(data.context?.projectId === currentContext.projectId && data.context.designFileId === designFileId, '所选文件上下文缺失或不符')
        currentContext = data.context
        return { frames: data.frames, context: currentContext, groups }
      }
      return data.frames
    },
    async listRevisions(frameId, { signal } = {}) {
      check(validId(frameId), '画板标识无效')
      const data = await boundedRequest(`/api/frames/${encodeURIComponent(frameId)}/revisions`, { signal })
      check(data.frameId === frameId && validId(data.currentRevisionId) && Array.isArray(data.revisions), '版本目录身份不符')
      return data.revisions.map(row => { check(validId(row.id) && (!row.frameId || row.frameId === frameId), '版本标识无效'); return { ...row, frameId, revisionId: row.id, current: row.id === data.currentRevisionId, viewerUrl: `/viewer/r/${encodeURIComponent(frameId)}?revision=${encodeURIComponent(row.id)}` } })
    },
    async loadRevision(frameId, revisionId, { signal } = {}) {
      identity({ frameId, revisionId })
      if (revisionId === 'current') {
        const revisions = await adapter.listRevisions(frameId, { signal }), current = revisions.find(row => row.current === true)
        check(current && validId(current.revisionId), '当前版本身份不存在')
        revisionId = current.revisionId
      }
      const data = await boundedRequest(`/api/inspector/frames/${encodeURIComponent(frameId)}/revisions/${encodeURIComponent(revisionId)}`, { signal })
      check(data.identity?.frameId === frameId && data.identity?.revisionId === revisionId && data.identity.projectId === currentContext.projectId && data.layerDoc && Array.isArray(data.assets) && Array.isArray(data.slices), '所选完整版本身份不符')
      for (const asset of [...data.assets, ...data.slices]) check(validId(asset.assetId) && asset.frameId === frameId && asset.revisionId === revisionId && Number.isSafeInteger(asset.byteLength) && asset.byteLength > 0, '版本资源声明无效')
      if (data.context) { check(data.context.projectId === currentContext.projectId && data.context.designFileId === data.identity.designFileId, '跨文件上下文身份不符'); currentContext = data.context }
      snapshots.set(`${frameId}/${revisionId}`, data)
      while (snapshots.size > 8) snapshots.delete(snapshots.keys().next().value)
      return data
    },
    async getPreview(assetId, options) {
      ownership(assetId, options); check(levels.has(options.maxDimension), 'LOD不在允许集合')
      const alpha=options.variant==='slice-alpha';check(options.variant===undefined||alpha,'预览变体无效')
      if(alpha){const snapshot=snapshots.get(`${options.frameId}/${options.revisionId}`);check(snapshot?.slices.some(slice=>slice.assetId===assetId),'切图不属于选定画板版本')}
      const route=alpha?`/api/previews/${encodeURIComponent(assetId)}/slice/${options.maxDimension}.png`:`/api/previews/${encodeURIComponent(assetId)}/${options.maxDimension}.jpg`
      const { result } = await metadata(route, options.signal)
      check(result.mime === (alpha?'image/png':'image/jpeg') && result.width <= options.maxDimension && result.height <= options.maxDimension, alpha?'实际PNG层级不符':'实际JPEG层级不符')
      return { ...result, assetId, frameId: options.frameId, revisionId: options.revisionId }
    },
    async getNativeTile(assetId, options) {
      ownership(assetId, options)
      check(options.tileSize === 512 && Number.isSafeInteger(options.x) && options.x >= 0 && Number.isSafeInteger(options.y) && options.y >= 0, '原生图块索引无效')
      const x = options.x * 512, y = options.y * 512; check(Number.isSafeInteger(x) && Number.isSafeInteger(y), '原生像素偏移溢出')
      const { result } = await metadata(`/api/previews/${encodeURIComponent(assetId)}/native/${x}_${y}.png`, options.signal)
      check(result.mime === 'image/png' && result.width <= 512 && result.height <= 512, '实际原生图块格式或尺寸不符')
      return { ...result, assetId, frameId: options.frameId, revisionId: options.revisionId }
    },
    async loadAsset(assetId, options) {
      ownership(assetId, options)
      const snapshot = snapshots.get(`${options.frameId}/${options.revisionId}`), source = [...(snapshot?.assets || []), ...(snapshot?.slices || [])].find(asset => asset.assetId === assetId)
      check(source && Number.isSafeInteger(source.width) && Number.isSafeInteger(source.height), '原资源缺少可信像素尺寸')
      const { result } = await metadata(`/api/assets/${encodeURIComponent(assetId)}`, options.signal, false)
      check(result.mime === source.mime && result.byteLength === source.byteLength, '原资源实际格式长度不符')
      return { ...source, ...result }
    },
    async getSliceDownloadUrl(frameId, revisionId, { kind, sliceId, signal } = {}) {
      identity({ frameId, revisionId }); check(kind === 'zip' || kind === 'slice', '下载类型不支持')
      const snapshot = snapshots.get(`${frameId}/${revisionId}`); check(snapshot && snapshot.slices.length, '该版本没有切图或尚未完成加载')
      let route = `/api/inspector/frames/${encodeURIComponent(frameId)}/revisions/${encodeURIComponent(revisionId)}/slices`
      if (kind === 'zip') route += '.zip'
      else { check(validId(sliceId) && snapshot.slices.some(row => row.sliceId === sliceId || row.id === sliceId), '切图不属于所选版本'); route += `/${encodeURIComponent(sliceId)}/download` }
      const { result, response } = await metadata(route, signal, false)
      check(kind === 'zip' ? result.mime === 'application/zip' : ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(result.mime), '下载实际MIME不符')
      return { ...result, frameId, revisionId, filename: filename(response.headers.get('content-disposition'), kind === 'zip' ? 'frame-revision-slices.zip' : 'slice.bin') }
    },
    onNavigate({ frameId, revisionId, replace = false }) {
      identity({ frameId, revisionId }); if (!windowObject?.history) return
      const url = makeURL(`/viewer/r/${encodeURIComponent(frameId)}?revision=${encodeURIComponent(revisionId)}`)
      if (windowObject.location.href === url) return
      windowObject.history[replace ? 'replaceState' : 'pushState']({ independentInspector: true, frameId, revisionId }, '', url)
    },
    resolveLocation() {
      if (!windowObject?.location) return null
      const url = new URL(windowObject.location.href), match = url.pathname.match(/^\/viewer\/r\/([\w-]+)$/), revisionId = url.searchParams.get('revision')
      if (!match || !validId(revisionId)) return null
      return { frameId: match[1], revisionId, mode: 'frame' }
    }
  }
  return adapter
}

export async function startProductionInspector(windowObject = window, documentObject = document) {
  const node = documentObject.getElementById('inspector-context'), container = documentObject.getElementById('inspector-root')
  check(node && container, '生产挂载上下文不存在')
  const context = JSON.parse(node.textContent)
  check(own(context, 'frameId') && validId(context.frameId) && validId(context.revisionId), '生产路由身份无效')
  const adapter = createProductionAdapter({ context, baseURL: windowObject.location.origin, windowObject })
  const { mountInspector } = await import('./index.mjs')
  const inspector = mountInspector(container, { adapter, initialFrameId: context.frameId, initialRevisionId: context.revisionId, initialMode: 'frame' })
  windowObject.independentInspector = inspector
  await inspector.ready
  return inspector
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') startProductionInspector().catch(error => {
  const container = document.getElementById('inspector-root'); if (container) container.textContent = '标注加载失败：' + (error?.message || '未知错误')
})
