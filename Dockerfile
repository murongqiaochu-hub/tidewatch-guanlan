# 平台服务镜像（候选）。只打包运行时需要的源码；不包含测试、审计、来源记录与本机构建产物。
# 基础镜像固定为第三方锁/系统覆盖记录核验过的 digest（Node 22.23.3、Debian bookworm、glibc 2.36-9+deb12u14）。
# 可在构建时覆盖为重新核验过的 digest；不要改回可变 tag。
# 原生预览所需的编码器（原生编码器/运行时/）与“从服务器下载插件”所需的 plugin.zip 不在本镜像内，
# 必须由发布流程另行构建并挂载或复制；缺失时对应能力会明确失败，不会伪造成功。
ARG BASE_IMAGE=node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
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
