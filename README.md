# Papan Informasi & Nomor Antrian

Papan informasi digital untuk beberapa layar publik (landscape), dengan nomor antrian yang dipanggil ke meja layanan.
Dibangun dengan Node.js (tanpa build step), SQLite bawaan Node, dan WebSocket untuk sinkronisasi realtime.

## Menjalankan

Butuh Node.js 22.13 atau lebih baru. `ffmpeg` bersifat opsional (untuk mengonversi video).

```bash
npm install
ADMIN_USERNAME="admin" ADMIN_PASSWORD="ganti-dengan-password-kuat" npm start
```

Lalu buka `http://localhost:3000/admin.html` dan masuk dengan akun tersebut.

- `npm install` juga menyalin pustaka pdf.js ke `public/vendor/pdfjs` (skrip `postinstall`). Folder itu diabaikan git, jadi jalankan `npm install` di setiap salinan baru.
- Admin pertama dibuat **hanya saat belum ada pengguna sama sekali**. Mengubah `ADMIN_PASSWORD` setelahnya tidak berpengaruh; ganti password lewat halaman Pegawai.
- Jika `ADMIN_PASSWORD` tidak diset, server membuat password acak dan mencetaknya satu kali di konsol. Password minimal 8 karakter.

### Variabel lingkungan

| Variabel | Keterangan |
|---|---|
| `PORT` | Port server (default 3000) |
| `DATA_DIR` | Lokasi database dan berkas unggahan (default `./data`) |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Akun admin pertama |
| `TLS_CERT`, `TLS_KEY` | Path sertifikat dan kunci privat PEM; keduanya harus diisi untuk mengaktifkan HTTPS |
| `TRUST_PROXY` | `1` bila di belakang reverse proxy tepercaya (lihat bagian HTTPS) |
| `VAPID_SUBJECT` | Subjek VAPID untuk notifikasi push (`mailto:` atau `https:`), opsional |

## Halaman

| Halaman | URL | Pengguna |
|---|---|---|
| Papan informasi | `/?screen=<slug>` | Layar publik (buka dalam mode kiosk/layar penuh) |
| Kiosk ambil nomor | `/kiosk.html` | Pengunjung (layar sentuh) |
| Pantau antrian | `/t.html?k=<token>` | Pengunjung, lewat QR di slip nomor |
| Panel meja | `/operator.html` | Pegawai: login, pilih meja, panggil, pindahkan, buat nomor, riwayat |
| Admin | `/admin.html` | Admin: dasbor, konten, layar, kategori, meja, pegawai, laporan, pengaturan |

Desain mengikuti satu sistem (`public/css/app.css`): biru dominan, kartu putih berborder tipis, kuning hanya sebagai sorotan kecil.
Papan dirancang landscape dan skalanya mengikuti lebar layar (diperiksa di 1366×768 sampai 4K). Panel meja dan admin responsif sampai layar ponsel.

## Banyak layar

Setiap layar didaftarkan di halaman **Layar** dengan nama dan *slug* (mis. `lobi`), lalu dibuka di perangkatnya lewat `/?screen=lobi`.

- **Kategori**: layar hanya menampilkan antrian, meja, dan panggilan untuk kategori yang dipilih. Kosong berarti semua kategori.
- **Konten**: tiap item konten bisa ditujukan ke layar tertentu. Item tanpa tujuan menjadi konten bersama yang tampil di semua layar.
- **Screensaver**: waktu idle bisa diatur per layar. Idle dihitung dari aktivitas antrian pada kategori layar itu saja.
- Alamat `/` tanpa parameter menampilkan semua antrian dan **hanya** konten bersama.
- Slug yang belum didaftarkan tetap menampilkan konten bersama, disertai peringatan di layar.

## Login pegawai

- Admin membuat akun di halaman **Pegawai** (username, password, peran) dan mencentang meja yang boleh dipakai pegawai itu.
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
  2. antrian kategori yang sama, diurutkan prioritas lalu waktu ambil.
- Meja yang sedang melayani satu antrian tidak bisa memanggil yang lain sebelum antrian itu **Selesai** atau **Lewati**.
- Saat ada panggilan, layar yang menampilkan kategori itu membunyikan bel dan mengumumkan nomor serta meja dengan suara Bahasa Indonesia (bisa dimatikan di pengaturan).

### Membuat nomor

- **Kiosk**: pengunjung memilih layanan. Slip nomor menampilkan jumlah orang di depan dan perkiraan waktu tunggu (rata-rata lama layanan hari ini ÷ jumlah meja kategori itu; tidak tampil bila belum ada data).
- **Operator**: tab **Buat nomor** di panel meja, dengan opsi *Prioritas* dan *Khusus meja ini* (hanya meja itu yang bisa memanggilnya).

