// ESM entry for Parent's allowlisted packbuilder. No JSX or external runtime.
import { TaskBudget, fail, id, record, checkCancelled, safeError } from './core.mjs';
import { createExporter, eligibleFrames } from './exporter.mjs';
import { buildPublication, createPublisher } from './publisher.mjs';
import { createBridge, createFigmaTransport } from './bridge.mjs';
import { CHANNEL, validateOperation, validateOperationResult } from './protocol.mjs';
import { ProductionError, validateProductionOperation, validateProductionOperationResult, validateRememberedLogin, validateSource, validateCommitResult, customHTTPSOrigin } from './production-protocol.mjs';
import { createProductionSession, listProductionFrames, readPublicFileSource } from './production-session.mjs';

export function startPlugin(sdk, html, { iframeOrigin = 'null', storageKey = 'independent-inspector.publish.pending.v1', production = null } = {}) {
  if (production) return startProductionPlugin(sdk, html, { iframeOrigin, storageKey, production });
  if (sdk.editorType !== 'figma') fail('SDK_CAPABILITY_MISSING');
  let height = 640; let counter = 0; let busy = false; let publisher = null; let currentService = null; let closing = false;
  const makeRequestId = () => `main-${++counter}`;
  let saved = null;
  const recovery = (async () => {
    if (!sdk.clientStorage?.getAsync) return;
    try { saved = await sdk.clientStorage.getAsync(storageKey); } catch { fail('SDK_READ_FAILED'); }
    if (saved && !['preparing', 'prepared', 'uploading', 'committing', 'unknownCommit', 'unknownPrepare'].includes(saved.phase)) saved = null;
  })();
  let bridge;
  const cryptoProxy = { subtle: { async digest(algorithm, bytes) {
    if (algorithm !== 'SHA-256') fail('BAD_SCHEMA');
    const result = await bridge.request('digest', { bytes });
    return result.digest.buffer.slice(result.digest.byteOffset, result.digest.byteOffset + result.digest.byteLength);
  } } };
  const exporter = createExporter(sdk, { cryptoAPI: cryptoProxy });
  const notify = state => { void bridge.request('notice', { state }).catch(() => {}); };
  const getPublisher = async service => {
    await recovery;
    if (publisher) {
      if (JSON.stringify(service) === JSON.stringify(currentService)) return publisher;
      if (publisher.status().locked) fail('UNKNOWN_COMMIT');
      if (publisher.status().queue.pending) fail('BUSY');
      // A new explicit service is allowed only after confirmed terminal work.
      publisher = null;
    }
    if (saved && JSON.stringify(saved.service) !== JSON.stringify(service)) fail('UNKNOWN_COMMIT');
    currentService = { ...service };
    const call = (method, manifest, sessionId, descriptor, bytes, context = {}) => bridge.request('network', { method, service: currentService, manifest, sessionId, descriptor, bytes, wireRequestId: context.requestId }, { signal: context.signal });
    const adapter = {
      prepare: (manifest, context) => call('prepare', manifest, null, null, null, context),
      upload: (sessionId, descriptor, bytes, context) => call('upload', null, sessionId, descriptor, bytes, context),
      commit: (sessionId, context) => call('commit', null, sessionId, null, null, context),
      query: (sessionId, context) => call('query', null, sessionId, null, null, context),
      abort: (sessionId, context) => call('abort', null, sessionId, null, null, context)
    };
    publisher = createPublisher(adapter, {
      makeRequestId,
      onState: notify,
      async journal(state) {
        const pending = ['preparing', 'prepared', 'uploading', 'committing', 'unknownCommit', 'unknownPrepare'].includes(state.phase);
        const entry = pending ? { phase: state.phase, sessionId: state.sessionId, requestId: state.requestId, sessionQuery: state.sessionQuery, service: currentService } : null;
        if (sdk.clientStorage?.setAsync) await sdk.clientStorage.setAsync(storageKey, entry);
        saved = entry;
      }
    });
    if (saved) publisher.restore(saved);
    return publisher;
  };
  const collect = async (payload, context, shouldPublish) => {
    if (busy || closing) fail('BUSY');
    await recovery;
    if (busy || closing) fail('BUSY');
    if (shouldPublish && (saved || publisher?.status().locked)) {
      if (!publisher) await getPublisher(saved.service);
      fail('UNKNOWN_COMMIT');
    }
    busy = true;
    try {
      const selection = eligibleFrames(sdk, payload.scope);
      const bindings = new Map();
      for (const binding of payload.bindings) {
        if (bindings.has(binding.figmaNodeId)) fail('BAD_SCHEMA');
        bindings.set(binding.figmaNodeId, { identity: binding.identity, expectedRevisionId: binding.expectedRevisionId });
      }
      if (bindings.size !== selection.frames.length || selection.frames.some(frame => !bindings.has(frame.id))) fail('DOCUMENT_CHANGED');
      const budget = new TaskBudget();
      const exported = await exporter.exportFrames(selection.frames, {
        signal: context.signal, scale: payload.scale, includeSlices: payload.includeSlices, chunkCapacity: payload.chunkCapacity, budget,
        onProgress: state => notify({ phase: 'exporting', ...state })
      });
      checkCancelled(context.signal);
      const publication = await buildPublication(exported, bindings, { budget, cryptoAPI: cryptoProxy, signal: context.signal });
      const eligibility = { scope: selection.scope, pageId: selection.pageId, count: selection.frames.length, excluded: selection.excluded };
      if (!shouldPublish) return { manifest: publication.manifest, assets: [...publication.assets.values()], eligibility, verification: 'SDK_BYTES_UNVERIFIED_DEVICE' };
      const instance = await getPublisher(payload.service);
      const result = await instance.publish(publication, { signal: context.signal });
      return { publication: result, state: instance.status() };
    } finally { busy = false; }
  };
  const handlers = {
    async hello() { await recovery; return { product: 'Independent Inspector · Development', height, state: publisher?.status() || saved || { phase: 'idle' }, verification: 'DEVICE_VALIDATION_PENDING' }; },
    list(payload) {
      const selection = eligibleFrames(sdk, payload.scope);
      const frames = selection.frames.map(frame => {
        let bounds = null; try { bounds = frame.absoluteBoundingBox ?? null; } catch { /* Explicit unknown metadata only. */ }
        return { id: id(frame.id), name: frame.name, absoluteBoundingBox: bounds };
      });
      return { scope: selection.scope, pageId: selection.pageId, frames, excluded: selection.excluded };
    },
    resize(payload) { height = payload.height; sdk.ui.resize(480, height); return { width: 480, height }; },
    export: (payload, context) => collect(payload, context, false),
    publish: (payload, context) => collect(payload, context, true),
    async query(_payload, context) { await recovery; if (!publisher && saved) await getPublisher(saved.service); if (!publisher || busy) fail('BUSY'); return publisher.query(context); },
    async abort() { await recovery; if (!publisher && saved) await getPublisher(saved.service); if (!publisher || busy) fail('BUSY'); await publisher.abort(); return publisher.status(); },
    async close() {
      if (busy || exporter.queue.snapshot().pending || publisher?.status().queue.pending) fail('BUSY');
      closing = true;
      // Respond once; only then close the channel/UI after all physical work.
      setTimeout(() => { void bridge.close().then(() => sdk.closePlugin()).catch(() => {}); }, 0);
      return { accepted: true };
    }
  };
  bridge = createBridge({ ...createFigmaTransport(sdk, iframeOrigin), channel: CHANNEL, handlers, validateRequest: validateOperation, validateResult: validateOperationResult, makeRequestId });
  sdk.showUI(html, { width: 480, height: 640, title: '{{BRAND_PLUGIN_NAME}}', themeColors: true });
  return { bridge, exporter, status: () => ({ busy, height, publisher: publisher?.status() || saved || { phase: 'idle' } }), async dispose() { closing = true; await bridge.close(); await exporter.queue.drain(); await publisher?.drain(); } };
}

