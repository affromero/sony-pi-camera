#!/bin/sh
set -eu

pi_host=${1:?Usage: open-camera.sh user@hostname.local}
camera_token=$(ssh -o BatchMode=yes "$pi_host" 'cat ~/.config/sony-pi-camera/camera-token')
if [ -z "$camera_token" ]; then
  printf 'Camera token is unavailable.\n' >&2
  exit 1
fi
ssh -f -N -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8765:127.0.0.1:8765 "$pi_host"
open "http://localhost:8765/#$camera_token"
printf 'Camera opened. The SSH connection must remain active.\n'
