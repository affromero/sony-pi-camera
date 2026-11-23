# Changelog

Releases use version tags such as `v0.1.0` on a checked commit from `main`.
Before 1.0, use patch releases for fixes and performance improvements and
minor releases for new capabilities. Record breaking changes in the notes.

## [0.1.0] - 2026-11-22

### Added

- Control a USB-connected Sony α7 III from the browser, including live preview, tap-to-focus, magnification, shutter, and exposure settings. ([Camera controls](https://github.com/affromero/sony-pi-camera/commit/ef50f75ec5fab1e8e86fb6e75856304597866c42))
- Open the read-only live preview and gallery with a family password or single-use invitation. Admins can share invitations as links or QR codes. ([#6](https://github.com/affromero/sony-pi-camera/pull/6), [QR codes](https://github.com/affromero/sony-pi-camera/commit/519af591113f1e6a26dcff9448556d85ee344aab), [Family access](https://github.com/affromero/sony-pi-camera/commit/cce2df97ebfc0722ac154e4414307ac27e84e18b))
- Review thumbnails, open photos at full size, and download originals. The admin gallery also supports sorting and date filters. ([Gallery](https://github.com/affromero/sony-pi-camera/commit/6c3545409fe7e5bf71a183b347e3a9872a64fcdb), [Photo loading progress](https://github.com/affromero/sony-pi-camera/commit/41fdd7bc1a1d931b53b9dc0328e57912745fe16a))
- Schedule daily captures in the camera dashboard and optionally use a vision model to advise on settings before the shutter fires. ([#6](https://github.com/affromero/sony-pi-camera/pull/6), [Capture scheduling](https://github.com/affromero/sony-pi-camera/commit/0b99d483260a52a189411a883ac61c1936b3fb7b))
- Use the Rust USB backend for preview and camera operations. The viewer streams by default, and setting updates confirm the value in one USB session. ([#11](https://github.com/affromero/sony-pi-camera/pull/11), [Setting updates](https://github.com/affromero/sony-pi-camera/commit/cce2df97ebfc0722ac154e4414307ac27e84e18b), [Default streaming](https://github.com/affromero/sony-pi-camera/commit/d015324adfcef8c859683fc5d55e7d40ba4b461e))
