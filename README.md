# Papan Informasi & Nomor Antrian

![CI](../../actions/workflows/ci.yml/badge.svg)

Papan informasi digital untuk beberapa layar publik (landscape), dengan nomor antrian yang dipanggil ke meja layanan.
Dibangun dengan Node.js (tanpa build step), SQLite bawaan Node, dan WebSocket untuk sinkronisasi realtime.

## Menjalankan

Butuh Node.js 22.13 atau lebih baru. `ffmpeg` bersifat opsional (untuk mengonversi video).

```bash
npm install
npm run build      # membangun antarmuka (Vite) ke dist/; wajib sebelum npm start
ADMIN_USERNAME="admin" ADMIN_PASSWORD="ganti-dengan-password-kuat" npm start
```

Lalu buka `http://localhost:3000/admin` dan masuk dengan akun tersebut.

- Antarmuka ditulis di `web/` dan dibangun Vite ke `dist/` (diabaikan git); server menyajikan `dist/`. Selama pengembangan jalankan `npm run dev` (server Vite di :5173 dengan proxy ke server di :3000). `npm test` dan `npm run test:e2e` membangun ulang otomatis. Alamat lama berakhiran `.html` dan `/?screen=` dialihkan 301 ke jalur baru.
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
| `HOST` | Antarmuka yang didengarkan, mis. `127.0.0.1` di belakang reverse proxy (default: semua) |
| `TICKET_RATE` | Batas pengambilan nomor per alamat per menit di kiosk (default 30) |
| `YOUTUBE` | `off` mematikan jenis konten YouTube dan mengembalikan CSP ke `'self'` saja (default `on`) |
| `WS_MAX_PER_IP` | Batas koneksi WebSocket per alamat (default 100) |
| `VAPID_SUBJECT` | Subjek VAPID untuk notifikasi push (`mailto:` atau `https:`), opsional |

## Halaman

| Halaman | URL | Pengguna |
|---|---|---|
| Papan informasi | `/layar/<slug>` (atau `/` untuk semua) | Layar publik (buka dalam mode kiosk/layar penuh). Tambah `?sound=on` pada perangkat kiosk yang browsernya berflag autoplay (lihat panduan penerapan) |
| Kiosk ambil nomor | `/kiosk` | Pengunjung (layar sentuh) |
| Pantau antrian | `/antrian/<token>` | Pengunjung, lewat QR di slip nomor |
| Panel meja | `/operator` | Pegawai: login, pilih meja, panggil, pindahkan, buat nomor, riwayat |
| Admin | `/admin` | Admin: dasbor, konten, layar, kategori, meja, pegawai, laporan, pengaturan |

Desain mengikuti satu sistem (`web/css/app.css`): biru dominan, kartu putih berborder tipis, kuning hanya sebagai sorotan kecil.
Papan dirancang landscape dan skalanya mengikuti lebar layar (diperiksa di 1366×768 sampai 4K). Panel meja dan admin responsif sampai layar ponsel.

## Banyak layar

Setiap layar didaftarkan di halaman **Layar** dengan nama dan *slug* (mis. `lobi`), lalu dibuka di perangkatnya lewat `/layar/lobi`.

- **Kategori**: layar hanya menampilkan antrian, meja, dan panggilan untuk kategori yang dipilih. Kosong berarti semua kategori.
- **Konten**: tiap item konten bisa ditujukan ke layar tertentu. Item tanpa tujuan menjadi konten bersama yang tampil di semua layar.
- **Screensaver**: waktu idle bisa diatur per layar. Idle dihitung dari aktivitas antrian pada kategori layar itu saja.
- **Mode layar**: sakelar *Tampilkan antrian di layar ini*. Dimatikan, layar menjadi **papan informasi saja**: panggung penuh tanpa kartu antrian, meja, panggilan, bel, atau suara. Pengunjung yang menggerakkan kursor atau menyentuh layar melihat **daftar informasi di sisi kiri**; selama itu durasi tayang **dimatikan sementara** (penghitung menunjukkan "Dijeda"), mengklik judul melompat ke informasi itu (PDF punya tombol halaman sebelumnya/berikutnya), dan setelah tidak ada gerakan selama *lanjut otomatis* (default 20 detik, 5-600) daftar menutup dan tayangan lanjut dengan durasi penuh.
- Alamat `/` tanpa parameter menampilkan semua antrian dan **hanya** konten bersama.
- Slug yang belum didaftarkan tetap menampilkan konten bersama, disertai peringatan di layar.

