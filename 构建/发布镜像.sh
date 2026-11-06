#!/bin/sh
# 本地构建发布镜像：先从锁定 deb 构建原生编码器运行时，再构建平台镜像。
# 需要 Node.js 22+、dpkg-deb、C 编译器（gcc/cc）与 Docker；不联网构建平台镜像本身。
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
command -v node >/dev/null 2>&1 || { echo '需要 node' >&2; exit 1; }
command -v dpkg-deb >/dev/null 2>&1 || { echo '需要 dpkg-deb' >&2; exit 1; }
command -v cc >/dev/null 2>&1 || { echo '需要 C 编译器（cc）' >&2; exit 1; }
test -f 原生编码器/build.mjs || { echo '缺少原生编码器构建脚本' >&2; exit 1; }
node 原生编码器/build.mjs
test -x 原生编码器/运行时/heron-codec || { echo '编码器构建未产出可执行文件' >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo '需要 docker' >&2; exit 1; }
image=${IMAGE_TAG:-tidewatch-guanlan:local}
docker build --pull=false -t "$image" .
echo "已构建镜像 $image；未推送。构建与运行边界见 部署与运维/04_容器化部署.md。"
