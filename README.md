# Papan Informasi & Nomor Antrian

Papan informasi digital untuk beberapa layar publik (landscape), dengan nomor antrian yang dipanggil ke meja layanan.
Dibangun dengan Node.js (tanpa build step), SQLite bawaan Node, dan WebSocket untuk sinkronisasi realtime.

## Menjalankan

Butuh Node.js 22.13 atau lebih baru.

```bash
npm install
ADMIN_USERNAME="admin" ADMIN_PASSWORD="ganti-dengan-password-kuat" npm start
```

Lalu buka `http://localhost:3000/admin.html` dan masuk dengan akun tersebut.

- Admin pertama dibuat **hanya saat belum ada pengguna sama sekali**. Mengubah `ADMIN_PASSWORD` setelahnya tidak berpengaruh; ganti password lewat tab Pegawai.
- Jika `ADMIN_PASSWORD` tidak diset, server membuat password acak dan mencetaknya satu kali di konsol. Password minimal 8 karakter.
- Variabel opsional: `PORT` (default 3000) dan `DATA_DIR` (default `./data`, berisi database dan berkas unggahan).

## Halaman

| Halaman | URL | Pengguna |
|---|---|---|
| Papan informasi | `/?screen=<slug>` | Layar publik (buka dalam mode kiosk/layar penuh) |
| Kiosk ambil nomor | `/kiosk.html` | Pengunjung (layar sentuh) |
| Panel meja | `/operator.html` | Pegawai: login, pilih meja, lalu panggil, panggil ulang, layani, selesai, lewati |
| Admin | `/admin.html` | Admin: konten, layar, kategori, meja, pegawai, pengaturan, laporan |

## Banyak layar

Setiap layar didaftarkan di tab **Layar** dengan nama dan *slug* (mis. `lobi`), lalu dibuka di perangkatnya lewat `/?screen=lobi`.

- **Kategori**: layar hanya menampilkan antrian, meja, dan panggilan untuk kategori yang dipilih. Kosong berarti semua kategori.
- **Konten**: tiap item konten bisa ditujukan ke layar tertentu. Item tanpa tujuan menjadi konten bersama yang tampil di semua layar.
- **Screensaver**: waktu idle bisa diatur per layar. Idle dihitung dari aktivitas antrian pada kategori layar itu saja.
- Alamat `/` tanpa parameter menampilkan semua antrian dan **hanya** konten bersama.
- Slug yang belum didaftarkan tetap menampilkan konten bersama, disertai peringatan di layar.

## Login pegawai

- Admin membuat akun di tab **Pegawai** (username, password, peran) dan mencentang meja yang boleh dipakai pegawai itu.
- Pegawai login di `/operator.html`, memilih satu meja dari daftar yang diizinkan, lalu bekerja di meja itu. Satu meja hanya bisa dipegang satu pegawai pada satu waktu.
- Pegawai tidak bisa keluar atau berpindah meja selama masih memegang antrian yang dipanggil atau sedang dilayani.
- Antrian mencatat pegawai yang melayani, dan laporan harian menampilkan jumlah per pegawai.
- Peran `admin` boleh membuka panel meja mana pun.

Keamanan: password disimpan sebagai hash scrypt; sesi memakai cookie `HttpOnly` + `SameSite=Lax` selama 12 jam; 5 kali gagal login dalam satu username dan alamat IP mengunci percobaan selama 5 menit. Sesi dicabut saat akun dinonaktifkan atau password diganti. Sistem selalu menyisakan minimal satu admin aktif.

## Cara kerja antrian

- Setiap kategori punya prefix (mis. `A`, `B`). Nomor reset setiap hari dan dihitung per kategori.
- Setiap meja dipetakan ke satu kategori.
- **Panggil berikutnya** di sebuah meja mengambil antrian berikut:
  1. antrian yang ditujukan khusus ke meja itu (lebih dulu), lalu
  2. antrian kategori yang sama, urut prioritas dan waktu ambil.
- Meja yang sedang melayani satu antrian tidak bisa memanggil yang lain sebelum antrian itu **Selesai** atau **Lewati**.
- Saat ada panggilan, layar yang menampilkan kategori itu membunyikan bel dan mengumumkan nomor serta meja dengan suara Bahasa Indonesia (bisa dimatikan di pengaturan).

## Konten & screensaver

- Jenis konten: **teks**, **gambar**, **video**, **PDF**. Setiap item tampil selama durasi yang diatur, lalu berganti otomatis. Countdown tampil di pojok layar.
- Untuk video, durasi 0 berarti tayang sampai video selesai.
- Screensaver berjalan saat tidak ada aktivitas antrian selama waktu *idle* yang diatur. Screensaver memakai item yang ditandai "screensaver" (gambar atau video).

## Struktur

```
server/
  index.js     HTTP API, unggah berkas, file statis, WebSocket
  service.js   logika antrian, konten, layar, kategori, meja, pengaturan
  auth.js      login, sesi, pembatas percobaan, manajemen pegawai
  db.js        skema SQLite, migrasi ringan, dan data awal
public/
  display.html, kiosk.html, operator.html, admin.html
  css/app.css  tema biru-kuning (token warna di :root)
  js/common.js utilitas API, WebSocket, waktu server, suara
  js/display.js logika papan informasi
```

## Batasan saat ini

- Belum ada transcoding video. Gunakan format MP4 (H.264) agar kompatibel.
- PDF ditampilkan sebagai dokumen utuh selama durasi tayang, bukan per halaman.
- Belum ada HTTPS bawaan. Jalankan di belakang reverse proxy (yang meneruskan `X-Forwarded-Proto`) bila diakses lewat jaringan lain; cookie otomatis ditandai `Secure` di belakang HTTPS.
- Pembatas login disimpan di memori, jadi reset saat server dimulai ulang. Di belakang proxy, alamat IP yang dilihat server adalah alamat proxy.
- Panel meja belum punya tombol ambil nomor oleh operator, pindah antrian ke meja lain, atau antrian prioritas di kiosk.
- Suara bel dan TTS butuh satu kali ketukan "Aktifkan" di layar setelah halaman dibuka (aturan autoplay browser).
