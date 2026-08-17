import type { DocManual } from './types';

/**
 * Driver manual — written from `components/driver/**` (DriverJobsPanel,
 * SjJobCard, DropCard, DropDepartModal/DropArriveModal/DropReceiveModal/
 * DropFailModal) and the `driver.*` namespace in `lib/i18n/id.ts`. The
 * "load"-stage temperature label exists in the dictionary but no driver
 * screen submits it — flagged rather than described as something the driver
 * does.
 */
export const driverManual: DocManual = {
  slug: 'driver',
  title: 'Panduan Driver',
  audience: 'Driver',
  permission: 'delivery.drop.execute',
  blurb: 'Surat Jalan hari ini, berangkat, tiba, serah terima, dan suhu rantai dingin.',
  minutes: 7,
  order: 4,
  sections: [
    {
      id: 'sj-hari-ini',
      heading: '1. Surat Jalan Hari Ini',
      blocks: [
        {
          type: 'p',
          text:
            'Layar utama Driver menampilkan **Surat Jalan Hari Ini** — daftar Surat Jalan yang masih berjalan (Siap Kirim, Memuat Barang, atau Dalam Perjalanan). Bila tidak ada tugas, layar menampilkan **"Tidak ada Surat Jalan untuk hari ini"**.',
        },
        {
          type: 'p',
          text:
            'Setiap kartu Surat Jalan menunjukkan nomor SJ, nomor polisi kendaraan, **Tipe Pengiriman** (Beku/Dingin atau Kering/Sembako), nomor segel, dan status SJ. Di bawahnya, tiap **Drop** (titik pengiriman) ditampilkan dengan nama & kota tujuan, status, dan waktu Berangkat/Tiba/Serah Terima begitu tercatat.',
        },
        {
          type: 'callout',
          kind: 'note',
          text:
            'Muat ulang daftar dengan tombol refresh bila baru terhubung ke internet — daftar dimuat sekali di awal (idealnya saat masih ada WiFi gudang) supaya tetap bisa dipakai sepanjang rute meski sinyal hilang.',
        },
      ],
    },
    {
      id: 'berangkat',
      heading: '2. Berangkat',
      blocks: [
        {
          type: 'p',
          text: 'Untuk drop yang belum dimulai, ketuk **Berangkat**.',
        },
        {
          type: 'p',
          text:
            'Isi **Suhu Muat Sebelum Berangkat** — wajib untuk pengiriman **Beku/Dingin**, opsional untuk **Kering**. Ketuk **Konfirmasi Berangkat**.',
        },
        {
          type: 'p',
          text:
            'Notifikasi **"Keberangkatan tersimpan — akan tersinkron otomatis saat koneksi tersedia"** muncul — data tersimpan di perangkat dan tersinkron otomatis begitu ada koneksi, jadi aksi ini tetap bisa dilakukan meski sinyal hilang di jalan.',
        },
      ],
    },
    {
      id: 'tiba-serah-terima',
      heading: '3. Tiba di Lokasi & Serah Terima',
      blocks: [
        {
          type: 'p',
          text: 'Setibanya di tujuan, ketuk **Tiba di Lokasi**.',
        },
        {
          type: 'callout',
          kind: 'rule',
          text: '**Suhu Saat Tiba wajib diisi untuk semua tipe pengiriman** — berbeda dari suhu keberangkatan, ini tidak bisa dilewati sekalipun untuk barang kering.',
        },
        {
          type: 'p',
          text:
            'Bila Surat Jalan ini punya segel, kolom **Cek Segel** muncul — pilih **Segel Utuh** atau **Segel Rusak**. Bila memilih Segel Rusak, isi **Catatan Segel Rusak** (wajib). Ketuk **Konfirmasi Tiba**.',
        },
        {
          type: 'p',
          text:
            'Langkah terakhir per drop adalah **Serah Terima** — ini titik pemeriksaan paling ketat di seluruh alur. Untuk setiap barang di tabel, isi **Diterima** (boleh berbeda dari Dikirim) dan pilih **Area Penyimpanan** tujuan. Bila jumlah diterima berbeda dari yang dikirim, kolom **Alasan Selisih** wajib diisi.',
        },
        {
          type: 'callout',
          kind: 'rule',
          text:
            'Serah Terima tidak bisa dikonfirmasi tanpa: **Foto Serah Terima**, tanda tangan **Penerima**, jumlah + area penyimpanan terisi di setiap baris, dan alasan pada setiap baris yang selisih. Suhu saat serah terima bersifat opsional di langkah ini.',
        },
        {
          type: 'p',
          text:
            'Ketuk **Konfirmasi Serah Terima**. Bila seluruh barang sesuai jumlah, drop selesai dengan status **Selesai**; bila ada selisih di satu atau lebih baris, statusnya **Selesai (Ada Selisih)**.',
        },
      ],
    },
    {
      id: 'gagal-kirim',
      heading: '4. Gagal Kirim',
      blocks: [
        {
          type: 'p',
          text:
            'Bila pengiriman ke suatu drop tidak bisa diselesaikan, ketuk **Gagal Kirim** (tersedia di sebelah tombol aksi utama), isi **Alasan Gagal Kirim** (wajib), lalu **Konfirmasi Gagal Kirim**.',
        },
        {
          type: 'callout',
          kind: 'warning',
          text:
            'Berbeda dari Berangkat/Tiba/Serah Terima, aksi Gagal Kirim membutuhkan koneksi internet aktif saat itu juga — tidak tersimpan otomatis untuk disinkron nanti. Bila gagal karena tidak ada koneksi, pesan **"Gagal menyimpan — periksa koneksi lalu coba lagi"** akan muncul; coba lagi setelah sinyal kembali.',
        },
      ],
    },
    {
      id: 'rantai-dingin',
      heading: '5. Bukti Foto & Suhu Rantai Dingin',
      blocks: [
        {
          type: 'table',
          headers: ['Tahap', 'Kapan dicatat', 'Wajib?'],
          rows: [
            ['Suhu Muat Sebelum Berangkat', 'Saat Berangkat', 'Wajib untuk Beku/Dingin, opsional untuk Kering'],
            ['Suhu Saat Tiba', 'Saat Tiba di Lokasi', 'Selalu wajib'],
            ['Suhu Saat Serah Terima', 'Saat Serah Terima', 'Opsional'],
          ],
        },
        {
          type: 'p',
          text:
            'Sistem tidak menilai suhu di perangkat driver — pusat yang menentukan apakah suhu melanggar batas aman (truk Beku/Dingin membawa barang chiller dan freezer sekaligus dengan batas berbeda). Hasil penilaian muncul kembali sebagai chip pada kartu drop; bila melanggar, muncul keterangan **"Pelanggaran rantai dingin — di luar batas aman"** dengan warna merah.',
        },
        {
          type: 'p',
          text:
            'Foto hanya diambil satu kali per drop, di langkah Serah Terima — foto ini adalah bukti serah terima barang, bukan foto kondisi produk atau foto segel terpisah. Nomor segel sendiri sudah tercatat di data Surat Jalan; driver hanya memilih status Segel Utuh/Segel Rusak, bukan mengetik ulang nomornya.',
        },
      ],
    },
  ],
};