## Login pegawai

- Admin membuat akun di halaman **Pegawai** (username, password, peran) dan mencentang meja yang boleh dipakai pegawai itu.
- Pegawai login di `/operator`, memilih satu meja dari daftar yang diizinkan, lalu bekerja di meja itu. Satu meja hanya bisa dipegang satu pegawai pada satu waktu.
- **Memanggil nomor berarti langsung melayaninya**: tidak ada tombol "Mulai layani". Alurnya menunggu → dilayani (saat dipanggil) → selesai atau dilewati.
- Pegawai tidak bisa keluar atau berpindah meja selama masih memegang antrian yang sedang dilayani.
- Antrian mencatat pegawai yang melayani, dan laporan harian menampilkan jumlah per pegawai.
- Peran `admin` boleh membuka panel meja mana pun.

Keamanan: password disimpan sebagai hash scrypt; sesi memakai cookie `HttpOnly` + `SameSite=Lax` selama 12 jam; pembatas login menyimpan hitungannya di database sehingga **bertahan saat server dimulai ulang**. Batasnya dua lapis dalam jendela 15 menit: 5 percobaan per pasangan (alamat, username) dan 20 percobaan per alamat (menahan tebakan banyak username dari satu sumber). Melampaui batas mengunci selama 5 menit. Percobaan dicatat sebelum password diverifikasi, sehingga permintaan paralel tidak bisa menembus batas, dan login yang berhasil menghapus hitungan akun serta menurunkan hitungan alamat satu tingkat (agar pengguna sah di balik alamat bersama tidak ikut terkunci). Sesi dicabut saat akun dinonaktifkan atau password diganti. Sistem selalu menyisakan minimal satu admin aktif.

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

