// Self-contained standard DOM UI, with browser WebCrypto and exact-origin fetch.
import { fail, id, requestId, sha256, jsonBytes, serviceOrigin, checkCancelled, safeError } from './core.mjs';
import { createBridge, createBrowserTransport } from './bridge.mjs';
import { createHTTPAdapter } from './publisher.mjs';
import { CHANNEL, validateOperation, validateOperationResult } from './protocol.mjs';
import { bindResizeControls } from './resize.mjs';
import { createDigestProvider } from './portable-sha256.mjs';
import { createProductionHTTP, customHTTPSOrigin, normalizeProductionLoginOrigin, validateProductionOperation, validateProductionOperationResult } from './production-protocol.mjs';

// Presentation only: never render protocol codes or identity-bearing diagnostic strings.
export function pluginErrorText(error) {
  const code = typeof error === 'string' ? error : safeError(error).code;
  if (code === 'DESIGNER_EXPIRED') return '设计师账户已到期，请联系管理员续期。';
  if (code === 'PROJECT_QUOTA_EXCEEDED') return '项目数量已达上限，请联系管理员提高额度，或删除现有项目后再新建。';
  return ['UNKNOWN_COMMIT', 'UNKNOWN_PREPARE', 'VISIBILITY_UNCONFIRMED', 'UNKNOWN_CLAIM', 'UNKNOWN_FINISH'].includes(code)
    ? '未能确认上传结果，请联系开发者' : '上传失败，请联系开发者';
}
// Presentation only: project/session/source authorization remains owned by the existing protocol.
function syncPluginPresentation(documentObject, { phase = 'idle', loggedIn, canPublish } = {}) {
  const $ = name => documentObject.getElementById(name), app = $('app');
  const previousPhase = app?.dataset?.taskPhase;
  if (app?.dataset) app.dataset.taskPhase = phase;
  if (typeof loggedIn === 'boolean') {
    const menu = $('production-account-menu'), menuBody = $('production-account-menu-content');
    const loginSlot = $('production-login-status-slot'), accountState = $('production-account-state');
    if (menu) menu.hidden = !loggedIn;
    const accountTarget = loggedIn ? menuBody : loginSlot;
    if (accountState && accountTarget && accountState.parentNode !== accountTarget) accountTarget.append(accountState);
    const notesTarget = loggedIn ? menuBody : $('production-account');
    const notes = documentObject.querySelector('#production-details');
    if (notes && notesTarget && notes.parentNode !== notesTarget) notesTarget.append(notes);
    const permission = $('production-permission'), permissionTarget = loggedIn && canPublish === true && notes ? notes : $('production-project-fields');
    if (permission && permissionTarget && permission.parentNode !== permissionTarget) permissionTarget.append(permission);
  }
  // A newly uncertain result must be discoverable without finding a disabled publish button below the fold.
  if (previousPhase !== phase && ['unknownPrepare','unknownCommit','verificationPending','partial','failed'].includes(phase)) {
    const message = $('status');
    message?.setAttribute?.('tabindex', '-1');
    message?.scrollIntoView?.({ block: 'nearest', behavior: 'auto' });
    message?.focus?.({ preventScroll: true });
  }
}

function frameListIcon(documentObject) {
  const icon = documentObject.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('class', 'frame-item-icon'); icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
  const path = documentObject.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M5 9H3V3h12v2M8 8h13v13H8V8Z'); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.6'); path.setAttribute('stroke-linejoin', 'round');
  icon.append(path); return icon;
}

async function pluginHello(bridge) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await bridge.request('hello', {}); }
    catch (error) { if (error.code !== 'REQUEST_TIMEOUT' || attempt === 2) throw error; }
  }
}

