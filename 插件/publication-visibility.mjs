// Verify the same project canvas and inspector directory used by readers.
// No names or design contents are returned to the coordinator.
import { fail, record, exactKeys, id } from './core.mjs';

export function validateVisibilityRequest(projectId, groupId, frames) {
  id(projectId); if (groupId !== null) id(groupId);
  if (!Array.isArray(frames) || !frames.length || frames.length > 10000) fail('BAD_SCHEMA');
  const nodes = new Set(), platform = new Set();
  for (const frame of frames) {
    exactKeys(frame, ['figmaNodeId', 'frameId', 'revisionId']);
    id(frame.figmaNodeId); id(frame.frameId); id(frame.revisionId);
    if (nodes.has(frame.figmaNodeId) || platform.has(frame.frameId)) fail('BAD_SCHEMA');
    nodes.add(frame.figmaNodeId); platform.add(frame.frameId);
  }
  return frames;
}

export function verifyPublicationVisibility(projectId, groupId, expected, canvas, directory) {
  validateVisibilityRequest(projectId, groupId, expected);
  const bad = () => fail('VISIBILITY_UNCONFIRMED');
  if (!record(canvas) || canvas.id !== projectId || !record(directory) || directory.projectId !== projectId || !Array.isArray(directory.frames)) bad();
  // Both responses must be from the same process and immutable catalog generation.
  // If anything changed between requests, keep the result unconfirmed.
  if (typeof canvas.catalogReadVersion !== 'string' || !/^[a-f0-9]{32}:[0-9]+$/.test(canvas.catalogReadVersion) || canvas.catalogReadVersion !== directory.catalogReadVersion) bad();
  if (!Array.isArray(canvas.groups) || !Array.isArray(directory.groups) || directory.groups.length > 1000) bad();
  const validPlatformId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  const groupIds = new Set(), canvasGroups = new Map();
  for (const group of canvas.groups) {
    if (!record(group) || !validPlatformId(group.id) || typeof group.name !== 'string' || group.name.length > 128 || canvasGroups.has(group.id)) bad();
    canvasGroups.set(group.id, group.name);
  }
  for (const group of directory.groups) {
    if (!record(group) || !validPlatformId(group.id) || group.projectId !== projectId || typeof group.name !== 'string' || group.name.length > 128 || groupIds.has(group.id) || canvasGroups.get(group.id) !== group.name) bad();
    groupIds.add(group.id);
  }
  if (canvasGroups.size !== groupIds.size) bad();
  if (directory.frames.length > 100000) bad();
  const directoryById = new Map();
  for (const row of directory.frames) {
    if (!record(row) || row.projectId !== projectId || !['frameId', 'designFileId', 'pageId', 'revisionId'].every(k => validPlatformId(row[k])) || row.currentRevisionId !== row.revisionId || directoryById.has(row.frameId)) bad();
    directoryById.set(row.frameId, row);
  }
  if (groupId !== null && (!canvas.groups.some(g => g?.id === groupId) || !groupIds.has(groupId))) bad();
  let canvasRows;
  if (Array.isArray(canvas.frames)) canvasRows = canvas.frames;
  else {
    if (!Array.isArray(canvas.files) || canvas.files.some(f => !Array.isArray(f?.pages) || f.pages.some(p => !Array.isArray(p?.frames)))) bad();
    canvasRows = canvas.files.flatMap(f => f.pages.flatMap(p => p.frames));
  }
  // Match the actual canvas's geometry filter and coordinate deduplication.
  const geometry = f => record(f) && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(f[k])) && f.width > 0 && f.height > 0;
  const displayed = new Map();
  for (const frame of canvasRows.filter(geometry)) {
    const key = `${frame.x},${frame.y}`, prior = displayed.get(key);
    const at = Date.parse(frame.publishedAt || '') || 0, before = Date.parse(prior?.publishedAt || '') || 0;
    if (!prior || at > before || at === before && String(frame.id) > String(prior.id)) displayed.set(key, frame);
  }
  if (canvasRows.length > 100000) bad();
  const visible = new Map();
  for (const row of displayed.values()) { if (visible.has(row.id)) bad(); visible.set(row.id, row); }
  for (const target of expected) {
    const c = visible.get(target.frameId), d = directoryById.get(target.frameId);
    if (!c || !d || c.currentRevisionId !== target.revisionId || (c.groupId ?? null) !== groupId ||
        d.projectId !== projectId || d.revisionId !== target.revisionId || d.figmaNodeId !== target.figmaNodeId || (d.groupId ?? null) !== groupId) bad();
  }
  return { projectId, groupId, frameCount: expected.length };
}
