import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { formatByteSize, formatByteProgress, productionProgress } from '../插件/ui.mjs';

const html = await fs.readFile(new URL('../插件/ui.html', import.meta.url), 'utf8');
const css = await fs.readFile(new URL('../插件/ui.css', import.meta.url), 'utf8');
const source = await fs.readFile(new URL('../插件/ui.mjs', import.meta.url), 'utf8');
const KB = 1024, MB = KB ** 2, GB = KB ** 3;

test('C29: byte sizes use base 1024, KB minimum, two decimals and MB/GB boundaries', () => {
  for (const [bytes, expected] of [
    [0, '0.00 KB'], [1, '0.00 KB'], [200, '0.20 KB'], [KB - 1, '1.00 KB'],
    [KB, '1.00 KB'], [KB + 1, '1.00 KB'], [1536, '1.50 KB'], [1264, '1.23 KB'],
    [MB - 1, '1024.00 KB'], [MB, '1.00 MB'], [MB + 1, '1.00 MB'],
    [1.125 * MB, '1.13 MB'], [GB - 1, '1024.00 MB'], [GB, '1.00 GB'],
    [GB + 1, '1.00 GB'], [1.125 * GB, '1.13 GB'], [1024 * GB, '1024.00 GB'],
  ]) assert.equal(formatByteSize(bytes), expected, String(bytes));
  for (const value of [-1, 0.5, NaN, Infinity, undefined, null, '1024', Number.MAX_SAFE_INTEGER + 1]) assert.equal(formatByteSize(value), '');
});

test('C29: completed and total always share the total unit, including zero and cross-unit pairs', () => {
  for (const [done, total, expected] of [
    [0, 0, '0.00/0.00 KB'], [100, 400, '0.10/0.39 KB'], [512, 2048, '0.50/2.00 KB'],
    [512 * KB, MB, '0.50/1.00 MB'], [512 * MB, GB, '0.50/1.00 GB'],
    [KB, GB, '0.00/1.00 GB'], [GB, GB, '1.00/1.00 GB'],
  ]) assert.equal(formatByteProgress(done, total), expected);
  for (const [done, total] of [[2, 1], [-1, 1], [1, -1], [0.5, 1], [0, Infinity], [undefined, 1]]) assert.equal(formatByteProgress(done, total), '');
});

test('C29: export/upload presentation converts sizes without changing counts, percentage or completion gates', () => {
  assert.deepEqual(productionProgress({ phase: 'exporting', exportDone: 1, exportTotal: 4, sourceBytes: 200 }), { caption: '画板导出', percent: 25, detail: '1/4 个画板 · 已导出 0.20 KB' });
  assert.deepEqual(productionProgress({ phase: 'uploading', uploadDone: 1, uploadTotal: 2, uploadedBytes: MB / 2, uploadTotalBytes: MB }), { caption: '本批资源上传', percent: 50, detail: '1/2 个资源 · 0.50/1.00 MB' });
  assert.equal(productionProgress({ phase: 'uploading', uploadedBytes: 2, uploadTotalBytes: 1 }).percent, null);
  assert.equal(productionProgress({ phase: 'committed', done: 1, total: 1, verified: false }).percent, null);
  assert.equal(productionProgress({ phase: 'committed', done: 1, total: 1, verified: true }).percent, 100);
  assert.match(source, /源文件大小：\$\{formatByteSize\(state.sourceBytes\)\}/);
  assert.match(source, /\$\{fallbackLabel \|\| name\} · \$\{formatByteSize\(bytes.byteLength\)\}/);
  assert.doesNotMatch(source, /\$\{[^}]+\} bytes|quantity\([^\n]+['"]bytes['"]\)/);
});

test('C29: return and upload share readable default, hover, focus-visible and disabled CSS', () => {
  const selector = '#app[data-production-stage=workspace] :is(#publish, #production-progress-back)';
  const rule = suffix => {
    const start = css.indexOf(`${selector}${suffix} {`);
    assert.ok(start >= 0, `missing shared ${suffix || 'default'} rule`);
    return css.slice(start + `${selector}${suffix} {`.length, css.indexOf('}', start));
  };
  assert.match(rule(''), /background: var\(--tone-850\); color: var\(--ink-100\); border-color: var\(--tone-control\)/);
  assert.doesNotMatch(rule(''), /transparent|opacity:\s*0|visibility:\s*hidden|display:\s*none/);
  assert.match(rule(':hover:not(:disabled)'), /background: var\(--button-primary-bg\); color: var\(--button-primary-fg\)/);
  assert.match(rule(':focus-visible'), /outline: 2px solid var\(--focus\); outline-offset: 3px/);
  assert.match(rule(':disabled'), /background: var\(--tone-800\); color: var\(--muted\)/);
  assert.match(html, /<button id="production-progress-back" type="button" hidden>返回画板选择<\/button>/);
  assert.match(source, /\$\('production-progress-back'\)\.hidden = page !== 'progress' \|\| Boolean\(current\)/);
  assert.match(source, /\$\('production-progress-back'\)\.addEventListener\('click', event => \{ if \(!event.isTrusted \|\| current\) return; showPage\('workspace', \{ focus: true \}\); \}\)/);
});
