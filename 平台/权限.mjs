// Capabilities are derived from live catalog rows, never token claims.
import { platformError } from './仓库.mjs';
import { isDesignerExpired, accountExpiryCode } from './账户策略.mjs';
const fail = (status,code) => {throw platformError(status,code);};
export function createPermissions({vault,clock = Date.now} = {}) {
  function project(user,projectId,{draft} = {}) {
    const all = table => draft ? draft.all(table) : vault.catalog[table];
    const live = user && all('users').find(row=>row.id === user.id && row.status === 'active');
    const target = all('projects').find(row=>row.id === projectId && !row.deletedAt);
    if(!target) fail(404,'project_not_found');
    // A previously authenticated principal must not regain privileges after a session change.
    const valid = live && (user.sessionVersion === undefined || (live.sessionVersion ?? 0) === user.sessionVersion);
    const now = clock();
    const rows = Object.fromEntries(['users','projects','projectMembers'].map(table=>[table,all(table)]));
    const projectOwner = rows.users.find(row=>row.id === target.ownerId);
    // A usable second relationship allows login, never access to expired projects.
    const denialCode = valid ? accountExpiryCode(live,rows,now) : null;
    const unavailableProject = live?.role === 'developer' && projectOwner?.role === 'designer' && (projectOwner.status !== 'active' || isDesignerExpired(projectOwner,now));
    const authorized = Boolean(valid && !denialCode);
    const admin = authorized && live.role === 'admin';
    const owner = authorized && target.ownerId === live.id && ['admin','designer'].includes(live.role);
    const member = authorized && all('projectMembers').some(row=>row.projectId === target.id && row.userId === live.id);
    const designer = authorized && live.role === 'designer';
    const developer = authorized && live.role === 'developer';
    const canRead = Boolean(authorized && !unavailableProject && (admin || owner || member));
    const canManage = Boolean(admin || (owner && designer));
    const canPublish = Boolean(admin || (designer && owner));
    const canEditLayout = Boolean(admin || (designer && owner));
    const canDelete = Boolean(admin || (owner && designer));
    return Object.freeze({project:target,user:authorized ? live : null,isAdmin:Boolean(admin),isOwner:Boolean(owner),isMember:Boolean(member),canRead,canManage,canPublish,canShare:canManage,canEditLayout,canDelete,role:authorized ? (designer ? 'designer' : developer ? 'developer' : live.role) : null,checkedAt:now,...(denialCode?{denialCode}:{})});
  }
  function requireCapability(user,id,name,options) {
    const result = project(user,id,options);
    if(result.denialCode) fail(403,result.denialCode);
    if(!result.user) fail(401,'authentication_required');
    if(!result[name]) fail(403,'project_forbidden');
    return result;
  }
  return Object.freeze({project,requireRead:(user,id,options)=>requireCapability(user,id,'canRead',options),requirePublish:(user,id,options)=>requireCapability(user,id,'canPublish',options),requireManage:(user,id,options)=>requireCapability(user,id,'canManage',options)});
}
