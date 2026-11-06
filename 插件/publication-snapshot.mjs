// Validate the same exact-revision responses consumed by the inspector.
import { fail, record } from './core.mjs';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export function verifyPublicationSnapshot(projectId, groupId, target, readVersion, revisions, snapshot, directoryRow) {
  const bad = () => fail('VISIBILITY_UNCONFIRMED');
  if (!record(revisions) || revisions.catalogReadVersion !== readVersion || revisions.frameId !== target.frameId || revisions.currentRevisionId !== target.revisionId || !Array.isArray(revisions.revisions)) bad();
  const seen = new Set();
  for (const revision of revisions.revisions) {
    if (!record(revision) || !validId(revision.id) || seen.has(revision.id) || revision.frameId && revision.frameId !== target.frameId) bad();
    seen.add(revision.id);
  }
  if (!seen.has(target.revisionId) || !record(snapshot) || snapshot.catalogReadVersion !== readVersion || !record(snapshot.identity) || !record(snapshot.frame) || !record(snapshot.layerDoc) || snapshot.layerDoc.contractVersion !== 1 || snapshot.layerDoc.frame?.type !== 'FRAME' || !Array.isArray(snapshot.layerDoc.frame?.children) || !Array.isArray(snapshot.assets) || !Array.isArray(snapshot.slices)) bad();
  const identity = snapshot.identity;
  if (!record(directoryRow) || identity.projectId !== projectId || identity.frameId !== target.frameId || identity.revisionId !== target.revisionId || identity.figmaNodeId !== target.figmaNodeId || !validId(identity.designFileId) || !validId(identity.pageId) || identity.designFileId !== directoryRow.designFileId || identity.pageId !== directoryRow.pageId || snapshot.layerDoc.frame?.id !== target.figmaNodeId || (snapshot.frame.groupId ?? null) !== groupId) bad();
  if (snapshot.context && (snapshot.context.projectId !== projectId || snapshot.context.designFileId !== identity.designFileId)) bad();
  // The viewer recursively visits every child; malformed nested nodes must not
  // turn a correct-looking root into a false successful verification.
  const pending = [[snapshot.layerDoc.frame, 0]]; let count = 0;
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (++count > 200000 || depth > 128 || !record(node) || node.children !== undefined && !Array.isArray(node.children)) bad();
    for (const child of node.children || []) pending.push([child, depth + 1]);
  }
  if (snapshot.previewAsset != null && (!record(snapshot.previewAsset) || snapshot.previewAsset.frameId !== target.frameId || snapshot.previewAsset.revisionId !== target.revisionId)) bad();
  for (const asset of [...snapshot.assets, ...snapshot.slices]) {
    if (!record(asset) || !validId(asset.assetId) || asset.projectId !== projectId || asset.designFileId !== identity.designFileId || asset.frameId !== target.frameId || asset.revisionId !== target.revisionId || !Number.isSafeInteger(asset.byteLength) || asset.byteLength <= 0) bad();
  }
}
