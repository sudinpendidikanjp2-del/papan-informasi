#!/usr/bin/env bash
# Uji asap image Docker dan docker-compose: build, isi image, siklus hidup container, izin volume, penutupan
# anggun, persistensi, backup/restore di dalam container, compose, bind mount milik root, dan --user tanpa izin tulis. Dipakai oleh CI dan bisa dijalankan lokal:
#
#   test/docker-smoke.sh
#
# Variabel opsional:
#   IMAGE            nama image yang dibangun/diuji (default papan-informasi:smoke)
#   APT_PACKAGES     paket sistem untuk build; kosong = lewati apt (ffmpeg dan CA lalu tidak diperiksa)
#   DOCKER_NETWORK   isi "host" bila daemon tanpa jaringan bridge (mis. di sandbox); default memakai publish port
#   FORWARD_PROXY=1  teruskan http_proxy/https_proxy/no_proxy sebagai build arg
#   SKIP_BUILD=1     pakai IMAGE yang sudah ada
#   COMPOSE_BUILD=1  compose membangun image sendiri (jalur sebenarnya); default memakai IMAGE yang sudah ada
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-papan-informasi:smoke}"
APT_PACKAGES="${APT_PACKAGES-ffmpeg tar ca-certificates}"
DOCKER_NETWORK="${DOCKER_NETWORK:-}"
SUFFIX="$$"
NAME="papan-smoke-$SUFFIX"
VOLUME="papan-smoke-data-$SUFFIX"
PROJECT="papan-smoke-c-$SUFFIX"
PORT="${PORT:-$((20000 + RANDOM % 20000))}"
PASS_ADMIN="rahasia-smoke-123"
TMP="$(mktemp -d)"
PASSED=0; FAILED=0; SKIPPED=0

if [ "$DOCKER_NETWORK" = "host" ]; then
  RUN_NET=(--network host -e "PORT=$PORT"); BASE="http://127.0.0.1:$PORT"
else
  RUN_NET=(-p "127.0.0.1:$PORT:3000");      BASE="http://127.0.0.1:$PORT"
fi

pass() { PASSED=$((PASSED+1)); echo "  PASS $*"; }
fail() { FAILED=$((FAILED+1)); echo "  FAIL $*"; }
skip() { SKIPPED=$((SKIPPED+1)); echo "  SKIP $*"; }
ok()   { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (dapat: '$2', harap: '$3')"; fi; }
step() { echo; echo "== $*"; }
has()  { case " $APT_PACKAGES " in *" $1 "*) return 0;; *) return 1;; esac; }

cleanup() {
  set +e
  # Isi bind mount dimiliki uid node; hapus lewat container supaya berhasil walau skrip tidak berjalan sebagai root.
  [ -d "$TMP/bind" ] && docker run --rm --entrypoint sh -v "$TMP/bind:/d" "$IMAGE" -c 'rm -rf /d/* /d/.[!.]*' >/dev/null 2>&1
  docker rm -f "$NAME" "$NAME-2" "$NAME-3" >/dev/null 2>&1
  docker volume rm -f "$VOLUME" >/dev/null 2>&1
  docker compose -p "$PROJECT" ${COMPOSE_FILES:+$COMPOSE_FILES} down -v >/dev/null 2>&1
  rm -rf "$TMP"
}
trap cleanup EXIT

wait_healthy() { # nama [detik]
  local n="$1" t="${2:-60}" i s
  for i in $(seq 1 "$t"); do
    s=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$n" 2>/dev/null || echo gone)
    [ "$s" = healthy ] && return 0
    [ "$s" = gone ] && return 1
    sleep 1
  done
  return 1
}
start_container() { # nama [env tambahan...]
  local n="$1"; shift
  docker run -d --name "$n" "${RUN_NET[@]}" -v "$VOLUME:/data" \
    --health-interval 2s --health-start-period 1s --health-retries 15 \
    -e ADMIN_PASSWORD="$PASS_ADMIN" "$@" "$IMAGE" >/dev/null
}
code() { curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "$@"; }
login() { # jar user pass
  code -c "$1" -X POST "$BASE/api/auth/login" -H 'content-type: application/json' -d "{\"username\":\"$2\",\"password\":\"$3\"}"
}

# ---------------------------------------------------------------- 1. build
step "1. Build image ($IMAGE)"
if [ "${SKIP_BUILD:-0}" = 1 ]; then
  skip "build dilewati (SKIP_BUILD=1)"
