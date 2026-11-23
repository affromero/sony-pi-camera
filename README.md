# Sony Pi Camera

Preview, control, and schedule photos from a USB-connected Sony camera on a Raspberry Pi. A family password or invitation opens a read-only gallery with live preview and original downloads. Optional AI advice suggests settings before a scheduled shot.

![Admin workspace showing a backyard bird feeder in the live preview, with focus, magnification, and camera settings](docs/camera-controls.jpg)

![Read-only family photo viewer showing a saved bird feeder photo with a download button](docs/family-photo-viewer.jpg)

Example setup for watching a backyard bird feeder and sharing photos with family. The scene and settings are simulated.

```mermaid
flowchart LR
    Family -->|Public HTTPS| Relay[Viewer relay]
    Relay -->|Guest Unix socket| Camera[Private camera service]
    Owner -->|LAN or VPN HTTPS| Admin[Admin]
    Admin --> Camera
    Timer --> Camera
    Timer -. Optional preview advice .-> AI[AI provider]
    Camera --> Gallery[Pi gallery]
    Camera --> Worker[Rust camera backend]
    Worker -->|libgphoto2| Sony[USB camera]
```

[Setup and operation](SETUP.md) · [USB benchmarks](SETUP.md#compare-usb-preview-backends) · [Changelog](CHANGELOG.md) · [Glossary](GLOSSARY.md) · [MIT license](LICENSE)