export function mountPluginUI(windowObject = window, documentObject = document) {
  if (documentObject.querySelector('meta[name="independent-production"]')?.content === 'enabled') return mountProductionUI(windowObject, documentObject);
  const $ = name => documentObject.getElementById(name);
  const recovery = documentObject.createElement('div'); recovery.id = 'recovery'; recovery.hidden = true;
  for (const [tag, name, text] of [['p','session',''],['button','query','查询状态'],['button','abort','中止未完成上传']]) {
    const node = documentObject.createElement(tag); node.id = name; node.textContent = text; if (tag === 'button') node.type = 'button'; recovery.append(node);
  }
  $('production-progress-page').append(recovery);
  const digestProvider = createDigestProvider(windowObject.crypto);
  const configuredParent = documentObject.querySelector('meta[name="figma-parent-origin"]')?.content || 'https://www.figma.com';
  const transport = createBrowserTransport(windowObject, configuredParent);
  let height = 640; let current = null; let directory = []; let service = null; let latestState = { phase: 'idle' }; let downloads = [];
  const status = text => { $('status').textContent = text; };
  const setBusy = busy => {
    const publishLocked = latestState.locked === true || ['preparing', 'prepared', 'uploading', 'committing', 'unknownCommit', 'unknownPrepare'].includes(latestState.phase);
    for (const name of ['export', 'publish', 'scope', 'scale', 'slices', 'origin', 'localhost', 'project', 'design-file', 'page', 'expected-revision', 'query', 'abort']) $(name).disabled = busy || name === 'publish' && publishLocked;
    $('cancel').disabled = !busy;
  };
  const renderState = state => {
    latestState = state;
    $('publish').disabled = Boolean(current) || state.locked === true || ['preparing', 'prepared', 'uploading', 'committing', 'unknownCommit', 'unknownPrepare'].includes(state.phase);
    syncPluginPresentation(documentObject, { phase: state.phase });
    $('task-diagnostics').textContent = state.sourceBytes == null ? '' : `源文件大小：${formatByteSize(state.sourceBytes)}`;
    if (state.phase === 'exporting') { $('progress').textContent = `已完成 ${state.done} / ${state.total}`; return; }
    const labels = { idle: '就绪', preparing: '准备发布会话', prepared: '会话已准备', uploading: '上传原始资源', committing: '提交中；请等待服务器确认', committed: '服务器已确认提交', unknownCommit: '提交结果未知：已锁定新发布', unknownPrepare: '准备结果未知：禁止自动再准备', aborted: '服务器已确认中止', expired: '服务器已确认过期', failed: '任务失败' };
    if (labels[state.phase]) status(labels[state.phase]);
    const uncertain = ['unknownCommit', 'unknownPrepare', 'committing', 'prepared', 'uploading', 'preparing'].includes(state.phase) && (state.sessionId || state.requestId);
    $('recovery').hidden = !uncertain;
    $('session').textContent = uncertain ? '原会话已保留，请查询确认结果；不会自动重新发布。' : '';
    $('query').disabled = Boolean(current) || !state.sessionId;
    $('abort').disabled = Boolean(current) || !state.sessionId;
  };
  const readService = () => {
    const value = $('origin').value.trim();
    if (!value) fail('BAD_ORIGIN');
    return { origin: serviceOrigin(value, { allowLocalhost: $('localhost').checked }), allowLocalhost: $('localhost').checked };
  };
  const handlers = {
    async digest(payload, { signal }) {
      checkCancelled(signal);
      const bytes = new Uint8Array(await digestProvider.subtle.digest('SHA-256', payload.bytes));
      checkCancelled(signal); return { digest: bytes };
    },
    async network(payload, { signal }) {
      if (service === null || payload.service.origin !== service.origin || payload.service.allowLocalhost !== service.allowLocalhost) fail('BAD_ORIGIN');
      const adapter = createHTTPAdapter({ origin: service.origin, allowLocalhost: service.allowLocalhost, fetchAPI: windowObject.fetch.bind(windowObject) });
      const context = { signal, requestId: payload.wireRequestId };
      if (payload.method === 'prepare') return adapter.prepare(payload.manifest, context);
      if (payload.method === 'upload') {
        if (await sha256(payload.bytes, digestProvider, signal) !== payload.descriptor.sha256) fail('BAD_BYTES');
        return adapter.upload(payload.sessionId, payload.descriptor, payload.bytes, context);
      }
      return adapter[payload.method](payload.sessionId, context);
    },
    notice(payload) { renderState(payload.state); return { accepted: true }; }
  };
  const bridge = createBridge({ ...transport, channel: CHANNEL, handlers, validateRequest: validateOperation, validateResult: validateOperationResult, makeRequestId: () => `ui-${requestId(windowObject.crypto)}`, onProtocolError: () => status('插件连接校验未通过，请重新打开插件后重试。') });
  const refresh = async () => {
    const response = await bridge.request('list', { scope: $('scope').value });
    directory = response.frames;
    const nodes = [];
    for (const frame of directory) { const item = documentObject.createElement('li'); const name = documentObject.createElement('span'); name.textContent = frame.name; item.append(frameListIcon(documentObject), name); nodes.push(item); }
    $('frames').replaceChildren(...nodes);
    $('selection-summary').textContent = `${directory.length} 个画板`;
    $('excluded').textContent = response.excluded.length ? `${response.excluded.length} 个非 FRAME 未纳入；整页仅当前页顶层 FRAME，不展开 SECTION 为顶层画板` : '';
    return response;
  };
  const createBindings = async () => {
    const projectId = id($('project').value.trim()); const designFileId = id($('design-file').value.trim()); const pageId = id($('page').value.trim());
    const expectedRevisionId = $('expected-revision').value.trim() ? id($('expected-revision').value.trim()) : null;
    const bindings = [];
    for (const frame of directory) {
      const stableHash = await sha256(jsonBytes([projectId, designFileId, pageId, frame.id]), digestProvider);
      bindings.push({ figmaNodeId: frame.id, expectedRevisionId, identity: { projectId, designFileId, pageId, frameId: `frame-${stableHash.slice(0, 32)}`, revisionId: `revision-${requestId(windowObject.crypto)}`, figmaNodeId: frame.id } });
    }
    return bindings;
  };
  const saveRequested = (bytes, mime, name) => {
    const url = windowObject.URL.createObjectURL(new windowObject.Blob([bytes], { type: mime }));
    const anchor = documentObject.createElement('a'); anchor.href = url; anchor.download = name; anchor.rel = 'noopener'; anchor.click();
    windowObject.setTimeout(() => windowObject.URL.revokeObjectURL(url), 60000);
    status('已向浏览器请求下载；保存结果未验证');
  };
  const renderDownloads = response => {
    downloads = response.assets;
    const manifestBytes = jsonBytes(response.manifest);
    const list = [];
    const add = (bytes, mime, name, fallbackLabel) => {
      const item = documentObject.createElement('li'); const button = documentObject.createElement('button'); button.type = 'button'; button.textContent = `${fallbackLabel || name} · ${formatByteSize(bytes.byteLength)}`;
      button.addEventListener('click', event => { if (event.isTrusted) saveRequested(bytes, mime, name); }); item.append(button); list.push(item);
    };
    add(manifestBytes, 'application/json', 'independent-inspector-manifest.json');
    for (const asset of downloads) add(asset.bytes, asset.descriptor.mime, asset.descriptor.fileName || `layerdoc-${asset.descriptor.sha256.slice(0, 16)}.json`, asset.descriptor.fileName ? null : '画板数据文件');
    $('download-list').replaceChildren(...list); $('downloads').hidden = false;
  };
  const execute = async operation => {
    if (current) return;
    const controller = new windowObject.AbortController(); current = controller; setBusy(true); $('progress').textContent = '';
    try {
      status('检查完整目录与显式身份…');
      await refresh(); checkCancelled(controller.signal);
      const bindings = await createBindings(); checkCancelled(controller.signal);
      if (operation === 'publish') service = readService();
      const payload = { scope: $('scope').value, scale: Number($('scale').value), includeSlices: $('slices').checked, chunkCapacity: 16, bindings, service: operation === 'publish' ? service : null };
      const result = await bridge.request(operation, payload, { signal: controller.signal });
      if (operation === 'export') { renderDownloads(result); status(`导出完成：${result.manifest.frames.length} 个画板；保存结果待确认`); }
      else renderState(result.state);
    } catch (error) { status(pluginErrorText(error)); }
    finally {
      current = null; setBusy(false);
      if (['unknownCommit', 'unknownPrepare', 'committed', 'aborted', 'expired'].includes(latestState.phase)) renderState(latestState);
      else { $('query').disabled = !latestState.sessionId; $('abort').disabled = !latestState.sessionId; }
    }
  };
  $('scope').addEventListener('change', event => { if (event.isTrusted && !current) void refresh().catch(error => status(pluginErrorText(error))); });
  $('export').addEventListener('click', event => { if (event.isTrusted) void execute('export'); });
  $('publish').addEventListener('click', event => { if (event.isTrusted) void execute('publish'); });
  $('cancel').addEventListener('click', event => { if (event.isTrusted && current) { current.abort(); $('cancel').disabled = true; status('已请求取消；请等待导出和网络请求安全结束。'); } });
  for (const operation of ['query', 'abort']) $(operation).addEventListener('click', event => {
    if (!event.isTrusted || current) return;
    try { service = readService(); } catch (error) { status(pluginErrorText(error)); return; }
    current = new windowObject.AbortController(); setBusy(true);
    void bridge.request(operation, {}, { signal: current.signal }).then(result => { const terminal = ['committed', 'aborted', 'expired'].includes(result.state); renderState(operation === 'query' ? { ...latestState, locked: terminal ? false : latestState.locked === true, phase: terminal ? result.state : 'unknownCommit' } : result); }).catch(error => status(pluginErrorText(error))).finally(() => { current = null; setBusy(false); $('query').disabled = !latestState.sessionId; $('abort').disabled = !latestState.sessionId; });
  });
  const removeResize = bindResizeControls(documentObject, { getHeight: () => height, async resize(next) { try { const result = await bridge.request('resize', { height: next }); height = result.height; } catch (error) { status(pluginErrorText(error)); } } });
  const ready = (async () => {
    try {
      const hello = await pluginHello(bridge); height = hello.height; renderState(hello.state);
      if (hello.state.service) { $('origin').value = hello.state.service.origin; $('localhost').checked = hello.state.service.allowLocalhost; }
      await refresh();
    } catch (error) { status('无法连接设计工具，请检查插件来源后重新打开；不会使用未经验证的连接。'); }
  })();
  return { bridge, ready, async dispose() { current?.abort(); removeResize(); await bridge.close(); downloads = []; } };
}
// Display only: protocol counters remain integer bytes. A pair shares the total's unit.
const validByteCount = value => Number.isSafeInteger(value) && value >= 0;
const byteUnit = bytes => bytes >= 1024 ** 3 ? [1024 ** 3, 'GB'] : bytes >= 1024 ** 2 ? [1024 ** 2, 'MB'] : [1024, 'KB'];
export function formatByteSize(bytes) {
  if (!validByteCount(bytes)) return '';
  const [divisor, unit] = byteUnit(bytes);
  return `${(bytes / divisor).toFixed(2)} ${unit}`;
}
export function formatByteProgress(done, total) {
  if (!validByteCount(done) || !validByteCount(total) || done > total) return '';
  const [divisor, unit] = byteUnit(total);
  return `${(done / divisor).toFixed(2)}/${(total / divisor).toFixed(2)} ${unit}`;
}

