"""仅打包显式列出的隔离资产。stdlib only；不执行项目测试/构建。"""
from pathlib import Path
import hashlib
import json
import subprocess
import zipfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
assert HERE.name == '观澜参考还原_20261027'
PREFIX = '品牌/观澜参考还原_20261027/'
ARCHIVE = HERE / 'guanlan-brand-assets.zip'
if ARCHIVE.exists():
    raise SystemExit('同名 ZIP 已存在，停止；不会覆盖。')
FILES = sorted([
    'README.md', 'SHA256SUMS', 'duotone.svg', 'mono.svg', 'reverse.svg',
    'logo.mjs', 'preview.html', 'preview.png', '生成预览.mjs', '验证.mjs',
    '验证结果.json', '范围核对.json', 'showcase.html', 'showcase.png',
    '导出展示图.mjs', '展示图验证.json', '打包.py',
])
sha = lambda data: hashlib.sha256(data).hexdigest()
git = lambda *args: subprocess.check_output(['git', '-C', str(ROOT), *args], text=True).strip()
head = git('rev-parse', 'HEAD')
assert head == 'a8d2312384333a5e92e5126edc6b745bd631d17c'
assert git('branch', '--show-current') == 'audit/pre-publication-20261026'
expected_dirty = {
    '发布审计/README.md': '9834910d1c876571b873b7f09e2cc46b71a29ea7c834856bd2de7fee8d204a6f',
    '发布审计/20_关键实现复核与修复.md': 'b87e89bd2ee0e7dc97592737cb3e76aed7c87f4afe424f5c8adaac6b44614fb5',
    '发布审计/21_观澜普通安装与人工功能验收草稿.md': 'c357bf06bd8bc14a9ac314d8382f295f1e03aeb1daebb9871b2ba459a65484c6',
}
after = {p: sha((ROOT / p).read_bytes()) for p in expected_dirty}
assert after == expected_dirty
preserved = {
    'duotone.svg': 'af7d71e8b57129fb536c863cf0c2e2e20e79a3bd55e90f174dc6440855201289',
    'mono.svg': '7a29dbe9d8114c4759c611ac39404f011d8ec1fe592276aa88a138125bb9e292',
    'reverse.svg': 'e45cf09a08a55a5d096fc800f4d7c670427923a6b65754de02bc4de69d944b5c',
    'logo.mjs': 'b4724e2c925a65f721af0f81be3bd5902d60e9587d9e4342f2361376b40386c5',
    'preview.html': 'f1b853daced3051fb55d000f0d8c02880133752da724856fb5b70511b4001fdc',
    'preview.png': '27367b192515456a247eab7f494646c4a695fbd64bec43194f5ae814314e1734',
    '生成预览.mjs': '3a695b27673f668653c1555f83d81b260ea27296c471cbb31b9a78e34b47ed14',
    '验证.mjs': '94ce8b827aea763252e769d6f11d03a33e8dbf9ed2924cfe1e3958a2d0604325',
    '验证结果.json': 'df0d8009d3da85491c610d8712790d8a4d8abc00f3db4fc77781098349f10228',
}
assert all(sha((HERE / p).read_bytes()) == h for p, h in preserved.items())
assert sorted(p.name for p in HERE.iterdir()) == FILES
assert all((HERE / p).is_file() and not (HERE / p).is_symlink() for p in FILES)
status = subprocess.check_output(['git', '-C', str(ROOT), 'status', '--porcelain=v1', '-z', '-uall']).decode().split('\0')
assert all(not s or s[3:] in expected_dirty or (s[:2] == '??' and s[3:].startswith(PREFIX)) for s in status)
subprocess.run(['git', '-C', str(ROOT), 'diff', '--check'], check=True)
# 同一目录范围记录和清单已由主 agent 读取；这里只更新本轮交付元数据。
report = json.loads((HERE / '范围核对.json').read_text())
report.update({
    'finalization': '用户已实际看图认可，固定标志；仅离线展示与打包，无应用接入',
    'HEAD': head,
    'existingDirtyBefore': expected_dirty,
    'existingDirtyAfter': after,
    'existingDirtyUnchanged': True,
    'onlyAddedThisDirectory': True,
    'newFiles': [PREFIX + p for p in sorted(FILES + [ARCHIVE.name])],
    'finalizationAddedFiles': [PREFIX + p for p in ['showcase.html', 'showcase.png', '导出展示图.mjs', '展示图验证.json', '打包.py', ARCHIVE.name]],
    'finalizationUpdatedFiles': [PREFIX + p for p in ['README.md', '范围核对.json', 'SHA256SUMS']],
    'fixedAssetsAndOriginalQAPreservedSHA256': preserved,
    'zipMembers': [HERE.name + '/' + p for p in FILES],
    'hashManifestExclusions': ['SHA256SUMS', ARCHIVE.name],
    'zipHashReporting': '交付回复单独报告 ZIP 本体 SHA-256，不写入包内形成自引用',
})
(HERE / '范围核对.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
manifest = ''.join(f'{sha((HERE / p).read_bytes())}  {p}\n' for p in FILES if p != 'SHA256SUMS')
(HERE / 'SHA256SUMS').write_text(manifest)
with zipfile.ZipFile(ARCHIVE, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for p in FILES:
        z.write(HERE / p, arcname=HERE.name + '/' + p)
with zipfile.ZipFile(ARCHIVE) as z:
    assert z.testzip() is None
    assert z.namelist() == report['zipMembers']
    for p in FILES:
        assert z.read(HERE.name + '/' + p) == (HERE / p).read_bytes()
    for line in z.read(HERE.name + '/SHA256SUMS').decode().splitlines():
        expected, name = line.split('  ', 1)
        assert sha(z.read(HERE.name + '/' + name)) == expected
assert {p: sha((ROOT / p).read_bytes()) for p in expected_dirty} == expected_dirty
assert git('rev-parse', 'HEAD') == head
assert all(sha((HERE / p).read_bytes()) == h for p, h in preserved.items())
print(json.dumps({'archive': str(ARCHIVE), 'sha256': sha(ARCHIVE.read_bytes()), 'bytes': ARCHIVE.stat().st_size,
                  'members': len(FILES), 'crcAndMemberBytesAndSHA256': 'PASS',
                  'fixedAssetsOriginalQAOldDirtyHEAD': 'UNCHANGED',
                  'manifestSHA256': sha((HERE / 'SHA256SUMS').read_bytes())}, ensure_ascii=False, indent=2))