else
  ARGS=(--build-arg "APT_PACKAGES=$APT_PACKAGES")
  [ -n "$DOCKER_NETWORK" ] && ARGS+=(--network "$DOCKER_NETWORK")
  if [ "${FORWARD_PROXY:-0}" = 1 ]; then
    ARGS+=(--build-arg "http_proxy=${http_proxy:-}" --build-arg "https_proxy=${https_proxy:-}" --build-arg "no_proxy=${no_proxy:-}")
  fi
  if docker build "${ARGS[@]}" -t "$IMAGE" . >"$TMP/build.log" 2>&1; then pass "docker build berhasil"; else fail "docker build gagal"; tail -20 "$TMP/build.log"; exit 1; fi
fi
SIZE=$(docker image inspect "$IMAGE" --format '{{.Size}}' 2>/dev/null || echo 0)
echo "  info ukuran image: $((SIZE/1024/1024)) MB"

# ---------------------------------------------------------------- 2. isi image
step "2. Isi image"
in_image() { docker run --rm --entrypoint sh "$IMAGE" -c "$1" 2>/dev/null; }
# Entrypoint dimulai sebagai root hanya untuk memperbaiki pemilik /data, lalu menurunkan hak: perintah apa pun dijalankan sebagai node.
UID_IN=$(docker run --rm "$IMAGE" id -u 2>/dev/null || echo ?); [ "$UID_IN" != 0 ] && [ "$UID_IN" != ? ] && pass "perintah berjalan sebagai non-root (uid $UID_IN)" || fail "berjalan sebagai root atau gagal ($UID_IN)"
ok "hasil build antarmuka ada di dist/ (halaman utama dan aset)" "$(in_image 'test -f /app/dist/display.html && ls /app/dist/assets/*.js >/dev/null 2>&1 && echo ya || echo tidak')" ya
ok "image akhir tanpa alat build (vite tidak terpasang)" "$(in_image 'test -d /app/node_modules/vite && echo ada || echo tidak')" tidak
ok "tar tersedia" "$(in_image 'command -v tar >/dev/null && echo ya || echo tidak')" ya
ok "tidak ada .git, data, atau test di image" "$(in_image 'ls -A /app | grep -c -x -e .git -e data -e test -e docs -e deploy || true')" 0
ok "hanya dependensi produksi (vite dan pdfjs-dist, yang dibundel, tidak terpasang)" "$(in_image 'cd /app && ls node_modules | grep -c -x -e vite -e pdfjs-dist || true')" 0
if has ffmpeg; then ok "ffmpeg tersedia" "$(in_image 'command -v ffmpeg >/dev/null && echo ya || echo tidak')" ya; else skip "ffmpeg tidak dipasang (APT_PACKAGES tanpa ffmpeg)"; fi
if has ca-certificates; then ok "sertifikat CA tersedia (TLS push)" "$(in_image 'test -s /etc/ssl/certs/ca-certificates.crt && echo ya || echo tidak')" ya; else skip "ca-certificates tidak dipasang"; fi

# ---------------------------------------------------------------- 3. jalan dan sehat
step "3. Container berjalan dan sehat"
docker volume create "$VOLUME" >/dev/null
start_container "$NAME"
if wait_healthy "$NAME" 60; then pass "status container 'healthy'"; else fail "container tidak sehat"; docker logs "$NAME" 2>&1 | tail -15; exit 1; fi
ok "/healthz 200" "$(code "$BASE/healthz")" 200
HDR=$(curl -s --noproxy '*' -D - -o /dev/null "$BASE/")
echo "$HDR" | grep -qi '^content-security-policy:.*script-src .self.;' && pass "CSP ketat pada halaman" || fail "CSP tidak ada"
echo "$HDR" | grep -qi '^x-content-type-options: nosniff' && pass "nosniff pada halaman" || fail "nosniff tidak ada"
ASSET=$(curl -s --noproxy '*' "$BASE/" | grep -o 'src="/assets/[^"]*\.js"' | head -1 | sed 's/src="//; s/"$//')
CT=$(curl -s --noproxy '*' -D - -o /dev/null "$BASE$ASSET" | tr -d '\r' | grep -i '^content-type:' || true)
echo "$CT" | grep -qi 'javascript' && pass "aset JavaScript hasil build dilayani ($ASSET)" || fail "aset tidak dilayani dengan benar: '$ASSET' $CT"
ok "jalur bersih /admin dan /kiosk menjawab 200" "$(code "$BASE/admin")$(code "$BASE/kiosk")" 200200
ok "alamat lama /admin.html dialihkan 301" "$(code "$BASE/admin.html")" 301
docker logs "$NAME" 2>&1 | grep -q 'Admin pertama dibuat' && pass "admin pertama dibuat dari ADMIN_PASSWORD" || fail "admin pertama tidak dibuat"

