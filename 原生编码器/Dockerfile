# Pinned builder base; apt is confined to this disposable build stage, never host.
FROM node@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS build
# Debian snapshot fixes the complete toolchain dependency solver input.
ARG DEBIAN_SNAPSHOT=20261015T000000Z
RUN printf 'Types: deb\nURIs: http://snapshot.debian.org/archive/debian/%s/\nSuites: bookworm\nComponents: main\nCheck-Valid-Until: no\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\n' "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list.d/debian.sources \
 && apt-get -o Acquire::Retries=0 -o Acquire::http::Timeout=30 update \
 && apt-get install -y --no-install-recommends gcc=4:12.2.0-3 libc6-dev binutils \
 && dpkg-query -W > /toolchain-packages.txt
WORKDIR /codec
COPY codec.c build.mjs dependencies.lock.json ./
COPY 依赖包/ ./依赖包/
COPY 第三方源码/ ./第三方源码/
RUN node build.mjs
# Artifact-only image; no shell, vips, FFTW, jbig, or toolchain is shipped here.
# libc/libm/loader are a documented host prerequisite, not silently copied.
FROM scratch AS artifacts
COPY --from=build /codec/运行时 /运行时
COPY --from=build /toolchain-packages.txt /构建工具链包.txt
COPY dependencies.lock.json /dependencies.lock.json
COPY 第三方许可/ /第三方许可/
# The ELF intentionally stays 0600; the consuming Linux host's loader launches it.
