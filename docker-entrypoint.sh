#!/bin/sh
# Entrypoint image: bila dimulai sebagai root, perbaiki pemilik direktori data (bind mount atau volume buatan
# platform sering dimiliki root) lalu turunkan hak ke pengguna "node" sebelum menjalankan server.
# Bila sudah dimulai non-root (docker run --user ...), langsung jalankan perintahnya.
set -e
DATA="${DATA_DIR:-/data}"
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$DATA"
  NODE_UID="$(id -u node)"
  NEED_FIX=0
  [ "$(stat -c %u "$DATA")" != "$NODE_UID" ] && NEED_FIX=1
  [ -e "$DATA/papan.db" ] && [ "$(stat -c %u "$DATA/papan.db")" != "$NODE_UID" ] && NEED_FIX=1
  if [ "$NEED_FIX" = 1 ]; then
    echo "[entrypoint] memperbaiki pemilik $DATA agar dapat ditulis pengguna node (uid $NODE_UID)" >&2
    chown -R node:node "$DATA" || echo "[entrypoint] peringatan: chown $DATA gagal (mis. NFS root squash); server mungkin tidak bisa menulis" >&2
  fi
  export HOME=/home/node
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
