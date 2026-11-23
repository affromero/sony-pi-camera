# Sony Pi Camera

Preview, control, and schedule photos from a USB-connected Sony camera on a Raspberry Pi. Family invitations open a read-only gallery with live preview and original downloads. Optional AI advice suggests settings before a scheduled shot.

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

[Setup and operation](SETUP.md) · [USB benchmarks](SETUP.md#compare-usb-preview-backends) · [Glossary](GLOSSARY.md) · [MIT license](LICENSE)