### Prioritas

Nomor prioritas (lansia, ibu hamil, penyandang disabilitas) dilayani lebih dulu di dalam kategorinya dan ditandai bintang di papan, panel meja, dan slip. Tombol prioritas di kiosk **mati secara bawaan** karena kiosk publik bisa disalahgunakan; aktifkan di Pengaturan bila ada petugas yang mengawasi. Operator selalu bisa membuat nomor prioritas dari panel meja.

### Pindah antrian

Saat memegang sebuah nomor, pegawai dapat memindahkannya dengan dua cara (kartu *Pindahkan antrian* di panel meja):

- **Ke meja lain**: nomor tetap sama dan kembali menunggu khusus untuk meja tujuan, yang memanggilnya lebih dulu.
- **Ke kategori lain**: tiket menunggu di antrian kategori tujuan (tidak khusus satu meja) dan dipanggil oleh meja mana pun di kategori itu. Karena nomor unik per kategori per hari, tiket mendapat **nomor baru** di kategori tujuan (mis. `A-001` menjadi `B-004`). Token dan halaman pantau pengunjung tetap sama, jadi ponsel pengunjung langsung menampilkan nomor barunya beserta banner penjelasan, bergetar, dan (bila berlangganan push) menerima notifikasi "nomor dipindahkan". Waktu ambil awal dipertahankan, sehingga tiket dilayani sesuai waktu kedatangan dan tidak antre ulang dari belakang. Opsi *Dahulukan* memberinya prioritas di kategori tujuan.
- Memilih **kategori yang sama** berarti mengembalikan tiket ke antrian kategorinya: nomor tetap, tidak lagi khusus satu meja, dan tidak ada push.

Riwayat dan hitungan pegawai asal tidak memuat tiket yang dipindahkan. Di laporan per kategori, tiket dihitung pada kategori tempat ia berakhir.

## Konten & screensaver

- Jenis konten: **teks**, **gambar**, **video**, **PDF**. Setiap item tampil selama durasi yang diatur, lalu berganti otomatis. Pil hitung mundur tampil di pojok, dan penanda progres bersegmen di bawahnya menunjukkan posisi dalam playlist.
- **Video**: durasi 0 berarti tayang sampai video selesai. Bila `ffmpeg` tersedia, video yang diunggah dikonversi ke MP4 H.264/AAC (tinggi maks 1080, `faststart`) agar terputar di browser layar mana pun. Konversi berjalan satu per satu di latar belakang; tombol Simpan aktif setelah selesai. Tanpa `ffmpeg`, video disimpan apa adanya dan dasbor menampilkan peringatan.
- **PDF**: tampil per halaman (pdf.js). Durasi berarti **detik per halaman**. Bila pdf.js gagal dimuat, dokumen tampil lewat penampil bawaan browser selama satu kali durasi.
- Screensaver berjalan saat tidak ada aktivitas antrian selama waktu *idle* yang diatur. Screensaver memakai item yang ditandai "screensaver" (gambar atau video).
- Berkas unggahan yang tidak lagi dipakai dihapus otomatis (saat konten dihapus atau diganti, dan penyapuan tiap jam untuk berkas yatim yang berumur lebih dari satu jam).
- Admin dapat memilih beberapa konten sekaligus untuk diaktifkan, dinonaktifkan, atau dihapus lewat bar aksi massal.

## Notifikasi pengunjung

Slip kiosk memuat kode QR ke halaman pantau (`/t.html?k=<token>`) di ponsel pengunjung. Tidak perlu aplikasi, akun, atau nomor telepon.

