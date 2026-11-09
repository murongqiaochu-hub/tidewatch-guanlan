# Tidewatch 观澜

> **许可状态｜源代码可见，不是开源许可证**  
> 本项目采用自定义 source-available（源代码可见）许可 v1.0，**不是 OSI 开源许可证**。个人与组织可按[许可](<LICENSE>)免费使用和自托管；把软件本身对外收费或分发需另行商业授权。第三方运行时组件按其自身许可提供。

## 项目简介

Tidewatch 观澜是一套自托管的 Figma 设计交付与标注查看工具，把设计稿上传、标注、切图交接从人工截图搬到自己的服务器上。主要能力：

- **画板上传**：在 Figma 插件里选择页面或画板，直接发布到自己的 Tidewatch 服务。
- **项目与分组管理**：按项目组织画板，可自定义分组，按分组浏览和筛选。
- **版本查看**：同一画板多次发布保留历史版本，查看时可切换到指定版本，标注与切图跟随当前版本。
- **图层标注**：选中图层查看真实设计属性，包括尺寸、颜色、字体、圆角、描边等，纯色矩形也能看到色号与尺寸。
- **切图查看与下载**：列出当前画板实际关联的导出切图，支持在线查看与下载。
- **账户与权限**：服务端提供账户、项目成员与访问权限控制。
- **插件连接自己的服务**：插件不内置服务地址，由使用者填写自己的 HTTPS 服务地址。

界面默认不展示内部标识、调试信息和原始 JSON，只保留真实名称、状态与设计属性。

## 私有化部署

两种方式：用现成容器镜像（推荐），或直接运行 Node 服务。镜像已发布到 Docker Hub，构建细节、Caddy 内部 CA HTTPS 链路测试及仍未验证项见[容器化部署说明](<部署与运维/04_容器化部署.md>)。

### 前置条件

- Node.js 22 或更新版本；项目不依赖 npm 运行时包。
- 专用数据目录：只给这套服务使用，由运行用户独占。
- 密钥文件：JWT 签名密钥；首次初始化空数据目录时另需管理员引导密码。两者都应是权限受限的普通文件。
- 需要让其他设备或公网访问时：有效的 HTTPS 证书与一个反向代理。

### 容器部署（推荐）

镜像：`murongqiaochu/tidewatch-guanlan-public:0.2.0`（Docker Hub 页面有同样的部署说明）。镜像基于 Node 22.23.3 / Debian 12，非 root（`10001:10001`）运行，内置原生编码器与自建 HTTPS 插件包；数据全部在挂载的 `/data`。

```bash
docker pull murongqiaochu/tidewatch-guanlan-public:0.2.0

mkdir -p /srv/tidewatch/data /srv/tidewatch/secrets
chmod 700 /srv/tidewatch/data /srv/tidewatch/secrets
chown -R 10001:10001 /srv/tidewatch/data

head -c 48 /dev/urandom | base64 | tr -d '\n' > /srv/tidewatch/secrets/jwt
head -c 24 /dev/urandom | base64 | tr -d '\n' > /srv/tidewatch/secrets/admin-password
chmod 600 /srv/tidewatch/secrets/jwt /srv/tidewatch/secrets/admin-password
chown 10001:10001 /srv/tidewatch/secrets/jwt /srv/tidewatch/secrets/admin-password

docker run -d --name tidewatch --restart unless-stopped \
  --user 10001:10001 \
  -e HANDOFF_DATA_DIR=/data -e HANDOFF_HOST=0.0.0.0 -e HANDOFF_PORT=4318 \
  -e HANDOFF_PUBLIC_ORIGIN=https://tidewatch.example.com -e HANDOFF_ORIGIN_MODE=fixed \
  -e HANDOFF_JWT_SECRET_FILE=/run/secrets/jwt \
  -e HANDOFF_ADMIN_PASSWORD_FILE=/run/secrets/admin-password \
  -v /srv/tidewatch/data:/data \
  -v /srv/tidewatch/secrets:/run/secrets:ro \
  -p 127.0.0.1:4318:4318 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 512m --cpus 1 \
  murongqiaochu/tidewatch-guanlan-public:0.2.0

curl -fsS http://127.0.0.1:4318/api/health
```

`HANDOFF_PUBLIC_ORIGIN` 必须是精确 origin（协议 + 主机，带端口时含端口，不带路径、结尾斜杠或通配符）。容器只监听回环，由同机 Caddy/Nginx 终止 TLS 并转发，转发时保留原始 `Host` 与端口：

```caddy
tidewatch.example.com {
    reverse_proxy 127.0.0.1:4318
}
```

首次用 `admin` + 生成的引导密码登录；已有数据集不会重置密码。

### 配置项