- Jenis konten: **teks**, **gambar**, **video**, **PDF**, dan **YouTube**. Setiap item tampil selama durasi yang diatur, lalu berganti otomatis. Pil hitung mundur tampil di pojok, dan penanda progres bersegmen di bawahnya menunjukkan posisi dalam playlist.
- **Video**: durasi 0 berarti tayang sampai video selesai. Bila `ffmpeg` tersedia, video yang diunggah dikonversi ke MP4 H.264/AAC (tinggi maks 1080, `faststart`) agar terputar di browser layar mana pun. Konversi berjalan satu per satu di latar belakang; tombol Simpan aktif setelah selesai. Tanpa `ffmpeg`, video disimpan apa adanya dan dasbor menampilkan peringatan.
- **YouTube**: tempel tautan video (`youtube.com/watch?v=`, `youtu.be/`, `shorts/`, `embed/`). Diputar lewat IFrame API (host `youtube-nocookie.com`), **dibisukan dan tanpa kontrol**; item berganti saat video selesai, dan durasi menjadi batas maksimum (0 = sampai selesai). Butuh internet di perangkat papan; bila pemutar tidak termuat atau video tidak bisa disematkan, item dilewati. CSP hanya dilonggarkan untuk host YouTube (`YOUTUBE=off` mematikannya). Tidak bisa dipakai sebagai screensaver.
- **Teks (markdown)**: isi teks ditulis dengan editor Tiptap (judul, tebal, miring, daftar, kutipan, garis) dan disimpan sebagai **markdown**. Berkas `.md` dapat diimpor (seret ke kotak impor; heading pertama menjadi judul bila judul kosong) dan teks markdown yang ditempel otomatis diformat. Di papan hasilnya disanitasi (HTML mentah, tautan, dan gambar dibuang) dan teks panjang diperkecil agar muat.
- **Urutan tayang**: seret ikon di kiri baris (atau panah atas/bawah pada ikon yang difokuskan) di tab *Semua*; urutan langsung tersimpan.
- **Unggah**: area seret-lepas (*dropzone*) untuk berkas konten, logo, dan markdown, dengan bilah progres unggah (persen, kecepatan, sisa waktu) dan **persen konversi video** yang dibaca dari ffmpeg.
- **PDF**: tampil per halaman (pdf.js). Durasi berarti **detik per halaman**. Bila pdf.js gagal dimuat, dokumen tampil lewat penampil bawaan browser selama satu kali durasi.
- Screensaver berjalan saat tidak ada aktivitas antrian **dan** tidak ada gerakan kursor, sentuhan, atau tombol selama waktu *idle* yang diatur; ia **hilang begitu kursor digerakkan** atau layar disentuh. Screensaver memakai item yang ditandai "screensaver" (gambar atau video).
- Berkas unggahan yang tidak lagi dipakai dihapus otomatis (saat konten dihapus atau diganti, dan penyapuan tiap jam untuk berkas yatim yang berumur lebih dari satu jam).
- Admin dapat memilih beberapa konten sekaligus untuk diaktifkan, dinonaktifkan, atau dihapus lewat bar aksi massal.

## Tampilan mobile dan tablet

Semua halaman dapat dipakai di ponsel dan tablet; tampilan TV tidak berubah.

- **Papan** (`/`, `/layar/<slug>`): pada lebar ≤ 820 px (ponsel dan tablet potret) menjadi **satu kolom yang dapat digulir**: kartu *Sedang dipanggil*, lalu konten (teks dikecilkan agar muat), lalu daftar meja dan panggilan terakhir. Layar *hanya informasi*: daftar pilihan menjadi **lembar bawah** yang dibuka dengan mengetuk tombol *Daftar* (atau layar) dan ditutup dengan × atau otomatis setelah diam.
- **Admin**: sidebar menjadi laci; **tabel menjadi kartu bertumpuk** berlabel di ≤ 720 px; laci formulir penuh layar dengan tombol Simpan menempel di bawah; bar aksi massal, editor markdown (bilah alat dapat digeser), dropzone ("Ketuk untuk memilih berkas"), tab, dan filter menyesuaikan lebar layar. Pada perangkat sentuh semua tombol bertinggi ≥ 44 px dan kolom isian berfont 16 px (iOS tidak memperbesar halaman).
- **Kiosk, panel meja, halaman pantau**: memakai tinggi `dvh` dan area aman (*notch*), kartu kategori kiosk menyusut hingga 320 px, panel meja satu kolom aksi di layar sangat sempit dan navigasi bawah ringkas di ponsel landscape.
- **Tablet landscape** memakai tata letak TV dengan teks dasar minimal 14 px.

Diuji otomatis (`test/e2e/mobile.e2e.cjs`) pada profil iPhone 13/SE, Pixel 7, iPad Mini, 320 px, dan ponsel landscape: tanpa gulir horizontal, tanpa elemen melewati tepi layar, target sentuh dan font kolom, urutan tata letak papan, lembar bawah, kartu tabel, dan laci. Perangkat nyata (khususnya Safari iOS) belum diuji.

## Notifikasi pengunjung

Slip kiosk memuat kode QR ke halaman pantau (`/antrian/<token>`) di ponsel pengunjung. Tidak perlu aplikasi, akun, atau nomor telepon.

