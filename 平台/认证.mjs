// New implementation: permitted data/wire specification only.
import { scrypt, randomBytes, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { constants as C } from 'node:fs';
import path from 'node:path';
import { newId, platformError,openCanonicalDirectory } from './仓库.mjs';
import { accountExpiryCode } from './账户策略.mjs';
const fail = (status,code) => {throw platformError(status,code);};
const DAY = 86400000;
const version = user => user.sessionVersion === undefined ? 0 : user.sessionVersion;
const validVersion = n => Number.isSafeInteger(n) && n >= 0;
const b64 = /^[A-Za-z0-9_-]+$/;
let running = 0;
const waiting = [];
function kdf(password,salt) {
  return new Promise((resolve,reject)=>{
    const start = () => { running++; scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:32*1024*1024},(error,key)=>{ running--; if(waiting.length) waiting.shift()(); if(error) reject(platformError(500,'password_kdf_failed')); else resolve(key); }); };
    if(running < 2) start(); else if(waiting.length < 16) waiting.push(start); else reject(platformError(429,'kdf_busy'));
  });
}
export function kdfDiagnostics() { return {active:running,queued:waiting.length,activeLimit:2,queueLimit:16}; }
export function validatePassword(password,{legacy = false} = {}) {
  if(typeof password !== 'string' || password.length > 256 || Buffer.byteLength(password,'utf8') > 512) fail(400,'invalid_password');
  const count = [...password].length;
  if(count < (legacy ? 1 : 12) || count > 128) fail(400,'invalid_password');
  // Reject unpaired surrogates, preserving all valid Unicode without normalization.
  if(!password.isWellFormed()) fail(400,'invalid_password');
  return password;
}
export function normalizeUsername(input) {
  if(typeof input !== 'string') fail(400,'invalid_username');
  const username = input.trim().replace(/[A-Z]/g,c=>c.toLowerCase());
  if(!/^[a-z0-9_.-]{3,48}$/.test(username)) fail(400,'invalid_username');
  return username;
}
export function validateDisplayName(value) {
  if(typeof value !== 'string' || value.length > 160 || [...value].length > 80 || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) || !value.isWellFormed()) fail(400,'invalid_display_name');
  return value;
}
export async function hashPassword(password) {
  validatePassword(password); const salt = randomBytes(16).toString('hex');
  const key = await kdf(password,salt);
  return {passwordHash:key.toString('hex'),salt};
}
export async function verifyPassword(password,encoded) {
  try { validatePassword(password,{legacy:true}); } catch {return false;}
  if(!encoded || !/^[a-f0-9]{32}$/.test(encoded.salt) || !/^[a-f0-9]{128}$/.test(encoded.passwordHash)) return false;
  const actual = await kdf(password,encoded.salt);
  return timingSafeEqual(actual,Buffer.from(encoded.passwordHash,'hex'));
}
export function userDTO(user) {
  return {id:user.id,username:user.username,role:user.role,status:user.status,ownerId:user.ownerId ?? null,displayName:user.displayName ?? user.username,createdAt:user.createdAt ?? null};
}
export async function loadAuthenticationSecret({mode = 'FILE',path:filePath,value,create = false} = {}) {
  if(mode === 'RAM') { const bytes = value === undefined ? randomBytes(48) : Buffer.from(value); if(bytes.length < 32) fail(500,'invalid_auth_secret'); return bytes; }
  if(mode !== 'FILE' || value !== undefined || typeof filePath !== 'string' || !path.isAbsolute(filePath)) fail(500,'auth_secret_file_required');
  let parent,handle;
  try {
    const directory = path.dirname(filePath);
    if(await fs.realpath(directory) !== directory) fail(500,'unsafe_auth_secret_path');
    parent = await openCanonicalDirectory(directory);
    const target = `/proc/self/fd/${parent.fd}/${path.basename(filePath)}`;
    let created = false;
    if(create) {try { handle = await fs.open(target,C.O_WRONLY|C.O_CREAT|C.O_EXCL|C.O_NOFOLLOW,0o600); created = true; } catch(e) {if(e.code !== 'EEXIST') throw e;}}
    if(created) { await handle.chmod(0o600); await handle.writeFile(randomBytes(48).toString('hex')); await handle.sync(); await handle.close(); handle = null; await parent.sync(); }
    handle = await fs.open(target,C.O_RDONLY|C.O_NOFOLLOW); const stat = await handle.stat();
    if(!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077)!==0 || stat.size > 16384 || stat.size < 32) fail(500,'invalid_auth_secret_file');
    // Existing FILE keys may be read-only mounts: validate, never repair permissions while reading.
    const buffer=Buffer.alloc(16385);let length=0;while(length<buffer.length){const result=await handle.read(buffer,length,buffer.length-length,length);if(!result.bytesRead)break;length+=result.bytesRead;}if(length>16384)fail(500,'invalid_auth_secret_file');const raw=buffer.subarray(0,length);
    const value = new TextDecoder('utf-8',{fatal:true}).decode(raw).trim();
    if(Buffer.byteLength(value,'utf8') < 32) fail(500,'invalid_auth_secret_file'); return Buffer.from(value,'utf8');
  } catch(e) { if(e.status) throw e; fail(500,'auth_secret_io_error'); }
  finally { await handle?.close(); await parent?.close(); }
}
export function createAuthentication({vault,secret,clock = Date.now} = {}) {
  if(!vault || !(typeof secret === 'string' || secret instanceof Uint8Array) || Buffer.byteLength(secret) < 32) fail(500,'invalid_auth_configuration');
  if(typeof secret==='string' && Buffer.byteLength(secret.trim(),'utf8')<32)fail(500,'invalid_auth_configuration');
  const key = Buffer.from(secret);
  const accessUser = u => ({id:u.id,username:u.username,role:u.role});
  const hashInviteToken = raw => createHmac('sha256',key).update(raw,'utf8').digest('hex');
  const expiryCode = (user,draft) => accountExpiryCode(user,draft ? Object.fromEntries(['users','projects','projectMembers'].map(table=>[table,draft.all(table)])) : vault.catalog,clock());
  function current(id) { const user = vault.catalog.users.find(row=>row.id === id); return user?.status === 'active' && validVersion(version(user)) ? user : null; }
  function tokenData(token) {
    if(typeof token !== 'string' || token.length > 8192) return null;
    const pieces = token.split('.');
    if(pieces.length !== 2 || !b64.test(pieces[0]) || !b64.test(pieces[1])) return null;
    const expected = createHmac('sha256',key).update(pieces[0],'ascii').digest();
    const sig = Buffer.from(pieces[1],'base64url');
    if(sig.length !== expected.length || sig.toString('base64url') !== pieces[1] || !timingSafeEqual(expected,sig)) return null;
    try {
      const raw = Buffer.from(pieces[0],'base64url'); if(raw.toString('base64url') !== pieces[0]) return null;
      const data = JSON.parse(raw.toString('utf8'));
      if(!data || typeof data.sub !== 'string' || !Number.isFinite(data.exp) || data.exp <= Math.floor(clock()/1000) || !validVersion(data.sessionVersion === undefined ? 0 : data.sessionVersion)) return null;
      if(data.rememberedSessionId !== undefined && typeof data.rememberedSessionId !== 'string') return null;
      return data;
    } catch {return null;}
  }
  function actor(req,{required = true} = {}) {
    const header = req.headers?.authorization;
    let token;
    if(header !== undefined) { if(typeof header === 'string' && /^Bearer /i.test(header)) token = header.slice(7); }
    else {
      const cookie = typeof req.headers?.cookie === 'string' ? req.headers.cookie : '';
      const match = /(?:^|;\s*)hsauth=([^;]*)/.exec(cookie); if(match) token = match[1];
    }
    const data = tokenData(token),user = data && current(data.sub);
    let valid = user && version(user) === (data.sessionVersion ?? 0);
    if(valid && data.rememberedSessionId) valid = vault.catalog.rememberedLogins.some(record=>record.id === data.rememberedSessionId && record.userId === user.id && record.sessionVersion === version(user) && Number.isSafeInteger(record.expiresAt) && record.expiresAt > clock());
    if(!valid) {if(required) fail(401,'authentication_required'); return null;}
    const denialCode = expiryCode(user);
    if(denialCode) {if(required) fail(403,denialCode); return null;}
    const result = userDTO(user);
    Object.defineProperties(result,{sessionVersion:{value:version(user)},rememberedSessionId:{value:data.rememberedSessionId ?? null}});
    return Object.freeze(result);
  }
  function issueAccess(user,{rememberDeviceId} = {}) {
    const live = current(user?.id); if(!live) fail(401,'authentication_required');
    if(expiryCode(live)) fail(403,'designer_expired');
    if(rememberDeviceId && !vault.catalog.rememberedLogins.some(record=>record.id === rememberDeviceId && record.userId === live.id && record.sessionVersion === version(live) && record.expiresAt > clock())) fail(401,'invalid_refresh_token');
    const data = Buffer.from(JSON.stringify({sub:live.id,role:live.role,sessionVersion:version(live),exp:Math.floor(clock()/1000)+43200,...(rememberDeviceId ? {rememberedSessionId:rememberDeviceId} : {})})).toString('base64url');
    return `${data}.${createHmac('sha256',key).update(data,'ascii').digest('base64url')}`;
  }
  function recheck(snapshot,draft) {
    const live = (draft ? draft.all('users') : vault.catalog.users).find(row=>row.id === snapshot.id);
    if(!live || live.status !== 'active' || version(live) !== version(snapshot) || live.passwordHash !== snapshot.passwordHash || live.salt !== snapshot.salt) fail(401,'invalid_credentials');
    if(expiryCode(live,draft)) fail(403,'designer_expired');
    return live;
  }
  async function login(username,password,{rememberLogin = false} = {}) {
    if(typeof username !== 'string' || typeof password !== 'string') fail(401,'invalid_credentials');
    try {validatePassword(password,{legacy:true});} catch {fail(401,'invalid_credentials');}
    const normalized = username.trim().replace(/[A-Z]/g,c=>c.toLowerCase());
    const snapshot = vault.catalog.users.find(row=>row.username === normalized && row.status === 'active');
    if(!snapshot) { await kdf(password,'00000000000000000000000000000000'); fail(401,'invalid_credentials'); }
    if(!await verifyPassword(password,snapshot)) fail(401,'invalid_credentials');
    let live = recheck(snapshot),refreshToken,rememberedSessionId;
    if(rememberLogin === true) {
      refreshToken = randomBytes(32).toString('base64url'); rememberedSessionId = newId();
      const tokenHash = createHash('sha256').update(refreshToken,'utf8').digest('hex');
      await vault.transact(draft=>{
        live = recheck(snapshot,draft); const now = clock();
        const all = draft.all('rememberedLogins');
        const own = all.filter(row=>row.userId === live.id && row.sessionVersion === version(live) && Number.isSafeInteger(row.expiresAt) && row.expiresAt > now).sort((a,b)=>a.expiresAt-b.expiresAt);
        // Fixed deadlines encode issuance order; stable array order resolves ties.
        const evict = new Set(own.slice(0,Math.max(0,own.length-31)).map(row=>row.id));
        for(const row of all) if(row.userId === live.id && (!Number.isSafeInteger(row.expiresAt) || row.expiresAt <= now || row.sessionVersion !== version(live) || evict.has(row.id))) draft.remove('rememberedLogins',row.id);
        draft.add('rememberedLogins',{id:rememberedSessionId,userId:live.id,tokenHash,sessionVersion:version(live),expiresAt:now+30*DAY});
      });
      recheck(snapshot);
    }
    return {token:issueAccess(live,{rememberDeviceId:rememberedSessionId}),user:accessUser(live),...(refreshToken ? {refreshToken,refreshExpiresAt:vault.catalog.rememberedLogins.find(r=>r.id===rememberedSessionId).expiresAt} : {})};
  }
  async function refresh(refreshToken) {
    if(typeof refreshToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(refreshToken) || Buffer.from(refreshToken,'base64url').toString('base64url') !== refreshToken) fail(401,'invalid_refresh_token');
    const hash = createHash('sha256').update(refreshToken,'utf8').digest('hex');
    const record = vault.catalog.rememberedLogins.find(row=>row.tokenHash === hash);
    const user = record && current(record.userId);
    if(!record || !user || record.sessionVersion !== version(user) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= clock()) fail(401,'invalid_refresh_token');
    return {token:issueAccess(user,{rememberDeviceId:record.id}),user:accessUser(user),refreshExpiresAt:record.expiresAt};
  }
  async function logoutRemembered(refreshToken) {
    if(typeof refreshToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(refreshToken)) return {ok:true};
    const hash = createHash('sha256').update(refreshToken,'utf8').digest('hex');
    await vault.transact(draft=>{ for(const record of draft.all('rememberedLogins')) if(record.tokenHash === hash) draft.remove('rememberedLogins',record.id); });
    return {ok:true};
  }
  return Object.freeze({actor,issueAccess,login,refresh,logoutRemembered,hashPassword,verifyPassword,userDTO,hashInviteToken});
}
