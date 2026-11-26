#!/bin/sh
set -eu

origin=${LAN_VIEWER_ORIGIN:-}
host=${origin#http://}
host=${host%%:*}
case "$host" in
    *.local) ;;
    *) echo 'Set LAN_VIEWER_ORIGIN to an HTTP .local hostname.' >&2; exit 1 ;;
esac

cidr=${LAN_VIEWER_CIDR:?Set LAN_VIEWER_CIDR to the Pi Wi-Fi address and prefix}
exec /usr/bin/avahi-publish-address --no-reverse "$host" "${cidr%/*}"
