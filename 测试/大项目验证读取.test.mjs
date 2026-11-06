import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyPublicationVisibility } from '../插件/publication-visibility.mjs';

const version = '0123456789abcdef0123456789abcdef:1';
const target = { figmaNodeId: '1:2', frameId: 'target', revisionId: 'revision' };
function fixture() {
  const row = { id: 'target', x: 10, y: 20, width: 30, height: 40, groupId: 'group', currentRevisionId: 'revision', publishedAt: '2026-01-01T00:00:00Z' };
  return {
    canvas: { id: 'project', catalogReadVersion: version, groups: [{ id: 'group', name: '组' }], files: [{ pages: [{ frames: [row] }] }] },
    directory: { projectId: 'project', catalogReadVersion: version, groups: [{ id: 'group', projectId: 'project', name: '组' }], frames: [{ frameId: 'target', projectId: 'project', designFileId: 'file', pageId: 'page', revisionId: 'revision', currentRevisionId: 'revision', figmaNodeId: '1:2', groupId: 'group' }] }
  };
}
test('画布全局竞争项覆盖目标时必须拒绝，即使竞争项属于其他组', () => {
  const { canvas, directory } = fixture();
  canvas.files[0].pages[0].frames.push({ ...canvas.files[0].pages[0].frames[0], id: 'other', groupId: null, publishedAt: '2026-02-01T00:00:00Z' });
  assert.throws(() => verifyPublicationVisibility('project', 'group', [target], canvas, directory), e => e.code === 'VISIBILITY_UNCONFIRMED');
});
test('竞争项无效几何不遮挡目标，跨代次拒绝', () => {
  const { canvas, directory } = fixture();
  canvas.files[0].pages[0].frames.push({ ...canvas.files[0].pages[0].frames[0], id: 'other', width: 0, publishedAt: '2026-02-01T00:00:00Z' });
  assert.equal(verifyPublicationVisibility('project', 'group', [target], canvas, directory).frameCount, 1);
  directory.catalogReadVersion = '0123456789abcdef0123456789abcdef:2';
  assert.throws(() => verifyPublicationVisibility('project', 'group', [target], canvas, directory), e => e.code === 'VISIBILITY_UNCONFIRMED');
});