# ---------------------------------------------------------------- 4. izin volume
step "4. Menulis ke volume sebagai non-root"
ok "login admin" "$(login "$TMP/j" admin "$PASS_ADMIN")" 200
ok "buat pegawai" "$(code -b "$TMP/j" -X POST "$BASE/api/admin/users" -H 'content-type: application/json' -d '{"username":"budi","name":"Budi","password":"password1","counterIds":[1]}')" 201
ok "simpan pengaturan" "$(code -b "$TMP/j" -X PUT "$BASE/api/admin/settings" -H 'content-type: application/json' -d '{"org_name":"Dinas Smoke"}')" 200
printf '\x89PNG\r\n\x1a\n' > "$TMP/a.png"; head -c 64 /dev/zero >> "$TMP/a.png"
ok "unggah berkas" "$(code -b "$TMP/j" -X POST "$BASE/api/admin/upload" -H 'x-filename: a.png' --data-binary @"$TMP/a.png")" 201
ok "berkas muncul di volume /data/uploads" "$(docker exec "$NAME" sh -c 'ls /data/uploads | wc -l')" 1
OWNER=$(docker exec "$NAME" stat -c %U /data/papan.db); ok "database dimiliki pengguna non-root" "$([ "$OWNER" != root ] && echo ya || echo tidak)" ya

# ---------------------------------------------------------------- 5. backup di dalam container
step "5. Backup di dalam container"
if docker exec "$NAME" node scripts/backup.js --out /data/backups >"$TMP/bk.log" 2>&1; then pass "backup berhasil"; else fail "backup gagal"; cat "$TMP/bk.log"; fi
ARCH=$(docker exec "$NAME" sh -c 'ls /data/backups | head -1')
ok "arsip terbentuk" "$(echo "$ARCH" | grep -c '^papan-backup-.*\.tar\.gz$')" 1
ok "arsip berizin 0600" "$(docker exec "$NAME" stat -c %a "/data/backups/$ARCH")" 600

# ---------------------------------------------------------------- 6. penutupan anggun
step "6. Penutupan anggun (docker stop)"
T0=$(date +%s%N); docker stop -t 15 "$NAME" >/dev/null; MS=$(( ($(date +%s%N)-T0)/1000000 ))
ok "kode keluar 0" "$(docker inspect --format '{{.State.ExitCode}}' "$NAME")" 0
[ "$MS" -lt 10000 ] && pass "berhenti dalam ${MS} ms (< 10 dtk)" || fail "berhenti terlalu lama: ${MS} ms"
docker logs "$NAME" 2>&1 | grep -q 'berhenti dengan bersih' && pass "log 'berhenti dengan bersih'" || fail "log penutupan bersih tidak ada"
docker rm "$NAME" >/dev/null

# ---------------------------------------------------------------- 7. persistensi
step "7. Persistensi di volume yang sama"
start_container "$NAME-2" -e ADMIN_PASSWORD=ganti-tidak-dipakai
wait_healthy "$NAME-2" 60 && pass "container baru sehat" || { fail "container baru tidak sehat"; docker logs "$NAME-2" 2>&1 | tail; }
ok "pegawai lama masih bisa login" "$(login "$TMP/j2" budi password1)" 200
ok "pengaturan lama masih ada" "$(curl -s "$BASE/api/settings" | grep -c 'Dinas Smoke')" 1
ok "ADMIN_PASSWORD baru diabaikan (admin lama tetap)" "$(login "$TMP/j3" admin "$PASS_ADMIN")" 200
docker logs "$NAME-2" 2>&1 | grep -q 'Admin pertama dibuat' && fail "admin dibuat ulang padahal sudah ada" || pass "admin tidak dibuat ulang"

