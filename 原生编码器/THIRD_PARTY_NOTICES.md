# Third-party notices and distribution boundary

This independently authored codec links privately to libpng, libjpeg-turbo, libwebp and zlib, and dynamically requires the Linux host's glibc libc/libm/ELF loader. It does not use or redistribute vips, FFTW, jbig, or the earlier Heron backend/vendor implementation. No optional GPL runtime image tool is enabled.

The complete, unmodified notices are retained under the `第三方许可/` subtree; corresponding upstream source archives, Debian patches and source descriptors are retained under `第三方源码/`. Exact official download URLs, sizes and SHA256 values are in the dependency lock. The build toolchain is fixed by the Docker base digest and dated Debian snapshot, not distributed in the artifact stage.

| Runtime component | Notices/conditions | Upstream |
|---|---|---|
| libpng 1.6.39 + Debian deb12u5 patches | Libpng; retain authors and disclaimer | https://www.libpng.org/pub/png/libpng.html |
| libjpeg-turbo 2.1.5 | IJG, BSD-3-Clause, Zlib; retain all applicable notices | https://github.com/libjpeg-turbo/libjpeg-turbo |
| libwebp 1.2.4 + Debian deb12u1 patches | BSD-3-Clause, accompanying patent materials | https://chromium.googlesource.com/webm/libwebp/ |
| zlib 1.2.13 | Zlib | https://zlib.net/ |
| host glibc 2.36 | LGPL-2.1-or-later plus per-file notices; dynamically replaceable host prerequisite | https://www.gnu.org/software/libc/ |

IJG attribution: This software is based in part on the work of the Independent JPEG Group.

Source archives contain additional build/example/documentation licenses, including GPL packaging/build tools and some dual-licensed libpng examples. They are retained as source and provenance materials, not compiled or installed as optional runtime codecs. GPL text appearing in that evidence must not be misrepresented as proof that the whole archive is permissive, nor as a claim that the codec links those example programs. GCC runtime exception text is retained for applicable compiler runtime fragments.

The four private codec libraries may be replaced/rebuilt by the recipient. Do not impose a blanket prohibition that defeats LGPL-covered host-library replacement or debugging rights. This notice is not legal clearance: final distribution packaging, copyright ownership of newly authored code, branding, patent review and EULA compatibility require the rights holder's/legal review. The old AGPL licenses and previously granted rights are unchanged.
