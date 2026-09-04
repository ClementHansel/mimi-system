import type { DocManual } from './types';

/**
 * Supervisor Outlet manual — written from `components/outlet/**`
 * (ReplenishmentPanel, ReceivingPanel/ReceiveDropForm, OpnamePanel, WastePanel)
 * and `components/approvals/**`, cross-checked against the `outlet.*`,
 * `status.*` and `approvals*` namespaces in `lib/i18n/id.ts`. Role→permission
 * mapping (which approve keys Supervisor actually holds) lives server-side
 * and was not verifiable from the frontend — flagged inline where relevant.
 */
export const supervisorOutletManual: DocManual = {
  slug: 'supervisor-outlet',
  title: 'Panduan Supervisor Outlet',
  audience: 'Supervisor Outlet',
  permission: ['replenishment.create', 'opname.create', 'waste.create', 'pettycash.create'],
  blurb: 'Minta barang, terima kiriman, stock opname, waste, dan persetujuan di outlet Anda.',
  minutes: 10,
  order: 2,
  sections: [
    {
      id: 'minta-barang',
      heading: '1. Minta Barang (Replenishment)',
      blocks: [
        {
          type: 'p',
          text: 'Buka tab **Minta Barang** lalu ketuk **Buat Permintaan**. Isi **Dibutuhkan Sebelum** (opsional), lalu untuk setiap barang pilih **Barang** dan isi **Jumlah** — pakai **Tambah Baris** untuk menambah barang lain.',
        },
        {
          type: 'callout',
          kind: 'note',
          text: 'Permintaan langsung diajukan begitu ketuk **Ajukan** — tidak ada langkah simpan-draft terpisah dari layar ini.',
        },
        {
          type: 'table',
          headers: ['Status', 'Arti'],
          rows: [
            ['Draft', 'Belum diajukan'],
            ['Diajukan', 'Sudah dikirim untuk disetujui'],
            ['Menunggu Persetujuan', 'Sedang di antrean approval'],
            ['Disetujui', 'Disetujui, siap diproses gudang'],
            ['Ditolak', 'Ditolak — buka detail untuk melihat alasannya'],
            ['Diproses', 'Gudang sedang menyiapkan barang'],
            ['Dikirim', 'Surat Jalan sudah berangkat'],
            ['Diterima', 'Barang sudah diterima di outlet'],
            ['Selesai', 'Permintaan tuntas'],
          ],
        },
        {
          type: 'p',
          text: 'Permintaan Anda melewati dua langkah persetujuan: Supervisor lalu Kepala Gudang. Kepala Gudang bisa mengubah jumlah per baris sebelum menyetujui — bila itu terjadi, baris permintaan menampilkan **"Jumlah diubah — lihat alasan"** beserta alasannya di layar detail.',
        },
      ],
    },
    {
      id: 'terima-kiriman',
      heading: '2. Terima Kiriman',
      blocks: [
        {
          type: 'p',
          text: 'Tab **Terima Barang** menampilkan kiriman yang masih berstatus Menunggu, Dalam Perjalanan, atau Tiba di Lokasi untuk outlet Anda. Ketuk barisnya untuk membuka formulir **Terima Barang**.',
        },
        {
          type: 'p',
          text: 'Untuk setiap barang: kolom **Dikirim** tidak bisa diubah (jumlah dari gudang), isi **Diterima** (default sama dengan Dikirim) dan pilih **Area Penyimpanan**. Bila jumlah diterima berbeda dari yang dikirim, kolom **Alasan Selisih** muncul dan wajib diisi.',
        },
        {
          type: 'callout',
          kind: 'rule',
          text: 'Wajib foto dan wajib tanda tangan. **Foto Barang Diterima** dan **Penerima** (tanda tangan) keduanya wajib — tombol **Konfirmasi Terima** tetap nonaktif sampai foto ada, tanda tangan ada, setiap baris punya jumlah + area penyimpanan, dan setiap selisih punya alasan. Ini bukan sekadar validasi — ini pengaman anti-kecurangan penerimaan barang.',
        },
        {
          type: 'p',
          text: 'Setelah dikirim, notifikasi **"Penerimaan tersimpan — akan tersinkron otomatis saat koneksi tersedia"** muncul; data tetap tersimpan meski sedang offline dan tersinkron begitu perangkat online kembali.',
        },
      ],
    },
    {
      id: 'stock-opname',
      heading: '3. Stock Opname',
      blocks: [
        {
          type: 'steps',
          items: [
            'Ketuk **Mulai Opname**, pilih **Area Penyimpanan**, lalu ketuk **Lanjut** — lembar hitung terbuka otomatis.',
            'Di **Lembar Hitung**, isi **Hasil Hitung** untuk tiap barang. **Selisih** terhitung otomatis dari Stok Sistem vs Hasil Hitung.',
            'Bila ada selisih pada suatu baris, kolom **Alasan** untuk baris itu wajib diisi.',
            'Ketuk **Simpan** untuk menyimpan progres tanpa mengajukan, atau **Ajukan** untuk mengirim lembar hitung untuk persetujuan.',
          ],
        },
        {
          type: 'callout',
          kind: 'warning',
          text: 'Setiap baris yang selisih wajib diisi alasannya sebelum diajukan — tombol Ajukan tidak aktif sampai semua terisi.',
        },
        {
          type: 'callout',
          kind: 'rule',
          text: 'Setelah diajukan, lembar hitung menjadi **catatan, bukan formulir** — kolom isian dan tombol Simpan/Ajukan tidak lagi muncul. Untuk memperbaiki hitungan yang sudah diajukan, minta penyetuju menolaknya lalu buat opname baru.',
        },
        {
          type: 'p',
          text: 'Setelah **Ajukan**, sistem memeriksa tiga hal: tidak ada sengketa hitung-ganda yang terbuka, setiap baris yang selisih sudah ada alasannya, dan minimal satu baris terhitung.',
        },
        {
          type: 'steps',
          items: [
            '**Langkah 1 — Supervisor Cabang** (untuk opname gudang: Kepala Gudang). Selalu ada.',
            '**Langkah 2 — Manajer**, hanya jika total nilai selisih **Rp2.000.000 atau lebih**. Ambang ini diatur di Administrasi → Pengaturan (`approval.threshold.opname`).',
            'Setelah disetujui penuh, sistem memposting koreksi stok ke buku besar dan status menjadi **Sudah Disesuaikan**.',
          ],
        },
        {
          type: 'callout',
          kind: 'rule',
          text: 'Stok TIDAK berubah sampai persetujuan selesai. Itulah gunanya ambang batas: selisih kecil cukup disetujui Supervisor, selisih besar wajib dilihat Manajer.',
        },
        {
          type: 'p',
          text: 'Status opname: Draft, Sedang Menghitung, Diajukan, Disetujui, Ditolak, Sudah Disesuaikan, Dibatalkan.',
        },
      ],
    },
    {
      id: 'waste',
      heading: '4. Waste',
      blocks: [
        {
          type: 'p',
          text: 'Tab **Waste / Retur** punya dua sub-tab: **Waste** dan **Retur ke Gudang**. Untuk mencatat waste, ketuk **Catat Waste**.',
        },
        {
          type: 'p',
          text: 'Isi Area Penyimpanan, Barang, Hasil Hitung (jumlah), dan **Alasan** — pilih salah satu kategori tetap: **Kedaluwarsa, Rusak, Busuk, Salah Olah,** atau **Lainnya**. Tambahkan **Catatan** bila perlu, dan gunakan **Tambah Baris** untuk barang lain.',
        },
        {
          type: 'callout',
          kind: 'rule',
          text: 'Wajib foto. **Foto Waste** wajib dilampirkan — tombol Ajukan menolak dengan pesan "Foto wajib dilampirkan" bila belum ada foto.',
        },
        {
          type: 'p',
          text: 'Waste langsung berstatus Menunggu setelah diajukan (tidak melalui status draft) — hanya ada tiga status: Menunggu, Disetujui, Ditolak.',
        },
        {
          type: 'p',
          text: 'Untuk **Retur ke Gudang**: ketuk **Buat Retur**, isi Barang, Area Penyimpanan, jumlah, **Alasan** (teks bebas, wajib), dan **Foto Bukti** (wajib). Retur langsung diajukan setelah dibuat, sama seperti permintaan barang.',
        },
      ],
    },
    {
      id: 'persetujuan',
      heading: '5. Persetujuan',
      blocks: [
        {
          type: 'p',
          text: 'Buka **Persetujuan Menunggu** (`/approvals`) untuk melihat dokumen yang menunggu keputusan Anda — daftar ini sudah disaring oleh sistem, jadi Anda hanya melihat dokumen yang memang wewenang Anda.',
        },
        {
          type: 'p',
          text: 'Untuk **Permintaan Barang**, layar detail memakai formulir khusus: centang **Ubah jumlah** pada baris yang ingin diubah, isi jumlah baru dan alasan perubahan (wajib bila diubah). Ketuk **Setujui** atau **Tolak** (Tolak meminta **Alasan Penolakan** wajib diisi, lalu **Konfirmasi Tolak**).',
        },
        {
          type: 'p',
          text: 'Untuk jenis dokumen lain (Stock Opname, Retur, Waste, dll.), gunakan panel persetujuan umum: isi **Catatan** (opsional, kecuali untuk Selisih Kas — di sana catatan wajib diisi bahkan untuk menyetujui), lalu **Setujui**, atau ketuk **Tolak** dan isi **Alasan Penolakan**.',
        },
        {
          type: 'callout',
          kind: 'note',
          text: 'Void/Refund dan Verifikasi Pembayaran tidak bisa disetujui dari layar ini — keduanya punya jalur persetujuan sendiri (Void/Refund lewat PIN Supervisor di modul Kasir; Verifikasi Pembayaran lewat aksi "Bayar" di modul Keuangan). Dari layar Persetujuan, Anda hanya bisa menolak keduanya.',
        },
      ],
    },
  ],
};