# ---------------------------------------------------------------- 8. restore di dalam container
step "8. Restore di dalam container"
docker stop -t 15 "$NAME-2" >/dev/null; docker rm "$NAME-2" >/dev/null
docker run --rm -v "$VOLUME:/data" --entrypoint node "$IMAGE" scripts/restore.js "/data/backups/$ARCH" --data /data --yes >"$TMP/rs.log" 2>&1 && pass "restore berhasil" || { fail "restore gagal"; cat "$TMP/rs.log"; }
ok "folder backups tetap di tempatnya" "$(docker run --rm -v "$VOLUME:/data" --entrypoint sh "$IMAGE" -c 'ls /data/backups | wc -l')" 1
ok "data lama disimpan di .bak-*" "$(docker run --rm -v "$VOLUME:/data" --entrypoint sh "$IMAGE" -c 'ls -A /data | grep -c "^\.bak-"')" 1
start_container "$NAME-3"
wait_healthy "$NAME-3" 60 && pass "server sehat setelah restore" || fail "server tidak sehat setelah restore"
ok "pegawai terpulihkan" "$(login "$TMP/j4" budi password1)" 200
docker stop -t 15 "$NAME-3" >/dev/null; docker rm "$NAME-3" >/dev/null

# ---------------------------------------------------------------- 9. compose
step "9. docker compose"
cp deploy/papan-informasi.env.example "$TMP/compose.env"
sed -i "s/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$PASS_ADMIN/" "$TMP/compose.env"
export PAPAN_IMAGE="$IMAGE" PAPAN_PORT="$PORT" PAPAN_ENV_FILE="$TMP/compose.env"
COMPOSE_FILES="-f docker-compose.yml"
CBASE="$BASE"; CHECK_OTHER_IP=0
if [ "$DOCKER_NETWORK" = "host" ]; then
  # Daemon tanpa bridge: jalankan compose dengan jaringan host. Port di dalam container tetap 3000.
  printf 'services:\n  papan:\n    network_mode: host\n    ports: !reset []\n' > "$TMP/override.yml"
  COMPOSE_FILES="-f docker-compose.yml -f $TMP/override.yml"; CBASE="http://127.0.0.1:3000"; CHECK_OTHER_IP=1
fi
export COMPOSE_FILES
dc() { docker compose -p "$PROJECT" --env-file "$TMP/compose.env" $COMPOSE_FILES "$@"; }
UP=(up -d --wait --wait-timeout 120); [ "${COMPOSE_BUILD:-0}" = 1 ] && UP+=(--build) || UP+=(--no-build)
if dc "${UP[@]}" >"$TMP/up.log" 2>&1; then pass "docker compose up --wait (sehat)"; else fail "compose up gagal"; tail -15 "$TMP/up.log"; dc logs 2>&1 | tail -15; fi
ok "healthz lewat compose" "$(code "$CBASE/healthz")" 200
if [ "$CHECK_OTHER_IP" = 1 ]; then
  OTHER=$(hostname -I 2>/dev/null | awk '{print $1}')
  if [ -n "$OTHER" ]; then ok "HOST=127.0.0.1 dari .env diabaikan compose (terjangkau lewat $OTHER)" "$(code --max-time 3 "http://$OTHER:3000/healthz")" 200; else skip "tidak ada alamat non-loopback untuk uji HOST"; fi
else
  pass "terjangkau lewat port yang dipublikasikan walau .env berisi HOST=127.0.0.1 (compose menimpanya)"
fi
ok "login admin lewat compose" "$(code -c "$TMP/jc" -X POST "$CBASE/api/auth/login" -H 'content-type: application/json' -d "{\"username\":\"admin\",\"password\":\"$PASS_ADMIN\"}")" 200
ok "buat pegawai" "$(code -b "$TMP/jc" -X POST "$CBASE/api/admin/users" -H 'content-type: application/json' -d '{"username":"sari","name":"Sari","password":"password2"}')" 201
dc down >/dev/null 2>&1
if dc "${UP[@]}" >"$TMP/up2.log" 2>&1; then pass "compose down lalu up"; else fail "compose up ulang gagal"; fi
ok "data bertahan setelah down/up (volume tidak ikut terhapus)" "$(code -X POST "$CBASE/api/auth/login" -H 'content-type: application/json' -d '{"username":"sari","password":"password2"}')" 200
T0=$(date +%s%N); dc stop -t 15 >/dev/null 2>&1; MS=$(( ($(date +%s%N)-T0)/1000000 ))
[ "$MS" -lt 10000 ] && pass "compose stop dalam ${MS} ms" || fail "compose stop lambat: ${MS} ms"
dc logs 2>&1 | grep -q 'berhenti dengan bersih' && pass "compose: penutupan bersih tercatat" || fail "compose: log penutupan tidak ada"
dc down -v >/dev/null 2>&1

