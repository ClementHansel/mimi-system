import type { DocManual } from './types';

/**
 * Kasir manual — written from `components/pos/**` (ShiftOpenForm, ProductGrid,
 * Cart, PaymentPanel, VoidRefundModal, ShiftCloseModal) and the `pos.*`
 * namespace in `lib/i18n/id.ts`. Every button/field/status name below is the
 * literal on-screen string, not a paraphrase — see the F-DOCS ticket report
 * for the "could not verify" list (no separate "setoran kas" screen exists;
 * closing the shift IS the cash-count/deposit step).
 */
export const kasirManual: DocManual = {
  slug: 'kasir',
  title: 'Panduan Kasir',
  audience: 'Kasir',
  permission: 'pos.catalog.read',
  blurb: 'Buka shift, layani pesanan, terima pembayaran, void/refund, dan tutup kasir.',
  minutes: 8,
  order: 1,
  sections: [
    {
      id: 'buka-shift',
      heading: '1. Buka Kasir',
      blocks: [
        {
          type: 'callout',
          kind: 'rule',
          text: 'Tidak bisa melayani transaksi tanpa shift yang terbuka. Selama belum ada shift, layar kasir hanya menampilkan formulir **Buka Kasir** — menu produk, keranjang, dan tombol pembayaran belum muncul sama sekali.',
        },
        {
          type: 'p',
          text: 'Jika akun Anda terhubung ke lebih dari satu outlet, layar **Pilih Outlet** muncul lebih dulu. Ketuk outlet yang sesuai, lalu ketuk **Lanjutkan**.',
        },
        {
          type: 'steps',
          items: [
            'Isi **Modal Awal Kas** — jumlah uang tunai di laci kasir saat shift dimulai. Kolom ini wajib diisi; tombol **Buka Kasir** tidak aktif sampai ada angkanya.',
            'Ketuk **Buka Kasir**.',
            'Notifikasi **"Kasir dibuka"** muncul dan layar berpindah ke menu produk.',
          ],
        },
        {
          type: 'p',
          text: 'Jika perangkat gagal menyiapkan penyimpanan lokal, layar menampilkan **"Gagal menyiapkan perangkat kasir"** dengan tombol **Coba Lagi** — hubungi Kepala Gudang/IT jika berulang.',
        },
      ],
    },
    {
      id: 'layani-pesanan',
      heading: '2. Layani Pesanan',
      blocks: [
        {
          type: 'p',
          text: 'Layar kasir punya dua tab: **Kasir** untuk transaksi biasa dan **GoFood/ShopeeFood** untuk mencatat pesanan online secara manual (lihat catatan di bagian bawah halaman ini).',
        },
        {
          type: 'p',
          text: 'Di tab **Kasir**, gunakan baris kategori di atas katalog untuk menyaring produk (**Semua** menampilkan seluruh katalog). Ketuk kartu produk satu kali untuk menambah 1 unit ke keranjang — ketuk berkali-kali untuk menambah jumlahnya.',
        },
        {
          type: 'list',
          items: [
            'Setiap baris keranjang punya tombol **–** dan **+** untuk mengubah jumlah, dan ikon tempat sampah untuk menghapus baris.',
            'Kolom **Diskon Transaksi** (opsional) berlaku untuk seluruh transaksi, bukan per item — belum ada diskon per baris di layar ini.',
            'Baris **Total (subtotal)** dan **Total** diperbarui otomatis setiap ada perubahan di keranjang.',
          ],
        },
        {
          type: 'callout',
          kind: 'note',
          text: 'Jika katalog kosong atau belum pernah dimuat, layar menampilkan **"Katalog produk belum tersedia"** — sambungkan perangkat ke internet minimal sekali untuk mengunduhnya. Katalog yang tersimpan dari sesi sebelumnya tetap bisa dipakai offline; sistem menandainya dengan catatan "menampilkan katalog tersimpan terakhir".',
        },
        {
          type: 'p',
          text: 'Setelah keranjang terisi, ketuk **Lanjut ke Pembayaran** (tombol ini nonaktif selama keranjang masih kosong).',
        },
      ],
    },
    {
      id: 'metode-pembayaran',
      heading: '3. Metode Pembayaran',
      blocks: [
        { type: 'p', text: 'Jendela **Pembayaran** menampilkan tiga pilihan metode:' },
        {
          type: 'table',
          headers: ['Metode', 'Status setelah dipilih', 'Catatan'],
          rows: [
            [
              'Tunai',
              'Dibayar',
              'Isi **Uang Diterima** — sistem menghitung **Kembalian** secara otomatis. Tombol selesai tetap nonaktif jika uang diterima kurang dari total.',
            ],
            [
              'QRIS',
              'Terverifikasi',
              '"Pembayaran QRIS terverifikasi otomatis melalui gateway." Nomor referensi opsional.',
            ],
            [
              'Transfer',
              'Belum Terverifikasi',
              '"Pembayaran transfer menunggu verifikasi Finance — belum dianggap lunas." Nomor referensi opsional.',
            ],
          ],
        },
        {
          type: 'p',
          text: 'Untuk QRIS dan Transfer, kolom **Jumlah Tagihan** menampilkan total transaksi (tidak bisa diubah) dan kolom **Nomor Referensi** boleh diisi mis. ID transaksi.',
        },
        {
          type: 'p',
          text: 'Ketuk **Selesaikan & Cetak Struk** untuk menutup transaksi. Jika printer tidak tersedia, muncul peringatan **"Struk tidak dapat dicetak — printer tidak tersedia"** — transaksi tetap tersimpan, hanya struk fisiknya yang gagal dicetak. Notifikasi **"Transaksi berhasil"** menandai transaksi selesai.',
        },
        {
          type: 'callout',
          kind: 'rule',
          text: 'Ada DUA tombol struk dan keduanya berbeda. **Selesaikan & Cetak Struk** di jendela pembayaran mencetak sambil MENYELESAIKAN transaksi. **Cetak Ulang Struk** di keranjang mencetak ULANG struk transaksi terakhir — untuk pelanggan yang minta salinan, atau saat kertas printer habis. Bukan fitur ganda.',
        },
        {
          type: 'p',
          text: 'Keranjang, total, dan tombol **Lanjut ke Pembayaran** tetap terlihat saat Anda menggulir daftar menu — hanya daftar menunya yang bergulir.',
        },
        {
          type: 'callout',
          kind: 'warning',
          text: 'Saat koneksi tidak sepenuhnya online, muncul peringatan "Transaksi belum terlihat di tablet lain — akan muncul setelah tersambung kembali." Transaksi offline tetap sah, tapi jangan kaget bila tidak langsung muncul di tablet lain sebelum sinkron.',
        },
      ],
    },
    {
      id: 'void-refund',
      heading: '4. Void / Refund',
      blocks: [
        {
          type: 'p',
          text: 'Tombol **Void Transaksi Terakhir** hanya aktif untuk transaksi yang baru saja diselesaikan di sesi layar ini — bila halaman di-refresh setelah transaksi selesai, tombol ini kembali nonaktif dan void harus ditangani lewat jalur lain (mis. Finance/Approval).',
        },
        {
          type: 'p',
          text: 'Sebelum ada transaksi di perangkat ini, **Void Transaksi Terakhir** dan **Cetak Ulang Struk** keduanya abu-abu, dengan keterangan **"Aktif setelah ada transaksi di perangkat ini."** di bawahnya. Itu normal, bukan tanda rusak.',
        },
        {
          type: 'callout',
          kind: 'rule',
          text: 'Void/refund SELALU memerlukan otorisasi supervisor — tidak ada jalur void tanpa PIN Supervisor, online maupun offline.',
        },
        {
          type: 'p',
          text: 'Isi jendela **Void / Refund**:',
        },
        {
          type: 'list',
          items: [
            '**Jenis** — pilih Void atau Refund.',
            '**Alasan** — wajib diisi; tombol **Ajukan** ditolak dengan pesan "Alasan wajib diisi" jika kosong.',
            '**Jumlah** — opsional (kosongkan untuk void penuh).',
            '**PIN Supervisor** — wajib, selalu diminta.',
          ],
        },
        {
          type: 'p',
          text: 'Saat perangkat sedang offline/tanpa koneksi ke pusat, jendela menambahkan badge **"Otorisasi Offline — Sementara"** serta dua kolom tambahan: **Supervisor Penyetuju** (pilih dari kredensial supervisor tersimpan di perangkat) dan **Foto Selfie Supervisor** (wajib). Hasilnya tersimpan sebagai **"Void/refund tersimpan (sementara)"** dan akan diverifikasi ulang oleh sistem pusat begitu perangkat tersinkron.',
        },
        {
          type: 'p',
          text: 'Saat online, mengirim dengan PIN langsung menghasilkan **"Void/refund disetujui"**; mengirim tanpa PIN saat itu menghasilkan status menunggu, **"Void/refund diajukan"** ("Menunggu persetujuan supervisor").',
        },
        {
          type: 'table',
          headers: ['Kegagalan otorisasi offline', 'Pesan yang muncul'],
          rows: [
            ['Kredensial dicabut', 'Kredensial supervisor telah dicabut'],
            ['Terkunci', 'Terlalu banyak percobaan PIN salah — kredensial terkunci'],
            ['Kedaluwarsa', 'Kredensial supervisor telah kedaluwarsa'],
            ['Melebihi batas', 'Jumlah melebihi batas otorisasi offline supervisor ini'],
            ['Butuh selfie', 'Foto selfie wajib untuk jumlah sebesar ini'],
            ['PIN salah', 'PIN salah'],
            ['Tidak ada kredensial', 'Tidak ada kredensial supervisor tersimpan di perangkat ini'],
          ],
        },
      ],
    },
    {
      id: 'tutup-shift',
      heading: '5. Tutup Kasir & Setoran Kas',
      blocks: [
        {
          type: 'callout',
          kind: 'note',
          text: 'Tidak ada layar "setoran kas" terpisah — menghitung dan mencocokkan uang tunai laci ADALAH proses Tutup Kasir di bawah ini.',
        },
        {
          type: 'p',
          text: 'Ketuk **Tutup Kasir**. Jendela menampilkan ringkasan yang tidak bisa diubah:',
        },
        {
          type: 'list',
          items: [
            '**Modal Awal Kas** — nilai yang diisi saat shift dibuka.',
            '**Perkiraan Kas (lokal)** — modal awal + total penjualan tunai yang tercatat di perangkat ini.',
            '**Jumlah Transaksi** — banyaknya transaksi yang dilayani di perangkat ini selama shift.',
          ],
        },
        {
          type: 'steps',
          items: [
            'Hitung uang tunai fisik di laci, lalu isi **Uang Tunai Dihitung**.',
            'Bila angkanya berbeda dari perkiraan lokal, muncul catatan selisih — ini hanya perkiraan; angka final tetap dihitung ulang oleh sistem pusat setelah sinkron, jadi jangan menganggapnya sebagai keputusan akhir.',
            'Isi **Catatan** bila perlu (opsional), lalu ketuk **Tutup Kasir** untuk menyelesaikan.',
          ],
        },
        {
          type: 'p',
          text: 'Notifikasi **"Kasir ditutup"** menandai shift selesai; laporan shift final baru tersedia setelah data tersinkron ke pusat. Layar kembali ke formulir Buka Kasir untuk shift berikutnya.',
        },
      ],
    },
    {
      id: 'lain-lain',
      heading: '6. Hal Lain yang Perlu Diketahui',
      blocks: [
        {
          type: 'list',
          items: [
            '**Tab GoFood/ShopeeFood** bukan transaksi kasir biasa — ini formulir pencatatan manual pesanan dari aplikasi ojek online: isi Nomor Pesanan dan Jumlah Kotor (Gross), lalu diskon/biaya platform/biaya lain; **Diterima Bersih (Net)** dihitung otomatis dan tidak bisa diubah manual. Tombol **Simpan Pesanan** nonaktif bila hasilnya negatif.',
            'Bilah status di atas menu produk menunjukkan outlet aktif Anda; akun yang menangani lebih dari satu outlet punya tombol **Ganti Outlet**.',
          ],
        },
      ],
    },
  ],
};