Saat nomor dipanggil, ponsel pengunjung yang membuka halaman pantau **bergetar berulang** (±tiap 3,5 detik, maksimal 90 detik) sampai pengunjung mengetuk "Saya sudah menuju meja"; panggil ulang memulainya lagi. Batas platform: getar hanya jalan di Chrome/Firefox Android saat halaman terbuka dan peringatan sudah diaktifkan lewat sentuhan; iOS Safari tidak mendukung getar. Untuk ponsel yang terkunci, notifikasi push membawa pola getar panjang (Android saja).

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

## Keamanan

- **Header dan CSP**: semua respons membawa `Content-Security-Policy` (skrip hanya dari asal sendiri, tanpa skrip inline), `X-Content-Type-Options: nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, dan HSTS di HTTPS. Berkas unggahan SVG disajikan dengan CSP `sandbox` sehingga SVG berskrip tidak berjalan bila dibuka langsung.
- **Unggahan**: isi berkas diperiksa terhadap ekstensinya (tanda tangan PNG, JPEG, GIF, WEBP, PDF, MP4, WebM), dan SVG ditolak bila memuat `<script>`, atribut `on...=`, `javascript:`, `<foreignObject>`, `@import`, atau rujukan `href` selain `#id` internal. Ukuran yang diumumkan di header `Content-Length` ditolak sejak awal bila melebihi 300 MB.
- **Validasi data**: nama berkas konten harus hasil unggahan dengan ekstensi yang cocok dengan jenis kontennya, logo harus berkas unggahan, prefix kategori hanya huruf dan angka (1-3 karakter), dan zona waktu harus dikenal. Teks bebas (nama instansi, judul, nama meja, dan sebagainya) selalu di-escape saat ditampilkan; audit otomatis dengan payload XSS di semua field dan semua halaman tidak menemukan titik bocor.
- **Pembatasan laju**: login (lihat atas), pengambilan nomor di kiosk (`TICKET_RATE`), dan pendaftaran push. Koneksi WebSocket dibatasi per alamat dan pesannya dibatasi 1 KB.
- **Ketahanan HTTP**: header harus lengkap dalam 20 detik, badan JSON dalam 15 detik, dan permintaan dengan target atau encoding rusak mendapat 400 tanpa menjatuhkan server.
- **Log audit**: satu baris JSON berawalan `AUDIT` ke stdout (journald atau `docker logs`) untuk login berhasil, gagal, dan terkunci, pembuatan, perubahan, dan penghapusan pegawai, serta perubahan pengaturan. Password dan token tidak pernah dicatat, dan username yang bentuknya bukan username wajar (mis. password yang salah diketik di kolom username) tidak dicatat.

Lihat juga bagian Login pegawai dan HTTPS di atas.

## Operasional

- **Kesehatan**: `GET /healthz` menjawab `200 {"ok":true}` tanpa autentikasi dan tanpa membuka data apa pun, atau `503` bila database tidak bisa dibaca atau server sedang berhenti. Cocok untuk pemantauan, systemd, dan Docker.
- **Penutupan anggun**: pada `SIGTERM`/`SIGINT` server berhenti menerima koneksi, memberi tahu klien WebSocket (kode 1001), menghentikan konversi video dan membuang berkas sementaranya, menghapus unggahan yang belum selesai, menutup database, lalu keluar (batas 10 detik). Berkas `papan.pid` di direktori data menandai server yang sedang berjalan.
- **Backup**: `npm run backup` (atau `node scripts/backup.js`) membuat snapshot database yang konsisten (aman saat server hidup dan menulis) ditambah berkas unggahan menjadi satu arsip `.tar.gz` berizin `0600` di folder `backups` di samping direktori data. Opsi: `--out DIR`, `--keep N` (default 14), `--no-uploads`, `--data DIR`. Nama arsip memuat waktu sampai milidetik sehingga tidak pernah saling menimpa. Arsip memuat hash password dan kunci VAPID, jadi simpan di tempat yang hanya bisa dibaca pemilik.
- **Restore**: `node scripts/restore.js <arsip> --yes`. Tanpa `--yes` hanya pratinjau. Skrip memeriksa arsip sebelum mengekstrak (path berbahaya, tautan, integritas database, tabel yang diharapkan), menolak berjalan bila server masih hidup (`--force` untuk melewatinya, mis. server dalam container), dan **tidak menghapus data lama**: data saat ini dipindahkan ke `<data>/.bak-<waktu>` sehingga pemulihan bisa dibatalkan.