// Stage-local counts: exported frames never stand in for uploaded resources.
export function productionProgress(state, elapsedSeconds = 0) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const ratio = (done, total) => count(done) && count(total) && total > 0 && done <= total ? Math.floor(done * 100 / total) : null;
  const quantity = (done, total, unit) => count(done) && count(total) && done <= total ? `${done}/${total} ${unit}` : '';
  const phase = state.phase;
  if (phase === 'exporting') return { caption: '画板导出', percent: ratio(state.exportDone, state.exportTotal), detail: [quantity(state.exportDone, state.exportTotal, '个画板'), count(state.sourceBytes) ? `已导出 ${formatByteSize(state.sourceBytes)}` : ''].filter(Boolean).join(' · ') || '正在导出画板' };
  if (phase === 'uploading') return { caption: '本批资源上传', percent: ratio(state.uploadedBytes, state.uploadTotalBytes) ?? ratio(state.uploadDone, state.uploadTotal), detail: [quantity(state.uploadDone, state.uploadTotal, '个资源'), formatByteProgress(state.uploadedBytes, state.uploadTotalBytes)].filter(Boolean).join(' · ') || '正在上传资源' };
  if (['committing', 'verifying', 'finishing'].includes(phase)) return { caption: '提交确认', percent: null, detail: `${quantity(state.done, state.total, '个画板已确认') || '等待服务器确认'} · 已等待 ${Math.max(0, Math.floor(elapsedSeconds))} 秒` };
  if (phase === 'committed' && state.verified === true && state.total > 0 && state.done === state.total) return { caption: '上传完成', percent: 100, detail: quantity(state.done, state.total, '个画板已确认') };
  return { caption: ['preparing','prepared'].includes(phase) ? '准备上传' : '上传状态', percent: null, detail: '' };
}

