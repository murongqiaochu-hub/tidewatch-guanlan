// Independently authored from the permitted platform contracts. No legacy implementation input.
import * as fs from 'node:fs/promises';
import { constants as C } from 'node:fs';
import path from 'node:path';
import { createHash,createHmac, randomBytes } from 'node:crypto';

export const TABLES = Object.freeze(['users','projects','projectGroups','frameGroups','projectMembers','projectInvites','inviteClaims','designFiles','pages','sections','frames','frameRevisions','assets','revisionAssets','publishSessions','publishOperations','auditLogs','rememberedLogins']);
// Unknown states retain the lock. Time alone never proves that publishing ended.
export const pendingPublishOperation = row => !['completed','cancelled'].includes(row.status);
export const pendingPublishSession = row => !['committed','aborted','expired'].includes(row.status);
export const newId = () => randomBytes(16).toString('base64url');
export function platformError(status, code, message = code) {
  return Object.assign(new Error(message), { status, statusCode: status, code });
}
const fail = (code, status = 400) => { throw platformError(status, code); };
const SH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const EXT = new Map([['image/png','png'],['image/jpeg','jpg'],['image/webp','webp'],['image/svg+xml','svg'],['application/json','json'],['text/plain','txt']]);
const activeRoots = new Set();
const trustedJSON = new WeakSet();
const aborted = signal => { if (signal?.aborted) throw platformError(499,'request_aborted'); };
function frozenJSON(value, maxDepth = 80, seen = new Set(), depth = 0) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value || typeof value !== 'object' || depth > maxDepth || seen.has(value)) fail('invalid_json');
  if (trustedJSON.has(value)) return value;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) fail('invalid_json');
  if(Array.isArray(value) && (Object.keys(value).length !== value.length || Object.keys(value).some((key,index)=>key !== String(index)))) fail('invalid_json');
  seen.add(value);
  const out = Array.isArray(value) ? [] : Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    // Null-prototype owned objects preserve even unfamiliar JSON keys without prototype assignment.
    out[key] = frozenJSON(child, maxDepth, seen, depth + 1);
  }
  seen.delete(value);
  trustedJSON.add(out); return Object.freeze(out);
}
function prepareRecord(table,record,preceding) {
  if(!record || typeof record !== 'object' || Array.isArray(record)) fail('invalid_record');
  let id=record.id;
  if(id === undefined) {
    if(table==='projectMembers' && typeof record.projectId==='string' && typeof record.userId==='string') id=`pm_${createHash('sha256').update(`${record.projectId}\0${record.userId}`).digest('hex').slice(0,32)}`;
    else if(table==='revisionAssets' && typeof record.revisionId==='string') {const index=preceding.filter(row=>row.revisionId===record.revisionId).length;id=`ras_legacy_${createHash('sha256').update(`${record.revisionId}\0${index}`,'utf8').digest('hex').slice(0,32)}`;}
    else fail('invalid_record_id');
    const cloned=frozenJSON(record),wrapped=Object.assign(Object.create(null),cloned);Object.defineProperty(wrapped,'id',{value:id,enumerable:false});trustedJSON.add(wrapped);return Object.freeze(wrapped);
  }
  if(typeof id!=='string'||!id)fail('invalid_record_id');
  return frozenJSON(record);
}
function validateReferences(root,status=500) {
  const maps=Object.fromEntries(TABLES.map(t=>[t,new Map(root[t].map(r=>[r.id,r]))]));
  const bad=()=>fail('catalog_relations_invalid',status);
  const refs={users:{ownerId:'users'},projects:{ownerId:'users',createdByUserId:'users',groupId:'projectGroups'},projectGroups:{ownerUserId:'users'},projectMembers:{projectId:'projects',userId:'users'},projectInvites:{projectId:'projects',createdByUserId:'users'},inviteClaims:{inviteId:'projectInvites',projectId:'projects',userId:'users'},designFiles:{projectId:'projects'},frameGroups:{projectId:'projects'},pages:{designFileId:'designFiles'},sections:{projectId:'projects',designFileId:'designFiles',pageId:'pages',parentSectionId:'sections'},frames:{designFileId:'designFiles',pageId:'pages',currentRevisionId:'frameRevisions',sectionId:'sections',groupId:'frameGroups'},frameRevisions:{frameId:'frames',pageId:'pages',previewAssetId:'assets',layerDocAssetId:'assets'},revisionAssets:{revisionId:'frameRevisions',assetId:'assets'},publishSessions:{projectId:'projects',designFileId:'designFiles'},rememberedLogins:{userId:'users'}};
  for(const [table,fields]of Object.entries(refs))for(const row of root[table])for(const [field,target]of Object.entries(fields))if(row[field]!==undefined&&row[field]!==null&&(typeof row[field]!=='string'||!maps[target].has(row[field])))bad();
  const unique=(table,fields,enabled=()=>true)=>{const keys=new Set();for(const row of root[table]){if(!enabled(row)||fields.some(k=>row[k]===undefined||row[k]===null))continue;const key=JSON.stringify(fields.map(k=>row[k]));if(keys.has(key))bad();keys.add(key);}};
  unique('projectGroups',['ownerUserId','name']);unique('frameGroups',['projectId','name']);unique('projectMembers',['projectId','userId']);for(const project of root.projects){if(project.groupId!=null){const group=maps.projectGroups.get(project.groupId);if(!group||group.ownerUserId!==project.ownerId)bad();}}unique('inviteClaims',['inviteId','userId']);for(const frame of root.frames){if(frame.groupId==null)continue;const group=maps.frameGroups.get(frame.groupId),file=maps.designFiles.get(frame.designFileId),projectId=frame.projectId??file?.projectId;if(!group||group.projectId!==projectId)bad();}unique('pages',['designFileId','figmaPageId']);unique('frames',['designFileId','figmaNodeId']);unique('designFiles',['projectId','figmaFileKey'],r=>Boolean(r.figmaFileKey));unique('assets',['sha256']);
  for(const frame of root.frames){const page=maps.pages.get(frame.pageId),revision=maps.frameRevisions.get(frame.currentRevisionId);if(page&&frame.designFileId!==undefined&&page.designFileId!==frame.designFileId)bad();if(frame.state==='published'&&!revision)bad();if(revision&&revision.frameId!==frame.id)bad();}
  for(const revision of root.frameRevisions){const frame=maps.frames.get(revision.frameId),page=maps.pages.get(revision.pageId);if(revision.coordinateMode==='project-xy') {const source=maps.designFiles.get(revision.designFileId),target=frame&&maps.designFiles.get(frame.designFileId);if(!frame||!page||!source||!target||source.projectId!==target.projectId||page.designFileId!==source.id||revision.projectId!==source.projectId)bad();}else if(frame&&page&&frame.designFileId!==page.designFileId)bad();}
  for(const claim of root.inviteClaims){const invite=maps.projectInvites.get(claim.inviteId);if(invite&&claim.projectId!==undefined&&claim.projectId!==invite.projectId)bad();}
  for(const session of root.publishSessions){const file=maps.designFiles.get(session.designFileId);if(file&&session.projectId!==undefined&&session.projectId!==file.projectId)bad();}
  // These invariants also cover writers outside the publishing service. The lock
  // belongs to this single Vault/service; it is not a distributed service lease.
  unique('publishOperations',['projectId'],pendingPublishOperation);
  unique('publishSessions',['operationId','batchIndex'],s=>s.operationId!==undefined);
  for(const operation of root.publishOperations){
    if(!ID.test(operation.id)||!ID.test(operation.projectId)||!maps.users.has(operation.createdBy)||!SH.test(operation.requestHash)||!Array.isArray(operation.frameIds)||(!operation.frameIds.length && !(operation.cancelTombstone===true && operation.status==='cancelled'))||operation.frameIds.length>10000||new Set(operation.frameIds).size!==operation.frameIds.length||operation.frameIds.some(id=>typeof id!=='string'||!id.length||id.length>512||/[\x00-\x20\x7f]/.test(id)))bad();
    if(pendingPublishOperation(operation)){
      const project=maps.projects.get(operation.projectId);
      if(!project||project.deletedAt||(project.ownerId??null)!==operation.projectOwnerId)bad();
      if(operation.groupId!=null&&maps.frameGroups.get(operation.groupId)?.projectId!==operation.projectId)bad();
      if(root.publishSessions.some(s=>(s.projectId===operation.projectId||maps.designFiles.get(s.designFileId)?.projectId===operation.projectId)&&s.operationId!==operation.id&&pendingPublishSession(s)))bad();
    }
  }
  for(const session of root.publishSessions)if(session.operationId!==undefined){
    const operation=maps.publishOperations.get(session.operationId);
    if(!operation||session.projectId!==operation.projectId||session.createdBy!==operation.createdBy||!Number.isSafeInteger(session.batchIndex)||session.batchIndex<0||session.batchIndex>=10000||!SH.test(session.requestHash)||!session.prepareResult||session.prepareResult.sessionId!==session.id)bad();
    if(Object.hasOwn(session,'groupId')!==Object.hasOwn(operation,'groupId')||session.groupId!==operation.groupId)bad();
    if(!pendingPublishOperation(operation)&&pendingPublishSession(session))bad();
  }
  const done=new Set();for(const section of root.sections){let row=section;const chain=[],seen=new Set();while(row&&!done.has(row.id)){if(seen.has(row.id))bad();seen.add(row.id);chain.push(row.id);const parent=maps.sections.get(row.parentSectionId);if(parent)for(const key of ['projectId','designFileId','pageId'])if(row[key]!=null&&parent[key]!=null&&row[key]!==parent[key])bad();row=parent;}for(const id of chain)done.add(id);}
}
function normalizeCatalog(input) {
  if (!input || Array.isArray(input) || input.version !== 1) fail('invalid_catalog', 500);
  const next = { ...input };
  for (const table of TABLES) {
    if (next[table] === undefined) next[table] = [];
    if (!Array.isArray(next[table])) fail('invalid_catalog', 500);
    const seen = new Set(),composites = new Set(),rows=[];
    for (const source of next[table]) {
      const record=prepareRecord(table,source,rows);
      if(seen.has(record.id))fail('invalid_catalog_ids',500);seen.add(record.id);
      if(table==='projectMembers'){const key=JSON.stringify([record.projectId,record.userId]);if(composites.has(key))fail('duplicate_membership',500);composites.add(key);}
      rows.push(record);
    }
    trustedJSON.add(rows);next[table]=Object.freeze(rows);
  }
  const ready=frozenJSON(next);validateReferences(ready);return ready;
}
function makeDraft(base) {
  const root = { ...base }, changed = new Set(), views = new Map();
  const check = table => { if (!TABLES.includes(table)) fail('unknown_collection'); };
  function writable(table) { check(table); if (!changed.has(table)) { root[table] = [...root[table]]; changed.add(table); } views.delete(table); return root[table]; }
  const api = Object.freeze({
    all(table) { check(table); if (!changed.has(table)) return root[table]; if (!views.has(table)) views.set(table, Object.freeze([...root[table]])); return views.get(table); },
    byId(table,id) { check(table); return root[table].find(row => row.id === id) ?? null; },
    add(table,record) { check(table); const copy=prepareRecord(table,record,root[table]); if(root[table].some(row=>row.id===copy.id || (table==='projectMembers'&&row.projectId===copy.projectId&&row.userId===copy.userId)))fail('duplicate_id',409);writable(table).push(copy);return copy; },
    patch(table,id,fields) { check(table); const index=root[table].findIndex(row=>row.id===id);if(index<0)fail('not_found',404);if(fields.id!==undefined&&fields.id!==id)fail('immutable_id');const before=root[table][index],value={...before,...fields};if(Object.prototype.propertyIsEnumerable.call(before,'id'))value.id=id;else delete value.id;const copy=prepareRecord(table,value,root[table].slice(0,index));writable(table)[index]=copy;return copy; },
    remove(table,id) { check(table);if(typeof id!=='string')fail('invalid_record_id'); const index = root[table].findIndex(row => row.id === id); if (index < 0) return false; writable(table).splice(index,1); return true; },
    set(table,records) { check(table); if (!Array.isArray(records)) fail('invalid_collection'); const ids=new Set(),rows=[];for(const record of records){const row=prepareRecord(table,record,rows);if(ids.has(row.id))fail('duplicate_id',409);ids.add(row.id);rows.push(row);} root[table] = rows; changed.add(table); views.delete(table); }
  });
  return { api, finish() { for (const table of changed) Object.freeze(root[table]); return Object.freeze(root); }, changed };
}
// A token generator avoids constructing a second whole-catalog string or history clone.
function* jsonTokens(value, limits, depth = 0) {
  if (depth > limits.maxDepth) fail('catalog_depth_limit',413);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') { yield JSON.stringify(value); return; }
  if (typeof value === 'string') { if (Buffer.byteLength(value) > limits.maxStringBytes) fail('catalog_string_limit',413); yield JSON.stringify(value); return; }
  if (!value || typeof value !== 'object') fail('invalid_json');
  const array = Array.isArray(value); yield array ? '[' : '{';
  let comma = false;
  for (const key of Object.keys(value)) {
    if (comma) yield ','; comma = true;
    if (!array) { if(Buffer.byteLength(key) > limits.maxStringBytes) fail('catalog_string_limit',413); yield JSON.stringify(key); yield ':'; }
    yield* jsonTokens(value[key], limits, depth + 1);
  }
  yield array ? ']' : '}';
}
function unsafeDataPrefixes() {
  const raw = process.env.HANDOFF_DENY_DATA_PREFIXES || '';
  return raw.split(path.delimiter).filter(Boolean).map(value => path.resolve(value));
}
function checkedRoot(dataDir) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || dataDir.includes('\0')) fail('invalid_data_root');
  const root = path.resolve(dataDir);
  const explicitDataMount=dataDir==='/data'&&root==='/data';
  const denied = unsafeDataPrefixes().some(prefix => root === prefix || root.startsWith(prefix + path.sep));
  if ((!explicitDataMount&&root.split(path.sep).filter(Boolean).length < 3) || /(?:^|\/)(?:secrets?|backups?|\.secrets|\.dsh)(?:\/|$)/i.test(root) || denied) fail('unsafe_data_root');
  return root;
}
async function requireExplicitDataMount() {
  let handle;
  try {
    if(process.platform!=='linux')fail('unsafe_data_root');
    handle=await fs.open(`/proc/${process.pid}/mountinfo`,C.O_RDONLY|C.O_NOFOLLOW);
    const bytes=Buffer.alloc(1024*1024+1);let length=0;
    while(length<bytes.length){const result=await handle.read(bytes,length,bytes.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}
    if(length>1024*1024||!bytes.toString('utf8',0,length).split('\n').some(line=>line.split(' ')[4]==='/data'))fail('unsafe_data_root');
  } catch(e) {if(e?.status)throw e;fail('unsafe_data_root');} finally {await handle?.close();}
}
const at = (directory, name) => `/proc/self/fd/${directory.fd}/${name}`;
async function openDirectoryAbsolute(root, create = false) {
  if (process.platform !== 'linux') fail('directory_capability_unavailable',500);
  let handle = await fs.open('/', C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  try {
    for (const component of root.split('/').filter(Boolean)) {
      if (create) { try { await fs.mkdir(at(handle,component),{mode:0o700}); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
      const next = await fs.open(at(handle,component), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
      await handle.close(); handle = next;
    }
    return handle;
  } catch (e) { await handle.close(); throw e; }
}
export async function openCanonicalDirectory(directory,{create = false} = {}) {
  if(typeof directory !== 'string' || !path.isAbsolute(directory)) fail('invalid_directory');
  const canonical = path.resolve(directory),handle = await openDirectoryAbsolute(canonical,create);
  try { const actual = await handle.stat(),named = await fs.lstat(canonical); if(!named.isDirectory() || actual.dev !== named.dev || actual.ino !== named.ino || await fs.realpath(canonical) !== canonical) fail('unsafe_directory',500); return handle; } catch(e) {await handle.close();throw e;}
}
async function childDirectory(parent, name, create = false) {
  if (!ID.test(name)) fail('invalid_directory');
  if (create) { try { await fs.mkdir(at(parent,name),{mode:0o700}); } catch(e) { if (e.code !== 'EEXIST') throw e; } }
  const handle = await fs.open(at(parent,name), C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
  if (create) await handle.chmod(0o700);
  return handle;
}
async function openRegular(directory,name,flags = C.O_RDONLY) {
  const handle = await fs.open(at(directory,name), flags | C.O_NOFOLLOW,0o600);
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.nlink !== 1) fail('unsafe_file',500); return {handle,stat}; } catch(e) { await handle.close(); throw e; }
}
async function unlinkOwned(directory,name,identity) {
  // Only a name created by this writer and the same inode may be unlinked.
  if (!/^\.(?:catalog|original|meta|stage|lock)-[a-f0-9]{32}\.tmp$/.test(name)) fail('unsafe_cleanup',500);
  try { const stat = await fs.lstat(at(directory,name)); if (stat.dev !== identity.dev || stat.ino !== identity.ino || !stat.isFile()) fail('cleanup_identity_changed',500); await fs.unlink(at(directory,name)); } catch(e) { if(e.code !== 'ENOENT') throw e; }
}
async function readBounded(handle, size, maxBytes, signal) {
  if (!Number.isSafeInteger(size) || size > maxBytes) fail('read_limit',413);
  const bytes = Buffer.alloc(size); let offset = 0;
  while (offset < size) { aborted(signal); const result = await handle.read(bytes,offset,Math.min(64*1024,size-offset),offset); if (!result.bytesRead) fail('truncated_file',500); offset += result.bytesRead; }
  const extra = Buffer.alloc(1); if ((await handle.read(extra,0,1,size)).bytesRead) fail('file_size_changed',500);
  aborted(signal); return bytes;
}
export async function openVault({dataDir,clock = Date.now,limits = {}} = {}) {
  const rootPath = checkedRoot(dataDir);
  if(rootPath==='/data')await requireExplicitDataMount();
  if (activeRoots.has(rootPath)) fail('vault_already_open',409);
  const budget = { maxCatalogBytes:128*1024*1024,maxStringBytes:16*1024*1024,maxDepth:80,maxOriginalBytes:256*1024*1024,...limits };
  for(const name of ['maxCatalogBytes','maxStringBytes','maxOriginalBytes','maxDepth']) if(!Number.isSafeInteger(budget[name]) || budget[name] < 1 || budget[name] > (name==='maxDepth'?128:1024*1024*1024)) fail('invalid_storage_limits',500);
  activeRoots.add(rootPath);
  let root,assets,tmp,catalog,closed = false,closing = false,tail = Promise.resolve(),lockHandle,lockName,lockStat;
  let writes = 0,commits = 0,cleanupErrors = 0,durabilityWarnings = 0;
  // Process-unique, read-only generation used to correlate independent reader DTOs.
  // It changes on every committed catalog transaction and is never persisted.
  const readEpoch = randomBytes(16).toString('hex');
  const pending = new Set();
  const safeError = e => e?.status ? e : platformError(500,'storage_io_error');
  async function fault(point) { if (typeof limits.fault === 'function') await limits.fault(point); }
  async function atomic(directory,name,tokens,kind = 'catalog',signal) {
    const temporary = `.${kind}-${randomBytes(16).toString('hex')}.tmp`;
    let handle,identity,renamed = false;
    try {
      handle = await fs.open(at(directory,temporary),C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
      identity = await handle.stat(); await handle.chmod(0o600);
      let total = 0,chunk = '',chunkBytes = 0;
      const flush = async () => { if (chunk) { await handle.writeFile(chunk); chunk = ''; chunkBytes = 0; } };
      for (const token of tokens) {
        aborted(signal); const n = Buffer.byteLength(token); total += n;
        if (total > budget.maxCatalogBytes) fail('catalog_size_limit',413);
        if (n > 64*1024) { await flush(); await handle.writeFile(token); }
        else { chunk += token; chunkBytes += n; if(chunkBytes >= 64*1024) await flush(); }
      }
      await flush(); await fault('beforeFileSync'); await handle.sync(); await handle.close(); handle = null;
      aborted(signal); await fault('beforeRename'); await fs.rename(at(directory,temporary),at(directory,name)); renamed = true;
      // Rename is the commit point. An error after it must never masquerade as a rollback.
      try { await fault('afterRename'); await directory.sync(); await fault('afterDirectorySync'); } catch { durabilityWarnings++; }
      writes++; return total;
    } finally {
      if (handle) await handle.close().catch(()=>{});
      if (!renamed && identity) await unlinkOwned(directory,temporary,identity).catch(()=>{cleanupErrors++;});
    }
  }
  function io(operation) {
    if (closed || closing) return Promise.reject(platformError(503,'vault_closed'));
    const promise = Promise.resolve().then(operation).catch(e=>{throw safeError(e);});
    pending.add(promise); promise.finally(()=>pending.delete(promise)).catch(()=>{}); return promise;
  }
  function serial(operation) { return io(()=>{ const promise = tail.then(operation); tail = promise.catch(()=>{}); return promise; }); }
  async function acquireLock() {
    // Exclusive process lease; stale leases are reclaimed only after ESRCH and exact inode/content validation.
    const name = 'writer.lock';
    try {
      lockHandle = await fs.open(at(root,name),C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
    } catch(e) {
      if(e.code !== 'EEXIST') throw e;
      const old = await openRegular(root,name); let raw,record;
      try { raw = await readBounded(old.handle,old.stat.size,1024); record = JSON.parse(raw); } finally { await old.handle.close(); }
      if (!Number.isSafeInteger(record.pid) || record.pid <= 0 || !/^[a-f0-9]{32}$/.test(record.nonce)) fail('vault_locked',409);
      try { process.kill(record.pid,0); fail('vault_locked',409); } catch(err) { if(err.code !== 'ESRCH') throw err; }
      const again = await openRegular(root,name);
      try { const text = await readBounded(again.handle,again.stat.size,1024); if(again.stat.ino !== old.stat.ino || again.stat.dev !== old.stat.dev || !text.equals(raw)) fail('vault_locked',409); await fs.unlink(at(root,name)); } finally { await again.handle.close(); }
      lockHandle = await fs.open(at(root,name),C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600);
    }
    lockName = name; lockStat = await lockHandle.stat(); await lockHandle.chmod(0o600);
    await lockHandle.writeFile(JSON.stringify({pid:process.pid,nonce:randomBytes(16).toString('hex')})); await lockHandle.sync();
  }
  async function releaseLock() {
    if (!lockHandle) return;
    await lockHandle.close(); lockHandle = null;
    const stat = await fs.lstat(at(root,lockName));
    if(stat.dev !== lockStat.dev || stat.ino !== lockStat.ino || !stat.isFile()) fail('lock_identity_changed',500);
    await fs.unlink(at(root,lockName)); await root.sync();
  }
  try {
    root = await openCanonicalDirectory(rootPath,{create:true}); await root.chmod(0o700);
    if (await fs.realpath(rootPath) !== rootPath) fail('unsafe_data_root');
    await acquireLock(); assets = await childDirectory(root,'assets',true); tmp = await childDirectory(root,'tmp',true);
    try {
      const file = await openRegular(root,'catalog.json');
      try { const bytes = await readBounded(file.handle,file.stat.size,budget.maxCatalogBytes); catalog = normalizeCatalog(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))); await file.handle.chmod(0o600); }
      finally { await file.handle.close(); }
    } catch(e) {
      if (e.code !== 'ENOENT') throw e;
      catalog = normalizeCatalog({version:1}); await atomic(root,'catalog.json',jsonTokens(catalog,budget));
    }
  } catch(e) {
    if(lockHandle) await releaseLock().catch(()=>{});
    await Promise.allSettled([assets?.close(),tmp?.close(),root?.close()]); activeRoots.delete(rootPath); throw safeError(e);
  }
  function descriptor(record) {
    if (!record || !SH.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes <= 0 || typeof record.mime !== 'string' || !record.mime || record.mime.length > 160) fail('invalid_asset');
    const relativePath = `${record.sha256.slice(0,2)}/${record.sha256}.${EXT.get(record.mime) ?? 'bin'}`;
    if(record.relativePath !== undefined && record.relativePath !== relativePath) fail('invalid_asset_path');
    return {...record,relativePath};
  }
  async function readFile(directory,name,maxBytes,signal,expected) {
    const file = await openRegular(directory,name);
    try {
      if(expected && file.stat.size !== expected.bytes) fail('asset_size_mismatch',500);
      const bytes = await readBounded(file.handle,file.stat.size,maxBytes,signal);
      if(expected && createHash('sha256').update(bytes).digest('hex') !== expected.sha256) fail('asset_hash_mismatch',500);
      return bytes;
    } finally { await file.handle.close(); }
  }
  async function immutable(directory,name,bytes,kind,signal) {
    const temporary = `.${kind}-${randomBytes(16).toString('hex')}.tmp`; let handle,identity;
    try {
      handle = await fs.open(at(directory,temporary),C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600); identity = await handle.stat(); await handle.chmod(0o600);
      for(let start=0;start<bytes.length;start+=65536) { aborted(signal); await handle.writeFile(bytes.subarray(start,start+65536)); }
      await handle.sync(); await handle.close(); handle = null; aborted(signal);
      try { await fs.link(at(directory,temporary),at(directory,name)); } catch(e) { if(e.code !== 'EEXIST') throw e; }
      await unlinkOwned(directory,temporary,identity); identity = null; await directory.sync();
    } finally { if(handle) await handle.close().catch(()=>{}); if(identity) await unlinkOwned(directory,temporary,identity).catch(()=>{cleanupErrors++;}); }
  }
  const STAGING_MARKER='.staging-owner.json';let stagingKey;
  async function loadStagingKey(create=false){if(stagingKey)return stagingKey;let file;try{file=await openRegular(root,'.staging-ownership.key');}catch(e){if(e.code!=='ENOENT')throw e;if(!create)return null;await immutable(root,'.staging-ownership.key',randomBytes(32),'meta');file=await openRegular(root,'.staging-ownership.key');}try{if(file.stat.size!==32)fail('staging_ownership_invalid',409);stagingKey=await readBounded(file.handle,file.stat.size,32);return stagingKey;}finally{await file.handle.close();}}
  async function stageDirectory(sessionId) {
    let created=false;try{await fs.mkdir(at(tmp,sessionId),{mode:0o700});created=true;}catch(e){if(e.code!=='EEXIST')throw e;}
    const directory=await childDirectory(tmp,sessionId);try{await directory.chmod(0o700);if(created){const marker={kind:'heron-independent-staging-v1',sessionId,nonce:randomBytes(16).toString('hex')};marker.mac=createHmac('sha256',await loadStagingKey(true)).update(JSON.stringify([sessionId,marker.nonce])).digest('hex');await immutable(directory,STAGING_MARKER,Buffer.from(JSON.stringify(marker)),'stage');await tmp.sync();}return directory;}catch(e){await directory.close();throw e;}
  }
  const vault = {
    get catalog() { return catalog; }, get readVersion() { return `${readEpoch}:${commits}`; }, dataDir:rootPath, assetsDir:path.join(rootPath,'assets'),
    transact(callback,{signal} = {}) { return serial(async()=>{ aborted(signal); const draft = makeDraft(catalog); const value = await callback(draft.api); aborted(signal); const next = draft.finish(); if(draft.changed.size) { validateReferences(next,409); await atomic(root,'catalog.json',jsonTokens(next,budget),'catalog',signal); catalog = next; commits++; } return value; }); },
    assetPath(record) { const safe = descriptor(record); return path.join(rootPath,'assets',safe.relativePath); },
    putOriginal(input) {
      // Capture mutable caller bytes before any queue wait.
      let record,bytes; try { record = descriptor(input); if(!(input.data instanceof Uint8Array)) fail('invalid_asset_bytes'); bytes = Buffer.from(input.data); if(bytes.length !== record.bytes || bytes.length > budget.maxOriginalBytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256) fail('asset_hash_mismatch'); } catch(e) { return Promise.reject(e); }
      return serial(async()=>{
        const directory = await childDirectory(assets,record.sha256.slice(0,2),true);
        try {
          const metaName = `${record.sha256}.meta.json`; let metadata;
          const known=catalog.assets.find(asset=>asset.sha256===record.sha256);if(known&&(known.mime!==record.mime||known.bytes!==record.bytes))fail('asset_descriptor_conflict',409);if(known)descriptor(known);
          try { metadata = JSON.parse((await readFile(directory,metaName,8192)).toString('utf8')); } catch(e) { if(e.code !== 'ENOENT') throw e; }
          if(metadata && (metadata.mime !== record.mime || metadata.bytes !== record.bytes)) fail('asset_descriptor_conflict',409);
          if(known&&metadata&&known.id!==metadata.id)fail('asset_identity_conflict',409);
          if (!metadata) metadata = known??{id:newId(),sha256:record.sha256,mime:record.mime,bytes:record.bytes,relativePath:record.relativePath,createdAt:new Date(clock()).toISOString(),createdBy:null};
          await immutable(directory,path.basename(record.relativePath),bytes,'original');
          await readFile(directory,path.basename(record.relativePath),budget.maxOriginalBytes,undefined,record);
          if(!metadata || !metadata.id) fail('invalid_asset_metadata',500);
          await immutable(directory,metaName,Buffer.from(JSON.stringify(metadata)),'meta');
          return frozenJSON(metadata);
        } finally { await directory.close(); }
      });
    },
    readOriginal(input,{maxBytes = budget.maxOriginalBytes,signal} = {}) { return io(async()=>{ const record = descriptor(input); aborted(signal); const directory = await childDirectory(assets,record.sha256.slice(0,2)); try { return await readFile(directory,path.basename(record.relativePath),maxBytes,signal,record); } finally { await directory.close(); } }); },
    openOriginal(input,{signal} = {}) { return io(async()=>{ const record = descriptor(input); aborted(signal); const directory = await childDirectory(assets,record.sha256.slice(0,2)); let file; try { file = await openRegular(directory,path.basename(record.relativePath)); if(file.stat.size !== record.bytes) fail('asset_size_mismatch',500); const hash = createHash('sha256'); const chunk = Buffer.alloc(65536); let offset = 0; while(offset < record.bytes) { aborted(signal); const part = await file.handle.read(chunk,0,Math.min(chunk.length,record.bytes-offset),offset); if(!part.bytesRead) fail('truncated_file',500); hash.update(chunk.subarray(0,part.bytesRead)); offset += part.bytesRead; } if(hash.digest('hex') !== record.sha256) fail('asset_hash_mismatch',500); } catch(e) { await file?.handle.close(); throw e; } finally { await directory.close(); }
      let settle; const lifetime = new Promise(resolve=>{settle=resolve;}); pending.add(lifetime); let done = false;
      return { ...file, async close() { if(done)return; done = true; try { await file.handle.close(); } finally { pending.delete(lifetime); settle(); } } };
    }); },
    stageAsset(sessionId,input,data,{signal} = {}) { let record,bytes; try { if(!ID.test(sessionId)) fail('invalid_session_id'); record = descriptor(input); if(!(data instanceof Uint8Array)) fail('invalid_asset_bytes'); bytes = Buffer.from(data); if(bytes.length !== record.bytes || bytes.length > budget.maxOriginalBytes || createHash('sha256').update(bytes).digest('hex') !== record.sha256) fail('asset_hash_mismatch'); } catch(e) { return Promise.reject(e); }
      return serial(async()=>{ aborted(signal); const directory = await stageDirectory(sessionId); try { await immutable(directory,record.sha256,bytes,'stage',signal); await readFile(directory,record.sha256,budget.maxOriginalBytes,signal,record); return {sessionId,sha256:record.sha256,mime:record.mime,bytes:record.bytes}; } finally { await directory.close(); } });
    },
    readStaged(sessionId,sha256,{maxBytes = budget.maxOriginalBytes,signal} = {}) { return io(async()=>{ if(!ID.test(sessionId) || !SH.test(sha256)) fail('invalid_staged_path'); aborted(signal); const directory = await childDirectory(tmp,sessionId); try { const bytes = await readFile(directory,sha256,maxBytes,signal); if(createHash('sha256').update(bytes).digest('hex') !== sha256) fail('asset_hash_mismatch',500); return bytes; } finally { await directory.close(); } }); },
    discardStaged(sessionId) { return serial(async()=>{if(!ID.test(sessionId))fail('invalid_session_id');if(catalog.publishSessions.some(s=>s.id===sessionId&&!['committed','aborted','expired'].includes(s.status)))fail('staging_session_open',409);let directory;try{directory=await childDirectory(tmp,sessionId);}catch(e){if(e.code==='ENOENT')return {removed:false,reason:'not_found'};throw e;}try{let markerFile;try{markerFile=await openRegular(directory,STAGING_MARKER);}catch(e){if(e.code==='ENOENT')return {removed:false,reason:'unowned_staging'};throw e;}let marker;try{marker=JSON.parse((await readBounded(markerFile.handle,markerFile.stat.size,2048)).toString('utf8'));}finally{await markerFile.handle.close();}const ownerKey=await loadStagingKey();if(!ownerKey||marker.kind!=='heron-independent-staging-v1'||marker.sessionId!==sessionId||!/^[a-f0-9]{32}$/.test(marker.nonce)||!/^[a-f0-9]{64}$/.test(marker.mac)||marker.mac!==createHmac('sha256',ownerKey).update(JSON.stringify([sessionId,marker.nonce])).digest('hex'))fail('staging_ownership_invalid',409);
      const entries=await fs.readdir(`/proc/self/fd/${directory.fd}`),files=[];for(const name of entries){if(name===STAGING_MARKER)continue;if(!SH.test(name))return {removed:false,reason:'unknown_staging_entry'};const file=await openRegular(directory,name);await file.handle.close();files.push({name,stat:file.stat});}
      const identity=await directory.stat(),named=await fs.lstat(at(tmp,sessionId));if(!named.isDirectory()||named.ino!==identity.ino||named.dev!==identity.dev)fail('staging_identity_changed',409);
      for(const file of [...files,{name:STAGING_MARKER,stat:markerFile.stat}]){const namedFile=await fs.lstat(at(directory,file.name));if(!namedFile.isFile()||namedFile.ino!==file.stat.ino||namedFile.dev!==file.stat.dev)fail('staging_identity_changed',409);await fs.unlink(at(directory,file.name));if(file.name!==STAGING_MARKER)await fault('afterStagedFileRemoval');}
      const finalName=await fs.lstat(at(tmp,sessionId));if(!finalName.isDirectory()||finalName.ino!==identity.ino||finalName.dev!==identity.dev)fail('staging_identity_changed',409);await directory.sync();await fs.rmdir(at(tmp,sessionId));await tmp.sync();return {removed:true};
      }finally{await directory.close();} }); },
    diagnostics() { return {commits,writes,pending:pending.size,cleanupErrors,durabilityWarnings,closed}; },
    async close() { if(closed) return; closing = true; while(pending.size) await Promise.allSettled([...pending]); await tail; let error; try { await releaseLock(); } catch(e) {error=safeError(e);} await Promise.allSettled([assets.close(),tmp.close(),root.close()]); closed = true; activeRoots.delete(rootPath); if(error) throw error; }
  };
  return Object.freeze(vault);
}