## Penerapan

Panduan lengkap memasang di server dan layar sungguhan ada di **[docs/PENERAPAN.md](docs/PENERAPAN.md)**: systemd, Docker Compose, HTTPS (Caddy, nginx, atau langsung), layar kiosk, backup terjadwal, pembaruan, pemantauan, daftar periksa keamanan, dan pemecahan masalah. Berkas contoh ada di [`deploy/`](deploy): layanan dan timer systemd, contoh konfigurasi lingkungan, Caddyfile, konfigurasi nginx, dan skrip layar kiosk. Dockerfile dan `docker-compose.yml` ada di akar repo.

Yang sudah diuji: unit systemd (valid menurut `systemd-analyze verify`), skrip backup dan restore, skrip layar kiosk (dengan peramban tiruan), serta `Dockerfile` dan compose (`test/docker-smoke.sh`, juga di CI). Yang belum diuji: contoh Caddy dan nginx, bunyi pada perangkat kiosk sungguhan, dan push ke layanan sungguhan.

## Pengujian

```bash
npm test             # unit dan integrasi: 155 tes, sekitar 10 detik, tanpa browser
npm run test:slow    # sama, ditambah tes slowloris (menunggu ~25 detik)
npm run test:e2e     # e2e Playwright di browser sungguhan (butuh Playwright dan Chromium)
```

`npm test` memakai pelari bawaan Node (`node --test`) dan tidak butuh dependensi tambahan. Tes integrasi menjalankan **server sungguhan** di port acak dengan direktori data sementara, jadi yang diuji adalah perilaku HTTP, WebSocket, sinyal, dan berkas yang sebenarnya. Cakupannya: validasi unggahan, logika antrian (urutan, prioritas, khusus meja, pindah ke meja dan kategori lain, filter layar), notifikasi (pemicu, pembersihan, penolakan SSRF), autentikasi dan pembatas login (termasuk bertahan setelah restart dan permintaan paralel), header keamanan dan input rusak, batas WebSocket, log audit, penutupan anggun, serta backup dan restore (termasuk arsip berbahaya).

`npm run test:e2e` menyalakan server segar untuk tiap skrip, membuat fixture sendiri (PNG, PDF 3 halaman, WebM; ffmpeg dipakai bila ada), lalu menjalankan alur lengkap di Chromium: admin, kiosk, panel meja, halaman pantau, pindah antrian, PDF per halaman, dan audit XSS dengan payload di semua field. Tangkapan layar disimpan di folder sementara yang dicetak di akhir. Playwright dicari secara lokal, lalu secara global (`npm root -g`); bila belum ada: `npm i -D playwright && npx playwright install chromium`.

`test/docker-smoke.sh` membangun image lalu menguji: isi image, pengguna non-root, kesehatan, header, tulis ke volume, penutupan anggun (`docker stop`), persistensi, backup dan restore di dalam container, serta compose. Butuh Docker; bila apt tidak terjangkau dari jaringan build: `DOCKER_NETWORK=host APT_PACKAGES="" ./test/docker-smoke.sh` (tambahkan `SKIP_BUILD=1` untuk memakai image yang sudah ada).

**CI** (`.github/workflows/ci.yml`) menjalankan `npm test` di Node 22 dan 24 beserta `npm audit`, e2e Playwright, dan uji Docker pada setiap push dan pull request.


## Rilis

