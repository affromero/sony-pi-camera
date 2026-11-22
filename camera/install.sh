#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ] || [ -z "${SUDO_USER:-}" ]; then
  printf 'Run with sudo from the camera user account.\n' >&2
  exit 1
fi
project_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
camera_home=$(getent passwd "$SUDO_USER" | cut -d: -f6)
config_dir="$camera_home/.config/sony-pi-camera"
install -d -m 700 -o "$SUDO_USER" "$config_dir"
# Keep existing camera credentials when upgrading from the original Pi dashboard.
old_config="$camera_home/.config/pi-field-notes"
for file in camera-token camera.crt camera.key transfer-ca.crt transfer-ca.key \
  transfer.crt transfer.key transfer-password transfer-camera-ip; do
  if [ -f "$old_config/$file" ] && [ ! -e "$config_dir/$file" ]; then
    install -m 600 -o "$SUDO_USER" "$old_config/$file" "$config_dir/$file"
  fi
done
if [ ! -e "$config_dir/camera.crt" ] && [ ! -e "$config_dir/camera.key" ]; then
  camera_name="$(hostname).local"
  umask 077
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$config_dir/camera.key" -out "$config_dir/camera.crt" \
    -subj "/CN=$camera_name" -addext "subjectAltName=DNS:$camera_name" \
    -addext 'keyUsage=critical,keyCertSign,cRLSign,digitalSignature' 2>/dev/null
  chown "$SUDO_USER" "$config_dir/camera.key" "$config_dir/camera.crt"
fi
if [ ! -s "$config_dir/camera.crt" ] || [ ! -s "$config_dir/camera.key" ]; then
  printf 'Camera certificate or key is missing. Restore the pair before installing.\n' >&2
  exit 1
fi
if [ ! -e "$config_dir/transfer-ca.crt" ] && [ ! -e "$config_dir/transfer-ca.key" ]; then
  umask 077
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$config_dir/transfer-ca.key" -out "$config_dir/transfer-ca.crt" \
    -subj '/CN=Pi Camera Transfer CA' \
    -addext 'basicConstraints=critical,CA:TRUE' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' 2>/dev/null
  chown "$SUDO_USER" "$config_dir/transfer-ca.key" "$config_dir/transfer-ca.crt"
fi
if [ ! -s "$config_dir/transfer-ca.crt" ] || [ ! -s "$config_dir/transfer-ca.key" ]; then
  printf 'Transfer CA certificate or key is missing. Restore the pair before installing.\n' >&2
  exit 1
fi
camera_ip=$(hostname -I | awk '{print $1}')
if [ -z "$camera_ip" ]; then
  printf 'The Pi needs an IP address to configure encrypted transfers.\n' >&2
  exit 1
fi
if [ ! -s "$config_dir/transfer.crt" ] || [ ! -s "$config_dir/transfer.key" ] || \
  ! openssl x509 -in "$config_dir/transfer.crt" -noout -checkip "$camera_ip" | grep -q 'does match' || \
  ! openssl x509 -in "$config_dir/transfer.crt" -noout -subject | grep -Fq "CN = $camera_ip" || \
  ! openssl verify -CAfile "$config_dir/transfer-ca.crt" "$config_dir/transfer.crt" >/dev/null 2>&1; then
  cert_dir=$(mktemp -d)
  trap 'rm -rf "$cert_dir"' EXIT
  printf 'subjectAltName=DNS:%s.local,IP:%s\nextendedKeyUsage=serverAuth\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n' \
    "$(hostname)" "$camera_ip" > "$cert_dir/extensions"
  openssl req -new -newkey rsa:2048 -nodes \
    -keyout "$cert_dir/transfer.key" -out "$cert_dir/transfer.csr" \
    -subj "/CN=$camera_ip" 2>/dev/null
  openssl x509 -req -in "$cert_dir/transfer.csr" \
    -CA "$config_dir/transfer-ca.crt" -CAkey "$config_dir/transfer-ca.key" \
    -set_serial "0x$(openssl rand -hex 16)" -days 3650 \
    -extfile "$cert_dir/extensions" -out "$cert_dir/transfer.crt" 2>/dev/null
  install -m 600 -o "$SUDO_USER" "$cert_dir/transfer.key" "$config_dir/transfer.key"
  install -m 600 -o "$SUDO_USER" "$cert_dir/transfer.crt" "$config_dir/transfer.crt"
fi
if [ ! -e "$config_dir/transfer-password" ]; then
  umask 077
  openssl rand -hex 12 > "$config_dir/transfer-password"
  chown "$SUDO_USER" "$config_dir/transfer-password"
fi
install -d -m 755 /opt/pi-camera
install -m 644 "$project_dir/camera.py" "$project_dir/camera.html" \
  "$project_dir/camera.js" "$project_dir/camera.css" \
  "$project_dir/transfer.py" "$project_dir/scheduled_capture.py" /opt/pi-camera/
install -d -m 755 /opt/pi-camera/sidedoor/web
install -m 644 "$project_dir/sidedoor/advice.mjs" \
  "$project_dir/sidedoor/ai-config.mjs" "$project_dir/sidedoor/package.json" \
  "$project_dir/sidedoor/package-lock.json" /opt/pi-camera/sidedoor/
install -m 644 "$project_dir/sidedoor/web/"* /opt/pi-camera/sidedoor/web/
install -m 644 "$project_dir/sony-pi-camera@.service" /etc/systemd/system/
install -m 644 "$project_dir/pi-camera-transfer@.service" /etc/systemd/system/
install -m 644 "$project_dir/sony-pi-capture@.service" \
  "$project_dir/sony-pi-capture@.timer" \
  "$project_dir/sony-pi-viewer@.service" /etc/systemd/system/
systemctl daemon-reload
if [ -f /etc/systemd/system/pi-field-notes-camera@.service ]; then
  systemctl disable --now "pi-field-notes-camera@$SUDO_USER.service"
fi
systemctl enable "sony-pi-camera@$SUDO_USER.service"
systemctl restart "sony-pi-camera@$SUDO_USER.service"
systemctl try-restart "pi-camera-transfer@$SUDO_USER.service"
