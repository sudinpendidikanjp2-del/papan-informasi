#!/usr/bin/env bash
# Membuka papan informasi dalam mode layar penuh (kiosk) dan membukanya kembali bila browser berhenti.
# Cocok untuk Raspberry Pi OS, Ubuntu/Debian desktop, atau mini PC yang tersambung ke layar.
#
#   deploy/kiosk-display.sh "http://192.168.1.10:3000/layar/lobi?sound=on"
#
# Variabel opsional:
#   KIOSK_PROFILE   folder profil browser khusus kiosk (default: ~/.config/papan-kiosk)
#   KIOSK_INSECURE  isi 1 untuk menerima sertifikat self-signed (hanya untuk jaringan lokal tepercaya)
set -u

URL="${1:-}"
if [ -z "$URL" ]; then
  echo "Penggunaan: $0 <alamat papan>, mis. $0 \"http://192.168.1.10:3000/layar/lobi?sound=on\"" >&2
  exit 2
fi

BROWSER=""
for b in chromium chromium-browser google-chrome google-chrome-stable; do
  if command -v "$b" >/dev/null 2>&1; then BROWSER="$b"; break; fi
done
if [ -z "$BROWSER" ]; then
  echo "Chromium atau Chrome tidak ditemukan. Pasang dengan: sudo apt install chromium (atau chromium-browser)." >&2
  exit 1
fi

PROFILE="${KIOSK_PROFILE:-$HOME/.config/papan-kiosk}"
mkdir -p "$PROFILE"

# Cegah layar padam dan sembunyikan kursor (X11). Di Wayland atur lewat pengaturan daya desktop.
if [ -n "${DISPLAY:-}" ]; then
  if command -v xset >/dev/null 2>&1; then
    xset s off
    xset -dpms
    xset s noblank
  fi
  if command -v unclutter >/dev/null 2>&1; then
    unclutter -idle 1 -root &
  fi
fi

# Setelah listrik padam, Chrome biasanya menampilkan "tidak ditutup dengan benar"; tandai penutupan normal.
fix_profile() {
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"Crashed"/"exit_type":"Normal"/' \
    "$PROFILE/Default/Preferences" 2>/dev/null || true
}

EXTRA=()
if [ "${KIOSK_INSECURE:-0}" = "1" ]; then EXTRA+=(--ignore-certificate-errors); fi

trap 'kill 0' EXIT TERM INT

while true; do
  fix_profile
  # --autoplay-policy: memungkinkan bunyi bel dan suara panggilan tanpa ketukan (dipasangkan dengan sound=on di alamat).
  "$BROWSER" \
    --kiosk --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
    --disable-translate --no-first-run --ozone-platform-hint=auto \
    --autoplay-policy=no-user-gesture-required \
    --overscroll-history-navigation=0 --check-for-update-interval=31536000 \
    --user-data-dir="$PROFILE" "${EXTRA[@]}" "$URL"
  echo "Browser berhenti (kode $?), dibuka lagi dalam 3 detik..." >&2
  sleep 3
done