# ---------------------------------------------------------------- 10. bind mount milik root
step "10. Bind mount milik root (platform deploy): entrypoint memperbaiki pemilik lalu menurunkan hak"
mkdir -p "$TMP/bind"; chmod 755 "$TMP/bind"
BIND_OWNER_BEFORE=$(stat -c %u "$TMP/bind")
echo "  info pemilik bind mount sebelum start: uid $BIND_OWNER_BEFORE"
docker run -d --name "$NAME-2" "${RUN_NET[@]}" -v "$TMP/bind:/data" \
  --health-interval 2s --health-start-period 1s --health-retries 15 \
  -e ADMIN_PASSWORD="$PASS_ADMIN" "$IMAGE" >/dev/null
if wait_healthy "$NAME-2" 60; then pass "container sehat di atas bind mount yang bukan milik node"; else fail "container tidak sehat di atas bind mount"; docker logs "$NAME-2" 2>&1 | tail -15; fi
ok "server berjalan sebagai uid 1000 (bukan root)" "$(docker exec "$NAME-2" awk '/^Uid:/{print $2}' /proc/1/status)" 1000
ok "database di bind mount dimiliki uid 1000" "$(docker exec "$NAME-2" stat -c %u /data/papan.db)" 1000
docker logs "$NAME-2" 2>&1 | grep -q 'memperbaiki pemilik' && pass "entrypoint mencatat perbaikan pemilik" || fail "log perbaikan pemilik tidak ada"
ok "login admin di bind mount" "$(login "$TMP/jb" admin "$PASS_ADMIN")" 200
docker stop -t 15 "$NAME-2" >/dev/null
ok "bind mount: kode keluar 0 saat docker stop" "$(docker inspect --format '{{.State.ExitCode}}' "$NAME-2")" 0
docker rm "$NAME-2" >/dev/null
# Start ulang di folder yang sama: tidak perlu chown lagi, data tetap ada.
docker run -d --name "$NAME-2" "${RUN_NET[@]}" -v "$TMP/bind:/data" \
  --health-interval 2s --health-start-period 1s --health-retries 15 \
  -e ADMIN_PASSWORD="$PASS_ADMIN" "$IMAGE" >/dev/null
wait_healthy "$NAME-2" 60 && pass "start ulang di bind mount yang sama sehat" || fail "start ulang gagal"
ok "login admin tetap berlaku setelah start ulang" "$(login "$TMP/jb" admin "$PASS_ADMIN")" 200
N_FIX=$(docker logs "$NAME-2" 2>&1 | grep -c 'memperbaiki pemilik' || true)
[ "$N_FIX" = 0 ] && pass "tidak ada chown ulang pada start kedua" || fail "chown terulang ($N_FIX)"
docker rm -f "$NAME-2" >/dev/null

# ---------------------------------------------------------------- 11. --user pada folder tak bisa ditulis
step "11. --user 1000 pada folder yang tidak bisa ditulis: pesan galat jelas"
mkdir -p "$TMP/ro"; chmod 555 "$TMP/ro"
set +e
RO_OUT=$(docker run --rm --name "$NAME-3" --user 1000:1000 -v "$TMP/ro:/data" -e ADMIN_PASSWORD="$PASS_ADMIN" "$IMAGE" 2>&1); RO_CODE=$?
set -e
ok "keluar dengan kode 1" "$RO_CODE" 1
echo "$RO_OUT" | grep -q 'Tidak dapat memakai direktori data' && pass "pesan galat menjelaskan masalahnya" || fail "pesan galat tidak muncul: $(echo "$RO_OUT" | head -3)"
echo "$RO_OUT" | grep -q 'ERR_SQLITE_ERROR' && fail "tumpukan galat SQLite masih muncul" || pass "tanpa tumpukan galat SQLite"

echo
echo "== Ringkasan: $PASSED lolos, $FAILED gagal, $SKIPPED dilewati"
[ "$FAILED" -eq 0 ]
