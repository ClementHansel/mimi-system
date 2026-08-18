import type { DocManual } from './types';

/**
 * Keuangan manual — written from `components/finance/**` (PaymentsPanel,
 * JournalPanel, FiscalPeriodsPanel, ReportsPanel) and the `finance.*`
 * namespace in `lib/i18n/id.ts`. §3 flags a real gap found in the backend
 * (`fiscal-periods.service.ts`): closing a period does not actually check
 * for unverified payments or unposted entries, despite that being the
 * documented rule — this is reported as-is, not softened.
 *
 * §1 opens with an explicit "Dasbor is not for you" note: confirmed against
 * `packages/shared/src/rbac.ts` (coordinator check) that Finance holds
 * NEITHER `dashboard.view` NOR `dashboard.outlet.view` — a Finance user may
 * still see the "Dasbor" tile on the home hub (other permissions can put a
 * different item there), but opening it fails/empties for them. Their real
 * numbers live in this module's own §4 Laporan.
 */
export const keuanganManual: DocManual = {
  slug: 'keuangan',
  title: 'Panduan Keuangan',
  audience: 'Keuangan',
  permission: ['payment.read', 'accounting.journal.read'],
  blurb: 'Verifikasi pembayaran, jurnal, tutup periode, dan laporan keuangan.',
  minutes: 10,
  order: 5,
  sections: [
    {
      id: 'verifikasi-pembayaran',
      heading: '1. Verifikasi Pembayaran',
      blocks: [
        {
          type: 'callout',
          kind: 'note',
          text: 'Peran Keuangan tidak memiliki akses ke menu **Dasbor** — bila Anda melihat tandanya di beranda, itu untuk peran lain. Angka penjualan, laba rugi, neraca, dan nilai stok Anda ada di modul ini sendiri, di tab **Laporan** (lihat §4 di bawah).',
        },
        {
          type: 'p',
          text: 'Tab **Verifikasi Pembayaran** menampilkan antrean pembayaran dengan status **Belum Terverifikasi**, **Terverifikasi**, **Dibayar**, atau **Ditolak** — bisa disaring per status dan jenis referensi (Pembayaran Penjualan, Purchase Order, Penggajian, Kas Kecil, dll).',
        },
        {
          type: 'p',
          text: 'Untuk pembayaran manual/lain-lain (THR, insentif, biaya lain yang tidak berasal dari dokumen lain), gunakan **Catat Pembayaran Baru**.',
        },
        {
          type: 'p',
          text: 'Setiap pembayaran mengikuti alur yang sama:',
        },
        {
          type: 'steps',
          items: [
            'Buka detail, unggah **Berkas Bukti** di bagian **Unggah Bukti Pembayaran** (selama status masih Belum Terverifikasi).',
            'Ketuk **Verifikasi** di bagian **Verifikasi Pembayaran** — tombol ini tetap nonaktif dengan keterangan "Bukti pembayaran harus diunggah sebelum dapat diverifikasi" sampai buktinya ada.',
            'Setelah Terverifikasi, ketuk **Tandai Dibayar** di bagian **Tandai Sudah Dibayar**, pilih Metode Pembayaran (Tunai/Transfer Bank/QRIS).',
          ],
        },
        {
          type: 'callout',
          kind: 'rule',
          text: 'Bukti pembayaran wajib diunggah sebelum verifikasi bisa dilakukan. Menolak pembayaran (tombol **Tolak**, tersedia selama status Belum Terverifikasi atau Terverifikasi) selalu wajib disertai **Alasan Penolakan** sebelum **Konfirmasi Tolak** aktif.',
        },
      ],
    },
    {
      id: 'jurnal',
      heading: '2. Jurnal',
      blocks: [
        {
          type: 'p',
          text: 'Tab **Jurnal** menampilkan entri dari dua sumber: **Sistem** (dibuat otomatis oleh mesin posting saat dokumen lain diproses) dan **Manual** (dibuat sendiri di sini). Saring dengan rentang tanggal, Sumber, atau Kode Akun.',
        },
        {
          type: 'p',
          text: 'Untuk membuat entri manual, ketuk **Posting Entri Manual**. Isi Tanggal Entri dan Keterangan, lalu tambahkan baris Akun/Debit/Kredit/Memo.',
        },
        {
          type: 'callout',
          kind: 'rule',
          text: 'Debit harus sama dengan kredit. Indikator "Seimbang (debit = kredit)" harus hijau sebelum entri bisa disimpan — bila belum, muncul "Belum seimbang — debit dan kredit harus sama" dan tombol Simpan tetap nonaktif.',
        },
        {
          type: 'p',
          text: 'Entri yang sudah terposting tidak pernah diedit langsung. Untuk membetulkan kesalahan, buka detail entri dan ketuk **Balik Entri (Reverse)** — wajib isi **Alasan Pembalikan**. Ini membuat entri pembalik baru, bukan menghapus/mengubah entri asli.',
        },
      ],
    },
    {
      id: 'tutup-periode',
      heading: '3. Tutup Periode',
      blocks: [
        {
          type: 'p',
          text: 'Tab **Periode Fiskal** menampilkan status tiap periode: **Terbuka**, **Ditutup**, atau **Terkunci**. Selama status masih Terbuka, tombol **Tutup Periode** tersedia; isi Catatan (opsional) lalu konfirmasi.',
        },
        {
          type: 'callout',
          kind: 'warning',
          text: 'Periksa sendiri sebelum menutup periode — sistem tidak melakukannya untuk Anda. Menutup periode saat ini hanya memeriksa bahwa periode itu masih berstatus Terbuka; sistem TIDAK secara otomatis memblokir penutupan meski masih ada pembayaran yang belum terverifikasi atau entri jurnal yang belum terposting untuk periode itu — walau itulah aturan yang seharusnya berlaku. Pastikan secara manual seluruh pembayaran dan entri periode tersebut sudah beres sebelum menutupnya.',
        },
        {
          type: 'p',
          text: 'Periode yang sudah Ditutup bisa dibuka kembali lewat tombol **Buka Kembali** — wajib isi **Alasan Membuka Kembali**. Periode yang sudah berstatus **Terkunci** tidak pernah bisa dibuka kembali (tidak ada tombolnya).',
        },
        {
          type: 'p',
          text: 'Setelah sebuah periode ditutup, sistem menolak entri jurnal baru yang tanggalnya jatuh di periode tersebut sampai periode itu dibuka kembali.',
        },
      ],
    },
    {
      id: 'laporan',
      heading: '4. Laporan',
      blocks: [
        {
          type: 'p',
          text: 'Tab **Laporan** punya empat sub-tab, semuanya untuk dilihat langsung di layar (belum ada tombol ekspor/unduh):',
        },
        {
          type: 'table',
          headers: ['Sub-tab', 'Isi'],
          rows: [
            [
              'Neraca Saldo',
              'Akun, Tipe, Debit, Kredit per periode, dengan indikator Seimbang/Tidak Seimbang',
            ],
            ['Laba Rugi', 'Pendapatan dan Beban untuk rentang tanggal, plus Laba Bersih'],
            ['Neraca', 'Aset, Liabilitas, Ekuitas per tanggal tertentu'],
            ['Nilai Stok', 'Nilai persediaan per lokasi dan kategori, dengan Total Keseluruhan'],
          ],
        },
      ],
    },
  ],
};
