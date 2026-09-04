import type { DocManual } from './types';

/**
 * Pemilik/Manajer manual — written from `components/dashboard/**`
 * (DashboardShell, OverviewCards, TrendPanel, OpsStatusPanel, OutletsPanel),
 * `components/admin/**` (UsersPanel, MasterDataPanel, AuditPanel,
 * SettingsPanel) and `components/approvals/**`, cross-checked against
 * `dashboard.*`/`admin.*`/`approvals*` in `lib/i18n/id.ts`. "Laporan" for
 * this role actually lives inside the Keuangan module (see §2) — there is
 * no separate reports screen under Dasbor or Administrasi.
 */
export const pemilikManajerManual: DocManual = {
  slug: 'pemilik-manajer',
  title: 'Panduan Pemilik / Manajer',
  audience: 'Pemilik & Manajer',
  permission: ['dashboard.view', 'dashboard.outlet.view'],
  blurb: 'Dasbor, laporan, pengaturan, dan persetujuan lintas outlet.',
  minutes: 11,
  order: 6,
  sections: [
    {
      id: 'dasbor',
      heading: '1. Dasbor',
      blocks: [
        {
          type: 'p',
          text: 'Setiap tampilan Dasbor selalu dibuka dengan pita cakupan yang jelas: **"Seluruh Perusahaan (Semua Outlet)"** untuk Pemilik/Manajer, dengan keterangan "Angka ini mencakup semua outlet — bukan satu outlet saja." Tidak ada dropdown filter outlet terpisah — cakupannya memang selalu seluruh perusahaan untuk peran ini.',
        },
        {
          type: 'p',
          text: 'Tombol **Segarkan Data** di pojok atas memuat ulang seluruh data dasbor secara manual.',
        },
        {
          type: 'p',
          text: 'Ada empat tab:',
        },
        {
          type: 'list',
          items: [
            '**Ringkasan** — kartu KPI (Pendapatan, Pendapatan Online, Estimasi Laba, Jumlah Transaksi, Rata-rata Nilai Transaksi, Outlet Aktif, masing-masing dengan perbandingan ke periode sebelumnya), grafik **Tren Penjualan**, dan panel **Status Operasional** — delapan indikator seperti Outlet Stok Menipis, Surat Jalan Dalam Perjalanan, Menunggu Persetujuan, Pelanggaran Suhu (24 Jam), yang menyala saat nilainya lebih dari nol.',
            '**Outlet** — tabel seluruh outlet (pendapatan, transaksi, shift terbuka, item stok menipis, perangkat offline); klik satu baris untuk membuka rincian per outlet (tren per jam, produk terlaris, staf yang sedang bertugas).',
            '**Produk Terlaris** — 10 produk dengan penjualan tertinggi pada rentang tanggal yang dipilih.',
            '**KPI Staf** — jumlah transaksi, total penjualan, tingkat kehadiran, dan jumlah keterlambatan per pegawai.',
          ],
        },
      ],
    },
    {
      id: 'laporan',
      heading: '2. Laporan',
      blocks: [
        {
          type: 'callout',
          kind: 'note',
          text: 'Laporan akuntansi (Neraca Saldo, Laba Rugi, Neraca, Nilai Stok) tidak ada di menu Dasbor — laporan-laporan ini ada di tab **Laporan** pada menu **Keuangan**. Lihat Panduan Keuangan §4 untuk rinciannya. Saat ini laporan hanya bisa dilihat di layar; belum ada tombol ekspor/unduh di aplikasi.',
        },
      ],
    },
    {
      id: 'pengaturan',
      heading: '3. Pengaturan (Administrasi)',
      blocks: [
        {
          type: 'p',
          text: 'Menu **Administrasi** punya empat tab:',
        },
        {
          type: 'list',
          items: [
            '**Pengguna** — cari, saring per Peran/Status, **Tambah Pengguna** (Username, Nama Lengkap, Email, No. Telepon, Kata Sandi, Peran, Lokasi). Anda hanya bisa memberi peran di bawah peran Anda sendiri. Dari detail pengguna: Ubah Peran, Ubah Lokasi, Reset Kata Sandi, atau Nonaktifkan (perlu konfirmasi — sesi dan kredensial offline pengguna itu langsung dicabut).',
            '**Data Master** — kelola Item, Kategori & Satuan, Produk & Resep, serta Lokasi & Area Simpan (termasuk tipe area: Freezer, Chiller, Gudang Kering, Display, Lini Dapur).',
            '**Jejak Audit** — riwayat perubahan lintas modul, bisa disaring per jenis entitas/pengguna/modul/tanggal; setiap baris punya rincian **Sebelum/Sesudah**.',
            '**Pengaturan** — pengaturan umum sistem, dan kartu terpisah **Mode Payroll Statutori (BPJS/PPh21)** untuk mengaktifkan/menonaktifkan mode payroll resmi (tabel tarif BPJS/PPh21 itu sendiri dikelola Keuangan/Admin SDM, bukan di kartu ini).',
          ],
        },
      ],
    },
    {
      id: 'persetujuan',
      heading: '4. Persetujuan',
      blocks: [
        {
          type: 'p',
          text: 'Buka **Persetujuan Menunggu** (`/approvals`) — daftar ini sudah disaring server sehingga Anda hanya melihat dokumen yang memang wewenang Anda: Permintaan Barang, Permintaan Pembelian, Pesanan Pembelian, Stock Opname, Retur, Proses Payroll, Pengajuan Cuti, Pinjaman Karyawan, Selisih Kas, dan Waste.',
        },
        {
          type: 'callout',
          kind: 'rule',
          text: 'Tombol **Setujui/Tolak** hanya muncul bila langkah yang sedang menunggu memang milik Anda. Bila dokumen sudah Anda setujui dan kini menunggu peran lain, panel keputusan tidak ditampilkan lagi — riwayatnya tetap terlihat.',
        },
        {
          type: 'p',
          text: 'Manajer yang dibatasi ke cabang tertentu tetap melihat **Permintaan Pembelian** dan **Pesanan Pembelian**, walaupun dokumen itu bermuara di Gudang Pusat. Gudang bukan milik satu cabang, jadi pembatasan cabang tidak menyembunyikannya.',
        },
        {
          type: 'p',
          text: 'Menolak selalu wajib mengisi **Alasan Penolakan** sebelum **Konfirmasi Tolak** aktif. Menyetujui butuh Catatan opsional — kecuali untuk **Selisih Kas**, di mana catatan wajib diisi bahkan untuk menyetujui.',
        },
        {
          type: 'callout',
          kind: 'note',
          text: 'Dua jenis dokumen tidak bisa disetujui dari layar ini: **Void/Refund** (persetujuannya memakai PIN di modul Kasir/POS) dan **Verifikasi Pembayaran** (keputusannya menyatu dengan aksi "Bayar" di modul Keuangan). Untuk keduanya, layar ini hanya menyediakan tombol Tolak.',
        },
      ],
    },
  ],
};
