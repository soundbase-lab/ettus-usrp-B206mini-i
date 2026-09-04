# Vendored third-party code

| Library | Version | Licence | Source |
|---|---|---|---|
| pffft (marton78 fork) | commit c14802c0bca7a638be450c33b5b0c87016813bbd (2026-09-03) | BSD-like (FFTPACK) | https://github.com/marton78/pffft |
| nlohmann/json | v3.12.0 single header | MIT | https://github.com/nlohmann/json |

Only the float single-precision pffft path is vendored (`pffft.c`, `pffft_common.c`, the SIMD headers).
Build with `-DPFFFT_ENABLE_NEON` on arm64 so `pffft_simd_size() == 4`.