- **Halaman pantau**: nomor, orang di depan, perkiraan tunggu, dan status (menunggu, giliran Anda, dilayani, selesai, dilewati). Diperbarui langsung lewat WebSocket tanpa muat ulang.
- **Peringatan di halaman** (selalu tersedia): setelah pengunjung mengetuk *Aktifkan peringatan*, ponsel berbunyi dan bergetar saat sisa antrian di depan mencapai batas "hampir giliran" (default 3, bisa diatur) dan saat dipanggil, termasuk saat dipanggil ulang. Judul tab berkedip saat giliran tiba. Peringatan ini hanya bekerja selama halaman masih terbuka, dan ponsel tidak boleh dalam mode senyap.
- **Notifikasi push** (opsional): tetap datang walau halaman ditutup. Syaratnya, pengunjung membuka situs lewat **HTTPS**, dan **server dapat menjangkau layanan push** browser (FCM, Mozilla, Apple, atau Windows) lewat internet. Di jaringan lokal tanpa HTTPS atau tanpa akses keluar, halaman pantau dan peringatan di halaman tetap berfungsi, dan halaman menjelaskan keadaannya kepada pengunjung.
- **Alamat QR**: di Pengaturan, isi *Alamat dasar untuk kode QR* dengan alamat yang bisa dijangkau ponsel pengunjung, mis. `http://192.168.1.10:3000`. Bila kosong, dipakai alamat yang dibuka di kiosk, sehingga kiosk yang memakai `localhost` menghasilkan QR yang tidak bisa dibuka dari ponsel (admin menampilkan peringatan untuk kasus ini).
- **Privasi dan keamanan**: tiap tiket punya token acak 96 bit sebagai satu-satunya kunci akses, dan halaman pantau hanya menampilkan data tiket itu sendiri. Server tidak menyimpan data pribadi pengunjung. Langganan push dihapus saat tiket selesai atau dilewati, atau bila layanan push melaporkan langganan tidak berlaku. Endpoint push yang diterima dibatasi ke layanan push browser yang dikenal, supaya pengunjung tidak bisa membuat server mengirim permintaan ke alamat sembarang. Kunci VAPID dibuat otomatis dan disimpan di tabel terpisah (tidak ikut `/api/settings`).
- Beberapa layanan push memeriksa subjek VAPID. Bila perlu, set `VAPID_SUBJECT` ke `mailto:` atau `https:` milik instansi.

SMS dan WhatsApp tidak disertakan karena butuh gateway berbayar dan nomor telepon pengunjung.

## HTTPS

Server dapat melayani HTTPS langsung:

```bash
openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=papan.local" \
  -keyout key.pem -out cert.pem
TLS_CERT=cert.pem TLS_KEY=key.pem npm start
```

Sertifikat self-signed di atas hanya untuk jaringan lokal (browser akan meminta konfirmasi sekali per perangkat). Untuk penggunaan yang lebih luas, pakai sertifikat dari CA tepercaya. Cookie sesi otomatis ditandai `Secure` dan WebSocket berjalan sebagai `wss`. Bila `TLS_CERT` atau `TLS_KEY` salah satunya saja yang diisi, server berhenti dengan pesan galat.

Bila server berada di belakang reverse proxy yang menangani HTTPS, set `TRUST_PROXY=1` agar server memakai `X-Forwarded-Proto` (untuk menandai cookie `Secure`) dan `X-Forwarded-For` (agar pembatas login menghitung per klien, bukan per proxy). Jangan aktifkan `TRUST_PROXY` bila server dapat dijangkau langsung oleh klien, karena header itu bisa dipalsukan.

## Struktur

```
server/
  index.js     HTTP/HTTPS API, unggah berkas, file statis, WebSocket
  service.js   logika antrian, konten, layar, kategori, meja, pengaturan
  auth.js      login, sesi, pembatas percobaan, manajemen pegawai
  media.js     konversi video (ffmpeg) dan pembersihan berkas yatim
  notify.js    langganan dan pengiriman push, QR, kunci VAPID
  db.js        skema SQLite, migrasi ringan, dan data awal
public/
  display.html, kiosk.html, operator.html, admin.html, t.html
  sw.js        service worker khusus notifikasi push
  css/app.css  sistem desain bersama (token warna di :root)
  js/common.js utilitas API, WebSocket, waktu server, suara
  js/icons.js  ikon SVG
  js/display.js logika papan informasi
  js/admin.js  logika dasbor admin
scripts/
  copy-vendor.js  menyalin pdf.js ke public/vendor (dipanggil postinstall)
```

## Batasan saat ini

- Pembatas login disimpan di memori, jadi reset saat server dimulai ulang.
- Nomor lama tidak bisa dipakai setelah antrian dipindah ke kategori lain; pengunjung yang tidak membuka halaman pantau dan tidak berlangganan push hanya tahu nomor barunya dari papan atau petugas.
- Papan memakai `import()` dinamis untuk pdf.js, sehingga membutuhkan browser yang cukup baru (Chrome 63 atau setara). Build pdf.js yang dipakai adalah versi *legacy* untuk kompatibilitas lebih luas.
- Suara bel dan TTS butuh satu kali ketukan "Aktifkan" di layar setelah halaman dibuka (aturan autoplay browser). Kualitas suara TTS bergantung pada suara bahasa Indonesia yang terpasang di perangkat.
- Notifikasi ke ponsel pengunjung memakai halaman pantau dan push browser; belum ada SMS atau WhatsApp.
- Pengiriman push ke layanan sungguhan (FCM dan sejenisnya) belum diuji end-to-end di lingkungan pengembangan karena butuh akses internet dan perangkat nyata; logika pemicu dan pembersihannya diuji dengan pengirim tiruan.
