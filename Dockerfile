# 平台服务镜像（候选）。只打包运行时需要的源码；不包含测试、审计、来源记录与本机构建产物。
# 默认用带版本号的官方 Node 镜像 tag；正式发行时应改为 digest 固定，例如：
#   docker build --build-arg BASE_IMAGE=node@sha256:<已核验的 manifest digest> -t <image> .
# 发行前还须核验该基础镜像的发行版、Node 版本、系统包清单与第三方许可，并补齐 NOTICE/SBOM/对应源码。
ARG BASE_IMAGE=node:22.19.0-bookworm-slim
FROM ${BASE_IMAGE}

ENV NODE_ENV=production \
    HANDOFF_HOST=0.0.0.0 \
    HANDOFF_PORT=4318 \
    HANDOFF_DATA_DIR=/data

WORKDIR /app

COPY package.json ./
COPY 平台/ ./平台/
COPY 查看器/ ./查看器/
COPY 界面/ ./界面/
COPY 品牌/identity.mjs 品牌/guanlan-logo.mjs ./品牌/
COPY 宿主/production-adapter.mjs 宿主/production-shell.css 宿主/stored-zip.mjs ./宿主/

# 源码文件可能带 0600/0700 权限；统一为 root 只读、非 root 可读，否则 10001 无法加载模块。
RUN chmod -R a+rX /app

# 固定非 root 运行身份；数据目录与密钥目录都由外部挂载。
RUN groupadd --gid 10001 tidewatch \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin tidewatch \
 && mkdir -p /data /run/secrets \
 && chown 10001:10001 /data /run/secrets \
 && chmod 0700 /data /run/secrets

USER 10001:10001

VOLUME ["/data"]
EXPOSE 4318

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.HANDOFF_PORT||4318)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "平台/启动.mjs"]
