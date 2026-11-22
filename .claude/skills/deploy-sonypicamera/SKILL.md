---
name: deploy-sonypicamera
description: Deploy or verify the Sony Pi Camera dashboard, scheduled capture advisor, and invite-only viewer on a Raspberry Pi. Use for requests to publish or update the camera viewer or deploy a verified Sony Pi Camera commit. The private project dashboard has its own deployment.
---

# Deploy Sony Pi Camera

1. Read `README.md` in the Sony Pi Camera checkout. Resolve the requested Pi, camera user, public hostname, and commit. Check SSH reachability, the camera, timer and viewer unit states, free disk and memory, and Node.js version. For a worktree, verify the exact deployed commit and avoid copying local configuration or photos.
2. Run the repository checks and record the currently deployed commit or preserve a copy of the installed code and units for rollback. Preserve the timer override, user photo library, camera credentials, and the viewer's systemd state directory. Keep provider keys, admin passwords, tunnel tokens and invitation URLs out of command arguments, logs and Git.
3. Install camera files and units with `sudo sh camera/install.sh` as directed in the README. For the viewer or advisor, ensure Node.js 22+ and install the locked dependencies under `/opt/pi-camera/sidedoor`. Initialize the admin locally only if needed and configure the requested HTTPS origin. Start or restart the viewer after dependencies and configuration are in place. Preserve the previous capture schedule.
4. Verify the viewer locally on port 8770 with its configured public Host header. Confirm unauthenticated requests to `/photos` and `/preview` return 401. Check that the viewer listens on loopback. When publishing, route the exact requested hostname to `http://127.0.0.1:8770` through the configured TLS ingress. Keep the dashboard and camera control ports off this route. Preserve the Host header and bypass caching for this hostname.
5. Check public TLS and unauthenticated responses. Using temporary authorized sessions, verify a single-use invitation, preview and download, and that viewer settings and deletion requests return 403. Verify admin settings and access controls read-only unless the operator requested a real write or a test shot. Verify the next scheduled run with `systemctl list-timers`. Report any hardware, AI or public DNS checks you could not run.
6. If an upgrade fails, restore the previous installed code and unit definitions, reload systemd and verify service recovery. Keep the live state directory and photos. For a failed first publication, disable the viewer service and remove only the newly added ingress route.