export function mountProductionUI(windowObject = window, documentObject = document) {
  const $ = name => documentObject.getElementById(name);
  const digestProvider = createDigestProvider(windowObject.crypto);
  const parentOrigin = documentObject.querySelector('meta[name="figma-parent-origin"]')?.content || 'https://www.figma.com';
  let client = null; let service = null; let user = null; let projects = []; let groups = []; let selectedGroupId = null; let remembered = null; let current = null; let height = 640; let state = { phase: 'idle', locked: false }; let config = {}; let rememberSupported = false; let connected = false; let eligibleFrameCount = 0; let frameEpoch = 0; let frameTimer = null; let disposed = false; let pickerEpoch = 0; let groupEpoch = 0; let accountPolicy = null; let designerExpired = false; let expiryDialog = null; let expiryDialogShown = false; const frameNames = new Map();
  const showPage = (name, { focus = false } = {}) => {
    const page = !user ? 'login' : name;
    $('app').dataset.productionPage = page;
    $('production-project-page').hidden = page !== 'projects';
    $('production-group-page').hidden = page !== 'groups';
    $('production-progress-page').hidden = page !== 'progress';
    $('production-account').hidden = page !== 'login';
    $('frame-selection').hidden = page !== 'workspace';
    $('task-actions').hidden = page === 'login' || page === 'projects' || page === 'groups';
    $('production-project-open').setAttribute('aria-expanded', String(page === 'projects'));
    $('production-group-open').setAttribute('aria-expanded', String(page === 'groups'));
    $('production-progress-back').hidden = page !== 'progress' || Boolean(current);
    if (focus) (page === 'projects' ? $('production-project-back') : page === 'groups' ? $('production-group-back') : page === 'progress' ? $('production-progress-title') : $('production-project-open')).focus?.();
  };
  const namespace = `src_window_${requestId(windowObject.crypto)}`;
  const status = text => { $('status').textContent = text; };
  const authStatus = text => { $('production-auth-status').textContent = text; };
  const expiredText = '设计师账户已到期，请联系管理员续期。', quotaText = '项目数量已达上限，请联系管理员提高额度，或删除现有项目后再新建。';
  const quotaPicker = documentObject.createElement('p'), quotaCreate = documentObject.createElement('p');
  quotaPicker.className = quotaCreate.className = 'subtle'; quotaPicker.setAttribute('role','status'); quotaCreate.setAttribute('role','status'); quotaPicker.dataset.accountQuota = quotaCreate.dataset.accountQuota = 'true';
  $('production-project-page').insertBefore(quotaPicker, $('production-project-search').parentNode); $('production-create-error').before(quotaCreate);
  const quotaSummary = () => {
    if (!accountPolicy) return '项目额度暂未读取，以服务器为准。';
    const limit = accountPolicy.projectLimit === null ? '不限' : String(accountPolicy.projectLimit);
    const expiry = accountPolicy.role !== 'designer' ? '' : accountPolicy.expiresAt === null ? ' · 永不过期' : ` · 到期时刻（北京时间 UTC+08:00）：${new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(accountPolicy.expiresAt))}`;
    return `现存项目：${accountPolicy.ownedProjectCount} / ${limit}${expiry}`;
  };
  const updateQuotaDisplay = () => { const value = quotaSummary(); quotaPicker.textContent = value; quotaCreate.textContent = value; };
  const expiredDuringUnknownUpload = () => ['unknownPrepare','unknownCommit','unknownClaim','unknownFinish','verificationPending'].includes(state.phase);
  const expiredDialogText = () => expiredText + (expiredDuringUnknownUpload() ? ' 当前上传结果尚未确认，请勿重复上传。' : '');
  const updateExpiryDialogText = () => { if (expiryDialog?.open) { const note = expiryDialog.querySelector('p'); if (note) note.textContent = expiredDialogText(); } };
  const isDesignerExpiredError = error => error?.code === 'DESIGNER_EXPIRED' || error?.status === 403 && error?.code === 'designer_expired';
  let loginFocusPending = false;
  const showExpiryDialog = () => {
    if (expiryDialog?.open) { updateExpiryDialogText(); return; }
    if (expiryDialogShown) return; expiryDialogShown = true;
    const dialog = documentObject.createElement('dialog'), title = documentObject.createElement('h2'), note = documentObject.createElement('p'), actions = documentObject.createElement('div'), confirm = documentObject.createElement('button');
    dialog.className = 'designer-expired-dialog'; dialog.setAttribute('aria-modal','true'); dialog.setAttribute('aria-labelledby','designer-expired-title'); dialog.setAttribute('aria-describedby','designer-expired-description');
    title.id='designer-expired-title'; title.textContent='账户已到期'; title.tabIndex=-1;
    note.id='designer-expired-description'; note.textContent=expiredDialogText();
    actions.className='designer-expired-actions'; confirm.type='button'; confirm.className='primary'; confirm.textContent='返回登录'; confirm.addEventListener('click',()=>dialog.close()); actions.append(confirm);
    // Native modal focus containment; Escape and the explicit action both return
    // to login, never restore focus to the now unauthenticated workspace.
    dialog.addEventListener('close',()=>{dialog.remove();if(expiryDialog===dialog)expiryDialog=null;if(designerExpired){loginFocusPending=true;controls()}},{once:true});
    dialog.append(title,note,actions); documentObject.body.append(dialog); expiryDialog=dialog; dialog.showModal(); title.focus?.({preventScroll:true});
  };
  const handleDesignerExpired = () => {
    designerExpired=true; user=null; client?.clearToken(); projects=[]; groups=[]; selectedGroupId=null; accountPolicy=null; updateQuotaDisplay(); authStatus(expiredText); status(expiredDialogText()); controls(); showExpiryDialog();
  };
  const refreshAccountPolicy = async signal => {
    try {
      const policy=await client.accountSelf({signal});
      if(disposed)return false;
      if(!user||policy.id!==user.id||policy.username!==user.username||policy.role!==user.role)fail('HTTP_RESPONSE_INVALID');
      accountPolicy=policy; updateQuotaDisplay(); return true;
    } catch(error) {
      if(isDesignerExpiredError(error)){handleDesignerExpired();throw error;}
      if(error?.status===401)throw error;
      accountPolicy=null; updateQuotaDisplay(); return false;
    }
  };
  const customService = () => config.serviceMode === 'custom-https';
  const switchLocked = () => Boolean(current) || state.locked === true || ['authorizing','claiming','resolvingSource','exporting','preparing','prepared','uploading','committing','verifying','finishing','unknownPrepare','unknownCommit','unknownClaim','unknownFinish','verificationPending','partial'].includes(state.phase) || state.phase === 'committed' && state.verified !== true;
  const inputOrigin = () => customService() ? customHTTPSOrigin($('production-origin').value) : normalizeProductionLoginOrigin($('production-origin').value.trim(), { allowLocalhost: config.allowLocalhost === true, state: { locked: false }, remembered: null });
  const matchesRemembered = () => { try { return Boolean(remembered && inputOrigin() === remembered.origin && remembered.allowLocalhost === (config.allowLocalhost === true)); } catch { return false; } };
  const controls = () => {
    const busy = Boolean(current) || !connected; const project = projects.find(p => p.id === $('production-project').value);
    $('app').dataset.productionStage = user ? 'workspace' : 'login';
    $('production-login-form').hidden = Boolean(user); $('production-project-fields').hidden = !user;
    $('production-title').textContent = user ? '当前项目' : '登录交付服务';
    $('production-logout').hidden = !user && !remembered;
    $('frame-selection').hidden = !user; $('task-actions').hidden = !user && !busy;
    for (const name of ['scope', 'scale', 'design-spec', 'design-scale', 'slices', 'production-origin', 'production-username', 'production-password', 'production-login', 'production-resume', 'production-logout']) $(name).disabled = busy;
    if (customService()) {
      $('production-origin').disabled = busy || switchLocked();
      $('production-resume').hidden = !remembered || Boolean(user);
      $('production-resume').disabled = busy || !matchesRemembered();
      $('production-resume').textContent = remembered ? `恢复登录（${remembered.origin}）` : '恢复登录';
      $('production-remember').parentNode && ($('production-remember').parentNode.lastChild?.nodeType === 3) && ($('production-remember').parentNode.lastChild.textContent = '记住此服务器登录');
      const originField = $('production-origin').parentNode;
      const originTarget = user ? $('production-account-menu-content') : $('production-login-form');
      if (originField && originField.parentNode !== originTarget) originTarget.append(originField);
    }
    $('production-remember').disabled = busy || !rememberSupported;
    $('production-project-open').disabled = busy || !user; $('production-group-open').disabled = busy || !user || !project; $('production-project-create').hidden = true; $('production-project-create').disabled = busy || !user; $('production-logout').disabled = busy || !user && !remembered;
    $('scope-page').disabled = busy; $('scope-selection').disabled = busy;
    if ($('scope').value === 'page') $('scope-page').checked = true; else $('scope-selection').checked = true;
    for (const name of ['production-project-back','production-group-back','production-project-search','production-page-create-group','production-page-create-project','production-create-submit','production-group-submit']) $(name).disabled = busy || !user;
    const canCreate = Boolean(user && ['admin','designer'].includes(user.role)); $('production-page-create-group').hidden = !canCreate || !project?.permissions.canPublish; $('production-page-create-project').hidden = !canCreate;
    $('publish').disabled = busy || !user || !project?.permissions.canPublish || eligibleFrameCount === 0 || customService() && switchLocked();
    $('cancel').disabled = !current;
    $('production-permission').textContent = project && !project.permissions.canPublish ? '此项目只读，不能发布。' : '';
    let page = $('app').dataset.productionPage;
    if (!user) page = 'login'; else if (!page || page === 'login') page = 'workspace'; else if (!['projects','groups','progress','workspace'].includes(page)) page = 'workspace';
    showPage(page);
    syncPluginPresentation(documentObject, { phase: state.phase, loggedIn: Boolean(user), canPublish: project?.permissions.canPublish });
    if (loginFocusPending && !busy && !user) { loginFocusPending=false; $('production-username').focus?.(); }
  };
  let commitStartedAt = null, progressTimer = null;
  const paintProgress = () => {
    const progress = productionProgress(state, commitStartedAt === null ? 0 : (Date.now() - commitStartedAt) / 1000);
    $('progress-ring').style.setProperty('--progress-angle', `${(progress.percent ?? 0) * 3.6}deg`);
    $('progress-ring-text').textContent = progress.percent === null ? '—' : `${progress.percent}%`;
    $('progress-ring-caption').textContent = progress.caption;
    $('progress').textContent = progress.detail;
  };
  const tickProgress = () => {
    progressTimer = null;
    if (disposed || commitStartedAt === null) return;
    paintProgress(); progressTimer = windowObject.setTimeout(tickProgress, 1000);
  };
  const render = next => {
    const wasWaiting = ['committing','verifying','finishing'].includes(state.phase);
    const waiting = ['committing','verifying','finishing'].includes(next.phase);
    state = next;
    if (waiting && !wasWaiting) commitStartedAt = Date.now();
    if (!waiting) { commitStartedAt = null; if (progressTimer !== null) windowObject.clearTimeout(progressTimer); progressTimer = null; }
    if (waiting && progressTimer === null) progressTimer = windowObject.setTimeout(tickProgress, 1000);
    $('task-diagnostics').textContent = '';
    const verified = next.phase === 'committed' && next.verified === true && next.total > 0 && next.done === next.total;
    const failed = ['failed','partial','expired'].includes(next.phase);
    const unknown = ['unknownPrepare','unknownCommit','unknownClaim','unknownFinish','verificationPending'].includes(next.phase) || next.phase === 'committed' && !verified;
    const labels = { idle:'就绪', authorizing:'正在校验项目权限', claiming:'正在准备上传', resolvingSource:'正在确认版本', exporting:'正在导出画板', preparing:'正在准备上传', prepared:'准备完成', uploading:'正在上传资源', committing:'正在提交版本', verifying:'正在确认上传结果', finishing:'正在确认上传结果', committed:'上传完成', aborted:'已取消' };
    const message = unknown ? '未能确认上传结果，请联系开发者' : failed ? '上传失败，请联系开发者' : labels[next.phase] || '未能确认上传结果，请联系开发者';
    status(designerExpired ? expiredDialogText() : message); if (designerExpired) updateExpiryDialogText(); $('progress-ring-phase').textContent = unknown ? '结果未确认' : failed ? '上传失败' : labels[next.phase] || '上传状态';
    $('production-progress-title').textContent = verified ? '上传完成' : unknown ? '结果未确认' : failed ? '上传失败' : '上传进度';
    const phaseOrder = ['exporting','preparing','uploading','committing'];
    const stage = failed ? next.failureStage : next.phase === 'prepared' ? 'preparing' : ['verifying','finishing','committed'].includes(next.phase) ? 'committing' : next.phase;
    const exportTotal = Number.isSafeInteger(next.exportTotal) && next.exportTotal > 0 ? next.exportTotal : 0;
    const exportDone = Math.max(0, Math.min(exportTotal, Number.isSafeInteger(next.exportDone) ? next.exportDone : 0));
    $('task-visual-progress').hidden = next.phase === 'idle'; paintProgress();
    for (const row of $('progress-stages').children) {
      const index = phaseOrder.indexOf(row.dataset.progressStage), active = phaseOrder.indexOf(stage);
      row.dataset.state = verified ? 'done' : failed && index === active ? 'failed' : index < active ? 'done' : index === active ? 'current' : 'waiting';
    }
    const progressRows = [...frameNames.values()].slice(0, exportTotal || frameNames.size).map((name, index) => {
      const row = documentObject.createElement('li'); row.dataset.state = index < exportDone ? 'done' : index === exportDone && failed && next.failureStage === 'exporting' ? 'failed' : 'waiting';
      const label = documentObject.createElement('span'); label.textContent = name; label.title = name;
      const stateText = documentObject.createElement('span'); stateText.textContent = row.dataset.state === 'done' ? '已导出' : row.dataset.state === 'failed' ? '未完成' : '';
      row.append(label, stateText); return row;
    });
    $('production-progress-frames').replaceChildren(...progressRows);
    const results = [...(next.completed || []).flatMap(r => r.frames || []), ...(next.mappingAvailable && next.commitResult && !(next.completed || []).some(r => r.sessionId === next.commitResult.sessionId) ? next.commitResult.frames : [])];
    const rows = results.map((f, index) => { const li = documentObject.createElement('li'); const name = documentObject.createElement('span'); name.textContent = frameNames.get(f.figmaNodeId) || `画板 ${index + 1}`; name.title = name.textContent; const label = documentObject.createElement('span'); label.textContent = ({new:'已新增',changed:'已更新','metadata-only':'信息已更新',unchanged:'无变化',committed:'已提交'})[f.status] || '已确认发布'; li.append(name, label); return li; });
    $('production-results').replaceChildren(...rows); $('production-results').hidden = !rows.length; $('production-result-details').hidden = !rows.length; controls();
  };
  const handlers = {
    async digest(payload, { signal }) { checkCancelled(signal); const digest = new Uint8Array(await digestProvider.subtle.digest('SHA-256', payload.bytes)); checkCancelled(signal); return { digest }; },
    notice(payload) { render(payload.state); return { accepted: true }; },
    'frames-changed'() { queueFrames(); return { accepted: true }; },
    async 'production-network'(payload, { signal }) {
      if (!client || !service || payload.service.origin !== service.origin || payload.service.allowLocalhost !== service.allowLocalhost) fail('BAD_ORIGIN');
      try { const value = await client[payload.method](...payload.args, { signal }); return { ok: true, value }; }
      catch (error) {
        if (isDesignerExpiredError(error)) handleDesignerExpired();
        else if (error?.status === 401) { user = null; client?.clearToken(); accountPolicy=null; updateQuotaDisplay(); authStatus('登录已失效，请重新登录。'); controls(); }
        return { ok: false, error: { code: safeError(error).code, status: Number.isInteger(error?.status) ? error.status : null, dispatched: error?.dispatched === true } };
      }
    }
  };
  const bridge = createBridge({ ...createBrowserTransport(windowObject, parentOrigin), channel: CHANNEL, handlers, validateRequest: validateProductionOperation, validateResult: validateProductionOperationResult, makeRequestId: () => `production-ui-${requestId(windowObject.crypto)}`, onProtocolError: () => status('插件连接校验未通过，请重新打开插件后重试。') });
  const command = (action, payload = {}, context = {}) => bridge.request('production-control', { action, ...payload }, context);
  const refreshFrames = async () => {
    const epoch = ++frameEpoch, scope = $('scope').value;
    let response;
    try { response = await bridge.request('list', { scope }); }
    catch (error) {
      if (!disposed && epoch === frameEpoch) { eligibleFrameCount = 0; frameNames.clear(); $('frames').replaceChildren(); $('selection-summary').textContent = '画板暂不可用'; $('scope-count').textContent = '（0）'; controls(); }
      throw error;
    }
    if (disposed || epoch !== frameEpoch || scope !== $('scope').value) return;
    let selectedCount = response.frames.length;
    if (scope === 'page') { try { const selection = await bridge.request('list', { scope: 'selection' }); selectedCount = selection.frames.length; } catch { /* The page list is still publishable; the selection count stays at 0. */ selectedCount = 0; } }
    if (disposed || epoch !== frameEpoch || scope !== $('scope').value) return;
    const rows = response.frames.map(f => { const li = documentObject.createElement('li'); const label = documentObject.createElement('span'); label.textContent = f.name; li.append(frameListIcon(documentObject), label); return li; });
    frameNames.clear(); for (const frame of response.frames) frameNames.set(frame.id, frame.name);
    $('frames').replaceChildren(...rows); $('selection-summary').textContent = `${selectedCount} 个画板`; $('scope-count').textContent = `（${selectedCount}）`;
    $('excluded').textContent = '';
    eligibleFrameCount = response.frames.length; controls();
  };
  const queueFrames = () => {
    if (disposed || !connected) return;
    ++frameEpoch;
    eligibleFrameCount = 0; controls();
    if (frameTimer !== null) windowObject.clearTimeout(frameTimer);
    frameTimer = windowObject.setTimeout(() => { frameTimer = null; if (current) { queueFrames(); return; } void refreshFrames().catch(error => status(pluginErrorText(error))); }, 90);
  };
  const connect = async () => {
    const allowLocalhost = config.allowLocalhost === true;
    let origin;
    try { origin = inputOrigin(); }
    catch (error) { authStatus(customService() ? '请填写有效的自建 HTTPS 服务器地址（仅域名或 IP 与端口）。' : '连接失败，请联系开发者'); throw error; }
    if (service && service.origin !== origin && (state.locked || ['unknownPrepare','unknownCommit','unknownClaim','unknownFinish','verificationPending','partial'].includes(state.phase))) fail('UNKNOWN_COMMIT');
    $('production-origin').value = origin;
    const next = { origin, allowLocalhost };
    const result = await command('connect-account', { service: next, namespace });
    if (!client || !service || service.origin !== next.origin || service.allowLocalhost !== next.allowLocalhost) { client?.clearToken(); ++pickerEpoch; ++groupEpoch; $('production-project').replaceChildren(); $('production-project-options').replaceChildren(); $('production-group-options').replaceChildren(); client = createProductionHTTP({ ...next, responseLimit: 4 * 1024 * 1024, fetchAPI: windowObject.fetch.bind(windowObject), cryptoAPI: { subtle: digestProvider.subtle, getRandomValues: windowObject.crypto?.getRandomValues?.bind(windowObject.crypto) } }); user = null; projects = []; groups = []; selectedGroupId = null; accountPolicy=null; designerExpired=false; expiryDialogShown=false; expiryDialog?.close(); updateQuotaDisplay(); }
    service = next; render(result.state);
  };
  const closeProjectOptions = () => { if ($('app').dataset.productionPage === 'projects') showPage('workspace'); };
  const projectLabel = p => `${p.name}${p.permissions.canPublish ? '' : '（只读）'}`;
  const selectedProject = () => projects.find(p => p.id === $('production-project').value) || null;
  const syncProjectRows = () => {
    const project = selectedProject();
    $('production-project-current').textContent = project?.name || (projects.length ? '选择项目' : '没有可访问的项目');
    const group = selectedGroupId ? groups.find(g => g.id === selectedGroupId) : null;
    $('production-group-current').textContent = group?.name || '未分组';
  };
  const renderGroupPicker = () => {
    const rows = [{ id: null, name: '未分组', frameCount: null }, ...groups].map(group => {
      const button = documentObject.createElement('button'); button.type = 'button';
      const name = documentObject.createElement('span'); name.textContent = group.name;
      const count = documentObject.createElement('small');
      count.textContent = Number.isSafeInteger(group.frameCount) ? `${group.frameCount} 个画板` : '';
      button.append(name, count); button.setAttribute('aria-current', String((selectedGroupId ?? null) === (group.id ?? null)));
      button.addEventListener('click', event => {
        if (!event.isTrusted || current) return;
        selectedGroupId = group.id ?? null; syncProjectRows(); showPage('workspace'); controls(); $('production-group-open').focus();
      });
      return button;
    });
    if (!groups.length) { const note = documentObject.createElement('p'); note.className = 'subtle'; note.textContent = '此项目尚未建立分组'; rows.push(note); }
    $('production-group-options').replaceChildren(...rows);
  };
  const renderPicker = () => {
    const needle = $('production-project-search').value.trim().toLocaleLowerCase();
    const filtered = projects.filter(p => !needle || p.name.toLocaleLowerCase().includes(needle));
    const rows = filtered.map(p => {
      const button = documentObject.createElement('button'); button.type = 'button';
      button.setAttribute('aria-current', String(p.id === $('production-project').value)); button.textContent = projectLabel(p);
      button.addEventListener('click', event => {
        if (!event.isTrusted || current) return;
        $('production-project').value = p.id; selectedGroupId = null; groups = [];
        syncProjectRows(); closeProjectOptions(); controls(); $('production-project-open').focus();
        void loadGroups().catch(error => status(pluginErrorText(error)));
      });
      return button;
    });
    if (!rows.length) { const empty = documentObject.createElement('p'); empty.textContent = needle ? '没有匹配的项目' : '暂无项目'; rows.push(empty); }
    $('production-project-options').replaceChildren(...rows);
  };
  const loadGroups = async (signal, preferredId = undefined) => {
    const epoch = ++groupEpoch, projectId = $('production-project').value;
    const fetched = client && projectId ? await client.frameGroups(projectId, { signal }) : [];
    if (disposed || epoch !== groupEpoch) return false;
    groups = fetched;
    if (preferredId !== undefined) selectedGroupId = preferredId;
    if (selectedGroupId && !groups.some(group => group.id === selectedGroupId)) selectedGroupId = null;
    syncProjectRows(); renderGroupPicker(); controls(); return true;
  };
  const loadProjects = async (signal, preferredId) => {
    const epoch = ++pickerEpoch, response = await client.projects({ signal });
    if (disposed || epoch !== pickerEpoch) return false;
    const previous = preferredId || $('production-project').value || state.projectId;
    const before = $('production-project').value;
    projects = response;
    const nodes = [documentObject.createElement('option'), ...projects.map(p => { const option = documentObject.createElement('option'); option.value = p.id; option.textContent = projectLabel(p); return option; })];
    nodes[0].value = ''; nodes[0].textContent = '请选择项目'; $('production-project').replaceChildren(...nodes);
    $('production-project').value = projects.some(p => p.id === previous) ? previous : projects.length === 1 ? projects[0].id : '';
    if ($('production-project').value !== before) selectedGroupId = null;
    await loadGroups(signal);
    if (disposed || epoch !== pickerEpoch) return false;
    await refreshAccountPolicy(signal);
    if (disposed || epoch !== pickerEpoch) return false;
    syncProjectRows(); renderPicker(); controls(); return true;
  };
  const run = async (worker, { onError } = {}) => {
    if (current) return; const controller = new windowObject.AbortController(); current = controller; controls();
    let operationError = '';
    try { await worker(controller.signal); }
    catch (error) {
      if (isDesignerExpiredError(error)) handleDesignerExpired();
      else if (error?.status === 401) { user = null; client?.clearToken(); accountPolicy=null; updateQuotaDisplay(); authStatus('登录已失效，请重新登录。'); }
      operationError = pluginErrorText(error); status(designerExpired ? expiredDialogText() : operationError); onError?.(error);
    } finally {
      // Keep the in-flight guard until the final current-state read settles.
      try { const latest = await command('status'); render(latest.state); }
      catch { if (!operationError) operationError = '未能确认上传结果，请联系开发者'; }
      current = null; controls();
      if (designerExpired) status(expiredDialogText());
      else if (operationError) status(['unknownPrepare','unknownCommit','unknownClaim','unknownFinish','verificationPending'].includes(state.phase) ? '未能确认上传结果，请联系开发者' : operationError);
    }
  };
  const authenticated = async signal => {
    user = await client.me({ signal }); await loadProjects(signal);
    designerExpired=false; expiryDialogShown=false; if(expiryDialog?.open)expiryDialog.close();
    authStatus(`已登录：${user.username || $('production-username').value}。权限以项目为准。`);
  };
  // Figma's inline iframe need not grant allow-forms. Never depend on a native
  // form submission to start authentication; click/Enter share this guarded path.
  const login = event => {
    event.preventDefault(); if (!event.isTrusted || current || !connected || user) return;
    if ($('production-login-form').reportValidity?.() === false) return;
    authStatus('正在连接设计工具…');
    void run(async signal => {
      const password = $('production-password').value, username = $('production-username').value.trim();
      let priorServiceRevocationUnconfirmed = false;
      try {
        const confirmedOrigin = inputOrigin(), preserveOtherRemembered = customService() && remembered && remembered.origin !== confirmedOrigin;
        const rememberLogin = $('production-remember').checked && rememberSupported && !preserveOtherRemembered;
        await connect(); authStatus('正在验证账号…');
        if (inputOrigin() !== confirmedOrigin || service.origin !== confirmedOrigin) fail('BAD_ORIGIN');
        const result = await client.login({ username, password, rememberLogin }, { signal });
        if (!rememberLogin && remembered && (!customService() || remembered.origin === service.origin)) {
          // A refresh credential belongs to its persisted service, even for revocation.
          if (service.origin === remembered.origin && service.allowLocalhost === remembered.allowLocalhost) {
            await client.rememberedLogout(remembered.refreshToken, { signal }); client.setToken(result.token);
          } else { priorServiceRevocationUnconfirmed = true; }
          await command('remember-clear'); remembered = null; $('production-resume').hidden = true;
        }
        if (rememberLogin) {
          if (result.refreshToken && result.refreshExpiresAt) {
            const candidate = { ...service, username: $('production-username').value.trim(), refreshToken: result.refreshToken, refreshExpiresAt: result.refreshExpiresAt };
            try { await command('remember-write', { remembered: candidate }); remembered = candidate; $('production-resume').hidden = false; }
            catch { rememberSupported = false; $('production-remember').checked = false; }
          } else { rememberSupported = false; $('production-remember').checked = false; }
        }
        authStatus('正在读取账户与项目…');
        await authenticated(signal);
        if (preserveOtherRemembered) authStatus('已登录；原服务器的记住记录仍隔离保留，本次不保存登录。');
        if (priorServiceRevocationUnconfirmed) authStatus('已登录；本机旧登录记录已清除，原服务撤销尚未确认。');
        if (rememberLogin && !rememberSupported) authStatus('已登录；此设备暂时无法保存登录记录，下次请重新登录。');
      } finally { $('production-password').value = ''; }
    }, { onError(error) {
      // Authentication failure belongs on the visible login page, never only in
      // the hidden publication progress panel.
      if(isDesignerExpiredError(error)){handleDesignerExpired();return;}
      user = null; client?.clearToken(); accountPolicy=null; updateQuotaDisplay();
      authStatus('登录未完成，请联系开发者');
    } });
  };
  $('production-origin').addEventListener('input', () => {
    if (!customService()) return;
    if (switchLocked()) { if (service) $('production-origin').value = service.origin; authStatus('当前上传尚未确认，不能切换服务器。'); controls(); return; }
    client?.clearToken(); client = null; user = null; ++pickerEpoch; ++groupEpoch;
    projects = []; groups = []; selectedGroupId = null; accountPolicy = null;
    designerExpired = false; expiryDialogShown = false; expiryDialog?.close(); updateQuotaDisplay();
    $('production-password').value = ''; $('production-username').value = '';
    $('production-project').replaceChildren(); $('production-project-options').replaceChildren(); $('production-group-options').replaceChildren();
    $('production-project-current').textContent = '登录后读取项目'; $('production-group-current').textContent = '未分组';
    authStatus(matchesRemembered() ? `已保存 ${remembered.origin} 的登录；请明确点击恢复登录。` : '服务器已更改，请在确认地址后重新输入账号密码登录。');
    controls();
  });
  $('production-login').addEventListener('click', login);
  $('production-login-form').addEventListener('submit', login);
  $('production-login-form').addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.isComposing) return;
    if (event.repeat) { event.preventDefault(); return; }
    login(event);
  });
  const resumeLogin = async signal => {
    if (!remembered) fail('BAD_SCHEMA');
    // Validate the configured origin; never migrate a refresh credential.
    if (customService()) { if (!matchesRemembered()) fail('BAD_ORIGIN'); }
    else $('production-origin').value = remembered.origin;
    await connect(); if (service.origin !== remembered.origin || service.allowLocalhost !== remembered.allowLocalhost) fail('BAD_ORIGIN');
    await client.refresh(remembered.refreshToken, { signal }); await authenticated(signal); $('production-resume').hidden = true;
  };
  $('production-resume').addEventListener('click', event => { if (event.isTrusted) void run(async signal => { await resumeLogin(signal); }); });
  $('production-logout').addEventListener('click', event => { if (!event.isTrusted) return; void run(async signal => {
    let revoked = true, localCleared = true;
    if (remembered) {
      try { if (!client || service.origin !== remembered.origin) fail('BAD_ORIGIN'); await client.rememberedLogout(remembered.refreshToken, { signal }); } catch { revoked = false; }
      try { await command('remember-clear'); remembered = null; $('production-resume').hidden = true; } catch { localCleared = false; }
    }
    client?.clearToken(); user = null; projects = []; groups = []; selectedGroupId = null; accountPolicy=null; updateQuotaDisplay(); designerExpired=false; expiryDialogShown=false; expiryDialog?.close(); $('production-project').replaceChildren(); $('production-account-menu').open = false;
    authStatus(!localCleared ? '本机登录记录未能清除，请检查插件存储后重试退出。' : !revoked ? '本机已退出，服务端撤销未确认；请在账户安全设置中处理。' : '已退出登录。');
    if (!localCleared) fail('SDK_READ_FAILED');
  }); });
  const closeCreate = () => { $('production-create-popover').hidden = true; $('production-create-error').hidden = true; $('production-page-create-project').focus?.(); };
  const closeGroup = () => { $('production-group-popover').hidden = true; $('production-group-error').hidden = true; $('production-page-create-group').focus?.(); };
  const openCreate = event => { if (!event.isTrusted || current || !user || !['admin','designer'].includes(user.role)) return; $('production-create-popover').hidden = false; $('production-create-error').hidden = true; $('production-create-name').focus(); };
  $('production-project-open').addEventListener('click', event => { if (!event.isTrusted || current || !user || !client) return; showPage('projects', { focus: true }); void run(async signal => { await loadProjects(signal); }); });
  $('production-project-back').addEventListener('click', event => { if (event.isTrusted && !current) { closeProjectOptions(); $('production-project-open').focus(); } });
  $('production-page-create-project').addEventListener('click', openCreate);
  $('production-project-create').addEventListener('click', openCreate);
  $('production-create-cancel').addEventListener('click', event => { if (event.isTrusted) closeCreate(); });
  $('production-page-create-group').addEventListener('click', event => { if (!event.isTrusted || current || !user || !['admin','designer'].includes(user.role) || !selectedProject()?.permissions.canPublish) return; $('production-group-popover').hidden = false; $('production-group-error').hidden = true; $('production-group-name').focus(); });
  $('production-group-back').addEventListener('click', event => { if (!event.isTrusted) return; showPage('workspace'); $('production-group-open').focus(); });
  $('production-group-open').addEventListener('click', event => {
    if (!event.isTrusted || current || !user || !client || !selectedProject()) return;
    showPage('groups', { focus: true }); renderGroupPicker();
    $('production-group-options').children?.[0]?.focus?.();
  });
  $('production-group-cancel').addEventListener('click', event => { if (event.isTrusted) closeGroup(); });
  $('production-project-search').addEventListener('input', renderPicker);
  const submitProject = event => {
    if (!event.isTrusted || current || !user || !['admin','designer'].includes(user.role)) return;
    const name = $('production-create-name').value.trim();
    if (!name || name.length > 128) { $('production-create-error').textContent = '请输入不超过128字的项目名称。'; $('production-create-error').hidden = false; return; }
    void run(async signal => {
      try {
        const created = await client.createProject(name, { signal });
        if (!await loadProjects(signal, created.id) || $('production-project').value !== created.id) fail('HTTP_RESPONSE_INVALID');
        $('production-create-name').value = ''; closeCreate(); selectedGroupId = null; showPage('workspace'); $('production-project-open').focus(); authStatus('项目已创建。');
      } catch (error) {
        let visibleError=error;
        if(error?.code==='PROJECT_QUOTA_EXCEEDED'){try{await refreshAccountPolicy(signal)}catch(readError){if(isDesignerExpiredError(readError))visibleError=readError}}
        $('production-create-error').textContent=pluginErrorText(visibleError); $('production-create-error').hidden=false; throw error;
      }
    });
  };
  $('production-create-submit').addEventListener('click', submitProject);
  // Input Enter is left to the browser/IME (especially while composing). Only
  // suppress the native Enter activation of the submit button itself.
  $('production-create-submit').addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
  const submitGroup = event => {
    if (!event.isTrusted || current || !user || !['admin','designer'].includes(user.role)) return;
    const name = $('production-group-name').value.trim();
    if (!name || name.length > 128) { $('production-group-error').textContent = '请输入分组名称（最多128字）。'; $('production-group-error').hidden = false; return; }
    void run(async signal => {
      try { const projectId = $('production-project').value; if (!projectId) fail('BAD_SCHEMA'); const group = await client.createFrameGroup(projectId, name, { signal }); if (!await loadGroups(signal, group.id)) fail('HTTP_RESPONSE_INVALID'); $('production-group-name').value = ''; closeGroup(); showPage('workspace'); $('production-group-open').focus(); }
      catch (error) { $('production-group-error').textContent = '未能创建分组，请联系开发者'; $('production-group-error').hidden = false; throw error; }
    });
  };
  $('production-group-submit').addEventListener('click', submitGroup);
  $('production-group-submit').addEventListener('keydown', event => { if (event.key === 'Enter') event.preventDefault(); });
  documentObject.addEventListener('keydown', event => { if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229) return; const page = $('app').dataset.productionPage; if (page === 'groups') { if (!$('production-group-popover').hidden) closeGroup(); else showPage('workspace'); return; } if (page !== 'projects') return; if (!$('production-create-popover').hidden) closeCreate(); else closeProjectOptions(); });
  $('production-project').addEventListener('change', () => { syncProjectRows(); controls(); });
  for (const [name, value] of [['scope-page', 'page'], ['scope-selection', 'selection']]) $(name).addEventListener('change', event => { if (!event.isTrusted || current || !event.target.checked) return; $('scope').value = value; queueFrames(); });
  $('scope').addEventListener('change', event => { if (event.isTrusted && !current) queueFrames(); });
  $('design-scale').addEventListener('change', event => { if (!event.isTrusted) return; $('scale').value = event.target.value; });
  const closeWorkspaceSettings = () => { $('workspace-settings-panel').hidden = true; $('production-settings-toggle').setAttribute('aria-expanded', 'false'); };
  $('production-settings-toggle').addEventListener('click', event => { if (!event.isTrusted) return; const open = $('workspace-settings-panel').hidden; $('workspace-settings-panel').hidden = !open; $('production-settings-toggle').setAttribute('aria-expanded', String(open)); });
  documentObject.addEventListener('click', event => { if (!$('workspace-settings-panel').hidden && !event.target.closest?.('#workspace-settings')) closeWorkspaceSettings(); });
  documentObject.addEventListener('keydown', event => { if (event.key === 'Escape' && !$('workspace-settings-panel').hidden) closeWorkspaceSettings(); });
  $('publish').addEventListener('click', event => { if (event.isTrusted && user && !current && !$('publish').disabled) { render({ phase: 'authorizing' }); showPage('progress', { focus: true }); status('正在读取画板…'); void run(async signal => { await refreshFrames(); checkCancelled(signal); const result = await command('publish', { projectId: id($('production-project').value), coordinateMode: 'project-xy', scope: $('scope').value, scale: Number($('design-scale').value) || 1, includeSlices: $('slices').checked, chunkCapacity: 16, designSpec: $('design-spec').value || 'web', groupId: selectedGroupId || null }, { signal, taskTimeoutMs: 0 }); render(result.state); }); } });
  $('production-progress-back').addEventListener('click', event => { if (!event.isTrusted || current) return; showPage('workspace', { focus: true }); });
  $('cancel').addEventListener('click', event => { if (event.isTrusted && current) { current.abort(); $('cancel').disabled = true; status('已请求取消；请等待导出和网络请求安全结束。'); } });
  const removeResize = bindResizeControls(documentObject, { getHeight: () => height, async resize(next) { try { const result = await bridge.request('resize', { height: next }); height = result.height; } catch (error) { status(pluginErrorText(error)); } } });
  $('settings').hidden = true; $('export').hidden = true; $('publish').textContent = '上传'; if (!$('design-spec').value) $('design-spec').value = 'web'; if (!$('design-scale').value) $('design-scale').value = '1'; $('scale').value = $('design-scale').value; controls();
  const ready = (async () => {
    try {
      const hello = await pluginHello(bridge); if (hello.state.production !== true) fail('BAD_SCHEMA'); height = hello.height; connected = true; config = hello.state.config || {}; rememberSupported = hello.state.rememberSupported === true;
      if (customService()) { $('production-origin').value = hello.state.service?.origin || ''; $('production-origin').readOnly = false; $('production-origin').placeholder = '填写自建 HTTPS 服务器地址'; authStatus('请填写自己的 HTTPS 服务器地址，然后登录。'); }
      else if (hello.state.service || config.origin) { const preferred = hello.state.service || config; $('production-origin').value = preferred.origin; }
      render(hello.state);
      try { const stored = await command('remember-read'); remembered = stored.remembered; rememberSupported = stored.supported; }
      catch { remembered = null; rememberSupported = false; }
      if (!rememberSupported) { $('production-remember').checked = false; $('production-remember').disabled = true; }
      controls();
      if (customService() && remembered) {
        // Display the exact saved server before offering an explicit restoration.
        // No refresh or login is dispatched by the empty release configuration.
        if (!$('production-origin').value) { $('production-origin').value = remembered.origin; $('production-username').value = remembered.username; }
        authStatus(`已保存 ${remembered.origin} 的登录；核对地址后点击恢复登录，不会自动连接。`);
        controls();
      } else if (remembered && remembered.origin === config.origin && remembered.allowLocalhost === config.allowLocalhost) {
        $('production-username').value = remembered.username;
        authStatus('正在自动登录…');
        await run(async signal => {
          try { await resumeLogin(signal); }
          catch (error) { if (error?.status === 401) { try { await command('remember-clear'); remembered = null; } catch { /* Local storage fault: never imply revocation. */ } } throw error; }
        });
        if (!user) { if(!designerExpired)authStatus('自动登录未完成，请手动登录。'); $('production-resume').hidden = !remembered; }
      } else if (remembered) {
        $('production-username').value = remembered.username;
        $('production-resume').hidden = true;
        authStatus('服务地址已更新，请使用原账号重新登录。');
      }
      try { await refreshFrames(); } catch (error) { status(pluginErrorText(error)); } controls();
    } catch (error) { controls(); if(isDesignerExpiredError(error))handleDesignerExpired();else status('连接失败，请联系开发者'); }
  })();
  return { bridge, ready, async dispose() { disposed = true; current?.abort(); client?.clearToken(); if (frameTimer !== null) windowObject.clearTimeout(frameTimer); if (progressTimer !== null) windowObject.clearTimeout(progressTimer); removeResize(); await bridge.close(); } };
}
if (typeof window !== 'undefined' && typeof document !== 'undefined') mountPluginUI();
