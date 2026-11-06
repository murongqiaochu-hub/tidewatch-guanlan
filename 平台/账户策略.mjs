import { platformError } from './仓库.mjs';

const fail = (status, code) => { throw platformError(status, code); };
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/;

export function validateExpiresAt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') fail(400, 'invalid_expires_at');
  const match = RFC3339.exec(value);
  if (!match) fail(400, 'invalid_expires_at');
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, , zone, , zoneHourText, zoneMinuteText] = match;
  const year = Number(yearText), month = Number(monthText), day = Number(dayText);
  const hour = Number(hourText), minute = Number(minuteText), second = Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] || hour > 23 || minute > 59 || second > 59) fail(400, 'invalid_expires_at');
  if (zone !== 'Z' && (Number(zoneHourText) > 23 || Number(zoneMinuteText) > 59)) fail(400, 'invalid_expires_at');
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) fail(400, 'invalid_expires_at');
  return new Date(milliseconds).toISOString();
}

export function validateProjectLimit(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) fail(400, 'invalid_project_limit');
  return value;
}

export function isDesignerExpired(user, now = Date.now()) {
  if (user?.role !== 'designer' || user.expiresAt === null || user.expiresAt === undefined) return false;
  const expires = typeof user.expiresAt === 'string' ? Date.parse(user.expiresAt) : NaN;
  return !Number.isFinite(expires) || now >= expires;
}

// Account ownership is a management relationship, not a project grant. Membership
// relates a developer to the project's CURRENT owner; deleted projects never count.
// Only an existing expired designer triggers this policy, preserving unassociated
// legacy accounts. Active administrator relationships remain usable as before.
export function accountExpiryCode(user, { users = [], projects = [], projectMembers = [] } = {}, now = Date.now()) {
  if (isDesignerExpired(user, now)) return 'designer_expired';
  if (user?.role !== 'developer') return null;
  const ownerIds = new Set([user.ownerId]);
  const memberProjects = new Set(projectMembers.filter(row => row.userId === user.id).map(row => row.projectId));
  let ownerlessMember = false;
  for (const project of projects) if (!project.deletedAt && memberProjects.has(project.id)) {
    ownerIds.add(project.ownerId);
    if (project.ownerId === null || project.ownerId === undefined) ownerlessMember = true;
  }
  const related = users.filter(row => ownerIds.has(row.id) && ['designer', 'admin'].includes(row.role));
  const expired = related.some(row => isDesignerExpired(row, now));
  const usable = ownerlessMember || related.some(row => row.status === 'active' && !isDesignerExpired(row, now));
  return expired && !usable ? 'designer_expired' : null;
}

export function ownedProjectCount(userId, projects) {
  if (typeof userId !== 'string') return 0;
  return projects.filter(project => project.ownerId === userId && !project.deletedAt).length;
}

export function assertCanAddOwnedProject(user, projects, now = Date.now()) {
  if (user?.role !== 'designer') return;
  if (isDesignerExpired(user, now)) fail(403, 'designer_expired');
  const limit = user.projectLimit;
  if (limit !== null && limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) fail(500, 'invalid_project_limit');
  if (limit !== null && limit !== undefined && ownedProjectCount(user.id, projects) >= limit) fail(409, 'project_quota_exceeded');
}