| 变量 | 默认 | 说明 |
|---|---|---|
| `HANDOFF_DATA_DIR` | — | 数据目录（容器内 `/data`）；需专用、至少三级绝对路径，不能落在 `secrets`/`backups` 等敏感名 |
| `HANDOFF_HOST` / `HANDOFF_PORT` | `127.0.0.1` / `4318` | 监听地址与端口（容器内用 `0.0.0.0`） |
| `HANDOFF_PUBLIC_ORIGIN` | 无 | 精确 HTTPS origin，用于来源校验与插件下载元信息 |
| `HANDOFF_ORIGIN_MODE` | 无 | 反向代理终止 TLS 时设为 `fixed` |
| `HANDOFF_JWT_SECRET_FILE` | 无 | JWT 签名密钥文件（必填） |
| `HANDOFF_ADMIN_PASSWORD_FILE` | 无 | 仅在空数据目录首次启动时用于创建管理员 |
| `HANDOFF_ADMIN_USER` | `admin` | 首次创建的管理员用户名 |
| `HANDOFF_CODEC_BINARY` | 镜像内 `…/heron-codec` | 原生编码器路径；可挂载自建产物覆盖 |
| `HANDOFF_CODEC_LIBRARIES` | 镜像内 `…/运行时/lib` | 编码器依赖库目录 |
| `HANDOFF_PLUGIN_ARCHIVE` | 镜像内 `/app/downloads/plugin.zip` | 供用户从自己服务下载的插件包绝对路径 |
| `HANDOFF_DENY_DATA_PREFIXES` | 空 | `:` 分隔的绝对路径前缀，显式拒绝把数据写进部署目录 |

数据全部落在 `HANDOFF_DATA_DIR`；升级前先停写并做一致性备份，回退镜像时不要用旧备份覆盖当前数据。

### 直接运行（Node.js）

在 Linux/macOS shell 中设置配置并启动：

```bash
export HANDOFF_DATA_DIR=/absolute/path/to/tidewatch-data
export HANDOFF_JWT_SECRET_FILE=/absolute/path/to/secrets/jwt
export HANDOFF_ADMIN_PASSWORD_FILE=/absolute/path/to/secrets/admin-password
export HANDOFF_HOST=127.0.0.1
export HANDOFF_PORT=4318
npm start
```

管理员引导密码只在首次初始化空数据目录时使用；数据目录已有内容时不会重置管理员。配置缺失、密钥文件权限过宽或路径非法时，启动会直接拒绝。

### 验证

在另一个终端检查健康端点，返回正常即表示服务已就绪：

```bash
curl -fsS http://127.0.0.1:4318/api/health
```

### 对外提供服务

- 保持 `HANDOFF_HOST` 为回环或内网地址，由反向代理对外终止 TLS 并转发；不要把服务端口直接暴露到公网。
- 反向代理应保留原始 `Host` 与端口，不要放宽服务端的来源校验，也不要用通配 CORS。
- 定期备份数据目录与密钥文件；密钥文件与数据目录应分开存放。

### 插件连接

插件不内置服务地址。安装后在插件中选择 `custom-https` 并填写自己的 HTTPS 服务地址；认证凭据按服务 origin 隔离，切换服务不会迁移登录状态，也不接受 HTTP 或降级重定向。

### 示例设计文件

