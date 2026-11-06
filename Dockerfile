# 平台服务镜像（C34 候选）。运行时源码 + 预构建原生编码器运行时 + 源码内重建的自建 HTTPS 插件包。
# 编码器运行时需先运行 `node 原生编码器/build.mjs`（需要 dpkg-deb 与 C 编译器），其哈希须与发布清单一致。
# 基础镜像固定为第三方锁/系统覆盖记录核验过的 digest（Node 22.23.3、Debian bookworm、glibc 2.36-9+deb12u14）。
# 插件包在镜像内用 Node 标准库从源码重建；编码器运行时使用按锁定 deb 预构建的产物。
ARG BASE_IMAGE=node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG PLUGIN_RELEASE=C34
ARG PLUGIN_DATE=2026-11-04

# 1) 插件包：只用 Node 标准库构建，无网络、无 npm 依赖。
FROM ${BASE_IMAGE} AS plugin
ARG PLUGIN_RELEASE
ARG PLUGIN_DATE
WORKDIR /src
COPY package.json ./
COPY 平台/ ./平台/
COPY 插件/ ./插件/
COPY 查看器/ ./查看器/
COPY 界面/ ./界面/
COPY 品牌/ ./品牌/
COPY 宿主/ ./宿主/
COPY 构建/ ./构建/
COPY 测试/ ./测试/
COPY 来源记录/01_独立实现行为合同.md ./来源记录/
RUN mkdir -p /out && node 构建/build.mjs --production-compat --service-mode custom-https --plugin-id 1699730787876999241 \
 && node 构建/打包交付插件.mjs --directory /src/构建产物/生产兼容包/插件 --output /out/plugin.zip \
      --service-mode custom-https --release ${PLUGIN_RELEASE} --date ${PLUGIN_DATE}

# 2) 原生编码器运行时：由 原生编码器/build.mjs 从锁定 deb 构建（本机/CI 预构建，哈希见发布清单）。

# 3) 最终服务镜像。
FROM ${BASE_IMAGE}
ENV NODE_ENV=production \
    HANDOFF_HOST=0.0.0.0 \
    HANDOFF_PORT=4318 \
    HANDOFF_DATA_DIR=/data \
    HANDOFF_CODEC_BINARY=/app/原生编码器/运行时/heron-codec \
    HANDOFF_CODEC_LIBRARIES=/app/原生编码器/运行时/lib \
    HANDOFF_PLUGIN_ARCHIVE=/app/downloads/plugin.zip

WORKDIR /app

COPY package.json ./
COPY 平台/ ./平台/
COPY 查看器/ ./查看器/
COPY 界面/ ./界面/
COPY 品牌/identity.mjs 品牌/guanlan-logo.mjs ./品牌/
COPY 宿主/production-adapter.mjs 宿主/production-shell.css 宿主/stored-zip.mjs ./宿主/
COPY --from=plugin /out/plugin.zip /app/downloads/plugin.zip
COPY 原生编码器/运行时/ /app/原生编码器/运行时/
# 随镜像提供 NOTICE、整镜像 SBOM、第三方锁与原生编码器 SBOM；对应源码按发布渠道单独提供。
COPY NOTICE.md /app/NOTICE.md
COPY 系统第三方/整镜像.SBOM.cdx.json /app/SBOM.cdx.json
COPY 系统第三方/系统第三方.lock.json /app/第三方锁.json
COPY 原生编码器/SBOM.cdx.json /app/原生编码器/SBOM.cdx.json

# 源码与构建产物可能带 0600/0700；统一为 root 只读、非 root 可读；编码器与插件包必须可执行/可读。
RUN chmod -R a+rX /app \
 && chmod 0644 /app/downloads/plugin.zip \
 && chown -R 10001:10001 /app/原生编码器/运行时 \
 && chmod 0700 /app/原生编码器/运行时 /app/原生编码器/运行时/lib /app/原生编码器/运行时/heron-codec \
 && chmod 0600 /app/原生编码器/运行时/lib/libpng16.so.16 /app/原生编码器/运行时/lib/libjpeg.so.62 \
      /app/原生编码器/运行时/lib/libwebp.so.7 /app/原生编码器/运行时/lib/libz.so.1

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