export function startProductionPlugin(sdk, html, { iframeOrigin = 'null', storageKey = 'independent-inspector.publish.pending.v1', production = {} } = {}) {
  if (sdk.editorType !== 'figma') fail('SDK_CAPABILITY_MISSING');
  const config = production === true ? {} : production;
  const pendingKey = `${storageKey}.production`; const rememberKey = `${storageKey}.production-refresh`;
  let height = 640; let counter = 0; let closing = false; let instance = null; let currentService = null; let bridge;
  let preflightBusy = false, writerNamespace = null;
  const makeRequestId = () => `production-main-${++counter}`;
  const storage = sdk.clientStorage;
  // C28: history is not a queue. Remove only this plugin's retired publication
  // keys; never touch remembered credentials or another plugin's storage.
  const discardHistory = (async () => {
    if (!storage?.deleteAsync) return;
    let keys = [storageKey, pendingKey];
    try { if (storage.keysAsync) keys.push(...(await storage.keysAsync()).filter(key => typeof key === 'string' && key.startsWith(`${pendingKey}.journal.`))); } catch {}
    await Promise.all([...new Set(keys)].map(key => storage.deleteAsync(key).catch(() => {})));
  })();
  const sameService = (a, b) => record(a) && record(b) && a.origin === b.origin && a.allowLocalhost === b.allowLocalhost;
  const cryptoProxy = { subtle: { async digest(algorithm, bytes) {
    if (algorithm !== 'SHA-256') fail('BAD_SCHEMA'); const value = await bridge.request('digest', { bytes });
    return value.digest.buffer.slice(value.digest.byteOffset, value.digest.byteOffset + value.digest.byteLength);
  } } };
  const exporter = createExporter(sdk, { cryptoAPI: cryptoProxy });
  const snapshot = () => ({ ...(instance?.status() || { phase: 'idle', locked: false, verified: false, sourceBinding: { mode: readPublicFileSource(sdk) ? 'sdk' : 'launch', manualAvailable: readPublicFileSource(sdk) === null, canBind: false, canConfirmRecovery: false, projectId: null } }), production: true, config: { origin: config.serviceMode === 'custom-https' ? '' : config.serviceOrigin || '', allowLocalhost: config.serviceMode !== 'custom-https' && config.allowLocalhost === true, ...(config.serviceMode === 'custom-https' ? { serviceMode: 'custom-https' } : {}) }, service: currentService, rememberSupported: Boolean(storage?.getAsync && storage?.setAsync) });
  const notify = state => { void bridge.request('notice', { state: { ...state, production: true } }).catch(() => {}); };
  const gate = async worker => {
    if (preflightBusy) fail('BUSY'); preflightBusy = true;
    try { return await worker(); } finally { preflightBusy = false; }
  };
  const connect = payload => gate(async () => {
    if (closing || instance?.status().busy) fail('BUSY');
    const service = payload.service;
    const allowedOrigins = config.serviceOrigins || (config.serviceOrigin ? [config.serviceOrigin.replace(/\/$/, '')] : []);
    if (config.serviceMode === 'custom-https') {
      if (service.allowLocalhost || customHTTPSOrigin(service.origin) !== service.origin) fail('BAD_ORIGIN');
    } else if (allowedOrigins.length && !allowedOrigins.includes(service.origin) || service.allowLocalhost && config.allowLocalhost !== true) fail('BAD_ORIGIN');
    if (instance && !sameService(currentService, service)) {
      const state = instance.status();
      if (state.locked || ['unknownPrepare','unknownCommit','unknownClaim','unknownFinish','verificationPending','partial'].includes(state.phase) || state.phase === 'committed' && state.verified !== true) fail('UNKNOWN_COMMIT');
    }
    if (writerNamespace && writerNamespace !== payload.namespace) fail('BAD_SCHEMA');
    if (instance && sameService(currentService, service)) return instance;
    writerNamespace = payload.namespace;
    const call = async (method, args, context = {}) => {
      const response = await bridge.request('production-network', { method, service: { ...service }, args }, { signal: context.signal });
      if (!response.ok) throw new ProductionError(response.error.code, response.error);
      return response.value;
    };
    const adapter = {
      projects: context => call('projects', [], context),
      intent: (projectId, context) => call('intent', [projectId], context),
      claim: (input, context) => call('claim', [input], context),
      queryOperation: (op, context) => call('queryOperation', [op], context),
      finish: (op, version, context) => call('finish', [op, version], context),
      cancelOperation: (op, context) => call('cancelOperation', [op], context),
      publishSource: (p, body, op, context) => call('publishSource', [p, body, op], context),
      prepare: (body, op, index, context) => call('prepare', [body, op, index], context),
      upload: (sid, asset, op, context) => call('upload', [sid, asset, op], context),
      commit: (sid, op, context) => call('commit', [sid, op], context),
      query: (sid, context) => call('query', [sid], context),
      queryCommitResult: (sid, context) => call('queryCommitResult', [sid], context),
      abort: (sid, op, context) => call('abort', [sid, op], context),
      verifyPublication: (projectId, groupId, frames, context) => call('verifyPublication', [projectId, groupId, frames], context)
    };
    currentService = { ...service };
    instance = createProductionSession({ sdk, adapter, namespace: payload.namespace, exporter, cryptoAPI: cryptoProxy, onState: notify, discardHistory: true });
    return instance;
  });
  const frameListeners = [];
  let observedPage = null;
  const changed = () => { if (!closing && bridge) void bridge.request('frames-changed', {}).catch(() => {}); };
  const followPage = () => {
    if (observedPage?.off) observedPage.off('nodechange', changed);
    observedPage = sdk.currentPage;
    if (observedPage?.on) observedPage.on('nodechange', changed);
    changed();
  };
  if (sdk.on) {
    sdk.on('selectionchange', changed); frameListeners.push(['selectionchange', changed]);
    sdk.on('currentpagechange', followPage); frameListeners.push(['currentpagechange', followPage]);
  }
  followPage();
  const releaseFrameListeners = () => {
    if (observedPage?.off) observedPage.off('nodechange', changed);
    for (const [event, listener] of frameListeners) sdk.off?.(event, listener);
  };
  const handlers = {
    async hello() { await discardHistory; return { product: 'Independent Inspector · Development', height, state: snapshot(), verification: 'DEVICE_VALIDATION_PENDING' }; },
    list(payload) { const selection = listProductionFrames(sdk, payload.scope); return { scope: selection.scope, pageId: selection.pageId, frames: selection.frames.map(f => ({ id: id(f.id), name: f.name, absoluteBoundingBox: f.absoluteBoundingBox ?? null })), excluded: selection.excluded }; },
    resize(payload) { height = payload.height; sdk.ui.resize(480, height); return { width: 480, height }; },
    async 'production-source-binding'(payload, context) {
      if (closing) fail('CLOSED'); if (!instance) fail('BAD_SCHEMA');
      return instance.bindSource(payload, context);
    },
    async 'production-control'(payload, context) {
      if (closing) fail('CLOSED');
      if (payload.action === 'connect-account' || payload.action === 'connect') { await connect(payload); return { state: snapshot() }; }
      if (payload.action === 'status') return { state: snapshot() };
      if (payload.action === 'remember-read') { if (!storage?.getAsync || !storage?.setAsync) return { supported: false, remembered: null }; try { const value = await storage.getAsync(rememberKey); return { supported: true, remembered: value ? validateRememberedLogin(value) : null }; } catch { return { supported: false, remembered: null }; } }
      if (payload.action === 'remember-write' || payload.action === 'remember-clear') {
        if (!storage?.setAsync || !storage?.getAsync) fail('SDK_CAPABILITY_MISSING');
        await storage.setAsync(rememberKey, payload.action === 'remember-write' ? payload.remembered : null); return { accepted: true };
      }
      if (!instance) fail('BAD_SCHEMA');
      if (payload.action === 'publish') return gate(async () => {
        const state = instance.status();
        if (config.serviceMode === 'custom-https' && (state.locked || ['unknownPrepare','unknownCommit','unknownClaim','unknownFinish','verificationPending','partial'].includes(state.phase) || state.phase === 'committed' && state.verified !== true)) fail('UNKNOWN_COMMIT');
        const { action, ...input } = payload; return instance.publish(input, context);
      });
      fail('BAD_SCHEMA');
    },
    async close() {
      if (preflightBusy || instance?.status().busy || exporter.queue.snapshot().pending) fail('BUSY'); closing = true; releaseFrameListeners();
      setTimeout(() => { void bridge.close().then(() => sdk.closePlugin()).catch(() => {}); }, 0); return { accepted: true };
    }
  };
  bridge = createBridge({ ...createFigmaTransport(sdk, iframeOrigin), channel: CHANNEL, handlers, validateRequest: validateProductionOperation, validateResult: validateProductionOperationResult, makeRequestId });
  sdk.showUI(html, { width: 480, height: 640, title: '{{BRAND_PLUGIN_NAME}}', themeColors: true });
  return { bridge, exporter, status: () => ({ busy: Boolean(instance?.status().busy), height, publisher: snapshot() }), async dispose() { closing = true; releaseFrameListeners(); await bridge.close(); await exporter.queue.drain(); await instance?.drain(); } };
}

// Explicit candidate builds supply the flag; the default public/offline path is unchanged.
if (typeof figma !== 'undefined' && typeof __html__ !== 'undefined') startPlugin(figma, __html__, typeof __INDEPENDENT_PRODUCTION__ === 'undefined' ? {} : { production: __INDEPENDENT_PRODUCTION__ });