第一次使用时可以打开[观澜示例设计文件（Figma）](<https://www.figma.com/design/913LMgj6vVZgfI38OIukq6>)：里面有两个深墨绿画板（桌面端 1440×1024、移动端 375×812），包含导航、标题、按钮、特性卡片与页脚，可直接用来试用「选画板 → 发布 → 在线查看标注与版本」的完整流程。文件为只读分享，需要修改时在 Figma 里复制一份到自己账号即可。

### 验证状态

- 镜像已在 NAS 宿主用真实 Docker 构建并启动：非 root 运行、健康检查达到 `healthy`、重启后数据保留、Compose 路径可用；验证用临时端口 14319，结束后容器与卷已清理。
- 镜像已发布到公开 Docker Hub 仓库：`docker pull murongqiaochu/tidewatch-guanlan-public:0.2.0`（manifest digest `sha256:3ec34830bc28e8de083fadff5514b51232e3bfafdde576d96a2107195e3f3ea9`），另有 `:latest`。
- Caddy HTTPS 反向代理端到端已在 NAS 隔离 Docker 网络验证：用 Caddy 内部 CA 对测试域名签发证书，并以受信 CA 验证 TLS；健康页/登录页 200、错误 Origin 403、登录与 Secure Cookie 成功、认证后 `/api/auth/me` 和 `/api/projects` 200。临时容器、网络、卷、密钥和证书已清理。
- 此验证不等于公网部署验收：正式域名/DNS、ACME 公网证书签发与续期、Nginx 样例及真实 Figma/macOS 客户端仍未验证；镜像内已含编码器运行时与插件包，但真实 Figma/macOS 与真实预览链路仍未验证。
- 基础镜像已在 `Dockerfile` 固定为第三方锁核验过的 digest（Node 22.23.3 / glibc 2.36-9+deb12u14），并已在 NAS 宿主重建核对：88 个系统包与第三方锁一致、镜像内应用与合规文件逐字节对应、非 root 健康检查通过。第三方对应源码随 GitHub Release 资产提供。
- 最新全量 Node 回归为 **1571 项：1558 通过、9 失败、4 跳过**（退出码 1；内部复跑日志不随公开包发布）；9 项均依赖本机未安装的 `vips`/`zip` 外部工具（JPEG 合成演示与打包校验），不是产品代码失败；不得宣称全量测试通过。
- 定向验证：C34 生产协议夹具 25/25、原生预览 HTTP 11/11、暗色网页 53/53；这些结果不替代全量测试。

容器方案已在隔离环境跑通，但还不是"已验证的生产部署"；细节见[容器化部署说明](<部署与运维/04_容器化部署.md>)。

## English quick start

Tidewatch Guanlan is a self-hosted design handoff tool for Figma: publish artboards from the plugin to your own server, browse annotations and slice assets in the browser, and keep revision history — without a third-party SaaS.

```bash
docker pull murongqiaochu/tidewatch-guanlan-public:0.2.0

mkdir -p /srv/tidewatch/data /srv/tidewatch/secrets
chmod 700 /srv/tidewatch/data /srv/tidewatch/secrets
chown -R 10001:10001 /srv/tidewatch/data
head -c 48 /dev/urandom | base64 | tr -d '\n' > /srv/tidewatch/secrets/jwt
head -c 24 /dev/urandom | base64 | tr -d '\n' > /srv/tidewatch/secrets/admin-password
chmod 600 /srv/tidewatch/secrets/jwt /srv/tidewatch/secrets/admin-password
chown 10001:10001 /srv/tidewatch/secrets/jwt /srv/tidewatch/secrets/admin-password

docker run -d --name tidewatch --restart unless-stopped \
  --user 10001:10001 \
  -e HANDOFF_DATA_DIR=/data -e HANDOFF_HOST=0.0.0.0 -e HANDOFF_PORT=4318 \
  -e HANDOFF_PUBLIC_ORIGIN=https://tidewatch.example.com -e HANDOFF_ORIGIN_MODE=fixed \
  -e HANDOFF_JWT_SECRET_FILE=/run/secrets/jwt \
  -e HANDOFF_ADMIN_PASSWORD_FILE=/run/secrets/admin-password \
  -v /srv/tidewatch/data:/data -v /srv/tidewatch/secrets:/run/secrets:ro \
  -p 127.0.0.1:4318:4318 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --memory 512m --cpus 1 \
  murongqiaochu/tidewatch-guanlan-public:0.2.0

curl -fsS http://127.0.0.1:4318/api/health
```

Put Caddy or Nginx in front for TLS and keep the original `Host` header; the container only listens on loopback. `HANDOFF_PUBLIC_ORIGIN` must be an exact HTTPS origin (no path, no trailing slash, no wildcard). Then install the Figma plugin from `plugin.zip` served by your own instance (or from the GitHub release), point it at your origin, and start publishing artboards.

Full options, backup notes and the sample Figma file are in the Chinese sections above and on the [Docker Hub page](<https://hub.docker.com/r/murongqiaochu/tidewatch-guanlan-public>).

License: source-available, **not** open source — free for individuals and internal organisational self-hosting; commercial licence required to monetise the software itself. See [LICENSE](<LICENSE>).

## 许可与商业授权

本项目采用 [Tidewatch 观澜源代码可见许可 v1.0](<LICENSE>)，自 2026-11-06 起生效：

- 个人可免费将软件用于商业或非商业工作，包括收费设计交付。
- 公司及其他组织可免费自部署并用于内部工作，包括营利业务和收费设计交付。
- 把软件本身作为商品或收费服务对外提供（出售许可、订阅/访问收费、对外托管）须另行取得商业授权；边界与条件由权利人书面确定。
- 部署协助、迁移、配置、维护，以及在用户自己的服务器上提供托管或运维协助，可另行约定服务范围与费用。
- 对外分发源码、二进制、修改版或衍生作品需另行授权；内部修改仅供内部使用。

本许可不是开源许可。此前按 AGPL-3.0 等条款发布的旧版本，其原有权利不因本许可改变。

## 构建与测试

需要 Node.js 22 或更新版本。常用命令：

```bash
npm test
npm run build
npm run demo
```

`npm run demo` 是合成数据演示，不是生产平台。构建与测试输出仅供本地候选验证；占位插件清单、兼容测试包以及 `构建产物/`、`开发包/` 中的文件都不是正式发行包，不要直接上传或分发。

截至 2026-11-06 最新全量 Node 测试为 **1571 项：1558 通过、9 失败、4 跳过**（退出码 1）；失败分类与根因见上，详细日志属内部记录、不随公开包发布。因此不得宣称全量测试通过、构建可复现或已具备生产部署条件。构建选项及产物边界见[构建说明](<构建/README.md>)。

<details>
<summary>第三方许可、来源记录与补充文档</summary>

- 请保留 [`NOTICE.md`](<NOTICE.md>)、第三方许可证原文、版权与 SPDX 标记；既有按 AGPL-3.0 等条款发布的版本，其原有许可权利不因本许可改变。
- 历史来源记录可能包含不适合公开的路径和运维细节。不得原样打包，也不得为公开发行而改写或覆盖原始证据；应先完成审阅并另备核准公开版本。
- 更多信息：[平台运行说明](<平台/README.md>)、[部署与运维说明](<部署与运维/README.md>)、[构建说明](<构建/README.md>)。

</details>
