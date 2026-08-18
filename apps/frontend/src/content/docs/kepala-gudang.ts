import type { DocManual } from './types';

/**
 * Kepala Gudang manual — written from `components/warehouse/**` (ApprovalQueuePanel,
 * ReplenishmentApproveForm, ReceivingPanel, SjCreateForm, StockOpnamePanel),
 * `app/delivery/**` (SuratJalanDetailDrawer) and the `warehouse.*`/`delivery.*`
 * namespaces in `lib/i18n/id.ts`. Confirmed against `packages/shared/src/rbac.ts`
 * (coordinator check): Kepala Gudang holds `opname.approve`, `waste.approve`,
 * and `return.approve` alongside `replenishment.approve.warehouse` — so §1
 * states positively that Stock Opname, Waste, and Retur documents share the
 * same approval queue, rather than hedging on it.
 */
export const kepalaGudangManual: DocManual = {
  slug: 'kepala-gudang',
  title: 'Panduan Kepala Gudang',
  audience: 'Kepala Gudang',
  permission: ['replenishment.approve.warehouse', 'delivery.read', 'purchasing.read'],
  blurb: 'Antrean persetujuan, penerimaan PO, buat & kirim Surat Jalan, opname gudang.',
  minutes: 12,
  order: 3,
  sections: [
    {
      id: 'antrean-persetujuan',
      heading: '1. Antrean Persetujuan',
      blocks: [
        {
          type: 'p',
          text: 'Tab **Antrean Persetujuan** di **/warehouse** menampilkan permintaan barang yang sudah lolos persetujuan Supervisor dan menunggu keputusan gudang — tabel **"Menunggu Persetujuan Gudang"** menyertakan kolom **Keputusan Supervisor** sehingga Anda melihat riwayatnya sebelum memutuskan.',
        },
        {
          type: 'p',
          text: 'Buka detail untuk meninjau tiap baris: Barang, Diminta, dan centang **Ubah baris ini** bila jumlah perlu dikurangi/diubah. Mengubah sebuah baris mewajibkan diisi **Alasan Perubahan** — banner peringatan muncul ("{{jumlah}} baris jumlahnya diubah — alasan wajib diisi sebelum disetujui") dan tombol **Setujui** tetap nonaktif sampai semua baris yang diubah punya alasan.',
        },
        {
          type: 'p',
          text: 'Ketuk **Tolak** untuk menolak — wajib isi **Alasan Penolakan** lalu **Konfirmasi Tolak**. Ketuk **Setujui** untuk menyetujui (dengan atau tanpa perubahan jumlah, plus Catatan opsional).',
        },
        {
          type: 'p',
          text: 'Permintaan yang disetujui pindah ke tabel **"Disetujui — Siap Diproses"**. Ketuk **Mulai Pemrosesan** untuk menandai pengambilan barang sudah dimulai — lakukan ini sebelum membuat Surat Jalan untuk permintaan tersebut.',
        },
        {
          type: 'p',
          text: 'Selain Permintaan Barang, layar **Persetujuan Menunggu** (`/approvals`) juga menampilkan dokumen **Stock Opname**, **Waste**, dan **Retur** yang menunggu keputusan Anda — Kepala Gudang memang diberi wewenang menyetujui ketiganya, bukan hanya Permintaan Barang. Ketiganya memakai panel persetujuan umum yang sama: isi **Catatan** (opsional) lalu **Setujui**, atau ketuk **Tolak** dan isi **Alasan Penolakan** (wajib) sebelum **Konfirmasi Tolak**.',
        },
      ],
    },
    {
      id: 'penerimaan-po',
      heading: '2. Penerimaan PO',
      blocks: [
        {
          type: 'p',
          text: 'Tab **Penerimaan PO** menampilkan Purchase Order berstatus Diterbitkan atau Diterima Sebagian. Buka salah satu untuk mencatat penerimaan barang dari supplier.',
        },
        {
          type: 'p',
          text: 'Untuk setiap baris: **Dipesan** dan **Sudah Diterima** hanya untuk ditinjau (tidak bisa diubah); isi **Diterima Sekarang**, pilih **Area Penyimpanan**, dan tambahkan **Catatan Kondisi** bila barang tidak dalam kondisi sempurna.',
        },
        {
          type: 'callout',
          kind: 'rule',
          text: 'Wajib foto. **Foto Barang Diterima** wajib untuk seluruh penerimaan (satu foto mewakili seluruh PO, bukan per baris) — tombol **Kirim** nonaktif tanpa foto, tanpa minimal satu baris terisi, atau bila ada baris yang belum punya area penyimpanan.',
        },
        {
          type: 'p',
          text: 'Setelah dikirim, muncul notifikasi **"Penerimaan PO berhasil dicatat"**. PO yang seluruh barisnya sudah lengkap diterima berubah status menjadi **Diterima**; bila masih ada sisa, tetap **Diterima Sebagian**.',
        },
      ],
    },
    {
      id: 'buat-kirim-sj',
      heading: '3. Buat & Kirim Surat Jalan',
      blocks: [
        {
          type: 'p',
          text: 'Buka menu **Pengiriman** (di /delivery — tab Pengiriman di /warehouse hanya menampilkan ringkasan dan mengarahkan ke sana). Ketuk **Buat Surat Jalan**.',
        },
        {
          type: 'callout',
          kind: 'rule',
          text: 'Barang beku/dingin dan kering tidak boleh digabung dalam satu Surat Jalan. Pilih **Tipe Pengiriman** lebih dulu — **Beku/Dingin** (truk chiller, membawa barang chiller maupun freezer sekaligus) atau **Kering (Sembako)** (truk biasa). Pilihan ini menyaring barang mana saja yang bisa disertakan; permintaan yang tidak punya barang cocok ditampilkan abu-abu dengan keterangan "Tidak ada barang yang cocok dengan tipe pengiriman ini".',
        },
        {
          type: 'steps',
          items: [
            'Centang permintaan yang disetujui untuk disertakan — baris yang tidak cocok dengan tipe pengiriman otomatis dikeluarkan (ditandai "X baris tidak disertakan karena beda tipe pengiriman").',
            'Tinjau **Rute Multi-Drop** — sistem mengelompokkan barang per outlet tujuan menjadi "Drop 1", "Drop 2", dst.',
            'Pilih **Driver** dan **Kendaraan**. Kendaraan dengan freezer ditandai ❄; untuk Tipe Pengiriman Beku/Dingin, kendaraan tanpa freezer akan ditolak ("Kendaraan ini tidak punya freezer — tidak bisa untuk pengiriman beku/dingin").',
            'Isi **Tanggal Rencana Kirim** dan **Catatan** (opsional), lalu ketuk **Buat Surat Jalan**.',
          ],
        },
        {
          type: 'p',
          text: 'Setelah dibuat, ikuti alur status di layar detail Surat Jalan:',
        },
        {
          type: 'table',
          headers: ['Langkah', 'Tombol', 'Syarat'],
          rows: [
            ['Draft → Siap Kirim', 'Tandai Siap Kirim', '—'],
            [
              'Siap Kirim → Memuat Barang',
              'Muat Barang',
              'Minimal satu Nomor Segel wajib diisi; Suhu Muat wajib untuk Beku/Dingin (tidak wajib untuk Kering)',
            ],
            ['Memuat Barang → Dalam Perjalanan', 'Berangkatkan', '—'],
            ['Kapan saja sebelum Dalam Perjalanan', 'Batalkan', 'Alasan Pembatalan wajib diisi'],
          ],
        },
        {
          type: 'callout',
          kind: 'note',
          text: 'Berangkat/tiba/serah-terima per drop bukan aksi Kepala Gudang — layar ini hanya menampilkan status dan suhu tiap drop secara read-only; driver dan outlet yang mengeksekusinya (lihat Panduan Driver dan Panduan Supervisor Outlet).',
        },
        {
          type: 'p',
          text: 'Pelanggaran suhu ditandai badge merah "Suhu di luar batas" pada drop terkait; drop yang selesai dengan selisih jumlah ditandai "Ada selisih pada drop ini".',
        },
      ],
    },
    {
      id: 'opname-gudang',
      heading: '4. Opname Gudang',
      blocks: [
        {
          type: 'steps',
          items: [
            'Ketuk **Mulai Opname**, pilih **Area Penyimpanan**, ketuk **Lanjut**.',
            'Isi **Hasil Hitung** per barang di lembar hitung — **Selisih** terhitung otomatis dari Stok Sistem.',
            'Isi **Alasan** untuk setiap baris yang selisih (wajib — banner "Setiap baris yang selisih wajib diisi alasannya sebelum diajukan" akan muncul jika belum lengkap).',
            'Ketuk **Simpan** untuk menyimpan progres, atau **Kirim** untuk mengajukan lembar hitung.',
          ],
        },
        {
          type: 'p',
          text: 'Status: Draft, Sedang Menghitung, Diajukan, Disetujui, Ditolak, Sudah Disesuaikan, Dibatalkan.',
        },
      ],
    },
    {
      id: 'aturan-penting',
      heading: '5. Aturan yang Wajib Diingat',
      blocks: [
        {
          type: 'list',
          items: [
            'Barang beku/dingin dan kering tidak pernah boleh digabung dalam satu Surat Jalan (aturan gudang, FR-LOG-02).',
            'Suhu muat wajib dicatat untuk pengiriman Beku/Dingin; tidak wajib untuk Kering. Nomor segel wajib untuk semua pengiriman, apa pun tipenya.',
            'Kendaraan tanpa freezer tidak bisa dipakai untuk pengiriman Beku/Dingin.',
            'Foto wajib pada penerimaan PO — tanpa foto, penerimaan tidak bisa disimpan.',
            'Mengubah jumlah pada persetujuan permintaan barang selalu butuh alasan tertulis.',
            'Menolak dokumen apa pun selalu butuh alasan tertulis.',
            'Selisih pada stock opname selalu butuh alasan sebelum bisa diajukan.',
          ],
        },
      ],
    },
  ],
};
