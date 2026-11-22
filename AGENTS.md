# Working on Sony Pi Camera

Read the architecture and hardware notes in [README.md](README.md). The tested configuration is a Sony α7 III with a Sigma 35mm F1.2 DG DN Art. Record the body, firmware, lens and shooting mode when reporting camera behavior.

- `camera/camera.py` serves the dashboard and serializes USB operations with a process-wide lock. Route camera commands through its gPhoto2 helper. Check the camera's readback when adding controls.
- `camera/camera.js`, `camera/camera.html` and `camera/camera.css` implement the browser controls. The magnifier overview uses the last full frame and the viewport reported by the body.
- `camera/transfer.py` handles optional FTPS uploads. Both services use `~/camera-photos`. The gallery's Delete action removes the Pi copy.
- Keep access keys, passwords, camera photos and generated private keys out of Git, examples and logs. Preserve the dashboard's token, host and origin checks.
- Use `uv sync --frozen` for development and `uv run --frozen pre-commit install --install-hooks` in your main checkout. Run all hooks, camera tests and the JavaScript syntax check before handing over changes. The README lists the commands.
- Mock the USB boundary in automated tests. Verify behavior on hardware when possible and identify anything checked only with a mock. Update the README and [glossary](glossary.md) when a feature changes setup or terminology.
