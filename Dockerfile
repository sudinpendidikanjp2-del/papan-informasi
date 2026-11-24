# Image Papan Informasi. CATATAN: berkas ini belum dibangun atau diuji di lingkungan pengembangan
# (daemon Docker tidak tersedia di sana). Uji dengan "docker compose up --build" sebelum dipakai.
FROM node:22-slim

# Paket sistem: ffmpeg untuk konversi video, tar untuk skrip backup/restore, ca-certificates agar server
# bisa memverifikasi TLS saat mengirim notifikasi push. Dapat diubah, mis. tanpa ffmpeg (image lebih kecil,
# video disimpan apa adanya): docker build --build-arg APT_PACKAGES="tar ca-certificates" .
# Nilai kosong melewati apt sepenuhnya (untuk lingkungan build tanpa akses ke repositori Debian).
ARG APT_PACKAGES="ffmpeg tar ca-certificates"
RUN if [ -n "$APT_PACKAGES" ]; then \
      apt-get update \
      && apt-get install -y --no-install-recommends $APT_PACKAGES \
      && rm -rf /var/lib/apt/lists/*; \
    fi

WORKDIR /app

# Skrip postinstall (menyalin pdf.js ke public/vendor) harus ada sebelum npm ci berjalan.
COPY package.json package-lock.json ./
COPY scripts ./scripts
RUN npm ci --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

# Direktori data dibuat dan dimiliki pengguna "node" sebelum dideklarasikan sebagai volume,
# supaya volume bernama baru bisa ditulis tanpa root.
RUN mkdir -p /data && chown -R node:node /data /app/public/vendor
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
VOLUME ["/data"]
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
