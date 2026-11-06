# 自托管平台（C34 候选）

本目录包含持久化服务、账户与权限、项目发布、查看器数据接口及网页入口。它是 C34 发布准备副本中的源代码说明，不代表公开发行、许可证生效或容器镜像已完成。

## 本地隔离启动

需要 Node.js 22 或更新版本。所有路径、账号与密钥必须属于独立测试环境；不要指向现有服务数据，也不要复用生产凭据。`npm start` 调用 `平台/启动.mjs`，启动前须提供专用数据目录和认证密钥文件：

```bash
export HANDOFF_DATA_DIR=/abs/path/to/tidewatch-test-data
export HANDOFF_JWT_SECRET_FILE=/abs/path/to/tidewatch-test-secrets/jwt
export HANDOFF_ADMIN_PASSWORD_FILE=/abs/path/to/tidewatch-test-secrets/admin-password
export HANDOFF_HOST=127.0.0.1 HANDOFF_PORT=4318
npm start
```

数据目录应由当前用户独占；密钥文件须为私有常规文件。仅首次创建空目录时需要管理员引导密码文件；已有数据目录不会重置管理员。配置缺失、权限过宽或路径非法时，启动会拒绝继续。

```bash
curl -fsS http://127.0.0.1:4318/api/health
```

`HANDOFF_*` 是当前 C34 运行时配置名，保留以维持兼容，不代表产品显示品牌。`npm run demo` 使用合成内存数据，不是持久服务，也不接触生产数据。

## 来源地址与插件

- Web/API 来源校验保持严格；部署时应保留原始 `Host` 与端口，不要将转发头当作可信来源，也不要以通配 CORS 放宽校验。
- C34 插件允许用户在运行时选择其自己的 HTTPS 服务地址；没有预设的发布者服务地址。运行时禁止 HTTP 与不安全重定向，认证数据按服务 origin 隔离。
- 插件兼容身份和协议字段应保持不变。实际插件清单、权限范围、用户输入地址流程和 Figma 平台资格须在正式发行前再次核验。

## 原生图片编码器

平台可选用原生 PNG/JPEG/WebP 编码器；未配置时，相关预览能力会明确返回不可用，不伪造成功。构建器从本目录锁定的本地 Debian 依赖包离线重建，需要 `dpkg-deb` 和 C 编译器；输出写入 `原生编码器/运行时/`，不是源码发行文件。第三方许可证、对应源码与镜像中的运行库须在最终发行材料中核验。

## 发布边界

本副本已加入平台 `Dockerfile`、`compose.yaml`、`.dockerignore` 与反代样例，并已在 NAS 宿主 Docker 验证构建、启动、健康检查、重启持久性和 Compose 路径；Caddy 内部 CA 的隔离 HTTPS 反代、登录、Secure Cookie、认证请求与错误 Origin 拒绝也已通过。私有 Docker Hub 候选镜像已推送，仍未公开。公网域名/证书签发、真实 Figma/macOS、编码器挂载、基础镜像 digest 与第三方材料仍未完成。`原生编码器/Dockerfile` 只用于编码器构建，不参与平台镜像。部署步骤与验证状态见[容器化部署说明](<../部署与运维/04_容器化部署.md>)。后端公开发行、镜像公开、生产迁移及许可审批彼此独立，均未由本说明授权。
