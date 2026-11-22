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
    Camera --> Sony[USB camera and Pi gallery]
```

[Setup and operation](SETUP.md) · [Glossary](GLOSSARY.md) · [MIT license](LICENSE)
