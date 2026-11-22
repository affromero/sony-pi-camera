---
name: deploy-sonypicamera
description: Deploy or verify the Sony Pi Camera dashboard, scheduled capture advisor, and invite-only viewer on a Raspberry Pi. Use for requests to publish or update the camera viewer or deploy a verified Sony Pi Camera commit. The private project dashboard has its own deployment.
---

# Deploy Sony Pi Camera

1. Read `README.md` in the Sony Pi Camera checkout. Resolve the requested Pi, camera user, public hostname, and commit. Check SSH reachability, the camera, timer and viewer unit states, free disk and memory, and Node.js version. For a worktree, verify the exact deployed commit and avoid copying local configuration or photos.
2. Run the repository checks and record the currently deployed commit or preserve a copy of the installed code and units for rollback. Preserve the timer override, user photo library, camera credentials, and the viewer's systemd state directory. Keep provider keys, admin passwords, tunnel tokens and invitation URLs out of command arguments, logs and Git.
3. Install camera files and units with `sudo sh camera/install.sh` as directed in the README. For the viewer or advisor, ensure Node.js 22+ and install the locked dependencies under `/opt/pi-camera/sidedoor`. Initialize the admin locally only if needed and configure the requested HTTPS origin. Start or restart the viewer after dependencies and configuration are in place. Preserve the previous capture schedule.
4. Read the viewer section in `SETUP.md`. Configure separate private admin and public viewer HTTPS origins. Route public ingress only to `/run/sony-camera-public-USER/viewer.sock`; route private admin ingress to `/run/sony-camera-USER/admin.sock`. Preserve Host headers and bypass caching. Confirm unauthenticated public media requests return 401 and public admin routes return 404.
5. Check public TLS and test a single-use invitation, preview, and download. Verify the relay uses Unix-only networking and cannot read admin state. Verify admin operations read-only unless the operator requested a real write or test shot. Check the timer with `systemctl list-timers`.
6. If an upgrade fails, restore the previous installed code and unit definitions, reload systemd and verify service recovery. Keep the live state directory and photos. For a failed first publication, disable the viewer service and remove only the newly added ingress route.
