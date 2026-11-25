# Panduan Penerapan

Panduan memasang Papan Informasi di server dan layar sungguhan. Semua berkas contoh ada di folder [`deploy/`](../deploy). Fitur dan konfigurasi aplikasi dijelaskan di [README](../README.md).

> **Yang sudah dan belum diuji.** Unit systemd, skrip backup/restore, skrip layar kiosk (dengan peramban tiruan), `Dockerfile`, dan `docker-compose.yml` sudah diuji (skrip uji asap Docker, lokal dan di CI). **Belum diuji**: contoh Caddy dan nginx, bunyi di perangkat kiosk sungguhan, dan pengiriman notifikasi push ke layanan push sungguhan. Uji bagian-bagian itu di lingkungan Anda sebelum dipakai untuk layanan publik.

## Isi

1. [Kebutuhan](#1-kebutuhan)
2. [Pasang dengan systemd (disarankan)](#2-pasang-dengan-systemd-disarankan)
3. [Alternatif: Docker Compose](#3-alternatif-docker-compose)
4. [HTTPS](#4-https)
5. [Memasang layar kiosk](#5-memasang-layar-kiosk)
6. [Backup dan pemulihan](#6-backup-dan-pemulihan)
7. [Pembaruan versi](#7-pembaruan-versi)
8. [Pemantauan](#8-pemantauan)
9. [Daftar periksa keamanan](#9-daftar-periksa-keamanan)
10. [Pemecahan masalah](#10-pemecahan-masalah)

## 1. Kebutuhan

| Komponen | Keterangan |
|---|---|
| Server | Linux (diuji di Ubuntu). RAM 1 GB cukup untuk beberapa layar; tambah disk bila banyak video. |
| Node.js | **22.13 atau lebih baru** (memakai `node:sqlite` bawaan). Paket `nodejs` bawaan banyak distribusi masih versi lama; pasang dari [nodejs.org](https://nodejs.org/en/download) atau repositori NodeSource, lalu periksa dengan `node -v`. |
| ffmpeg | Opsional. Tanpa ffmpeg video disimpan apa adanya dan dasbor menampilkan peringatan. `sudo apt install ffmpeg` |
| tar | Untuk backup dan restore (hampir selalu sudah ada). |
| Jaringan | Server dan layar dalam jaringan yang sama. Untuk notifikasi push ke ponsel, server juga harus bisa mengakses internet dan situs dibuka lewat HTTPS. |
| Layar kiosk | Mini PC atau Raspberry Pi 3 ke atas dengan OS 64-bit dan Chromium. |

## 2. Pasang dengan systemd (disarankan)

Contoh untuk Ubuntu atau Debian, dijalankan sebagai pengguna dengan `sudo`.

```bash
# 1. Pengguna khusus tanpa login, lalu ambil kode
sudo useradd --system --home /opt/papan-informasi --shell /usr/sbin/nologin papan
sudo git clone https://github.com/sudinpendidikanjp2-del/papan-informasi /opt/papan-informasi
sudo chown -R papan:papan /opt/papan-informasi

# 2. Pasang dependensi (juga menyalin pdf.js ke public/vendor lewat skrip postinstall)
cd /opt/papan-informasi
sudo -u papan npm ci --omit=dev

# 3. Konfigurasi. Edit berkasnya: ganti ADMIN_PASSWORD dengan password kuat.
sudo install -m 0640 -o root -g papan deploy/papan-informasi.env.example /etc/papan-informasi.env
sudoedit /etc/papan-informasi.env

# 4. Pasang layanan. Bila "which node" bukan /usr/bin/node, ubah ExecStart di berkas service lebih dulu.
sudo cp deploy/papan-informasi.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now papan-informasi

# 5. Periksa
systemctl status papan-informasi --no-pager
curl -s http://127.0.0.1:3000/healthz
```

Hasil yang benar: `{"ok":true,...}`. Data tersimpan di `/var/lib/papan-informasi` (dibuat otomatis, hanya bisa diakses pengguna `papan`).

Pada start pertama, admin dibuat dari `ADMIN_USERNAME` dan `ADMIN_PASSWORD`. Setelah masuk lewat halaman admin, ganti password di halaman Pegawai lalu **hapus baris `ADMIN_PASSWORD`** dari `/etc/papan-informasi.env` (nilainya tidak dipakai lagi).

Konfigurasi bawaan membuat server hanya mendengarkan `127.0.0.1` (`HOST=127.0.0.1`) dan mempercayai header reverse proxy (`TRUST_PROXY=1`). Jadi **harus** ada reverse proxy atau HTTPS langsung; lihat bagian 4. Untuk mencoba cepat tanpa proxy, hapus baris `HOST` dan `TRUST_PROXY` lalu `sudo systemctl restart papan-informasi`.

Perintah yang sering dipakai:

```bash
sudo systemctl restart papan-informasi     # mulai ulang (menutup dengan bersih, maks. 10 detik)
journalctl -u papan-informasi -f           # log langsung
journalctl -u papan-informasi | grep AUDIT # log audit: login, pegawai, pengaturan
```

## 3. Alternatif: Docker Compose

> Build `Dockerfile` dan siklus hidup container (jalan, sehat, berhenti bersih, data bertahan, backup dan restore, compose) diuji otomatis oleh `test/docker-smoke.sh`, juga di CI.

```bash
git clone https://github.com/sudinpendidikanjp2-del/papan-informasi && cd papan-informasi
cp deploy/papan-informasi.env.example .env
nano .env                         # ganti ADMIN_PASSWORD
docker compose up -d --build
```

Atau pakai image siap pakai dari GHCR (lihat bagian Rilis di README): `PAPAN_IMAGE=ghcr.io/<pemilik>/papan-informasi:<versi> docker compose up -d`.

```bash
docker compose ps                 # kolom STATUS harus "healthy" setelah sekitar 15 detik
```

- Data ada di volume Docker `papan-data` (`/data` di dalam container). `HOST` dan `DATA_DIR` di `.env` diabaikan karena compose menimpanya.
- Port dipublikasikan hanya ke `127.0.0.1:3000`. Pasang reverse proxy (bagian 4) di mesin yang sama, atau ubah `ports` menjadi `"3000:3000"` untuk membukanya ke jaringan (tanpa HTTPS).
- Backup di Docker: `docker compose exec papan node scripts/backup.js --out /data/backups` (arsip ikut berada di volume; salin keluar secara berkala), atau jalankan skrip backup dari host terhadap folder volume.
- Restore menolak berjalan bila server hidup, tetapi tidak bisa melihat proses di dalam container. Hentikan dulu (`docker compose stop papan`) lalu jalankan restore dengan `--force`.

## 4. HTTPS

Notifikasi push dan layanan pantau yang aman membutuhkan HTTPS. Pilih salah satu:

**A. Reverse proxy dengan domain (disarankan).** Contoh [`deploy/Caddyfile`](../deploy/Caddyfile) (sertifikat otomatis) dan [`deploy/nginx.conf`](../deploy/nginx.conf). Syaratnya: nama domain yang mengarah ke server dan port 80/443 terbuka. Pastikan `HOST=127.0.0.1` dan `TRUST_PROXY=1`, dan proxy meneruskan WebSocket serta mengizinkan unggahan sampai 300 MB. Pada nginx, `X-Forwarded-For` harus **ditimpa** (`$remote_addr`), bukan ditambah, supaya klien tidak bisa memalsukan alamatnya.

**B. HTTPS langsung dari aplikasi.** Isi `TLS_CERT` dan `TLS_KEY` di `/etc/papan-informasi.env` (dan hapus `HOST` serta `TRUST_PROXY`). Berkas sertifikat harus bisa dibaca pengguna `papan`. Port di bawah 1024 tidak bisa dipakai tanpa hak khusus, jadi tetap di `PORT=3000` dan arahkan 443 ke sana di firewall bila perlu.

**C. Jaringan lokal tanpa domain.** Sertifikat self-signed membuat browser meminta konfirmasi di setiap perangkat, dan layanan push di ponsel pengunjung umumnya **tidak berjalan** dengan sertifikat yang tidak dipercaya. Pilihannya: pakai CA internal yang sertifikatnya dipasang di perangkat, atau terima bahwa lewat HTTP peringatan di halaman pantau (suara dan getar) tetap bekerja tetapi push tidak.

Setelah HTTPS aktif, isi **Alamat dasar untuk kode QR** di Pengaturan dengan alamat yang dipakai pengunjung (mis. `https://antrian.instansi.go.id`), supaya QR di kiosk mengarah ke alamat yang benar.

## 5. Memasang layar kiosk

Satu perangkat per layar. Langkah untuk Raspberry Pi OS atau Ubuntu desktop:

1. Pasang Chromium: `sudo apt install chromium` (di sebagian distribusi namanya `chromium-browser`).
2. Salin repo atau cukup skrip `deploy/kiosk-display.sh` ke perangkat, lalu `chmod +x`.
3. Daftarkan layar di halaman **Layar** admin (mis. slug `lobi`), lalu uji manual:
   ```bash
   deploy/kiosk-display.sh "https://antrian.instansi.go.id/?screen=lobi&sound=on"
   ```
4. Mulai otomatis: aktifkan login otomatis desktop (Raspberry Pi: `sudo raspi-config` > System Options > Auto Login), lalu
   ```bash
   mkdir -p ~/.config/autostart
   cp deploy/papan-kiosk.desktop ~/.config/autostart/   # edit alamat dan jalur skrip di dalamnya
   ```

Skrip membuka kembali browser bila tertutup, menonaktifkan penghemat layar (X11), menyembunyikan kursor (bila `unclutter` terpasang), dan membersihkan pesan "Chrome tidak ditutup dengan benar" setelah listrik padam. Untuk sertifikat self-signed di jaringan tepercaya, jalankan dengan `KIOSK_INSECURE=1`.

**Suara.** Browser menahan audio sampai ada interaksi pengguna. Parameter `sound=on` pada alamat menyembunyikan overlay "Aktifkan" dan skrip kiosk menjalankan Chromium dengan `--autoplay-policy=no-user-gesture-required` agar bel dan suara panggilan langsung berbunyi. **Bagian ini belum teruji di perangkat nyata** (peramban headless di lingkungan pengembangan tidak menegakkan kebijakan autoplay). Bila bel atau suara tidak keluar, hapus `&sound=on` dari alamat, mulai ulang, dan ketuk tombol **Aktifkan** sekali. Suara pembacaan nomor (TTS) juga bergantung pada adanya suara bahasa Indonesia di perangkat; bunyi bel tidak.

Layar sentuh kiosk pengambilan nomor memakai alamat `https://.../kiosk.html` dengan cara yang sama (tanpa `sound=on`).

## 6. Backup dan pemulihan

**Backup terjadwal harian** (pukul 02:30, simpan 14 arsip terbaru):

```bash
sudo cp deploy/papan-backup.service deploy/papan-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now papan-backup.timer
sudo systemctl start papan-backup.service        # jalankan sekarang untuk mencoba
sudo ls -l /var/lib/papan-informasi-backups      # arsip: papan-backup-<tanggal>-<jam>.tar.gz
```

> **Salin arsip ke luar mesin ini** secara berkala (disk lain, NAS, atau penyimpanan cloud), mis. dengan `rsync` atau `rclone` dari server lain. Backup di mesin yang sama tidak melindungi dari kerusakan disk. Arsip berisi hash password pegawai dan kunci VAPID; batasi aksesnya.

**Pulihkan** (server harus berhenti):

```bash
sudo systemctl stop papan-informasi
sudo -u papan env DATA_DIR=/var/lib/papan-informasi node /opt/papan-informasi/scripts/restore.js \
     /var/lib/papan-informasi-backups/papan-backup-XXXX.tar.gz              # pratinjau
sudo -u papan env DATA_DIR=/var/lib/papan-informasi node /opt/papan-informasi/scripts/restore.js \
     /var/lib/papan-informasi-backups/papan-backup-XXXX.tar.gz --yes        # jalankan
sudo systemctl start papan-informasi
```

Data lama tidak dihapus: dipindahkan ke `/var/lib/papan-informasi/.bak-<waktu>`; hapus setelah yakin pemulihan benar. **Uji pemulihan secara berkala** ke direktori lain (`--data /tmp/uji`) agar Anda tahu backup benar-benar bisa dipakai.

## 7. Pembaruan versi

```bash
sudo systemctl start papan-backup.service         # 1. backup dulu
cd /opt/papan-informasi
sudo -u papan git pull                            # 2. ambil versi baru
sudo -u papan npm ci --omit=dev                   # 3. dependensi (dan pdf.js)
sudo systemctl restart papan-informasi            # 4. mulai ulang
curl -s http://127.0.0.1:3000/healthz             # 5. periksa
```

Migrasi database berjalan otomatis saat start dan hanya **menambah** tabel dan kolom. Karena itu kode lama biasanya masih bisa membuka database yang sudah dimigrasi, tetapi fitur yang butuh kolom baru tidak akan jalan. Untuk kembali ke versi sebelumnya dengan bersih: `git checkout <commit lama>`, `npm ci --omit=dev`, pulihkan backup yang diambil sebelum pembaruan, lalu mulai ulang.

## 8. Pemantauan

- **Hidup atau tidak**: `GET /healthz` (200 atau 503). Pantau dari alat yang Anda pakai (Uptime Kuma, Zabbix, dan sejenisnya), atau dari proxy (Caddy memeriksanya otomatis pada contoh).
- **Log**: `journalctl -u papan-informasi`. Baris berawalan `AUDIT` berisi satu JSON per kejadian (login berhasil, gagal, terkunci; pegawai dibuat, diubah, dihapus; pengaturan diubah) tanpa password atau token. Pantau lonjakan `login_failed` dan `login_locked`.
- **Disk**: unggahan video dan arsip backup bertambah terus. Periksa `df -h /var/lib` secara berkala; retensi backup default 14 arsip.
- **Layar**: papan menampilkan pita merah bila koneksi ke server terputus, dan menyambung kembali sendiri.

## 9. Daftar periksa keamanan

- [ ] Password admin awal sudah diganti dan baris `ADMIN_PASSWORD` dihapus dari `/etc/papan-informasi.env`.
- [ ] `/etc/papan-informasi.env` hanya bisa dibaca root dan pengguna `papan` (`ls -l` menunjukkan `-rw-r-----`).
- [ ] Server dijangkau lewat HTTPS; `HOST=127.0.0.1` dan `TRUST_PROXY=1` bila ada proxy; port 3000 **tidak** terbuka ke jaringan.
- [ ] Firewall hanya membuka yang perlu, mis. `sudo ufw allow 443/tcp` dan `sudo ufw allow 80/tcp` (untuk pengalihan dan penerbitan sertifikat), `sudo ufw allow OpenSSH`, lalu `sudo ufw enable`.
- [ ] Setiap pegawai punya akun sendiri dengan meja yang diizinkan seperlunya; akun yang tidak dipakai dinonaktifkan.
- [ ] Tombol prioritas di kiosk tetap mati kecuali ada petugas yang mengawasi.
- [ ] Backup berjalan, tersalin ke luar mesin, dan pemulihannya sudah pernah diuji.
- [ ] Sistem operasi, Node.js, dan dependensi diperbarui secara berkala (`npm audit --omit=dev` di folder aplikasi).

## 10. Pemecahan masalah

| Gejala | Penyebab umum dan tindakan |
|---|---|
| Layanan gagal start | `journalctl -u papan-informasi -n 50`. Periksa jalur Node di `ExecStart` (`which node`), `ADMIN_PASSWORD` minimal 8 karakter pada start pertama, dan `Error: listen EADDRINUSE` (port sudah dipakai: ubah `PORT`). |
| 502 dari proxy | Aplikasi tidak jalan, atau `PORT`/`HOST` tidak cocok dengan alamat di konfigurasi proxy. Coba `curl http://127.0.0.1:3000/healthz` di server. |
| Layar menampilkan pita merah "koneksi terputus" | Server mati atau jaringan putus. Bila server sehat, periksa proxy: harus meneruskan WebSocket (`/ws`) dan memberi `proxy_read_timeout` yang cukup (contoh nginx sudah benar). |
| Tidak ada bel atau suara di papan | Overlay "Aktifkan" belum diketuk, atau (di kiosk) alamat tanpa `sound=on` / peramban tanpa flag autoplay. Lihat bagian 5. Bunyi bel berbeda dari suara TTS; TTS butuh suara bahasa Indonesia di perangkat. |
| QR di kiosk tidak bisa dibuka dari ponsel | Alamat dasar mengarah ke `localhost` atau alamat internal. Isi **Alamat dasar untuk kode QR** di Pengaturan (admin menampilkan peringatan). |
| Notifikasi push tidak datang | Situs tidak lewat HTTPS tepercaya, server tidak bisa mengakses internet, atau pengunjung menolak izin notifikasi. Peringatan suara dan getar di halaman pantau tetap bekerja selama halaman terbuka. |
| Login ditolak "Terlalu banyak percobaan" | Penguncian 5 menit (bertahan walau server dimulai ulang). Tunggu, atau bersihkan: `sudo -u papan node --input-type=module -e "import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync('/var/lib/papan-informasi/papan.db'); d.exec('PRAGMA busy_timeout = 5000'); console.log(d.prepare('DELETE FROM login_attempts').run().changes)"` |
| Semua pegawai terkunci bersamaan | Server di belakang proxy tetapi `TRUST_PROXY=1` belum diset, sehingga semua klien tampak berasal dari alamat proxy. Set `TRUST_PROXY=1` (hanya bila server tidak bisa dijangkau langsung). |
| Unggahan gagal dengan 413 atau terputus | Batas proxy lebih kecil dari 300 MB (`client_max_body_size` pada nginx). |
| Video tidak terputar di layar | ffmpeg tidak terpasang (video tidak dikonversi). Pasang ffmpeg lalu unggah ulang videonya. |
| Jam di papan salah | Zona waktu di Pengaturan, dan jam server (aktifkan NTP: `timedatectl set-ntp true`). Papan memakai jam server, bukan jam perangkat layar. |
| Disk penuh | Hapus konten lama (berkas unggahan ikut terhapus), kurangi retensi backup, atau pindahkan folder backup ke disk lain. |
