// Exact peer-bound RPC. Terminal acknowledgment follows physical work, never abort alone.
import { SOURCE_LIMIT, InspectorError, fail, record, exactKeys, id, utf8, safeError, checkCancelled, requestId, number, cancellationController } from './core.mjs';

export function structuredSize(value, limit = SOURCE_LIMIT) {
  const stack = [{ value }]; const ancestors = new Set(); let total = 0;
  while (stack.length) {
    const current = stack.pop();
    if (current.exit) { ancestors.delete(current.value); continue; }
    const item = current.value;
    if (item instanceof Uint8Array) total += item.byteLength;
    else if (item === null || typeof item === 'boolean') total += 5;
    else if (typeof item === 'number') { if (!Number.isFinite(item)) fail('BAD_SCHEMA'); total += 24; }
    else if (typeof item === 'string') { if (item.length > limit) fail('HTTP_BODY_TOO_LARGE'); total += utf8(item).byteLength + 2; }
    else if (Array.isArray(item) || record(item)) {
      if (ancestors.has(item)) fail('BAD_SCHEMA'); ancestors.add(item); total += 2;
      stack.push({ value: item, exit: true });
      for (const key of Object.keys(item)) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('BAD_SCHEMA');
        total += utf8(key).byteLength + 3; stack.push({ value: item[key] });
      }
    } else fail('BAD_SCHEMA');
    if (total > limit) fail('HTTP_BODY_TOO_LARGE');
  }
  return total;
}
function validateEnvelope(message, channel, limit) {
  if (!record(message) || message.v !== 1 || message.channel !== channel) fail('BAD_SCHEMA');
  id(message.requestId);
  if (message.kind === 'request') {
    exactKeys(message, ['v', 'channel', 'kind', 'requestId', 'operation', 'payload']); id(message.operation); structuredSize(message.payload, limit);
  } else if (message.kind === 'cancel') {
    exactKeys(message, ['v', 'channel', 'kind', 'requestId']);
  } else if (message.kind === 'terminalAck') {
    exactKeys(message, ['v', 'channel', 'kind', 'requestId', 'physicalDone', 'ok', 'cancelled', 'result', 'error'], ['v', 'channel', 'kind', 'requestId', 'physicalDone', 'ok', 'cancelled']);
    if (message.physicalDone !== true || typeof message.ok !== 'boolean' || typeof message.cancelled !== 'boolean') fail('BAD_SCHEMA');
    if (message.ok) { if (!Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')) fail('BAD_SCHEMA'); structuredSize(message.result, limit); }
    else { if (Object.hasOwn(message, 'result')) fail('BAD_SCHEMA'); exactKeys(message.error, ['code']); if (safeError(message.error).code !== message.error.code) fail('BAD_SCHEMA'); }
  } else fail('BAD_SCHEMA');
  return message;
}
export function createBridge({ channel, send, subscribe, trustedPeer, handlers = {}, validateRequest = () => {}, validateResult = () => {}, makeRequestId = requestId, maxBodyBytes = SOURCE_LIMIT, maxPending = 8, historyCapacity = 65536, timeoutMs = 120000, onProtocolError = () => {} } = {}) {
  id(channel); if (typeof send !== 'function' || typeof subscribe !== 'function' || typeof trustedPeer !== 'function') fail('BAD_SCHEMA');
  number(maxBodyBytes, 1, SOURCE_LIMIT); number(maxPending, 1, 32); number(historyCapacity, 1, 65536); number(timeoutMs, 1, 3600000);
  const outgoing = new Map(); const incoming = new Map(); const seen = new Set(); const sent = new Set(); let closing = false;
  const packet = (kind, requestId, extra = {}) => ({ v: 1, channel, kind, requestId, ...extra });
  const transmit = value => { validateEnvelope(value, channel, maxBodyBytes); send(value); };
  const terminal = (entry, extra) => {
    if (entry.terminal) return;
    // Validate before marking terminal, so an oversize result becomes one safe error ack.
    const message = packet('terminalAck', entry.requestId, { physicalDone: true, cancelled: entry.controller.signal.aborted, ...extra });
    validateEnvelope(message, channel, maxBodyBytes);
    entry.terminal = true;
    try { send(message); } catch (error) { entry.terminal = false; throw error; }
  };
  const receive = async (raw, peer) => {
    if (!trustedPeer(peer)) return false;
    let message;
    try { message = validateEnvelope(raw, channel, maxBodyBytes); } catch (error) { onProtocolError(safeError(error)); return false; }
    if (message.kind === 'terminalAck') {
      const entry = outgoing.get(message.requestId);
      if (!entry || entry.terminal) return false;
      try { if (message.ok) validateResult(entry.operation, message.result); } catch (error) { onProtocolError(safeError(error)); return false; }
      entry.terminal = true; outgoing.delete(message.requestId); clearTimeout(entry.timer); entry.signal?.removeEventListener('abort', entry.abort);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new InspectorError(message.error.code));
      return true;
    }
    if (message.kind === 'cancel') {
      const entry = incoming.get(message.requestId);
      if (entry && !entry.terminal) entry.controller.abort();
      return Boolean(entry);
    }
    if (seen.has(message.requestId)) return false;
    // At the history bound refuse new work, instead of evicting replay protection.
    if (seen.size >= historyCapacity) {
      terminal({ requestId: message.requestId, terminal: false, controller: cancellationController() }, { ok: false, error: { code: 'QUEUE_FULL' } });
      onProtocolError({ code: 'QUEUE_FULL' }); return false;
    }
    seen.add(message.requestId);
    const entry = { requestId: message.requestId, terminal: false, controller: cancellationController() };
    if (closing || incoming.size >= maxPending) { terminal(entry, { ok: false, error: { code: closing ? 'CLOSED' : 'BUSY' } }); return true; }
    try { validateRequest(message.operation, message.payload); if (typeof handlers[message.operation] !== 'function') fail('BAD_SCHEMA'); }
    catch (error) { terminal(entry, { ok: false, error: safeError(error) }); return true; }
    incoming.set(message.requestId, entry);
    entry.work = (async () => {
      try {
        const result = await handlers[message.operation](message.payload, { signal: entry.controller.signal, requestId: message.requestId });
        validateResult(message.operation, result);
        terminal(entry, { ok: true, result });
      } catch (error) { terminal(entry, { ok: false, error: safeError(error) }); }
      finally { incoming.delete(message.requestId); }
    })();
    await entry.work;
    return true;
  };
  const unsubscribe = subscribe((message, peer) => { void receive(message, peer).catch(error => onProtocolError(safeError(error))); });
  const cancelOutgoing = entry => {
    if (entry.terminal || entry.cancelSent) return;
    entry.cancelSent = true;
    transmit(packet('cancel', entry.requestId));
    // No early rejection: its peer must send physicalDone terminalAck.
  };
  return {
    request(operation, payload, { signal, requestId: explicitId, helloTimeoutMs = 4000, taskTimeoutMs = timeoutMs } = {}) {
      if (closing) return Promise.reject(new InspectorError('CLOSED'));
      checkCancelled(signal); id(operation); validateRequest(operation, payload); structuredSize(payload, maxBodyBytes);
      // An explicit interactive batch may outlive a network request. Zero removes
      // only its aggregate deadline; cancellation/physicalDone and per-HTTP limits remain.
      number(taskTimeoutMs, 0, 3600000);
      if (outgoing.size >= maxPending) return Promise.reject(new InspectorError('BUSY'));
      if (sent.size >= historyCapacity) return Promise.reject(new InspectorError('QUEUE_FULL'));
      const reqId = id(explicitId || makeRequestId());
      if (sent.has(reqId) || seen.has(reqId)) fail('BAD_SCHEMA');
      sent.add(reqId);
      const entry = { requestId: reqId, operation, signal, terminal: false, cancelSent: false };
      const promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
      outgoing.set(reqId, entry);
      entry.abort = () => cancelOutgoing(entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
      // Only hello is read-only and safe to abandon/retry before the peer exists.
      // Stateful work retains the physicalDone gate, including on timeout.
      if (operation === 'hello' || taskTimeoutMs > 0) entry.timer = setTimeout(() => {
        if (operation !== 'hello') { cancelOutgoing(entry); return; }
        entry.terminal = true; outgoing.delete(reqId); signal?.removeEventListener('abort', entry.abort);
        entry.reject(new InspectorError('REQUEST_TIMEOUT'));
      }, operation === 'hello' ? number(helloTimeoutMs, 1, 60000) : taskTimeoutMs);
      try { transmit(packet('request', reqId, { operation, payload })); } catch (error) { outgoing.delete(reqId); clearTimeout(entry.timer); signal?.removeEventListener('abort', entry.abort); entry.reject(error); }
      return promise;
    },
    receive,
    async close() {
      closing = true;
      for (const entry of outgoing.values()) cancelOutgoing(entry);
      for (const entry of incoming.values()) entry.controller.abort();
      await Promise.all([...incoming.values()].map(entry => entry.work));
      // An unresponsive peer leaves close pending and resources held, intentionally.
      await Promise.all([...outgoing.values()].map(entry => new Promise(resolve => {
        const success = entry.resolve; const failure = entry.reject;
        entry.resolve = value => { success(value); resolve(); }; entry.reject = error => { failure(error); resolve(); };
      })));
      if (typeof unsubscribe === 'function') unsubscribe();
    },
    snapshot() { return { outgoing: outgoing.size, incoming: incoming.size, closing, rememberedRequests: seen.size }; }
  };
}

export function browserPeer(event, { parentWindow, topWindow, parentOrigin }) {
  if (typeof parentOrigin !== 'string' || !/^https:\/\//.test(parentOrigin)) return false;
  // The opaque wrapper receives outgoing UI messages, but real Figma desktop
  // dispatches replies from its exact top WindowProxy, not that immediate wrapper.
  // Only the immediate parent may use null origin; the top requires pinned HTTPS.
  return event?.source === parentWindow && (event?.origin === parentOrigin || event?.origin === 'null') || Boolean(topWindow) && event?.source === topWindow && event?.origin === parentOrigin;
}
export function createBrowserTransport(windowObject, parentOrigin) {
  let parsed; try { parsed = new URL(parentOrigin); } catch { fail('BAD_ORIGIN'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== parentOrigin || parsed.username || parsed.password || !['www.figma.com', 'figma.com'].includes(parsed.hostname)) fail('BAD_ORIGIN');
  const parentWindow = windowObject.parent;
  const topWindow = windowObject.top !== windowObject ? windowObject.top : undefined;
  if (!parentWindow || parentWindow === windowObject) fail('BAD_ORIGIN');
  return {
    // This transport is exclusively for bundled, non-navigating inline UI.
    // An opaque target cannot be addressed with an HTTPS or literal 'null' origin.
    send(message) { parentWindow.postMessage({ pluginMessage: message }, '*'); },
    subscribe(listener) {
      const handler = event => { if (browserPeer(event, { parentWindow, topWindow, parentOrigin }) && record(event.data) && Object.hasOwn(event.data, 'pluginMessage')) listener(event.data.pluginMessage, event); };
      windowObject.addEventListener('message', handler); return () => windowObject.removeEventListener('message', handler);
    },
    trustedPeer: event => browserPeer(event, { parentWindow, topWindow, parentOrigin })
  };
}
export function createFigmaTransport(sdk, iframeOrigin = 'null') {
  // Official figma.ui.onmessage authenticates the iframe source but exposes only props.origin.
  // Opaque `null` is explicitly pinned; this is not permission to trust arbitrary null-origin windows.
  if (iframeOrigin !== 'null') { const parsed = new URL(iframeOrigin); if (parsed.protocol !== 'https:' || parsed.origin !== iframeOrigin) fail('BAD_ORIGIN'); }
  return {
    send(message) { sdk.ui.postMessage(message, { origin: iframeOrigin === 'null' ? '*' : iframeOrigin }); },
    subscribe(listener) {
      const handler = (message, props) => listener(message, { origin: props?.origin, officialUI: true });
      if (typeof sdk.ui.on === 'function') { sdk.ui.on('message', handler); return () => sdk.ui.off('message', handler); }
      sdk.ui.onmessage = handler;
      return () => { if (sdk.ui.onmessage === handler) sdk.ui.onmessage = undefined; };
    },
    trustedPeer: peer => peer?.officialUI === true && peer.origin === iframeOrigin
  };
}
