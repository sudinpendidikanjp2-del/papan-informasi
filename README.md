# Papan Informasi & Nomor Antrian

Papan informasi digital untuk layar publik, dengan nomor antrian yang dipanggil ke meja layanan.
Dibangun dengan Node.js (tanpa build step), SQLite bawaan Node, dan WebSocket untuk sinkronisasi realtime.

## Menjalankan

Butuh Node.js 22.13 atau lebih baru.

```bash
npm install
ADMIN_TOKEN="ganti-dengan-token-rahasia" npm start
```

Lalu buka `http://localhost:3000`. Bila `ADMIN_TOKEN` tidak diset, server membuat token sementara dan mencetaknya di konsol.

Variabel opsional: `PORT` (default 3000) dan `DATA_DIR` (default `./data`, berisi database dan berkas unggahan).

## Halaman

| Halaman | URL | Pengguna |
|---|---|---|
| Papan informasi | `/` | Layar publik (buka dalam mode kiosk/fullscreen) |
| Kiosk ambil nomor | `/kiosk.html` | Pengunjung (layar sentuh) |
| Panel meja | `/operator.html` | Pegawai per meja: panggil, panggil ulang, layani, selesai, lewati |
| Admin | `/admin.html` | Kelola konten, kategori, meja, pengaturan, laporan |

Halaman panel meja dan admin meminta token saat pertama kali dibuka dan menyimpannya di browser.

## Cara kerja antrian

- Setiap kategori punya prefix (mis. `A`, `B`). Nomor reset setiap hari dan dihitung per kategori.
- Setiap meja dipetakan ke satu kategori.
- **Panggil berikutnya** di sebuah meja mengambil antrian berikut:
  1. antrian yang ditujukan khusus ke meja itu (lebih dulu), lalu
  2. antrian kategori yang sama, urut prioritas dan waktu ambil.
- Meja yang sedang melayani satu antrian tidak bisa memanggil yang lain sebelum antrian itu **Selesai** atau **Lewati**.
- Saat ada panggilan, layar membunyikan bel dan mengumumkan nomor serta meja dengan suara Bahasa Indonesia (bisa dimatikan di pengaturan).

## Konten & screensaver

- Jenis konten: **teks**, **gambar**, **video**, **PDF**. Setiap item tampil selama durasi yang diatur, lalu berganti otomatis. Countdown tampil di pojok layar.
- Untuk video, durasi 0 berarti tayang sampai video selesai.
- Screensaver berjalan saat tidak ada aktivitas antrian selama *idle* yang diatur (menit). Screensaver memakai item yang ditandai "screensaver" (gambar atau video).

## Struktur

```
server/
  index.js     HTTP API, unggah berkas, file statis, WebSocket
  service.js   logika antrian, konten, kategori, meja, pengaturan
  db.js        skema SQLite dan data awal
public/
  display.html, kiosk.html, operator.html, admin.html
  css/app.css  tema biru-kuning (token warna di :root)
  js/common.js utilitas API, WebSocket, waktu server, suara
```

## Batasan saat ini

- Belum ada login per pegawai. Akses panel meja memakai satu token bersama.
- Belum ada transcoding video. Gunakan format MP4 (H.264) agar kompatibel.
- PDF ditampilkan sebagai dokumen utuh di dalam durasi tayang, bukan per halaman.
- Belum ada HTTPS bawaan. Jalankan di belakang reverse proxy bila diakses dari jaringan lain.
- Belum ada fitur pindah antrian ke meja lain dan antrian prioritas di kiosk.