Push ke `main` menjalankan `.github/workflows/release.yml`: tes dulu, lalu **image Docker dipublikasikan ke GHCR hanya bila pesan commit memuat "rilis baru"** (tidak peka huruf besar-kecil). Pada merge commit hanya **judul PR** (atau judul yang Anda ketik saat merge) yang masuk ke pesan, jadi frasa itu harus ada di sana. Alternatifnya, jalankan manual tanpa frasa apa pun: tab Actions → Rilis → *Run workflow* (branch `main`). Naikkan `version` di `package.json` sebelum merilis; bila tag `vX.Y.Z` sudah ada, rilis ditolak agar image lama tidak tertimpa. Hasilnya: image `ghcr.io/<pemilik>/papan-informasi` dengan tag versi, `latest`, dan `sha-<commit>`, plus GitHub Release.

```bash
docker pull ghcr.io/<pemilik>/papan-informasi:latest
export PAPAN_IMAGE=ghcr.io/<pemilik>/papan-informasi:latest
docker compose pull papan && docker compose up -d --no-build
```

Paket GHCR baru bersifat privat; ubah visibilitasnya di pengaturan paket di GitHub bila ingin dapat ditarik tanpa login.

## Struktur

```
server/
  index.js     HTTP/HTTPS API, unggah berkas, file statis, WebSocket
  service.js   logika antrian, konten, layar, kategori, meja, pengaturan
  auth.js      login, sesi, pembatas percobaan, manajemen pegawai
  media.js     konversi video (ffmpeg) dan pembersihan berkas yatim
  notify.js    langganan dan pengiriman push, QR, kunci VAPID
  upload-check.js  validasi isi berkas unggahan (tanda tangan, SVG aman)
  ratelimit.js pembatas laju endpoint publik
  audit.js     log audit JSON ke stdout
  db.js        skema SQLite, migrasi ringan, dan data awal
web/           sumber antarmuka (Vite membangunnya ke dist/)
  display.html, kiosk.html, operator.html, admin.html, antrian.html
  static/sw.js service worker khusus notifikasi push (disalin apa adanya ke dist/)
  css/app.css  sistem desain bersama (token warna di :root)
  js/common.js utilitas API, WebSocket, waktu server, suara
  js/icons.js  ikon SVG
  js/display.js logika papan informasi
  js/kiosk.js, js/operator.js, js/track.js, js/admin.js  logika halaman masing-masing
  js/admin.js  logika dasbor admin
vite.config.js  konfigurasi build antarmuka
test/         tes unit, integrasi (npm test), dan e2e (test/e2e)
deploy/       contoh systemd, proxy, dan skrip layar kiosk
docs/         panduan penerapan
scripts/
  backup.js       backup database dan unggahan menjadi satu arsip
  restore.js      pulihkan dari arsip backup
```

## Batasan saat ini

- Nomor lama tidak bisa dipakai setelah antrian dipindah ke kategori lain; pengunjung yang tidak membuka halaman pantau dan tidak berlangganan push hanya tahu nomor barunya dari papan atau petugas.
- Papan memakai `import()` dinamis untuk pdf.js, sehingga membutuhkan browser yang cukup baru (Chrome 63 atau setara). Build pdf.js yang dipakai adalah versi *legacy* untuk kompatibilitas lebih luas.
- Suara bel dan TTS butuh satu kali ketukan "Aktifkan" di layar setelah halaman dibuka (aturan autoplay browser). Kualitas suara TTS bergantung pada suara bahasa Indonesia yang terpasang di perangkat.
- Notifikasi ke ponsel pengunjung memakai halaman pantau dan push browser; belum ada SMS atau WhatsApp.
- Pengiriman push ke layanan sungguhan (FCM dan sejenisnya) belum diuji end-to-end di lingkungan pengembangan karena butuh akses internet dan perangkat nyata; logika pemicu dan pembersihannya diuji dengan pengirim tiruan.
