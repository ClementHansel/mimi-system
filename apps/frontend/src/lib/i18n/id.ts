/**
 * Bahasa Indonesia — the ONLY locale (BUILD-PLAN collision rule §6.9: no
 * hardcoded user-facing strings anywhere, ever; English is for code/comments
 * only). Wave 4–5 agents add keys here as they build real screens; they never
 * need to touch `i18n/index.tsx`.
 *
 * Structure: a nested object, looked up by dot-path (`t('nav.pos')`,
 * `t('status.replenishment.approved')`). Keep new keys grouped under the
 * closest existing namespace instead of inventing a new top-level one.
 */
export const id = {
  shell: {
    appName: 'Mimi Chicken OS',
    tagline: 'Sistem Operasional Mimi Chicken',
    skipToContent: 'Langsung ke konten',
    toggleSidebar: 'Buka/tutup menu',
    search: 'Cari…',
    notifications: 'Notifikasi',
    noNotifications: 'Tidak ada notifikasi baru',
    profile: 'Profil',
    myAccount: 'Akun Saya',
    logout: 'Keluar',
    switchLocation: 'Pindah Lokasi',
  },

  nav: {
    section: {
      operasional: 'Operasional',
      logistik: 'Logistik & Gudang',
      keuangan: 'Keuangan',
      sdm: 'SDM',
      sistem: 'Sistem',
      // The sidebar's interface switcher, for roles that work in more than one
      // interface and have no hub to return to (owner/superadmin get `home`).
      antarmuka: 'Antarmuka Lain',
      // Per-interface section headings. `gudang` covers what the owner calls
      // "the items and their movement": stock on the floor, and the Surat
      // Jalan that takes it out of the building.
      gudang: 'Barang & Pergerakan',
      outlet: 'Outlet',
      driver: 'Pengiriman',
      referensi: 'Referensi',
      // Chats + Mail are in every interface (owner, 2026-08-27); WhatsApp sits
      // in this same section but only in the dashboard.
      pesan: 'Pesan',
      // POS's own section. Never drawn at the till (POS is chromeless) — it is
      // the sidebar a cashier gets on Chats/Mail, which keeps them in POS.
      kasir: 'Kasir',
      // The `employee` interface's own section — everything about yourself.
      personal: 'Personal',
    },
    // The way back to the hub (`/`) — rendered by the sidebar for owner and
    // superadmin only, the two roles the hub belongs to.
    home: 'Beranda',
    approvals: 'Persetujuan Saya',
    pos: 'Kasir (POS)',
    dashboard: 'Dasbor',
    outlet: 'Outlet',
    warehouse: 'Gudang Pusat',
    purchasing: 'Pembelian',
    chat: 'Pesan (WhatsApp)',
    finance: 'Keuangan',
    hr: 'SDM & Absensi',
    assets: 'Aset & Maintenance',
    admin: 'Administrasi',
    me: 'Akun Saya',
    topology: 'Topologi Perangkat',
    driver: 'Pengiriman (Driver)',
    delivery: 'Pengiriman (Dispatcher)',
    docs: 'Dokumentasi',
    // The `employee` interface (`/me`). Titled as the person's own account
    // rather than "Karyawan": on their phone this is *their* space, not an HR
    // module about them.
    employee: 'Akun Saya',
    // Your own thread with head office (`/me/chat`). Renamed from "Pesan
    // Saya" to "Mail" (owner, 2026-08-27) so it reads distinctly from `chat`
    // above (the WhatsApp inbox, dashboard-only) and from Chats.
    myChat: 'Mail',
  },

  auth: {
    loginTitle: 'Masuk ke Mimi Chicken OS',
    loginSubtitle: 'Masukkan username dan kata sandi Anda',
    username: 'Username',
    usernamePlaceholder: 'mis. kasir01',
    password: 'Kata Sandi',
    passwordPlaceholder: '••••••••',
    submit: 'Masuk',
    submitting: 'Memproses…',
    invalidCredentials: 'Username atau kata sandi salah.',
    accountInactive: 'Akun ini sudah tidak aktif. Hubungi admin.',
    genericError: 'Gagal masuk. Silakan coba lagi.',
    sessionExpired: 'Sesi Anda telah berakhir. Silakan masuk kembali.',
    offlineNotice: 'Anda sedang offline. Masuk memerlukan koneksi pertama kali di perangkat ini.',
    mustSetPin: 'Atur PIN 6-digit Anda sebelum melanjutkan (dibutuhkan untuk otorisasi di POS).',
    showPassword: 'Tampilkan kata sandi',
    hidePassword: 'Sembunyikan kata sandi',
    // Brand panel copy (F-BRAND) — real, verified Mimi Chicken facts only
    // (no fabricated logo/colours/claims). Kept in `auth` alongside the rest
    // of the login screen's strings rather than a new top-level namespace.
    brandHeadline: 'Ayam Geprek & Fried Chicken, Renyah di Setiap Outlet',
    brandTagline:
      'Satu sistem untuk kasir, gudang pusat, dan dapur — dari Samarinda sampai Balikpapan.',
    brandOutlets:
      'Samarinda: Loa Janan · Lambung · Bung Tomo — Balikpapan: Gunung Guntur · Sepinggan · Karang Rejo',
    brandHours: 'Buka 09.00–22.00 WITA (Senin–Jumat), 09.00–23.00 WITA (Sabtu–Minggu)',
    brandFooter: '© {{year}} Mimi Chicken · @mimichicken.official',
  },

  // Role display names (CONTRACTS §2.1 RoleKey / §3 columns) — used by
  // ApprovalTimeline, the user directory, and anywhere a role key needs a
  // human label instead of its raw `snake_case` wire value.
  role: {
    owner: 'Pemilik',
    manager: 'Manajer',
    finance: 'Keuangan',
    kepala_gudang: 'Kepala Gudang',
    supervisor: 'Supervisor Cabang',
    // Retired 2026-08-23 (migration 237). The label stays because approvals,
    // audit rows and sync payloads already name this role, and they should
    // render as what they were rather than as a raw snake_case key.
    leader_outlet: 'Leader/Staff Outlet (nonaktif)',
    kasir: 'Kasir',
    hr_admin: 'Admin SDM',
    driver: 'Driver',
    koki: 'Juru Masak',
    superadmin: 'Super Admin',
  },

  // The home hub (`app/page.tsx`) — a directory of the SIX interfaces
  // (owner's ruling, 2026-08-21). Titles come from `nav.*` via
  // `lib/nav.ts`'s `INTERFACES`; this namespace only supplies the hub's own
  // chrome copy and one blurb per interface, so it can never grow a 7th card
  // on its own. The per-area blurbs the old card-per-route hub needed
  // (approvals/purchasing/finance/hr/admin/…) are gone with it: those are
  // sections inside the dashboard, not interfaces.
  hub: {
    overline: 'ANTARMUKA',
    greeting: 'Halo, {{name}}',
    // A central role (Owner/Manager/Finance/HR Admin) legitimately carries
    // an empty `locations` array — it means "not restricted to one outlet",
    // not "nobody assigned this yet" — so the empty case reads as "Semua
    // Lokasi", never as an incomplete-setup warning.
    allOutlets: 'Semua Lokasi',
    multipleOutlets: '{{count}} Lokasi',
    roleAtOutlet: '{{role}} · {{outlet}}',
    subtitle: 'Pilih antarmuka tempat Anda bekerja hari ini',
    // One sentence per interface, keyed by its `lib/nav.ts` id.
    surface: {
      dashboard:
        'Kantor pusat: ringkasan penjualan dan stok, persetujuan, pengiriman, pembelian, keuangan, SDM, aset, dan administrasi.',
      pos: 'Layani pesanan, terima pembayaran, dan kelola shift serta kas kecil di kasir cabang.',
      outlet:
        'Layar harian outlet: permintaan barang, penerimaan, stok opname, waste, dan kas kecil.',
      warehouse:
        'Operasional gudang pusat (frozen, chilled, dry): penerimaan, stok, dan pemenuhan permintaan outlet.',
      driver:
        'Layar mobile driver: Surat Jalan hari ini, rute, navigasi, dan serah terima per tujuan.',
      employee:
        'Data diri Anda: absensi, slip gaji, dan pengajuan cuti — semua tentang Anda sendiri.',
      docs: 'Panduan penggunaan langkah demi langkah — baca online atau unduh sebagai PDF.',
    },
    emptyTitle: 'Belum ada akses ke antarmuka manapun',
    emptyDescription: 'Hubungi admin untuk memberikan akses sesuai peran Anda.',
  },

  // F-DOCS (BUILD-PLAN W7-03) — the "Dokumentasi" workspace: `app/docs/**`.
  // Manual body copy itself lives in `content/docs/*.ts` (not here — that's
  // long-form prose per role, not reusable UI chrome); this namespace is
  // only the reader/index chrome shared across every manual.
  docs: {
    kicker: 'Dokumentasi',
    title: 'Panduan Pengguna',
    subtitle:
      'Panduan langkah demi langkah untuk setiap peran — baca online, atau unduh sebagai PDF.',
    emptyTitle: 'Belum ada manual untuk peran Anda',
    emptyDescription: 'Hubungi admin bila menurut Anda seharusnya ada manual yang bisa diakses.',
    minutesRead: '{{minutes}} menit baca',
    sectionsCount: '{{count}} bagian',
    downloadPdf: 'Unduh PDF',
    backToAll: 'Semua Manual',
    onThisPage: 'Di Halaman Ini',
    prev: 'Sebelumnya',
    next: 'Selanjutnya',
    notFoundTitle: 'Manual tidak ditemukan',
    notFoundDescription: 'Halaman ini tidak ada. Kembali ke daftar manual.',
    deniedTitle: 'Manual ini bukan untuk peran Anda',
    deniedDescription:
      'Manual ini ditujukan untuk peran lain. Hubungi admin bila Anda merasa ini keliru.',
    printKicker: 'Mimi Chicken OS · Manual Pengguna',
    printAudience: 'Untuk: {{audience}}',
    printFootline: 'Sistem operasional untuk gudang pusat dan jaringan outlet.',
    printedOn: 'Dicetak {{date}}',
  },

  // POS (F02) — cashier tablet, offline-first (CONTRACTS §4.13, SYNC-PROTOCOL §8 rows 1-3/16-17).
  pos: {
    noLocation: 'Outlet belum ditentukan',
    notCrossVisible:
      'Transaksi belum terlihat di tablet lain — akan muncul setelah tersambung kembali.',

    // F-POS-2 — standalone POS top bar (`PosTopBar`/`app/pos/layout.tsx`):
    // the compact "Cabang: X" under the brand mark, and the two reasons
    // `PosStatusBar`'s secondary line gives for why the till is operating as
    // that outlet (mirrors AIRE's "Operating branch: X — from your open
    // shift", built from Mimi's own assigned-vs-chosen mechanism).
    branchLabel: 'Cabang: {{name}}',
    branchReasonAssigned: 'Outlet ini ditetapkan untuk akun Anda.',
    branchReasonChosen: 'Berdasarkan outlet yang Anda pilih saat masuk.',

    chooseOutletTitle: 'Pilih Outlet',
    chooseOutletDescription:
      'Akun Anda tidak terikat ke satu outlet. Pilih outlet yang ingin Anda layani.',
    chooseOutletSubmit: 'Lanjutkan',
    changeOutlet: 'Ganti Outlet',
    outletLoadFailedTitle: 'Gagal memuat daftar outlet',
    outletLoadFailedDescription: 'Periksa koneksi internet Anda, lalu coba lagi.',
    runtimeLoadFailedTitle: 'Gagal menyiapkan perangkat kasir',
    runtimeLoadFailedDescription:
      'Terjadi kendala saat menyiapkan penyimpanan lokal perangkat ini. Coba lagi atau muat ulang halaman.',

    openShiftTitle: 'Buka Kasir',
    openShiftDescription: 'Masukkan jumlah modal awal kas sebelum mulai melayani transaksi.',
    openingCash: 'Modal Awal Kas',
    openingCashHint: 'Jumlah uang tunai di laci kasir saat shift dimulai.',
    openShiftSubmit: 'Buka Kasir',
    shiftOpenedTitle: 'Kasir dibuka',
    shiftOpenFailed: 'Gagal membuka kasir',

    closeShiftTitle: 'Tutup Kasir',
    closeShiftDescription: 'Hitung uang tunai di laci sebelum menutup shift.',
    localCashEstimate: 'Perkiraan Kas (lokal)',
    salesCount: 'Jumlah Transaksi',
    closingCashCounted: 'Uang Tunai Dihitung',
    localVarianceNote:
      'Selisih dari perkiraan lokal: {{amount}}. Angka final dihitung ulang oleh sistem pusat saat tersinkron.',
    closeShiftSubmit: 'Tutup Kasir',
    closeShiftFinalNote: 'Laporan shift final setelah tersinkron ke pusat.',
    shiftClosedTitle: 'Kasir ditutup',
    shiftClosedDescription: 'Laporan shift final akan tersedia setelah tersinkron.',
    shiftCloseFailed: 'Gagal menutup kasir',

    // F-POS-2 "Shift" tab (`ShiftPanel`) — the running totals already
    // accumulated in `shift-store.ts` (`recordSale`/`recordVoid`), just
    // surfaced permanently instead of only inside `ShiftCloseModal`.
    shiftPanelTitle: 'Ringkasan Shift',
    shiftPanelDescription:
      'Ringkasan berjalan sejak kasir dibuka. Angka final dihitung ulang oleh sistem pusat saat tersinkron.',
    shiftKasirLabel: 'Kasir',
    shiftOpenedAtLabel: 'Dibuka Pukul',
    grossSalesLabel: 'Total Penjualan (lokal)',
    voidCountLabel: 'Jumlah Void/Refund',

    tabKasir: 'Kasir',
    tabShift: 'Shift',

    // F-POS-3 — one POS interface, three prices (owner: "need only 1
    // interface for 3 of them"). GoFood/ShopeeFood used to be their own
    // tab/form; they're now a CHANNEL of the same till, toggled here.
    channelToggleLabel: 'Pilih channel penjualan',
    channelWalkIn: 'Kasir',
    channelGofood: 'GoFood',
    channelShopeefood: 'ShopeeFood',
    channelActiveLabel: 'Transaksi ini: {{channel}}',
    channelBannerActive: 'Mode channel aktif: {{channel}} — harga berbeda dari Kasir (walk-in).',
    channelSwitchConfirmTitle: 'Ganti Channel Penjualan?',
    channelSwitchConfirmDescription: 'Mengganti ke {{channel}} akan memperbarui harga.',
    channelSwitchConfirmBody:
      'Keranjang belum kosong. Semua harga item di keranjang akan diperbarui mengikuti channel baru. Item yang tidak ditemukan di katalog akan tetap memakai harga saat ini.',
    channelSwitchConfirmSubmit: 'Ganti & Perbarui Harga',
    catalogEmptyTitle: 'Katalog produk belum tersedia',
    catalogEmptyDescription:
      'Sambungkan perangkat ke internet minimal sekali untuk mengunduh katalog produk.',
    catalogOfflineNote:
      'Menampilkan katalog tersimpan terakhir — belum berhasil memuat data terbaru.',
    categoryFilter: 'Filter kategori',
    goToPayment: 'Lanjut ke Pembayaran',
    voidLastSale: 'Void Transaksi Terakhir',
    closeShift: 'Tutup Kasir',
    paymentTitle: 'Pembayaran',

    cartEmptyTitle: 'Keranjang masih kosong',
    cartEmptyDescription: 'Ketuk produk di sebelah kiri untuk menambahkan ke keranjang.',
    decreaseQty: 'Kurangi jumlah',
    increaseQty: 'Tambah jumlah',
    subtotal: 'subtotal',
    saleDiscount: 'Diskon Transaksi',

    paymentCash: 'Tunai',
    paymentQris: 'QRIS',
    paymentTransfer: 'Transfer',
    paymentStatusLabel: 'Status Pembayaran',
    transferPendingNote: 'Pembayaran transfer menunggu verifikasi Finance — belum dianggap lunas.',
    qrisSettleNote: 'Pembayaran QRIS terverifikasi otomatis melalui gateway.',
    cashReceived: 'Uang Diterima',
    change: 'Kembalian',
    amountDue: 'Jumlah Tagihan',
    paymentReference: 'Nomor Referensi',
    paymentReferencePlaceholder: 'mis. ID transaksi QRIS/transfer',
    completeSale: 'Selesaikan & Cetak Struk',
    printUnavailable: 'Struk tidak dapat dicetak — printer tidak tersedia',
    saleCompletedTitle: 'Transaksi berhasil',
    saleFailed: 'Transaksi gagal disimpan',

    voidRefundTitle: 'Void / Refund',
    voidRefundOnlineDescription:
      'Memerlukan otorisasi supervisor. Setelah diajukan, supervisor akan memberikan kode 6 digit sekali pakai untuk dimasukkan di sini.',
    voidRefundOfflineDescription:
      'Tidak ada koneksi — otorisasi menggunakan kredensial supervisor tersimpan di perangkat ini (sementara, akan diverifikasi ulang saat tersinkron).',
    voidSubmit: 'Ajukan',
    voidOfflineBadge: 'Otorisasi Offline — Sementara',
    voidType: 'Jenis',
    voidTypeVoid: 'Void',
    voidTypeRefund: 'Refund',
    voidAmount: 'Jumlah',
    voidApprover: 'Supervisor Penyetuju',
    supervisorPin: 'PIN Supervisor',
    voidCodeLabel: 'Kode Persetujuan (6 digit)',
    voidCodeHint: 'Minta kode kepada supervisor. Berlaku 5 menit dan hanya bisa dipakai sekali.',
    voidCodeSubmit: 'Konfirmasi Kode',
    voidRequestedWaitingCode:
      'Permintaan terkirim. Supervisor sudah diberi tahu — masukkan kode yang mereka berikan.',
    voidCodeRequired: 'Masukkan kode 6 digit dari supervisor',
    voidLockedTitle: 'Terlalu banyak kode salah',
    voidLockedDescription: 'Akun ini terkunci. Minta atasan yang lebih tinggi untuk membukanya.',
    voidSelfie: 'Foto Selfie Supervisor',
    // RISK-S2 — the copy names the AMOUNT that makes the photo mandatory.
    // A requirement whose trigger is invisible reads as arbitrary, and an
    // arbitrary-seeming control in front of a waiting customer is the one
    // people find ways around.
    voidSelfieRequired: 'Foto Selfie Supervisor (wajib)',
    voidSelfieRequiredHint:
      'Void di atas Rp{{amount}} wajib disertai foto selfie supervisor saat offline.',
    voidApprovedTitle: 'Void/refund disetujui',
    voidRequestedTitle: 'Void/refund diajukan',
    voidAwaitingApproval: 'Menunggu persetujuan supervisor.',
    voidNoCredential: 'Pilih supervisor penyetuju terlebih dahulu',
    voidAuthFailed: 'Otorisasi gagal',
    voidAuthReason: {
      revoked: 'Kredensial supervisor telah dicabut',
      locked_out:
        'Terlalu banyak percobaan PIN salah — kredensial terkunci sampai perangkat kembali online',
      cooling_down: 'Terlalu banyak percobaan. Coba lagi sebentar.',
      expired: 'Kredensial supervisor telah kedaluwarsa',
      scope_exceeded: 'Jumlah melebihi batas otorisasi offline supervisor ini',
      selfie_required: 'Foto selfie wajib untuk jumlah sebesar ini',
      pin_invalid: 'PIN salah',
      not_cached: 'Tidak ada kredensial supervisor tersimpan di perangkat ini',
    },
    voidAuthReasonCoolingDownFor:
      'Terlalu banyak percobaan PIN salah. Coba lagi dalam {{seconds}} detik.',
    voidUnlockTitle: 'Kredensial supervisor terkunci di perangkat ini',
    voidUnlockExplainer:
      'Hubungi kantor pusat dan bacakan kode tantangan di bawah. Mereka akan memberikan kode pembuka 8 karakter.',
    voidUnlockChallengeLabel: 'Kode tantangan (bacakan ke kantor pusat)',
    voidUnlockCodeLabel: 'Kode pembuka dari kantor pusat',
    voidUnlockSubmit: 'Buka Kunci',
    voidUnlockAttemptsLeft: 'Sisa percobaan: {{count}}',
    voidUnlockSuccess: 'Kredensial dibuka. Silakan masukkan PIN supervisor.',
    voidUnlockInvalid: 'Kode pembuka salah',
    voidUnlockExhausted:
      'Percobaan habis. Kredensial ini hanya bisa dipulihkan setelah perangkat kembali online.',
    voidProvisionalTitle: 'Void/refund tersimpan (sementara)',
    voidProvisionalDescription: 'Menunggu verifikasi ulang oleh sistem pusat saat tersinkron.',
    voidFailed: 'Gagal memproses void/refund',
  },

  common: {
    // Used by `SearchableSelect` — the type-to-filter dropdown for long lists
    // (locations, items, suppliers), where a native <select> opened taller than
    // the modal it lived in.
    select: 'Pilih…',
    searchPlaceholder: 'Cari…',
    noResults: 'Tidak ada hasil',
    // The clear button's aria-label. Missing, it was the only thing a screen
    // reader announced for that control — and `translate()` returns the KEY
    // when it cannot resolve one, so the button read out as "common.clear".
    clear: 'Hapus pilihan',
    showDetail: 'Lihat detail',
    hideDetail: 'Sembunyikan',
    save: 'Simpan',
    cancel: 'Batal',
    delete: 'Hapus',
    remove: 'Hapus',
    edit: 'Ubah',
    // Activate / deactivate, used by Data Master's item and product lists.
    // NOT delete: history, recipes and stock movements keep referring to a
    // deactivated row, so the copy must not promise removal.
    activate: 'Aktifkan',
    deactivate: 'Nonaktifkan',
    create: 'Tambah',
    submit: 'Ajukan',
    approve: 'Setujui',
    reject: 'Tolak',
    amend: 'Ubah Jumlah',
    confirm: 'Konfirmasi',
    back: 'Kembali',
    next: 'Lanjut',
    close: 'Tutup',
    filter: 'Filter',
    reset: 'Reset Filter',
    export: 'Ekspor',
    upload: 'Unggah',
    retry: 'Coba Lagi',
    refresh: 'Muat Ulang',
    loading: 'Memuat…',
    saving: 'Menyimpan…',
    yes: 'Ya',
    no: 'Tidak',
    actions: 'Aksi',
    // Shown as the whole heading when someone opens a panel their role cannot
    // reach (`WarehousePanelPage`). Missing, that page's only text was the
    // literal string "common.noAccess" — the dev-only console warning in
    // `translate()` is compiled out of production, so nothing else said so.
    noAccess: 'Anda tidak memiliki akses ke halaman ini',
    viewDetails: 'Lihat Detail',
    reason: 'Alasan',
    reasonPlaceholder: 'Tuliskan alasan…',
    optional: '(opsional)',
    required: '(wajib)',
    selectPlaceholder: 'Pilih…',
    all: 'Semua',
    from: 'Dari',
    to: 'Sampai',
    total: 'Total',
    status: 'Status',
    date: 'Tanggal',
    location: 'Lokasi',
    notes: 'Catatan',
  },

  validation: {
    required: 'Wajib diisi',
    invalidNumber: 'Angka tidak valid',
    invalidDate: 'Tanggal tidak valid',
    minValue: 'Nilai minimal {{min}}',
    maxValue: 'Nilai maksimal {{max}}',
    photoRequired: 'Foto wajib dilampirkan',
    signatureRequired: 'Tanda tangan wajib diisi',
    reasonRequired: 'Alasan wajib diisi',
    invalidFileType: 'Jenis berkas tidak didukung',
    fileTooLarge: 'Ukuran berkas melebihi {{maxMb}} MB',
  },

  // Bulk LINE import, shared by every document create form that offers it
  // (`components/common/LineImportButton`). Distinct from `importData` below,
  // which is the server-validated master-data importer: this one fills in the
  // form and writes nothing by itself.
  lineImport: {
    openButton: 'Impor CSV',
    modalTitle: 'Impor Baris — {{entity}}',
    intro:
      'Unggah atau tempel CSV untuk mengisi baris dokumen ini. Tidak ada yang tersimpan sampai Anda menekan Simpan/Ajukan pada formulir.',
    downloadTemplate: 'Unduh Template CSV',
    column: 'Kolom',
    expected: 'Isi yang diharapkan',
    fileLabel: 'Berkas CSV',
    fileHint: 'Ekspor daftar, ubah di spreadsheet, lalu unggah kembali berkasnya.',
    pasteLabel: 'Atau tempel dari spreadsheet',
    pasteHint: 'Salin blok sel (termasuk baris judul) lalu tempel di sini.',
    check: 'Periksa Berkas',
    readError: 'Berkas tidak dapat dibaca',
    emptyFile: 'Berkas kosong atau tidak memiliki baris judul',
    readyCount: '{{count}} baris siap diimpor',
    errorCount: '{{count}} baris ditolak',
    skippedCount: '{{count}} baris dilewati',
    lineNo: 'Baris {{line}}',
    missingHeaders: 'Kolom wajib tidak ditemukan: {{headers}}',
    unknownHeaders: 'Kolom tidak dikenali (diabaikan): {{headers}}',
    stale: 'Berkas atau tempelan berubah setelah diperiksa — periksa ulang sebelum menerapkan.',
    applyLines: 'Terapkan {{count}} Baris',
    append: 'Tambahkan ke Baris Yang Ada',
    replace: 'Ganti Semua Baris',
    applied: '{{count}} baris dimasukkan ke formulir',
    // Row-level rejections, worded so the operator knows which cell to fix.
    unknownItem: 'Barang tidak ditemukan: "{{value}}" (gunakan SKU atau nama persis)',
    unknownArea: 'Area penyimpanan tidak ditemukan: "{{value}}"',
    unknownOutlet: 'Outlet tidak ditemukan: "{{value}}"',
    unknownSupplier: 'Supplier tidak ditemukan: "{{value}}"',
    missingItem: 'Kolom barang kosong',
    missingArea: 'Kolom area penyimpanan kosong',
    invalidQty: 'Jumlah tidak valid: "{{value}}"',
    missingQty: 'Kolom jumlah kosong',
    negativeQty: 'Jumlah tidak boleh negatif',
    invalidPrice: 'Harga tidak valid: "{{value}}"',
    unknownReason: 'Alasan tidak dikenali: "{{value}}"',
    missingReason: 'Alasan wajib diisi',
    duplicateLine: 'Baris ganda untuk barang/area yang sama',
    notInDocument: 'Barang/area ini tidak ada pada dokumen yang sedang dibuka',
  },

  // CSV export, shared by every list that offers it (`components/common/ExportButton`).
  exportData: {
    export: 'Ekspor CSV',
    exportFiltered: 'Ekspor (terfilter)',
    exportAll: 'Ekspor Semua',
    exportError: 'Gagal mengekspor data',
    exportPdf: 'Ekspor PDF',
    exportPdfFiltered: 'Ekspor PDF (terfilter)',
    exportAllPdf: 'Ekspor Semua (PDF)',
    pdfGeneratedAt: 'Dibuat: {{date}}',
    pdfPageOf: 'Halaman {{page}} dari {{total}}',
    pdfEmpty: 'Tidak ada data',
  },

  // Dispatcher screen: assign a Surat Jalan's driver and truck, and reorder its
  // drops. `/delivery/assign`.
  deliveryAssign: {
    title: 'Penugasan Pengiriman',
    subtitle: 'Pilih Surat Jalan, tetapkan sopir dan truk, lalu atur urutan drop',
    picker: {
      label: 'Surat Jalan',
      placeholder: 'Pilih Surat Jalan...',
      empty:
        'Penugasan sopir & truk hanya berlaku untuk Surat Jalan berstatus draft atau siap — saat ini tidak ada Surat Jalan berstatus tersebut.',
      noneSelected: 'Pilih Surat Jalan untuk mulai',
    },
    form: {
      title: 'Sopir & Truk',
      subtitle: 'Ubah sopir atau kendaraan sebelum Surat Jalan dimuat',
      locked: 'Surat Jalan sudah dimuat atau dalam perjalanan — sopir dan truk tidak dapat diubah',
      driver: 'Sopir',
      vehicle: 'Kendaraan',
      vehicleFreezer: '{{plate}} (freezer)',
      save: 'Simpan Sopir & Truk',
      saved: 'Sopir/truk berhasil diperbarui',
      saveError: 'Gagal memperbarui sopir/truk',
    },
    order: {
      title: 'Urutan Drop',
      subtitle: 'Seret untuk mengubah urutan, atau gunakan tombol naik/turun',
      empty: 'Surat Jalan ini belum memiliki drop',
      locked: 'Urutan rute terkunci — Surat Jalan sudah dimuat atau dalam perjalanan',
      moveUp: 'Pindahkan ke atas',
      moveDown: 'Pindahkan ke bawah',
      save: 'Simpan Urutan',
      saved: 'Urutan drop berhasil disimpan',
      saveError: 'Gagal menyimpan urutan drop',
      seq: 'Urutan',
      outlet: 'Outlet',
      city: 'Kota',
      // The importable column: the sequence an outlet should be visited in.
      importSeqHint: 'angka urutan kunjungan, mis. 1',
      importOutletHint: 'nama outlet persis seperti pada daftar drop',
      importNote:
        'Impor hanya MENGUBAH URUTAN drop yang sudah ada pada Surat Jalan ini — drop tidak bisa ditambah atau dihapus dari berkas.',
      importMissingSeq: 'Kolom urutan kosong atau bukan angka',
      importIncomplete: 'Berkas harus memuat semua drop Surat Jalan ini ({{count}} drop)',
    },
  },

  // Bulk CSV import of master data. Mounted as an Impor CSV button in each
  // Data Master tab (`components/admin/MasterDataIo`), not a route of its own.
  importData: {
    title: 'Import Data Massal',
    description:
      'Unggah data master lewat CSV — format diambil langsung dari skema database, jadi tidak ada kolom yang tidak terduga.',
    entityLabel: 'Jenis Data',
    // The toolbar affordance and its modal heading. The entity is no longer
    // chosen in a dropdown — it comes from the tab the button sits in — so the
    // heading names it instead ("Impor Item / Bahan Baku").
    openButton: 'Impor CSV',
    modalTitle: 'Impor {{entity}}',
    entity: {
      itemCategories: 'Kategori Item',
      items: 'Item / Bahan Baku',
      products: 'Produk Menu',
      chartOfAccounts: 'Bagan Akun',
    },
    step1: '1. Unduh Template',
    downloadTemplate: 'Unduh Template CSV',
    templateHint:
      'Baris kedua berisi petunjuk kolom (diawali #) — boleh dihapus atau dibiarkan, baris itu tidak akan ikut diimpor.',
    templateFailed: 'Gagal mengunduh template',
    step2: '2. Unggah & Periksa',
    uploadHint: 'Format CSV, maksimal 5 MB',
    runPreview: 'Periksa File',
    previewFailed: 'Gagal memeriksa file',
    fileErrorsTitle: 'Format file tidak sesuai',
    step3: '3. Tinjau & Terapkan',
    previewSummary: '{{total}} baris — {{create}} baru, {{update}} perbarui, {{errors}} bermasalah',
    hasErrorsHint: 'Perbaiki baris yang bermasalah lalu unggah ulang sebelum bisa diterapkan.',
    readyToCommit: 'Semua baris valid — siap diterapkan.',
    commit: 'Terapkan Import',
    commitSuccess: 'Import berhasil diterapkan',
    commitSuccessDetail: '{{inserted}} data baru, {{updated}} data diperbarui',
    commitFailed: 'Import gagal diterapkan — tidak ada data yang tersimpan',
    preview: {
      columnLine: 'Baris',
      columnKey: 'Kunci',
      columnStatus: 'Status',
      columnError: 'Keterangan',
      empty: 'Tidak ada baris data',
    },
    status: {
      wouldCreate: 'Baru',
      wouldUpdate: 'Perbarui',
      error: 'Error',
    },
  },

  // Internal staff chat (direct + group), `/chat/internal`. Distinct from
  // `chat.*`, which is the outbound WhatsApp inbox.
  chatInternal: {
    // "Obrolan" → "Chats" (owner, 2026-08-27), matching the nav entry every
    // interface now carries.
    title: 'Chats',
    newChat: 'Chat Baru',
    empty: 'Belum ada percakapan',
    noMessages: 'Belum ada pesan',
    noResults: 'Tidak ada hasil',
    selectConversation: 'Pilih percakapan untuk membaca dan membalas',
    unnamed: 'Tanpa nama',
    memberCount: '{{count}} anggota',
    modeDirect: 'Pesan Langsung',
    modeGroup: 'Grup',
    fieldGroupName: 'Nama Grup',
    createGroup: 'Buat Grup',
    searchColleague: 'Cari Kolega',
    searchColleaguePlaceholder: 'Cari nama…',
    selected: 'Dipilih',
    manage: 'Kelola',
    manageGroup: 'Kelola Grup',
    members: 'Anggota',
    addMember: 'Tambah Anggota',
    roleAdmin: 'Admin',
    onlyAdminCanManage: 'Hanya admin grup yang dapat mengubah nama dan anggota.',
    leaveGroup: 'Keluar dari Grup',
  },

  table: {
    empty: 'Belum ada data',
    loading: 'Memuat data…',
    error: 'Gagal memuat data',
    rowsPerPage: 'Baris per halaman',
    pageInfo: 'Halaman {{page}} dari {{totalPages}}',
    showingRows: 'Menampilkan {{from}}–{{to}} dari {{total}}',
    sortAscending: 'Urutkan naik',
    sortDescending: 'Urutkan turun',
    // Distinct from `empty` on purpose. "Belum ada data" tells an operator who
    // is filtering that the warehouse is empty, which is false and sends them
    // to look for a bug; this says the filter is what hid everything.
    noMatches: 'Tidak ada yang cocok dengan filter',
  },

  photo: {
    capture: 'Ambil Foto',
    retake: 'Ambil Ulang',
    useCamera: 'Gunakan Kamera',
    chooseFile: 'Pilih dari Berkas',
    wajibFoto: 'Foto wajib (bukti)',
    noPhoto: 'Belum ada foto',
    cameraUnavailable: 'Kamera tidak tersedia — pilih berkas sebagai gantinya.',
  },

  signature: {
    label: 'Tanda Tangan',
    clear: 'Hapus',
    placeholder: 'Tanda tangan di sini',
  },

  fileUpload: {
    dragDrop: 'Seret berkas ke sini atau klik untuk memilih',
    selected: '{{count}} berkas dipilih',
    remove: 'Hapus berkas',
  },

  dateRange: {
    label: 'Rentang Tanggal',
    presetToday: 'Hari Ini',
    presetYesterday: 'Kemarin',
    presetLast7: '7 Hari Terakhir',
    presetLast30: '30 Hari Terakhir',
    presetThisMonth: 'Bulan Ini',
    presetLastMonth: 'Bulan Lalu',
    custom: 'Kustom',
  },

  offline: {
    tierOnline: 'Terhubung',
    tierLan: 'Mode LAN (Node Cabang)',
    tierIsolated: 'Offline — Tidak Ada Koneksi',
    onlineDesc: 'Semua data tersinkron dengan pusat.',
    lanDesc:
      'Terhubung ke node cabang. Keputusan pusat (persetujuan gudang, verifikasi pembayaran) menunggu koneksi ke server.',
    isolatedDesc:
      'Perangkat ini bekerja sendiri. Transaksi tersimpan lokal dan akan tersinkron otomatis saat koneksi kembali.',
    queuedCount: '{{count}} transaksi menunggu sinkronisasi',
    lastSync: 'Sinkron terakhir {{when}}',
    neverSynced: 'Belum pernah tersinkron',
    syncNow: 'Sinkronkan Sekarang',

    // D-25b manual "Coba Sinkron" action — re-checks connectivity and
    // attempts a sync, shared by SyncStatusPill (header) and OfflineBanner.
    retrySync: 'Coba Sinkron',
    retrying: 'Memeriksa…',
    retrySuccess: 'Berhasil',
    retryFailedReason: {
      offline: 'Masih offline — server tidak dapat dihubungi',
      syncFailed: 'Sinkronisasi gagal — coba lagi',
      unknown: 'Gagal memeriksa koneksi',
    },
  },

  sync: {
    // Connectivity pill (D-25b) — is the cloud reachable right now. Kept
    // independent from the pair below; never combine into one label.
    online: 'Online',
    offline: 'Offline',
    // Sync pill (D-25b) — does local data match the cloud (outbox drained).
    // Deliberately computed without looking at connectivity, so "offline and
    // fully drained" still reads as `synced` here.
    synced: 'Tersinkron',
    syncing: 'Menyinkronkan…',
    queued: '{{count}} menunggu',
    provisional: 'Sementara (offline)',
  },

  approvalTimeline: {
    title: 'Riwayat Persetujuan',
    step: 'Langkah {{step}}',
    actedBy: 'oleh {{name}}',
    noReason: 'Tanpa alasan tercatat',
    offlineAuthorized: 'Diotorisasi offline',
    reverificationVerified: 'Terverifikasi saat sinkron',
    reverificationFailed: 'Verifikasi gagal',
    reverificationUnprovable: 'Tidak dapat diverifikasi — menunggu tinjauan keuangan',
    pendingStep: 'Menunggu persetujuan {{role}}',
    empty: 'Belum ada riwayat persetujuan',
  },

  permissionGate: {
    noAccess: 'Anda tidak memiliki akses ke bagian ini.',
  },

  // The approvals inbox (`/approvals`) + deep-link detail screen
  // (`/approvals/:documentType/:documentId`) — CONTRACTS §4.0. `documentType`
  // holds the human label per `ApprovalDocumentType` value, shared by both
  // screens (the inbox's type filter/column and the detail page's title).
  approvals: {
    documentType: {
      replenishment_request: 'Permintaan Barang',
      void_refund: 'Void/Refund',
      purchase_request: 'Permintaan Pembelian',
      purchase_order: 'Pesanan Pembelian',
      stock_opname: 'Stock Opname',
      return: 'Retur',
      payroll_run: 'Proses Payroll',
      payment_verification: 'Verifikasi Pembayaran',
      leave_request: 'Pengajuan Cuti',
      employee_loan: 'Pinjaman Karyawan',
      cash_variance_proposal: 'Selisih Kas',
      waste: 'Waste',
    },
  },

  approvalsInbox: {
    title: 'Persetujuan Menunggu',
    filterByType: 'Filter Jenis Dokumen',
    allTypes: 'Semua Jenis',
    type: 'Jenis',
    number: 'Nomor Dokumen',
    requestedBy: 'Diajukan Oleh',
    location: 'Lokasi',
    amount: 'Nominal',
    waiting: 'Menunggu Sejak',
    step: 'Langkah',
    emptyTitle: 'Tidak ada persetujuan menunggu',
    emptyDescription: 'Semua dokumen yang menunggu keputusan Anda akan muncul di sini.',
  },

  approvalCode: {
    explainer:
      'Menyetujui dokumen ini akan membuat kode 6 digit sekali pakai. Sampaikan kode itu kepada petugas yang mengajukan agar mereka bisa menyelesaikannya.',
    issue: 'Setujui & Buat Kode',
    reissue: 'Buat Kode Baru',
    issuedTitle: 'Kode persetujuan dibuat',
    issuedDescription: 'Berlaku sampai {{time}}. Hanya bisa dipakai satu kali.',
    stillPending: 'Dokumen masih menunggu sampai kode ini dimasukkan oleh petugas yang mengajukan.',
    issueFailed: 'Gagal membuat kode persetujuan',
  },
  approvalDetail: {
    backToInbox: 'Kembali ke Persetujuan',
    summary: 'Ringkasan',
    amount: 'Nominal',
    requestedBy: 'Diajukan Oleh',
    location: 'Lokasi',
    waiting: 'Menunggu Sejak',
    waitingOnStep: 'Menunggu langkah {{step}} — {{role}}',
    chainFinished: 'Proses persetujuan telah selesai — status akhir: {{state}}',
    actionTitle: 'Keputusan',
    notYourTurn: 'Dokumen ini sedang menunggu persetujuan pihak lain pada langkah saat ini.',
    note: 'Catatan',
    rejectReason: 'Alasan Penolakan',
    reject: 'Tolak',
    confirmReject: 'Konfirmasi Tolak',
    approve: 'Setujui',
    approved: 'Berhasil disetujui',
    rejected: 'Berhasil ditolak',
    unknownType: 'Jenis dokumen tidak dikenali',
    notFound: 'Persetujuan tidak ditemukan',
    approveUnsupported: {
      voidRefund:
        'Persetujuan void/refund memerlukan verifikasi PIN dan dilakukan dari modul Kasir (POS), bukan dari layar ini. Penolakan tetap dapat dilakukan di sini.',
      paymentVerification:
        'Keputusan Owner untuk pembayaran ini menyatu dengan aksi "Bayar" pada modul Keuangan, bukan aksi terpisah di sini. Penolakan tetap dapat dilakukan di sini.',
    },
  },

  emptyState: {
    genericTitle: 'Belum ada data',
    genericDescription: 'Data akan muncul di sini setelah tersedia.',
  },

  // Status labels, namespaced per CONTRACTS.md §2 enum. Kept flat-per-domain
  // (rather than one shared table) because the same raw string sometimes
  // needs different Indonesian wording depending on the document type.
  status: {
    replenishment: {
      draft: 'Draft',
      submitted: 'Diajukan',
      awaiting_approval: 'Menunggu Persetujuan',
      approved: 'Disetujui',
      rejected: 'Ditolak',
      processing: 'Diproses',
      shipped: 'Dikirim',
      received: 'Diterima',
      completed: 'Selesai',
    },
    suratJalan: {
      draft: 'Draft',
      ready: 'Siap Kirim',
      loading: 'Memuat Barang',
      in_transit: 'Dalam Perjalanan',
      completed: 'Selesai',
      cancelled: 'Dibatalkan',
    },
    drop: {
      pending: 'Menunggu',
      en_route: 'Dalam Perjalanan',
      arrived: 'Tiba di Lokasi',
      completed: 'Selesai',
      completed_discrepancy: 'Selesai (Ada Selisih)',
      failed: 'Gagal',
    },
    opname: {
      draft: 'Draft',
      counting: 'Sedang Menghitung',
      submitted: 'Diajukan',
      approved: 'Disetujui',
      rejected: 'Ditolak',
      adjusted: 'Sudah Disesuaikan',
      cancelled: 'Dibatalkan',
    },
    waste: { pending: 'Menunggu', approved: 'Disetujui', rejected: 'Ditolak' },
    return: {
      draft: 'Draft',
      submitted: 'Diajukan',
      approved: 'Disetujui',
      rejected: 'Ditolak',
      in_transit: 'Dalam Perjalanan',
      received: 'Diterima',
      completed: 'Selesai',
      cancelled: 'Dibatalkan',
    },
    purchaseRequest: {
      draft: 'Draft',
      submitted: 'Diajukan',
      approved: 'Disetujui',
      rejected: 'Ditolak',
      converted: 'Dikonversi ke PO',
      cancelled: 'Dibatalkan',
    },
    purchaseOrder: {
      draft: 'Draft',
      pending_approval: 'Menunggu Persetujuan',
      approved: 'Disetujui',
      issued: 'Diterbitkan',
      partially_received: 'Diterima Sebagian',
      received: 'Diterima',
      closed: 'Ditutup',
      cancelled: 'Dibatalkan',
    },
    pettyCash: { pending: 'Menunggu Verifikasi', verified: 'Terverifikasi', rejected: 'Ditolak' },
    shift: { open: 'Berjalan', closed: 'Ditutup' },
    sale: { completed: 'Selesai', voided: 'Dibatalkan (Void)', refunded: 'Refund' },
    payment: {
      pending: 'Belum Terverifikasi',
      verified: 'Terverifikasi',
      paid: 'Dibayar',
      rejected: 'Ditolak',
    },
    voidRefund: { pending: 'Menunggu Persetujuan', approved: 'Disetujui', rejected: 'Ditolak' },
    onlineOrder: { completed: 'Selesai', cancelled: 'Dibatalkan' },
    settlement: { pending: 'Menunggu Pencairan', settled: 'Sudah Cair' },
    approval: {
      pending: 'Menunggu',
      approved: 'Disetujui',
      rejected: 'Ditolak',
      cancelled: 'Dibatalkan',
    },
    approvalStep: {
      pending: 'Menunggu',
      approved: 'Disetujui',
      rejected: 'Ditolak',
      skipped: 'Dilewati',
    },
    employment: {
      active: 'Aktif',
      probation: 'Masa Percobaan',
      resigned: 'Mengundurkan Diri',
      terminated: 'Diberhentikan',
    },
    attendance: {
      present: 'Hadir',
      late: 'Terlambat',
      absent: 'Alpha',
      sick: 'Sakit',
      permission: 'Izin',
      leave: 'Cuti',
      holiday: 'Libur Nasional',
      off: 'Libur Kerja',
    },
    leave: {
      pending: 'Menunggu',
      approved: 'Disetujui',
      rejected: 'Ditolak',
      cancelled: 'Dibatalkan',
    },
    payrollRun: {
      draft: 'Draft',
      calculated: 'Sudah Dihitung',
      pending_approval: 'Menunggu Persetujuan',
      approved: 'Disetujui',
      paid: 'Sudah Dibayar',
      cancelled: 'Dibatalkan',
    },
    // Employment contract lifecycle (W7).
    contract: {
      draft: 'Draf',
      active: 'Berlaku',
      expired: 'Berakhir',
      terminated: 'Diputus',
    },
    loan: {
      pending: 'Menunggu',
      active: 'Berjalan',
      paid_off: 'Lunas',
      written_off: 'Dihapusbukukan',
      rejected: 'Ditolak',
    },
    asset: {
      active: 'Aktif',
      in_maintenance: 'Dalam Perbaikan',
      retired: 'Tidak Dipakai',
      lost: 'Hilang',
    },
    maintenanceJob: {
      scheduled: 'Terjadwal',
      due: 'Jatuh Tempo',
      in_progress: 'Dikerjakan',
      done: 'Selesai',
      verified: 'Terverifikasi',
      skipped: 'Dilewati',
    },
    fiscalPeriod: { open: 'Terbuka', closed: 'Ditutup', locked: 'Terkunci' },
    journalEntry: { posted: 'Terposting', reversed: 'Dibalik (Reversal)' },
    device: {
      online: 'Online',
      stale: 'Tidak Merespons',
      offline: 'Offline',
      unpaired: 'Belum Terhubung',
      retired: 'Nonaktif',
    },
    topologyOutlet: { online: 'Online', degraded: 'Sebagian Bermasalah', offline: 'Offline' },
    reverification: {
      verified: 'Terverifikasi',
      failed: 'Gagal Verifikasi',
      unprovable: 'Tidak Dapat Dibuktikan',
    },
    offlineAuthOutcome: {
      pending_verification: 'Menunggu Verifikasi',
      verified: 'Terverifikasi',
      failed: 'Gagal',
      unprovable: 'Tidak Dapat Dibuktikan',
    },
  },

  placeholder: {
    pos: {
      title: 'Kasir (POS)',
      description:
        'Layar kasir tablet, offline-first: transaksi, shift, pembayaran QRIS/tunai, void/refund.',
      owner: 'Dibangun oleh W4-06 (senior-fe) pada Wave 4.',
      coverage: 'Cakupan: FR-POS-01..07',
    },
    dashboard: {
      title: 'Dasbor',
      description:
        'KPI pemilik/manajer: pendapatan, profit, produk terlaris, KPI pegawai, drill-down realtime.',
      owner: 'Dibangun oleh W5-01 pada Wave 5.',
      coverage: 'Cakupan: FR-DASH-01..04',
    },
    outlet: {
      title: 'Outlet',
      description:
        'Permintaan barang, terima barang + foto, stok per area, stock opname, waste/retur, kas kecil.',
      owner: 'Dibangun oleh W4-07 (senior-fe) pada Wave 4.',
      coverage: 'Cakupan: FR-LOG-06..21, FR-SO-01..04, FR-WST-01..04',
    },
    warehouse: {
      title: 'Gudang Pusat',
      description:
        'Stok gudang, antrean persetujuan, picking, pembuatan Surat Jalan, penerimaan, retur ke supplier.',
      owner: 'Dibangun oleh W4-08 (medior) pada Wave 4.',
      coverage: 'Cakupan: FR-LOG-01..05, FR-LOG-14..21',
    },
    purchasing: {
      title: 'Pembelian',
      description: 'Permintaan pembelian, purchase order, penerimaan PO, riwayat harga supplier.',
      owner: 'Dibangun oleh W5-04 pada Wave 5.',
      coverage: 'Cakupan: FR-PO-01..04, FR-SUP-01..06',
    },
    finance: {
      title: 'Keuangan',
      description:
        'Antrean verifikasi pembayaran, jurnal, bagan akun, neraca saldo, laba rugi, ekspor laporan.',
      owner: 'Dibangun oleh W5-02 pada Wave 5.',
      coverage: 'Cakupan: FR-ACCT-01..04, JGUD-01..07, JOUT-01..09',
    },
    hr: {
      title: 'SDM & Absensi',
      description: 'Data pegawai, jadwal shift, absensi, cuti/izin, kasbon, payroll.',
      owner: 'Dibangun oleh W4-10 (medior) pada Wave 4.',
      coverage: 'Cakupan: FR-HR-01..04, PIN-01..07, POUT-01..09',
    },
    assets: {
      title: 'Aset & Maintenance',
      description: 'Daftar aset, jadwal perawatan, tugas maintenance dengan bukti foto.',
      owner: 'Dibangun oleh W4-09 (senior-fe) pada Wave 4.',
      coverage: 'Cakupan: FR-PMS-01..04',
    },
    admin: {
      title: 'Administrasi',
      description: 'Pengguna, peran, data master, area penyimpanan, penampil jejak audit.',
      owner: 'Dibangun oleh W4-05 (medior) pada Wave 4.',
      coverage: 'Cakupan: FR-AUDIT-01..02, D-15',
    },
    me: {
      title: 'Akun Saya',
      description:
        'Absen GPS + selfie, slip gaji, pengajuan cuti — untuk semua pegawai, dari ponsel.',
      owner: 'Dibangun oleh W4-10 (medior) pada Wave 4.',
      coverage: 'Cakupan: FR-HR-01/02, POUT-01..09',
    },
    topology: {
      title: 'Topologi Perangkat',
      description:
        'Pohon perangkat live: Pusat → Kota → Outlet → Node → Perangkat, status heartbeat, kesehatan sinkronisasi per outlet, antrean konflik.',
      owner: 'Dibangun oleh W5-03 pada Wave 5.',
      coverage: 'Cakupan: D-13, SYNC-PROTOCOL §7',
    },
    driver: {
      title: 'Pengiriman (Driver)',
      description:
        'Surat jalan hari ini, checklist multi-drop, suhu + segel, foto serah terima, tanda tangan — offline-first.',
      owner: 'Dibangun oleh W4-09 (senior-fe) pada Wave 4.',
      coverage: 'Cakupan: FR-LOG-01..05, FR-LOG-14..16',
    },
  },

  // F01 `(auth)` — added by W4-05 on top of the Wave-1 login baseline.
  setPin: {
    title: 'Atur PIN Anda',
    subtitle: 'PIN 6-digit dibutuhkan untuk otorisasi cepat di POS dan persetujuan (D-17).',
    currentPassword: 'Kata Sandi Saat Ini',
    currentPasswordPlaceholder: 'Konfirmasi kata sandi Anda',
    pin: 'PIN Baru (6 digit)',
    pinPlaceholder: '••••••',
    confirmPin: 'Ulangi PIN',
    pinMismatch: 'PIN tidak cocok',
    pinInvalid: 'PIN harus 6 digit angka',
    submit: 'Simpan PIN',
    submitting: 'Menyimpan…',
    success: 'PIN berhasil disimpan.',
    skip: 'Lewati untuk saat ini',
  },

  // F07 `finance/` — payment verification queue, journal, chart of accounts,
  // reports, fiscal periods, and the D-17 exception queue (CONTRACTS §4.17).
  finance: {
    tabs: {
      payments: 'Verifikasi Pembayaran',
      journal: 'Jurnal',
      coa: 'Bagan Akun',
      reports: 'Laporan',
      periods: 'Periode Fiskal',
      exceptions: 'Antrean Pengecualian',
    },
    refType: {
      purchase_order: 'Purchase Order',
      payroll_run: 'Penggajian',
      petty_cash: 'Kas Kecil',
      maintenance_job: 'Tugas Maintenance',
      sale_payment: 'Pembayaran Penjualan',
      online_order: 'Pesanan Online',
      incentive: 'Insentif',
      thr: 'THR',
      other: 'Lainnya',
    },
    payeeType: {
      supplier: 'Supplier',
      employee: 'Pegawai',
      platform: 'Platform',
      other: 'Lainnya',
    },
    accountType: {
      asset: 'Aset',
      liability: 'Liabilitas',
      equity: 'Ekuitas',
      revenue: 'Pendapatan',
      expense: 'Beban',
    },
    payments: {
      columnNumber: 'No. PV',
      columnRefType: 'Jenis',
      columnPayee: 'Penerima',
      columnAmount: 'Jumlah',
      columnStatus: 'Status',
      columnLocation: 'Lokasi',
      filterStatusAll: 'Semua Status',
      statusPending: 'Belum Terverifikasi',
      statusVerified: 'Terverifikasi',
      statusPaid: 'Dibayar',
      statusRejected: 'Ditolak',
      filterRefTypeAll: 'Semua Jenis',
      createButton: 'Catat Pembayaran',
      empty: 'Belum ada pembayaran yang perlu diverifikasi.',
      createTitle: 'Catat Pembayaran Baru',
      createDescription:
        'Untuk pembayaran manual/lain-lain (THR, insentif, biaya lain) yang tidak berasal dari dokumen lain.',
      createSuccess: 'Pembayaran berhasil dicatat.',
      refType: 'Jenis Referensi',
      payeeType: 'Jenis Penerima',
      amount: 'Jumlah',
      referenceNumber: 'Nomor Referensi',
      notes: 'Catatan',
      detailTitle: 'Detail Pembayaran',
      viewProof: 'Lihat Bukti Pembayaran',
      verifiedAt: 'Diverifikasi',
      paidAt: 'Dibayar',
      uploadProofTitle: 'Unggah Bukti Pembayaran',
      proofFile: 'Berkas Bukti',
      uploadProofButton: 'Unggah Bukti',
      proofUploadSuccess: 'Bukti pembayaran berhasil diunggah.',
      verifyTitle: 'Verifikasi Pembayaran',
      verifyNote: 'Catatan Verifikasi',
      verifyButton: 'Verifikasi',
      verifySuccess: 'Pembayaran berhasil diverifikasi.',
      proofRequiredHint: 'Bukti pembayaran harus diunggah sebelum dapat diverifikasi.',
      payTitle: 'Tandai Sudah Dibayar',
      paidVia: 'Metode Pembayaran',
      paidViaCash: 'Tunai',
      paidViaBankTransfer: 'Transfer Bank',
      paidViaQris: 'QRIS',
      payButton: 'Tandai Dibayar',
      paySuccess: 'Pembayaran berhasil ditandai lunas.',
      rejectButton: 'Tolak',
      rejectTitle: 'Tolak Pembayaran?',
      rejectReason: 'Alasan Penolakan',
      rejectSuccess: 'Pembayaran berhasil ditolak.',
    },
    journal: {
      columnNumber: 'No. Entri',
      columnDate: 'Tanggal',
      columnDescription: 'Keterangan',
      columnSource: 'Sumber',
      columnStatus: 'Status',
      columnLocation: 'Lokasi',
      // Human sentences for the GL engine's machine-written `description`
      // (`<eventType> — <refKind> <uuid>`). Rendered by `JournalDescription`;
      // the raw string stays on hover and in the detail drawer, so nothing is
      // lost — the ledger is just readable now (owner, 2026-08-21: "Keterangan
      // is too confusing for normal user").
      event: {
        // The PRD's 16 (§6.2)
        gudang_purchase: 'Pembelian gudang',
        gudang_goods_in: 'Barang masuk gudang',
        gudang_goods_out_to_outlet: 'Barang keluar gudang ke outlet',
        gudang_return_to_supplier: 'Retur gudang ke supplier',
        gudang_waste: 'Waste gudang',
        gudang_stock_adjustment: 'Penyesuaian stok gudang',
        gudang_stock_revaluation: 'Revaluasi nilai stok gudang',
        outlet_goods_in_from_warehouse: 'Barang masuk outlet dari gudang',
        outlet_ingredient_usage: 'Pemakaian bahan di outlet',
        outlet_sales: 'Penjualan outlet',
        outlet_waste: 'Waste outlet',
        outlet_return_to_warehouse: 'Retur outlet ke gudang',
        outlet_stock_adjustment: 'Penyesuaian stok outlet',
        outlet_direct_purchase: 'Pembelian langsung oleh outlet',
        outlet_petty_cash: 'Kas kecil outlet',
        outlet_operating_expense: 'Biaya operasional outlet',
        // D-04 extensions (§6.3)
        payroll_accrual: 'Akrual gaji',
        payroll_payment: 'Pembayaran gaji',
        qris_settlement: 'Settlement QRIS',
        transfer_verified: 'Transfer masuk terverifikasi',
        platform_settlement: 'Settlement pesanan online',
        sale_void_reversal: 'Pembatalan penjualan (void)',
        offline_auth_rejected: 'Otorisasi offline ditolak',
        petty_cash_topup: 'Pengisian kas kecil',
        // Not an event type: the engine's own reversal prefix.
        reversal: 'Pembalikan entri {{entry}}',
      },
      // The source document a system entry was posted from.
      ref: {
        usage_day: 'rekap pemakaian harian',
        sale_day: 'rekap penjualan harian',
        po_receipt: 'penerimaan PO',
        surat_jalan: 'Surat Jalan',
        sj: 'Surat Jalan',
        goods_receipt: 'penerimaan barang',
        replenishment: 'permintaan outlet',
        opname: 'stok opname',
        waste: 'waste',
        return: 'retur',
        petty_cash: 'kas kecil',
        payroll_run: 'run payroll',
        payment_verification: 'verifikasi pembayaran',
        pos_sale: 'transaksi kasir',
      },
      sourceManual: 'Manual',
      sourceSystem: 'Sistem',
      filterSourceAll: 'Semua Sumber',
      filterAccountCode: 'Kode Akun',
      postButton: 'Posting Entri Manual',
      empty: 'Belum ada entri jurnal.',
      postSuccess: 'Entri jurnal berhasil diposting.',
      postTitle: 'Posting Entri Jurnal Manual',
      entryDate: 'Tanggal Entri',
      description: 'Keterangan',
      lineAccount: 'Akun',
      lineDebit: 'Debit',
      lineCredit: 'Kredit',
      lineMemo: 'Memo',
      balanced: 'Seimbang (debit = kredit)',
      unbalanced: 'Belum seimbang — debit dan kredit harus sama',
      debitCreditTotals: 'Total Debit {{debit}} · Total Kredit {{credit}}',
      detailTitle: 'Detail Entri Jurnal',
      totals: 'Total',
      reverseButton: 'Balik Entri (Reverse)',
      reverseTitle: 'Balik Entri Jurnal?',
      reverseReason: 'Alasan Pembalikan',
      reverseSuccess: 'Entri jurnal berhasil dibalik.',
    },
    coa: {
      columnCode: 'Kode',
      columnName: 'Nama',
      columnType: 'Tipe',
      columnNormalBalance: 'Saldo Normal',
      columnPostable: 'Dapat Diposting',
      columnStatus: 'Status',
      searchPlaceholder: 'Cari kode atau nama akun…',
      filterTypeAll: 'Semua Tipe',
      filterStatusAll: 'Semua Status',
      createButton: 'Tambah Akun',
      empty: 'Belum ada akun.',
      createTitle: 'Tambah Akun Baru',
      editTitle: 'Ubah Akun',
      code: 'Kode Akun',
      name: 'Nama Akun',
      type: 'Tipe Akun',
      parent: 'Akun Induk',
      normalBalanceDebit: 'Debit',
      normalBalanceCredit: 'Kredit',
      createSuccess: 'Akun berhasil dibuat.',
      updateSuccess: 'Akun berhasil diperbarui.',
    },
    periods: {
      empty: 'Belum ada periode fiskal.',
      columnCode: 'Periode',
      columnRange: 'Rentang Tanggal',
      columnStatus: 'Status',
      columnClosedAt: 'Ditutup Pada',
      closeButton: 'Tutup Periode',
      reopenButton: 'Buka Kembali',
      closeTitle: 'Tutup Periode {{period}}?',
      reopenTitle: 'Buka Kembali Periode {{period}}?',
      closeNote: 'Catatan (opsional)',
      reopenReason: 'Alasan Membuka Kembali',
      closeSuccess: 'Periode berhasil ditutup.',
      reopenSuccess: 'Periode berhasil dibuka kembali.',
    },
    exceptions: {
      columnClass: 'Kelas',
      columnDocument: 'Dokumen',
      columnAmount: 'Jumlah',
      columnApprover: 'Penyetuju',
      columnOutlet: 'Outlet',
      columnOccurredAt: 'Terjadi Pada',
      columnVerdict: 'Putusan',
      columnDevice: 'Perangkat',
      columnRelayReceivedAt: 'Diterima Relay Pada',
      pinAttempts: 'Percobaan PIN',
      filterStatusAll: 'Semua Status',
      statusOpen: 'Terbuka',
      statusResolved: 'Terselesaikan',
      statusDismissed: 'Ditutup',
      filterClassAll: 'Semua Kelas',
      classFailed: 'Gagal Verifikasi',
      classUnprovable: 'Tidak Dapat Dibuktikan',
      empty: 'Tidak ada kasus pengecualian.',
      detailTitle: 'Detail Kasus Pengecualian',
      physicalEffectSuspected: 'Diduga berdampak fisik (barang/uang sudah keluar)',
      pendingVerdict: 'Menunggu Putusan',
      verdict: {
        upheld: 'Dikuatkan (Sah)',
        rejected: 'Ditolak',
      },
      recordVerdictTitle: 'Catat Putusan',
      verdictLabel: 'Putusan',
      reasonLabel: 'Alasan',
      routeToPayrollDeduction: 'Alihkan ke potongan gaji (kasbon)',
      submitVerdict: 'Simpan Putusan',
      verdictSuccess: 'Putusan berhasil dicatat.',
      selfieAlt: 'Foto selfie otorisasi',
    },
    reports: {
      tabs: {
        trialBalance: 'Neraca Saldo',
        profitLoss: 'Laba Rugi',
        balanceSheet: 'Neraca',
        stockValue: 'Nilai Stok',
      },
      period: 'Periode',
      columnAccount: 'Akun',
      // A report that silently rendered NOTHING when its fetch failed, or when
      // no fiscal period existed, read as an unbuilt feature (owner,
      // 2026-08-21: "This seems not developed"). Every tab now says which of
      // the three states it is in.
      noPeriods: 'Belum ada periode fiskal',
      noPeriodsHint:
        'Buat periode di tab Periode Fiskal terlebih dahulu — Neraca Saldo dihitung per periode.',
      // Short enough to fit the control that shows it. The long form ("Pilih
      // periode untuk menampilkan laporan") was clipped mid-word, and the
      // Select's own label already says "Periode", so the extra words were
      // repeating what was on screen anyway.
      selectPeriod: 'Pilih periode…',
      loadError: 'Laporan gagal dimuat',
      loadErrorHint: 'Coba muat ulang. Bila masih gagal, laporkan ke admin.',
      emptyHint: 'Belum ada jurnal yang terposting pada rentang yang dipilih.',
      balanced: 'Seimbang',
      unbalanced: 'Tidak Seimbang',
      empty: 'Tidak ada data untuk ditampilkan.',
      range: 'Rentang Tanggal',
      revenue: 'Pendapatan',
      expenses: 'Beban',
      totalRevenue: 'Total Pendapatan',
      totalExpense: 'Total Beban',
      netProfit: 'Laba Bersih',
      asOf: 'Per Tanggal',
      assets: 'Aset',
      liabilities: 'Liabilitas',
      equity: 'Ekuitas',
      subtotal: 'Subtotal',
      grandTotal: 'Total Keseluruhan',
    },
  },

  // W7 — two-way WhatsApp chat.
  chat: {
    title: 'Pesan Masuk (WhatsApp)',
    myTitle: 'Mail — Kantor Pusat',
    empty: 'Belum ada percakapan',
    myEmpty: 'Belum ada pesan. Tulis pesan pertama Anda ke kantor pusat.',
    noMessages: 'Belum ada pesan',
    selectConversation: 'Pilih percakapan untuk membaca dan membalas',
    newConversation: 'Percakapan Baru',
    composerPlaceholder: 'Tulis pesan… (Enter kirim, Shift+Enter baris baru)',
    send: 'Kirim',
    close: 'Tutup Percakapan',
    reopen: 'Buka Kembali',
    fieldPhone: 'Nomor WhatsApp',
    fieldName: 'Nama Kontak',
    phoneHint: 'Boleh ditulis 08… atau 62… — keduanya disimpan sebagai satu nomor yang sama.',
    deliveryDisabledNotice:
      'Pengiriman WhatsApp belum aktif (WA_ENABLED=false, kredensial gateway belum ada). Pesan tetap tersimpan dan terbaca di aplikasi, tetapi BELUM terkirim ke ponsel siapa pun sampai gateway dihidupkan.',
    status: {
      pending: 'Belum terkirim',
      failed: 'Gagal kirim',
    },
  },
  purchasing: {
    tabs: {
      outletRequests: 'Permintaan Outlet',
      requests: 'Permintaan Pembelian',
      orders: 'Purchase Order',
      suppliers: 'Supplier',
      priceHistory: 'Riwayat Harga Supplier',
    },
    suppliers: {
      // The entity name the import modal heading is built from.
      title: 'Supplier',
      searchPlaceholder: 'Cari kode atau nama supplier…',
      createButton: 'Tambah Supplier',
      createTitle: 'Tambah Supplier',
      editTitle: 'Ubah Supplier',
      empty: 'Belum ada supplier',
      openDetail: 'Detail',
      deactivate: 'Nonaktifkan',
      deactivated: 'Supplier dinonaktifkan',
      created: 'Supplier ditambahkan',
      updated: 'Supplier diperbarui',
      columnCode: 'Kode',
      columnName: 'Nama Supplier',
      columnContact: 'Kontak',
      columnTerms: 'Termin',
      columnOutletVisible: 'Terlihat Outlet',
      columnStatus: 'Status',
      termsCash: 'Tunai',
      termsDays: '{{days}} hari',
      termsHint: 'Jumlah hari jatuh tempo pembayaran. Isi 0 untuk pembayaran tunai.',
      fieldCode: 'Kode Supplier',
      fieldName: 'Nama Supplier',
      fieldContact: 'Nama Kontak',
      fieldPhone: 'Telepon',
      fieldEmail: 'Email',
      fieldAddress: 'Alamat',
      fieldTerms: 'Termin (hari)',
      fieldBankName: 'Nama Bank',
      fieldBankAccount: 'No. Rekening',
      fieldBankAccountName: 'Nama Pemilik Rekening',
      fieldOutletVisible: 'Tampilkan ke staf outlet',
      outletVisibleHint:
        'Supervisor dan Leader outlet dapat memilih supplier ini (nama dan kontak saja) pada form kas kecil. Harga, termin, dan data bank tetap tersembunyi dari mereka.',
      codeLocked: 'Kode tidak dapat diubah — sudah tercetak pada PO yang terbit.',
      tabItems: 'Barang & Harga',
      tabHistory: 'Riwayat Harga',
      tabTransactions: 'Riwayat PO',
      addItem: 'Tambah Barang',
      selectItem: 'Pilih barang…',
      noItems: 'Belum ada barang untuk supplier ini',
      noHistory: 'Belum ada riwayat harga',
      noTransactions: 'Belum ada PO untuk supplier ini',
      noSku: 'Tanpa SKU supplier',
      price: 'Harga',
      sku: 'SKU Supplier',
      leadTime: 'Lead time {{days}} hari',
      leadTimeLabel: 'Lead time',
      priceUpdated: 'Harga diperbarui',
    },
    filterLocationAll: 'Semua Lokasi',
    filterSupplierAll: 'Semua Supplier',
    // "Permintaan Outlet" — the office's view of store requests and the
    // conversion into a PR (owner, 2026-08-21).
    outletRequests: {
      intro:
        'Permintaan barang dari outlet. Yang tidak bisa dipenuhi dari stok gudang bisa diubah menjadi Permintaan Pembelian (PR).',
      columnNumber: 'No. Permintaan',
      columnLocation: 'Outlet',
      columnLines: 'Jumlah Item',
      columnNeededBy: 'Dibutuhkan',
      filterLocation: 'Outlet',
      filterStatusAll: 'Semua Status',
      empty: 'Belum ada permintaan dari outlet.',
      convertButton: 'Jadikan PR',
      exportQtyApproved: 'Disetujui',
      notConvertible: 'Hanya permintaan yang sudah diajukan outlet yang bisa dijadikan PR.',
      convertTitle: 'Jadikan PR — {{number}}',
      convertDescription:
        'Item di bawah akan disalin ke PR baru berstatus Draft. Permintaan outlet ini tidak berubah.',
      convertConfirm: 'Buat PR Draft',
      convertSuccess: 'PR {{number}} dibuat dari permintaan outlet.',
      lineCount: '{{count}} item',
      noLines: 'Permintaan ini tidak punya item.',
      notes: 'Catatan (opsional)',
      notesPlaceholder: 'mis. beli di supplier terdekat, stok gudang habis',
      priceHint:
        'Harga belum diisi — lengkapi harga perkiraan dan supplier di PR sebelum diajukan.',
    },

    requests: {
      columnNumber: 'No. PR',
      columnLocation: 'Lokasi',
      columnRequestedBy: 'Diajukan Oleh',
      columnNeededBy: 'Dibutuhkan',
      columnLines: 'Jumlah Item',
      columnStatus: 'Status',
      filterStatusAll: 'Semua Status',
      createButton: 'Buat Permintaan',
      createTitle: 'Permintaan Pembelian Baru',
      createSuccess: 'Permintaan pembelian berhasil dibuat.',
      empty: 'Belum ada permintaan pembelian.',
      location: 'Lokasi',
      neededBy: 'Dibutuhkan Tanggal',
      // Destination is a warehouse, not any location (owner, 2026-08-21).
      destination: 'Tujuan Pengiriman (Gudang)',
      destinationHint: 'Barang yang dibeli diterima di gudang ini.',
      // Editing + attribution (owner, 2026-08-21: "PR should be editable but
      // shown who make it and who made the changes, who approved it etc with
      // time stamps").
      editTitle: 'Ubah {{number}}',
      editButton: 'Ubah PR',
      editSuccess: 'Perubahan PR tersimpan.',
      editRejectedHint:
        'PR yang ditolak akan kembali menjadi Draft setelah diubah, lalu bisa diajukan lagi.',
      createdBy: 'Dibuat Oleh',
      updatedBy: 'Terakhir Diubah',
      sourceRequest: 'Dari Permintaan Outlet',
      // An approved PR's next step, offered where the approval is read.
      createPoButton: 'Buat PO dari PR ini',
      createPoHint:
        'Item dan tujuan PR akan disalin ke form PO. Harga masih perkiraan — sesuaikan dengan penawaran supplier.',
      historyTitle: 'Riwayat Perubahan',
      historyEmpty: 'Belum ada perubahan tercatat.',
      historyAction: {
        create: 'PR dibuat',
        update: 'PR diubah',
        approve: 'Keputusan persetujuan',
      },
      item: 'Item',
      qty: 'Jumlah',
      estPrice: 'Estimasi Harga',
      suggestedSupplier: 'Supplier Usulan',
      addLine: 'Tambah Baris',
      detailTitle: 'Detail Permintaan Pembelian',
      lines: 'Daftar Item',
      submitButton: 'Ajukan',
      submitSuccess: 'Permintaan pembelian berhasil diajukan.',
      decideTitle: 'Putuskan Permintaan',
      note: 'Catatan',
      approveButton: 'Setujui',
      approveSuccess: 'Permintaan pembelian disetujui.',
      rejectButton: 'Tolak',
      rejectSuccess: 'Permintaan pembelian ditolak.',
      rejectTitle: 'Tolak Permintaan Pembelian',
      rejectReason: 'Alasan Penolakan',
      approvalTitle: 'Riwayat Persetujuan',
    },
    orders: {
      columnNumber: 'No. PO',
      columnSupplier: 'Supplier',
      columnOrderDate: 'Tgl. Pesan',
      columnExpectedDate: 'Estimasi Datang',
      columnTotal: 'Total',
      columnStatus: 'Status',
      filterStatusAll: 'Semua Status',
      createButton: 'Buat PO',
      createTitle: 'Purchase Order Baru',
      createSuccess: 'Purchase order berhasil dibuat.',
      empty: 'Belum ada purchase order.',
      priceHiddenNotice:
        'Anda tidak memiliki akses melihat/mengisi harga beli supplier. Hubungi Manager/Finance/Kepala Gudang untuk membuat PO dengan harga.',
      supplier: 'Supplier',
      location: 'Lokasi',
      fromPr: 'Dari Permintaan Pembelian (opsional)',
      fromPrNone: 'Tidak dari PR',
      // Picking a PR copies its destination and lines into this PO; the price
      // is the requester's ESTIMATE and has to be confirmed against the supplier.
      fromPrHint:
        'Pilih PR untuk menyalin tujuan dan itemnya. Harga masih perkiraan — pastikan sesuai penawaran supplier.',
      orderDate: 'Tanggal Pesan',
      expectedDate: 'Estimasi Tanggal Datang',
      notes: 'Catatan',
      item: 'Item',
      qtyOrdered: 'Jumlah Dipesan',
      unitPrice: 'Harga Satuan',
      addLine: 'Tambah Baris',
      detailTitle: 'Detail Purchase Order',
      lines: 'Daftar Item',
      qtyReceived: 'Jumlah Diterima',
      lineTotal: 'Subtotal Baris',
      cancelReason: 'Alasan Pembatalan',
      submitButton: 'Ajukan Persetujuan',
      submitSuccess: 'Purchase order diajukan untuk persetujuan.',
      note: 'Catatan',
      approveButton: 'Setujui',
      approveSuccess: 'Purchase order disetujui.',
      rejectButton: 'Tolak',
      rejectSuccess: 'Purchase order ditolak.',
      rejectTitle: 'Tolak Purchase Order',
      rejectReason: 'Alasan Penolakan',
      issueButton: 'Terbitkan ke Supplier',
      issueSuccess: 'Purchase order diterbitkan.',
      receiveButton: 'Terima Barang',
      receiveTitle: 'Penerimaan Barang PO',
      receiveConfirm: 'Konfirmasi Penerimaan',
      receiveSuccess: 'Penerimaan barang berhasil dicatat.',
      due: 'Sisa',
      storageArea: 'Area Simpan',
      conditionNotes: 'Catatan Kondisi/Selisih',
      receivingPhotos: 'Foto Bukti Penerimaan',
      closeButton: 'Tutup PO',
      closeSuccess: 'Purchase order ditutup.',
      cancelButton: 'Batalkan',
      cancelTitle: 'Batalkan Purchase Order',
      approvalTitle: 'Riwayat Persetujuan',
      paymentStatusLabel: 'Status Pembayaran',
      paymentStatusUnavailable: 'Status pembayaran belum tersedia',
    },
    priceHistory: {
      supplier: 'Supplier',
      item: 'Item',
      filterItemAll: 'Semua Item',
      selectSupplier: 'Pilih supplier untuk melihat riwayat harga.',
      empty: 'Belum ada riwayat harga untuk supplier ini.',
      columnItem: 'Item',
      columnPrice: 'Harga',
      columnEffectiveDate: 'Berlaku Sejak',
      columnSource: 'Sumber',
      columnRecordedBy: 'Dicatat Oleh',
      source: {
        manual: 'Manual',
        po: 'Dari PO',
      },
    },
  },

  admin: {
    tabs: {
      users: 'Pengguna',
      masterData: 'Data Master',
      audit: 'Jejak Audit',
      settings: 'Pengaturan',
      // F-DOC — the two owner-facing surfaces the document designers added.
      // `documents` is gated on `doc_template.manage` and `brand` on
      // `settings.manage`, not on `settings.read`: both WRITE (a layout, a
      // settings key), and a role that may only read settings must not see a
      // canvas it cannot save.
      documents: 'Dokumen',
      brand: 'Merek',
      email: 'Email',
    },
    email: {
      title: 'Pengaturan Email',
      description:
        'Hubungkan akun Gmail perusahaan Anda. Semua notifikasi email akan dikirim dari akun ini.',
      gmailHelpTitle: 'Cara mendapatkan App Password Gmail',
      gmailStep1: 'Aktifkan Verifikasi 2 Langkah di Akun Google Anda.',
      gmailStep2:
        'Buka myaccount.google.com/apppasswords, lalu buat App Password baru (pilih "Mail").',
      gmailStep3: 'Salin 16 karakter yang muncul, lalu tempel di kolom App Password di bawah.',
      host: 'Server SMTP',
      port: 'Port',
      port587: '587 — STARTTLS (disarankan untuk Gmail)',
      port465: '465 — SSL/TLS',
      username: 'Alamat Gmail',
      password: 'App Password',
      passwordHint: '16 karakter dari Google. Bukan kata sandi akun Anda.',
      passwordStored: 'Sudah tersimpan. Kosongkan jika tidak ingin mengubah.',
      fromEmail: 'Alamat Pengirim',
      fromEmailHint:
        'Gmail akan menimpa alamat ini dengan akun di atas kecuali "Send mail as" diatur.',
      fromName: 'Nama Pengirim',
      enabled: 'Aktifkan pengiriman email',
      enabledHint: 'Nonaktifkan untuk berhenti mengirim tanpa menghapus kredensial.',
      testButton: 'Uji Koneksi',
      testOk: 'Koneksi berhasil.',
      testFailed: 'Koneksi gagal.',
      lastTestOk: 'Uji koneksi terakhir berhasil.',
      lastTestFailed: 'Uji koneksi terakhir gagal',
      saveSuccess: 'Pengaturan email tersimpan.',
    },
    users: {
      title: 'Pengguna',
      description: 'Kelola akun, peran, dan lokasi akses staf.',
      searchPlaceholder: 'Cari username atau nama…',
      createButton: 'Tambah Pengguna',
      columnUsername: 'Username',
      columnName: 'Nama',
      columnRole: 'Peran',
      columnLocations: 'Lokasi',
      columnStatus: 'Status',
      columnLastLogin: 'Login Terakhir',
      statusActive: 'Aktif',
      statusInactive: 'Nonaktif',
      never: 'Belum pernah',
      filterRole: 'Semua Peran',
      filterStatus: 'Semua Status',
      createTitle: 'Tambah Pengguna Baru',
      editTitle: 'Ubah Pengguna',
      username: 'Username',
      name: 'Nama Lengkap',
      email: 'Email',
      phone: 'No. Telepon',
      password: 'Kata Sandi',
      role: 'Peran',
      locations: 'Lokasi',
      rankWarning: 'Anda hanya dapat menetapkan peran di bawah peran Anda sendiri.',
      assignRole: 'Ubah Peran',
      assignLocations: 'Ubah Lokasi',
      resetPassword: 'Reset Kata Sandi',
      newPassword: 'Kata Sandi Baru',
      deactivate: 'Nonaktifkan',
      deactivateTitle: 'Nonaktifkan Pengguna?',
      deactivateDescription:
        'Pengguna {{name}} tidak akan bisa masuk lagi. Sesi dan kredensial offline akan dicabut.',
      createSuccess: 'Pengguna berhasil dibuat.',
      updateSuccess: 'Data pengguna berhasil diperbarui.',
      roleUpdateSuccess: 'Peran berhasil diperbarui.',
      locationsUpdateSuccess: 'Lokasi berhasil diperbarui.',
      passwordResetSuccess: 'Kata sandi berhasil direset.',
      deactivateSuccess: 'Pengguna berhasil dinonaktifkan.',
      selectLocationsHint: 'Pilih satu atau lebih lokasi.',
      // The manager rule is a real footgun without this line: before
      // migration 235 assigning a branch to a manager did nothing at all,
      // and now it CONFINES them. An owner adding one branch to a
      // company-wide manager would otherwise silently take away the other
      // nineteen.
      managerScopeHint:
        'Khusus Manajer: kosongkan untuk akses semua cabang, atau pilih cabang tertentu untuk membatasi aksesnya hanya ke cabang itu.',
    },
    masterData: {
      tabs: {
        items: 'Item',
        categoriesUnits: 'Kategori & Satuan',
        products: 'Produk & Resep',
        menuCategories: 'Kategori Menu POS',
        locations: 'Lokasi & Area Simpan',
      },
      items: {
        title: 'Item / Bahan',
        createButton: 'Tambah Item',
        editTitle: 'Ubah Item',
        createTitle: 'Tambah Item',
        searchPlaceholder: 'Cari SKU atau nama…',
        columnSku: 'SKU',
        columnName: 'Nama',
        columnCategory: 'Kategori',
        columnUnit: 'Satuan',
        columnStorageType: 'Jenis Simpan',
        columnSellable: 'Bisa Dijual',
        // The ingredient / sellable split (owner, 2026-08-21).
        columnKind: 'Jenis',
        kindIngredient: 'Bahan',
        kindSellable: 'Bisa Dijual',
        kindAll: 'Semua Jenis',
        filterKind: 'Jenis Item',
        statusAll: 'Semua Status',
        activated: '{{name}} diaktifkan.',
        deactivated: '{{name}} dinonaktifkan.',
        columnStatus: 'Status',
        sku: 'SKU',
        name: 'Nama',
        category: 'Kategori',
        baseUnit: 'Satuan Dasar',
        storageType: 'Jenis Penyimpanan',
        storageFrozen: 'Beku',
        storageChilled: 'Dingin',
        storageDry: 'Kering',
        isSellable: 'Bisa Dijual Langsung',
        shelfLifeDays: 'Masa Simpan (hari)',
        barcode: 'Barcode',
        tempMin: 'Suhu Min (°C)',
        tempMax: 'Suhu Maks (°C)',
        createSuccess: 'Item berhasil ditambahkan.',
        updateSuccess: 'Item berhasil diperbarui.',
        deactivateSuccess: 'Item berhasil dinonaktifkan.',
      },
      categories: {
        title: 'Kategori Item',
        createButton: 'Tambah Kategori',
        name: 'Nama Kategori',
        parent: 'Kategori Induk',
        noParent: 'Tanpa induk',
        createSuccess: 'Kategori berhasil ditambahkan.',
        rename: 'Ganti Nama',
        renameTitle: 'Ganti Nama Kategori — {{name}}',
        renameSuccess: 'Nama kategori berhasil diubah.',
        updateSuccess: 'Kategori berhasil diperbarui.',
      },
      units: {
        title: 'Satuan',
        createButton: 'Tambah Satuan',
        code: 'Kode',
        name: 'Nama Satuan',
        createSuccess: 'Satuan berhasil ditambahkan.',
      },
      products: {
        title: 'Produk / Menu',
        createButton: 'Tambah Produk',
        editTitle: 'Ubah Produk',
        createTitle: 'Tambah Produk',
        searchPlaceholder: 'Cari kode atau nama produk…',
        columnCode: 'Kode',
        columnName: 'Nama',
        columnCategory: 'Kategori',
        columnPrice: 'Harga',
        columnHasRecipe: 'Punya Resep',
        columnStatus: 'Status',
        code: 'Kode',
        name: 'Nama',
        category: 'Kategori',
        price: 'Harga Jual (Kasir)',
        // F-POS-3 — the two channel prices. "Kasir" here is the walk-in
        // price the field above already carries; the hint spells out the
        // null->walk-in fallback in the same words the toggle/receipt use.
        priceGofood: 'Harga GoFood',
        priceShopeefood: 'Harga ShopeeFood',
        priceChannelHint: 'Kosongkan jika sama dengan harga Kasir (walk-in).',
        editRecipe: 'Ubah Resep',
        categoryAll: 'Semua Kategori',
        activated: '{{name}} ditampilkan kembali di POS.',
        deactivated: '{{name}} disembunyikan dari POS.',
        recipeTitle: 'Resep — {{name}}',
        yieldQty: 'Hasil (Yield)',
        addLine: 'Tambah Bahan',
        recipeItem: 'Bahan',
        recipeQty: 'Jumlah',
        recipeUnit: 'Satuan',
        removeLine: 'Hapus',
        createSuccess: 'Produk berhasil ditambahkan.',
        updateSuccess: 'Produk berhasil diperbarui.',
        recipeSuccess: 'Resep berhasil disimpan.',
        deactivateSuccess: 'Produk berhasil dinonaktifkan.',
        columnPhoto: 'Foto',
        columnKind: 'Jenis',
        kindProduct: 'Produk',
        kindPackage: 'Paket',
        kindAll: 'Semua Jenis',
        noPhoto: 'Belum ada foto',
        photo: 'Foto Produk',
        photoHint: 'JPG atau PNG, maksimal 8 MB. Foto akan dikompres otomatis.',
        photoReplaceHint: 'Unggah foto baru untuk menggantikan foto ini.',
        photoUploading: 'Mengunggah foto…',
        categoryPlaceholder: 'Pilih kategori menu',
        memberCount: '{{count}} isi paket',
        editPackage: 'Ubah Isi Paket',
        makePackage: 'Jadikan Paket',
        packageTitle: 'Isi Paket — {{name}}',
        packageHint:
          'Paket dijual sebagai satu baris dengan harganya sendiri. Stok dihitung dari resep setiap produk isinya, jadi paket tidak perlu resep sendiri.',
        packageDuplicate: 'Ada produk isi yang sama dua kali — ubah jumlahnya saja.',
        member: 'Produk Isi',
        memberPlaceholder: 'Pilih produk',
        memberQty: 'Jumlah',
        addMember: 'Tambah Isi',
        membersTotal: 'Total harga satuan isi',
        packagePrice: 'Harga paket',
        packageSaving: 'Hemat',
        packageSaved: 'Isi paket berhasil disimpan.',
      },
      menuCategories: {
        title: 'Kategori Menu POS',
        description:
          'Kategori yang muncul sebagai tombol filter di kasir. Urutannya menentukan urutan tombol di layar POS.',
        empty: 'Belum ada kategori menu.',
        name: 'Nama Kategori',
        createButton: 'Tambah Kategori',
        createSuccess: 'Kategori menu berhasil ditambahkan.',
        rename: 'Ganti Nama',
        renameTitle: 'Ganti Nama — {{name}}',
        renameHint:
          '{{count}} produk memakai kategori ini. Nama baru langsung berlaku untuk semuanya tanpa perlu mengubah tiap produk.',
        renameSuccess: 'Nama kategori berhasil diubah.',
        reorderSuccess: 'Urutan kategori berhasil disimpan.',
        deactivateSuccess: 'Kategori berhasil dinonaktifkan.',
        activateSuccess: 'Kategori berhasil diaktifkan kembali.',
        productCount: '{{count}} produk',
        inUseHint: 'Masih ada produk di kategori ini. Pindahkan dulu produknya.',
        moveUp: 'Naikkan urutan',
        moveDown: 'Turunkan urutan',
      },
      locations: {
        title: 'Lokasi',
        createButton: 'Tambah Lokasi',
        editTitle: 'Ubah Lokasi',
        createTitle: 'Tambah Lokasi',
        columnCode: 'Kode',
        columnName: 'Nama',
        columnType: 'Tipe',
        columnCity: 'Kota',
        columnAreas: 'Jumlah Area',
        columnStatus: 'Status',
        code: 'Kode',
        name: 'Nama',
        type: 'Tipe Lokasi',
        typeWarehouse: 'Gudang',
        typeOutlet: 'Outlet',
        city: 'Kota',
        address: 'Alamat',
        phone: 'No. Telepon',
        // FR-LOG-03 — outlet only. 'Belum diatur' is a real state, not a
        // placeholder: an outlet nobody has agreed a schedule for must read as
        // undecided rather than appear to be on the rarest one.
        cadence: 'Frekuensi Pengiriman',
        cadenceNone: 'Belum diatur',
        cadenceDaily: 'Setiap hari',
        cadenceTwiceWeekly: '2x seminggu',
        cadenceThriceWeekly: '3x seminggu',
        cadenceWeekly: 'Mingguan',
        geofenceRadius: 'Radius Geofence (m)',
        // Closing / reopening an outlet. The copy is deliberate: this is a SOFT
        // close (`is_active = false`), and promising deletion would be a lie —
        // every Surat Jalan, stock balance and shift that ever touched the
        // location still refers to it.
        deactivateTitle: 'Tutup lokasi "{{name}}"?',
        deactivateWarning:
          'Lokasi disembunyikan dari semua pilihan (pengiriman, opname, absensi, POS) tetapi seluruh riwayatnya tetap tersimpan. Lokasi dapat dibuka kembali kapan saja.',
        deactivated: 'Lokasi ditutup',
        reactivateTitle: 'Buka kembali lokasi "{{name}}"?',
        reactivateWarning:
          'Lokasi akan kembali muncul di semua pilihan dan dapat menerima pengiriman serta transaksi lagi.',
        reactivated: 'Lokasi dibuka kembali',
        storageAreas: 'Area Penyimpanan',
        // GEOFENCE (owner, 2026-08-21: attendance fenced at 200 m of the outlet).
        // These fields did not exist, so an outlet created here had no centre and
        // every check-in at it failed.
        geofenceTitle: 'Geofence Absensi',
        geofenceHint:
          'Titik pusat outlet untuk absensi. Tanpa titik ini, karyawan di outlet tersebut tidak bisa absen.',
        latitude: 'Latitude',
        longitude: 'Longitude',
        coordsHint: 'Gunakan tombol di bawah saat Anda berada di lokasi outlet.',
        useCurrentPosition: 'Ambil Lokasi Saya Sekarang',
        geoUnsupported: 'Perangkat ini tidak mendukung GPS.',
        geoDenied: 'Izin lokasi ditolak — aktifkan GPS lalu coba lagi.',
        radius: 'Radius (meter)',
        radiusDefault: 'Ikuti pengaturan (200 m)',
        radiusInherited: 'Ikuti pengaturan ({{radius}} m)',
        radiusHint:
          'Kosongkan untuk mengikuti pengaturan sistem. Isi hanya bila outlet ini perlu radius berbeda.',
        addArea: 'Tambah Area',
        areaCode: 'Kode Area',
        areaName: 'Nama Area',
        areaType: 'Jenis Area',
        areaTypeFreezer: 'Freezer',
        areaTypeChiller: 'Chiller',
        areaTypeDryStore: 'Gudang Kering',
        areaTypeDisplay: 'Display',
        areaTypeKitchenLine: 'Lini Dapur',
        createSuccess: 'Lokasi berhasil ditambahkan.',
        updateSuccess: 'Lokasi berhasil diperbarui.',
        areaCreateSuccess: 'Area penyimpanan berhasil ditambahkan.',
        areaUpdateSuccess: 'Area penyimpanan berhasil diperbarui.',
        areaHasStock: 'Area tidak dapat dinonaktifkan — masih ada stok di dalamnya.',
      },
    },
    audit: {
      title: 'Jejak Audit',
      description:
        'Siapa mengubah apa, sebelum dan sesudah, kapan, dan mengapa — kontrol anti-kecurangan (FR-AUDIT-01/02).',
      filterEntityType: 'Jenis Entitas',
      filterEntityId: 'ID Entitas',
      filterUser: 'Pengguna',
      filterModule: 'Modul',
      filterLocation: 'Lokasi',
      columnWhen: 'Waktu',
      columnUser: 'Pengguna',
      columnModule: 'Modul',
      columnAction: 'Aksi',
      columnEntity: 'Entitas',
      columnReason: 'Alasan',
      columnOffline: 'Offline',
      viewDetail: 'Lihat Perubahan',
      detailTitle: 'Detail Perubahan',
      before: 'Sebelum',
      after: 'Sesudah',
      noValue: 'Tidak ada',
      noReason: 'Tanpa alasan tercatat',
      offlineAuthorized: 'Diotorisasi Offline',
      empty: 'Belum ada catatan audit.',
    },
    settings: {
      // REDESIGNED SETTINGS SCREEN (owner, 2026-08-21: "this is confusing for
      // normal user"). The old table showed the raw key plus the developer's
      // English description and no value at all. Everything below is the
      // owner-facing layer: section names, per-setting names, and — the part
      // that was missing entirely — what changing each one actually DOES.
      columnSetting: 'Pengaturan',
      columnValue: 'Nilai Saat Ini',
      // RISK-P5/S1 — a signpost, not a control. The switch is per-outlet and
      // lives beside the node's live queue status, because turning one OFF
      // requires that queue to be empty first (D-26). The copy says where it
      // is and what the default is, so "I could not find it in Pengaturan"
      // stops being a reasonable conclusion.
      lanNode: {
        title: 'Branch Node (LAN) per Outlet',
        hint: 'Setiap outlet bisa memakai branch node di jaringan lokal, atau langsung ke cloud. Bawaannya langsung ke cloud. Pengaturannya ada di halaman Topologi, di samping status node outlet tersebut.',
        link: 'Buka Topologi untuk mengatur',
      },
      searchPlaceholder: 'Cari pengaturan…',
      searchEmpty: 'Tidak ada pengaturan yang cocok.',
      valueLabel: 'Nilai',
      enabledLabel: 'Aktif',
      rawJsonLabel: 'Nilai Mentah (JSON)',
      showRaw: 'Tampilkan nilai mentah (JSON)',
      hideRaw: 'Sembunyikan nilai mentah',
      noSpecHelp:
        'Pengaturan teknis. Ubah hanya bila Anda tahu dampaknya — nilai disimpan apa adanya.',
      section: {
        approval: 'Persetujuan',
        attendance: 'Absensi & Cuti',
        payroll: 'Penggajian',
        pos: 'Kasir & Offline',
        coldchain: 'Rantai Dingin',
        sync: 'Sinkronisasi & Notifikasi',
        company: 'Profil Perusahaan',
        other: 'Lainnya',
      },
      sectionHint: {
        approval: 'Batas nilai yang menentukan siapa harus menyetujui sebuah dokumen.',
        attendance: 'Aturan absen di outlet dan kuota cuti tahunan.',
        payroll: 'Lembur, potongan, dan aturan penggajian.',
        pos: 'Batas di kasir dan aturan saat perangkat sedang offline.',
        coldchain: 'Batas suhu untuk barang beku selama pengiriman.',
        sync: 'Toleransi sinkronisasi antar perangkat dan kanal notifikasi.',
        company: 'Identitas perusahaan yang dicetak di dokumen dan slip gaji.',
        other: 'Pengaturan teknis lain.',
      },
      unit: {
        minutes: '{{n}} menit',
        hours: '{{n}} jam',
        metres: '{{n}} m',
        days: '{{n}} hari',
        count: '{{n}}×',
        percent: '{{n}}%',
      },
      unitHint: {
        minutes: 'Dalam menit.',
        hours: 'Dalam jam.',
        metres: 'Dalam meter.',
        days: 'Dalam hari.',
        count: 'Jumlah maksimum.',
        percent: 'Dalam persen.',
      },
      spec: {
        field: {
          managerAbove: 'Wajib disetujui Manajer di atas',
          ownerAbove: 'Wajib disetujui Pemilik di atas',
          annualLeave: 'Cuti tahunan',
          marriageLeave: 'Cuti menikah',
          ratePerHour: 'Tarif lembur per jam',
          minMinutes: 'Minimal lembur dihitung',
          perLateMinute: 'Potongan per menit terlambat',
          sickPaid: 'Sakit tetap dibayar',
          permissionPaid: 'Izin tetap dibayar',
          perAbsentDay: 'Potongan per hari alpha',
          mode: 'Mode',
          splitRule: 'Aturan pembagian',
          pct: 'Toleransi selisih harga',
          minC: 'Suhu minimum (°C)',
          maxC: 'Suhu maksimum (°C)',
          companyName: 'Nama perusahaan',
          address: 'Alamat',
          city: 'Kota',
        },
        void: {
          label: 'Batas Void/Refund',
          help: 'Void atau refund di kasir di atas nilai ini wajib disetujui Manajer. Di bawahnya, kasir bisa memprosesnya sendiri.',
        },
        opname: {
          label: 'Batas Selisih Stok Opname',
          help: 'Stok opname dengan nilai selisih di atas ini wajib disetujui Manajer sebelum stok dikoreksi.',
        },
        po: {
          label: 'Batas Pesanan Pembelian (PO)',
          help: 'PO dengan total di atas nilai ini wajib disetujui Pemilik, bukan hanya Manajer.',
        },
        payment: {
          label: 'Batas Verifikasi Pembayaran',
          help: 'Pembayaran di atas nilai ini wajib diverifikasi Pemilik sebelum dianggap lunas.',
        },
        approvalMode: {
          label: 'Mode Persetujuan per Dokumen',
          help: 'Menentukan apakah sebuah jenis dokumen perlu persetujuan manusia atau lewat otomatis.',
          elsewhere:
            'Diatur di layar Mode Persetujuan, bukan di sini — di sana ada pengaman saat sebuah rantai persetujuan dimatikan.',
        },
        geofence: {
          label: 'Radius Absensi (Geofence)',
          help: 'Jarak maksimum dari titik outlet agar karyawan bisa absen. Terlalu kecil membuat karyawan gagal absen padahal sudah di lokasi (GPS ponsel biasanya melenceng 20–50 m).',
        },
        lateGrace: {
          label: 'Toleransi Keterlambatan',
          help: 'Menit setelah jam shift yang masih dihitung tepat waktu. Lewat dari ini, absensi ditandai terlambat dan bisa terkena potongan.',
        },
        leaveQuotas: {
          label: 'Kuota Cuti',
          help: 'Jumlah hari cuti per karyawan per tahun. Dipakai saat pengajuan cuti memeriksa sisa kuota.',
        },
        overtime: {
          label: 'Lembur',
          help: 'Tarif lembur per jam dan lama minimum agar lembur dihitung. Di bawah minimum, kelebihan jam tidak dibayar.',
        },
        deductions: {
          label: 'Potongan Absensi',
          help: 'Potongan gaji karena terlambat atau tidak masuk, dan apakah sakit/izin tetap dibayar.',
        },
        statutory: {
          label: 'Mode Payroll Statutori (PPh21 & BPJS)',
          help: 'Bila aktif, perhitungan gaji menyertakan iuran BPJS dan potongan PPh21.',
          elsewhere:
            'Diatur lewat tab Payroll Statutori — ada langkah konfirmasi karena mengubahnya mempengaruhi seluruh perhitungan gaji.',
        },
        soShortfall: {
          label: 'Pembebanan Selisih Stok ke Gaji',
          help: 'Aturan saat selisih stok opname dibebankan ke karyawan yang sedang bertugas.',
        },
        cashVariance: {
          label: 'Batas Selisih Kas Kasir',
          help: 'Selisih kas saat tutup shift di atas nilai ini otomatis membuat usulan koreksi kas untuk ditinjau.',
        },
        qris: {
          label: 'Mode QRIS',
          help: 'Cara pembayaran QRIS dijalankan: statis (satu kode tercetak) atau dinamis per transaksi.',
        },
        selfieAbove: {
          label: 'Selfie Wajib untuk Otorisasi Offline',
          help: 'Saat perangkat offline, persetujuan di atas nilai ini wajib disertai selfie penyetuju sebagai bukti.',
        },
        offlineCap: {
          label: 'Batas Jumlah Otorisasi Offline',
          help: 'Berapa kali satu kredensial offline boleh dipakai sebelum perangkat harus online lagi.',
        },
        offlineTtl: {
          label: 'Masa Berlaku Kredensial Offline',
          help: 'Berapa lama kredensial otorisasi offline tetap berlaku sebelum perangkat wajib online.',
        },
        coldchain: {
          label: 'Batas Suhu Barang Beku',
          help: 'Rentang suhu yang dianggap aman selama pengiriman beku. Di luar rentang ini, pengiriman ditandai pelanggaran rantai dingin.',
        },
        offlineWindow: {
          label: 'Batas Waktu Offline',
          help: 'Berapa lama sebuah perangkat boleh offline sebelum data yang dikirimnya ditandai perlu ditinjau.',
        },
        priceVariance: {
          label: 'Toleransi Selisih Harga',
          help: 'Selisih harga antar perangkat di bawah persentase ini dianggap wajar dan tidak masuk antrean rekonsiliasi.',
        },
        waEnabled: {
          label: 'Kanal WhatsApp',
          help: 'Bila nonaktif, pesan WhatsApp hanya dicatat di sistem dan tidak benar-benar dikirim.',
        },
        company: {
          label: 'Profil Perusahaan',
          help: 'Nama dan alamat yang dicetak di Surat Jalan, slip gaji, dan dokumen resmi lain.',
        },
      },
      title: 'Pengaturan',
      description:
        'Parameter sistem: profil perusahaan, ambang persetujuan, dan mode payroll statutori.',
      tabGeneral: 'Umum',
      tabPayroll: 'Payroll Statutori',
      columnKey: 'Kunci',
      columnDescription: 'Deskripsi',
      columnUpdatedBy: 'Diubah Oleh',
      columnUpdatedAt: 'Terakhir Diubah',
      editValue: 'Ubah Nilai',
      editTitle: 'Ubah Pengaturan',
      rawJsonHint: 'Nilai berupa JSON — divalidasi oleh server sesuai skema kunci ini.',
      invalidJson: 'JSON tidak valid',
      updateSuccess: 'Pengaturan berhasil diperbarui.',
      payrollStatutory: {
        title: 'Mode Payroll Statutori (BPJS / PPh21)',
        description:
          'Amendment 1 — bila diaktifkan, perhitungan payroll menyertakan iuran BPJS dan potongan PPh21 (TER/PTKP/Pasal 17). Nonaktif secara default.',
        statusEnabled: 'Aktif',
        statusDisabled: 'Nonaktif',
        readyBadge: 'Siap Diaktifkan',
        notReadyBadge: 'Belum Lengkap',
        enabledAt: 'Diaktifkan pada {{when}}',
        enabledBy: 'oleh {{name}}',
        profileCoverage: '{{withProfile}} dari {{total}} pegawai punya profil pajak',
        missingTitle: 'Konfigurasi yang belum lengkap:',
        missing: {
          bpjs_configs: 'Tarif BPJS belum diatur',
          pph21_ter_rates: 'Tarif PPh21 TER belum diatur',
          pph21_ptkp: 'Tabel PTKP belum diatur',
          pph21_article17_brackets: 'Tarif Pasal 17 belum diatur',
          employee_tax_profiles: 'Profil pajak pegawai belum lengkap',
        },
        configureHint:
          'Tarif BPJS, tabel PPh21, dan profil pajak pegawai dikonfigurasi di modul SDM & Payroll.',
        enableButton: 'Aktifkan Mode Statutori',
        disableButton: 'Nonaktifkan',
        confirmEnableTitle: 'Aktifkan Mode Payroll Statutori?',
        confirmEnableDescription:
          'Payroll berikutnya akan menghitung BPJS dan PPh21 secara otomatis. Tindakan ini tercatat di jejak audit.',
        disableTitle: 'Nonaktifkan Mode Statutori?',
        disableReasonLabel: 'Alasan',
        disableReasonPlaceholder: 'Mengapa mode statutori dinonaktifkan?',
        enableSuccess: 'Mode payroll statutori diaktifkan.',
        disableSuccess: 'Mode payroll statutori dinonaktifkan.',
        notReadyError: 'Konfigurasi belum lengkap — lengkapi item di atas sebelum mengaktifkan.',
      },
    },
  },

  // F04 `outlet` (W4-07) — Leader/Staff Outlet + Supervisor Cabang's daily
  // working screen: request barang, terima barang, stok per area, stock
  // opname, waste/retur, kas kecil. Additive-only namespace (no existing key
  // above touched) per this file's own "Wave 4–5 agents add keys here"
  // contract.
  outlet: {
    // Which outlet these flows act on. A central role (owner/superadmin) has no
    // assigned outlet, so it picks one — and can switch to monitor others.
    location: {
      current: 'Outlet:',
      change: 'Ganti Outlet',
      chooseTitle: 'Pilih Outlet',
      chooseDescription:
        'Akun Anda tidak terikat ke satu outlet. Pilih outlet yang ingin Anda lihat atau kelola.',
      loadFailedTitle: 'Gagal memuat daftar outlet',
      loadFailedDescription: 'Periksa koneksi Anda lalu coba lagi.',
    },
    tabs: {
      replenishment: 'Minta Barang',
      receiving: 'Terima Barang',
      stock: 'Stok',
      opname: 'Stock Opname',
      waste: 'Waste / Retur',
      pettyCash: 'Kas Kecil',
      roster: 'Jadwal Shift',
    },
    replenishment: {
      number: 'No. Permintaan',
      item: 'Barang',
      qty: 'Jumlah',
      qtyRequested: 'Diminta',
      qtyApproved: 'Disetujui',
      amendReason: 'Alasan Perubahan Jumlah',
      new: 'Buat Permintaan',
      addLine: 'Tambah Baris',
      neededBy: 'Dibutuhkan Sebelum',
      created: 'Permintaan barang berhasil diajukan',
      empty: 'Belum ada permintaan barang',
      draftHint: 'Permintaan ini masih draft — lengkapi dan ajukan dari layar sebelumnya.',
      rejectedFlag: 'Ditolak — lihat alasan',
      amendedFlag: 'Jumlah diubah — lihat alasan',
    },
    receiving: {
      title: 'Terima Barang',
      driver: 'Driver',
      item: 'Barang',
      qtySent: 'Dikirim',
      qtyReceived: 'Diterima',
      storageArea: 'Area Penyimpanan',
      discrepancyReason: 'Alasan Selisih',
      photoLabel: 'Foto Barang Diterima',
      signatureLabel: 'Penerima',
      confirm: 'Konfirmasi Terima',
      received: 'Barang berhasil diterima',
      queued: 'Penerimaan tersimpan — akan tersinkron otomatis saat koneksi tersedia',
      empty: 'Tidak ada pengiriman yang menunggu diterima',
    },
    stock: {
      belowMin: 'Di Bawah Stok Minimum',
      // Names the outlet in the heading: a printed stock sheet ends up on a
      // clipboard next to another outlet's, and an untitled one is unusable.
      reportTitle: 'Laporan Stok — {{outlet}}',
    },
    opname: {
      number: 'No. Opname',
      // Says the one thing a CSV cannot do here, before the operator finds out
      // from a list of rejected rows.
      importNote:
        'Impor hanya mengisi qty pada baris yang sudah ada di lembar hitung ini. Barang yang belum ada di lembar akan dilaporkan sebagai baris gagal, bukan ditambahkan.',
      new: 'Mulai Opname',
      area: 'Area Penyimpanan',
      countSheet: 'Lembar Hitung',
      item: 'Barang',
      systemQty: 'Stok Sistem',
      countedQty: 'Hasil Hitung',
      diffQty: 'Selisih',
      lineCount: 'Jumlah Baris',
      empty: 'Belum ada stock opname',
      submitted: 'Stock opname berhasil diajukan',
      reasonGateHint: 'Setiap baris yang selisih wajib diisi alasannya sebelum diajukan.',
    },
    waste: {
      importNote:
        'Impor mengisi baris waste. Foto bukti tetap wajib dan diunggah di bawah — CSV tidak menggantikan bukti foto.',
      tab: 'Waste',
      number: 'No. Waste',
      new: 'Catat Waste',
      photoLabel: 'Foto Waste',
      created: 'Waste berhasil dicatat',
      empty: 'Belum ada catatan waste',
      reason: {
        expired: 'Kedaluwarsa',
        damaged: 'Rusak',
        spoiled: 'Busuk',
        prep_error: 'Salah Olah',
        other: 'Lainnya',
      },
    },
    return: {
      tab: 'Retur ke Gudang',
      number: 'No. Retur',
      new: 'Buat Retur',
      photoLabel: 'Foto Bukti',
      created: 'Retur berhasil diajukan',
      empty: 'Belum ada retur',
      importNote: 'Impor mengisi baris retur. Foto bukti tetap wajib dan diunggah di bawah.',
    },
    pettyCash: {
      importNote:
        'Impor mengisi baris belanja. Bukti pembayaran dan foto barang tetap wajib diunggah di bawah. Tulis jumlah dalam rupiah, mis. 120.000.',
      number: 'No. Kas Kecil',
      new: 'Catat Kas Kecil',
      storeName: 'Nama Toko/Supplier',
      description: 'Keterangan',
      category: 'Kategori Biaya',
      categoryOptions: {
        bahan_baku: 'Bahan Baku',
        kebersihan: 'Kebersihan',
        operasional_lain: 'Operasional Lain',
      },
      paymentProofLabel: 'Bukti Pembayaran',
      goodsPhotoLabel: 'Foto Barang',
      created: 'Kas kecil berhasil dicatat',
      empty: 'Belum ada catatan kas kecil',
      useFreeText: 'Bukan dari daftar? Ketik manual',
    },
  },

  // F05 `warehouse` (W4-08) — Kepala Gudang + warehouse staff's daily working
  // screen: antrean persetujuan, pembuatan Surat Jalan, stok gudang,
  // penerimaan PO, retur ke supplier, rekap pengiriman harian. Additive-only
  // namespace, same "Wave 4–5 agents add keys here" contract as `outlet`.
  warehouse: {
    dash: {
      inTransit: 'Surat Jalan Dalam Perjalanan',
      pendingApprovals: 'Menunggu Persetujuan',
      lowStock: 'Outlet Stok Menipis',
      coldChain: 'Pelanggaran Rantai Dingin (24 jam)',
      areas: 'Area Gudang',
    },
    tabs: {
      approvalQueue: 'Antrean Persetujuan',
      suratJalan: 'Pengiriman',
      stock: 'Stok Gudang',
      receiving: 'Penerimaan PO',
      opname: 'Stock Opname',
      waste: 'Waste',
      return: 'Retur',
      recap: 'Rekap Harian',
    },
    // Shown instead of a bare error/blank state when this account has no
    // `warehouse`-type location (e.g. a company-wide role like Owner) — see
    // `useWarehouseLocation()`. Distinct from `table.error`/`table.empty`:
    // there's genuinely nothing to retry here, it's an assignment gap.
    noLocation: 'Akun ini belum terhubung ke lokasi gudang manapun.',
    approvalQueue: {
      number: 'No. Permintaan',
      outlet: 'Outlet',
      requestedBy: 'Diminta Oleh',
      supervisorDecision: 'Keputusan Supervisor',
      item: 'Barang',
      qtyRequested: 'Diminta',
      qtyApproved: 'Disetujui',
      amend: 'Ubah Jumlah',
      amendThisLine: 'Ubah baris ini',
      amendReason: 'Alasan Perubahan',
      amendWarning: '{{count}} baris jumlahnya diubah — alasan wajib diisi sebelum disetujui.',
      note: 'Catatan (opsional)',
      rejectReason: 'Alasan Penolakan',
      reject: 'Tolak',
      confirmReject: 'Konfirmasi Tolak',
      approve: 'Setujui',
      approved: 'Permintaan berhasil disetujui',
      rejected: 'Permintaan berhasil ditolak',
      empty: 'Tidak ada permintaan yang menunggu persetujuan gudang',
      pendingTitle: 'Menunggu Persetujuan Gudang',
      approvedTitle: 'Disetujui — Siap Diproses',
      approvedHint:
        'Mulai pemrosesan untuk menandai pengambilan barang sudah dimulai, sebelum Surat Jalan dibuat.',
      approvedEmpty: 'Tidak ada permintaan yang disetujui dan menunggu diproses',
      process: 'Mulai Pemrosesan',
      processed: 'Permintaan mulai diproses',
    },
    sj: {
      number: 'No. Surat Jalan',
      new: 'Buat Surat Jalan',
      create: 'Buat Surat Jalan',
      created: 'Surat Jalan berhasil dibuat',
      empty: 'Belum ada Surat Jalan',
      shipmentType: 'Tipe Pengiriman',
      frozen: 'Beku/Dingin',
      dry: 'Kering (Sembako)',
      mixWarning:
        'Barang beku/dingin dan kering tidak boleh digabung dalam satu Surat Jalan — pilih tipe pengiriman dulu, hanya barang yang cocok yang bisa disertakan.',
      pickRequests: 'Pilih Permintaan yang Disetujui',
      noApprovedRequests: 'Belum ada permintaan yang disetujui dan siap dikirim',
      noCompatibleLines: 'Tidak ada barang yang cocok dengan tipe pengiriman ini',
      excludedLines: '{{count}} baris tidak disertakan karena beda tipe pengiriman',
      routePreview: 'Rute Multi-Drop',
      dropSeq: 'Drop {{seq}}',
      driver: 'Driver',
      vehicle: 'Kendaraan',
      vehicleNeedsFreezer:
        'Kendaraan ini tidak punya freezer — tidak bisa untuk pengiriman beku/dingin',
      plannedDate: 'Tanggal Rencana Kirim',
      dropsCount: 'Jumlah Drop',
      markReady: 'Tandai Siap Kirim',
      load: 'Muat Barang',
      loaded: 'Barang berhasil dimuat',
      dispatch: 'Berangkatkan',
      dispatched: 'Surat Jalan berhasil diberangkatkan',
      seals: 'Nomor Segel',
      sealNumber: 'Nomor segel',
      addSeal: 'Tambah Segel',
      sealRequired: 'Minimal satu nomor segel wajib diisi',
      loadTemp: 'Suhu Muat',
      tempRequired: 'Suhu muat wajib diisi untuk pengiriman beku/dingin',
      tempLogs: 'Catatan Suhu',
      stage: { load: 'Muat', depart: 'Berangkat', arrive: 'Tiba' },
      edit: 'Ubah Surat Jalan',
      updated: 'Surat Jalan berhasil diubah',
      cancel: 'Batalkan',
      cancelReason: 'Alasan Pembatalan',
      confirmCancel: 'Konfirmasi Batalkan',
      cancelled: 'Surat Jalan berhasil dibatalkan',
    },
    stock: {
      // Naming the searchable fields, because the filter searches more than the
      // one column an operator can see the point of typing into.
      filterPlaceholder: 'Cari nama barang, SKU, atau area…',
      filterAreaAll: 'Semua Area',
      filterCount: 'Menampilkan {{shown}} dari {{total}} baris',
      truncated:
        'Daftar dipotong pada {{shown}} baris — persempit dengan filter area agar hasil pencarian lengkap.',
      movementType: 'Jenis Mutasi',
      counterparty: 'Lokasi Lawan',
      movementTypes: {
        purchase_in: 'Pembelian Masuk',
        transfer_in: 'Transfer Masuk',
        transfer_out: 'Transfer Keluar',
        return_in: 'Retur Masuk',
        return_out: 'Retur Keluar',
        waste_out: 'Waste Keluar',
        adjustment: 'Penyesuaian',
      },
    },
    receiving: {
      poNumber: 'No. PO',
      supplier: 'Supplier',
      total: 'Total',
      qtyOrdered: 'Dipesan',
      qtyAlreadyReceived: 'Sudah Diterima',
      qtyReceivedNow: 'Diterima Sekarang',
      conditionNotes: 'Catatan Kondisi',
      photoLabel: 'Foto Barang Diterima',
      received: 'Penerimaan PO berhasil dicatat',
      empty: 'Tidak ada PO yang menunggu penerimaan',
    },
    return: {
      tabToSupplier: 'Retur ke Supplier',
      tabFromOutlet: 'Retur dari Outlet',
      number: 'No. Retur',
      new: 'Buat Retur',
      supplier: 'Supplier',
      condition: 'Kondisi Barang',
      conditions: {
        damaged: 'Rusak',
        expired: 'Kedaluwarsa',
        wrong_item: 'Salah Barang',
        other: 'Lainnya',
      },
      photoLabel: 'Foto Bukti',
      receiveProofLabel: 'Foto Bukti Terima',
      created: 'Retur berhasil diajukan',
      ship: 'Kirim',
      shipped: 'Retur berhasil dikirim ke supplier',
      received: 'Retur berhasil diterima',
      shippedAt: 'Dikirim Pada',
      empty: 'Belum ada retur ke supplier',
      emptyFromOutlet: 'Tidak ada retur dari outlet yang menunggu diterima',
    },
    recap: {
      sjCount: 'Surat Jalan',
      dropCount: 'Total Drop',
      frozenSjCount: 'SJ Beku/Dingin',
      drySjCount: 'SJ Kering',
      outletsCount: '{{count}} outlet',
      empty: 'Belum ada pengiriman untuk tanggal ini',
      // The recap opens on the ALL-cities total and is narrowed from there; the
      // per-city cards it used to render unconditionally were one long page.
      city: 'Kota',
      outlet: 'Outlet',
      allCities: 'Semua Kota',
      allOutlets: 'Semua Outlet',
      searchItem: 'Cari barang…',
      scopeAll: 'Semua Kota & Outlet',
      itemsCount: '{{count}} barang',
      noItems: 'Tidak ada barang pada filter ini',
      item: 'Nama Barang',
      qty: 'Jumlah',
    },
    waste: {
      unitCost: 'Nilai Satuan',
    },
    outbound: {
      movedTitle: 'Sekarang di /delivery',
      movedDescription:
        'Pembuatan dan pengelolaan Surat Jalan (multi-drop, driver, kendaraan, rantai dingin) sudah pindah ke layar Pengiriman.',
      openDelivery: 'Buka Layar Pengiriman',
      staged: 'Siap Dikirim',
      inTransit: 'Dalam Perjalanan',
      empty: 'Tidak ada Surat Jalan yang siap kirim atau sedang dalam perjalanan',
      viewAll: 'Lihat semua Surat Jalan di /delivery →',
    },
  },

  // F-DELIVERY `delivery` — the central-warehouse DISPATCHER's own surface
  // (CONTRACTS §4.10): Surat Jalan list/create/status-walk plus live
  // per-drop + cold-chain tracking. Reuses `warehouse.sj.*` for concepts the
  // reused `SjCreateForm` (`components/warehouse/SjCreateForm.tsx`) already
  // renders (shipment type picker, request picker, seals, load temp) —
  // this namespace only covers screens/copy unique to `/delivery`.
  // Additive-only.
  delivery: {
    title: 'Pengiriman — Surat Jalan',
    subtitle: 'Buat dan pantau Surat Jalan, drop per outlet, dan rantai dingin dari gudang pusat.',
    new: 'Buat Surat Jalan',
    // Route planning (gudang) + live tracking — migration 221.
    route: {
      title: 'Rute & Petunjuk Pengiriman',
      subtitle:
        'Atur urutan pemberhentian dan tulis petunjuk untuk setiap lokasi. Driver mengikuti urutan ini.',
      save: 'Simpan Rute',
      saveInstructions: 'Simpan Petunjuk',
      saved: 'Rute tersimpan',
      saveError: 'Gagal menyimpan rute',
      locked:
        'Urutan rute terkunci — Surat Jalan sudah dimuat atau dalam perjalanan. Petunjuk per lokasi masih dapat diubah dan langsung terlihat oleh driver.',
      moveUp: 'Naikkan urutan',
      moveDown: 'Turunkan urutan',
      instructionsLabel: 'Petunjuk untuk driver',
      instructionsPlaceholder:
        'Contoh: masuk lewat gang samping, telepon Pak Andi sebelum sampai, bongkar di pintu belakang',
      noCoords:
        'Lokasi belum punya koordinat — driver hanya dapat alamat teks dan truk tidak muncul di peta',
      hasCoords: 'Koordinat tersedia — navigasi & peta aktif',
    },
    live: {
      title: 'Pantau Truk',
      subtitle: 'Posisi truk yang sedang dalam perjalanan, diperbarui otomatis.',
      empty: 'Tidak ada truk dalam perjalanan saat ini',
      noSignal: 'Belum ada sinyal lokasi',
      lastSeen: 'Terakhir {{time}}',
      stale: 'Sinyal tertunda',
      progress: '{{done}} dari {{total}} drop selesai',
      openInMaps: 'Buka di Peta',
      refresh: 'Muat Ulang',
      accuracy: 'Akurasi ±{{m}} m',
    },
    filterStatusAll: 'Semua Status',
    filterDate: 'Tanggal Rencana Kirim',
    clearFilters: 'Hapus Filter',
    empty: 'Belum ada Surat Jalan untuk filter ini',
    columnNumber: 'No. Surat Jalan',
    columnTruckType: 'Tipe Truk',
    columnDestinations: 'Outlet Tujuan',
    columnDriver: 'Driver',
    columnVehicle: 'Kendaraan',
    columnPlannedDate: 'Tgl. Rencana',
    columnProgress: 'Progres Drop',
    columnStatus: 'Status',
    // Columns that exist only in the CSV/PDF export — one row per DROP there,
    // so it carries per-stop facts the on-screen table has no room for.
    exportSeq: 'Urutan Drop',
    exportCity: 'Kota',
    exportDropStatus: 'Status Drop',
    exportReceivedBy: 'Diterima Oleh',
    exportReceivedAt: 'Waktu Diterima',
    exportDiscrepancy: 'Catatan Selisih',
    truckChiller: 'Truk Chiller (Beku + Dingin)',
    truckDry: 'Truk Kering (Dry)',
    truckSplitNotice:
      'Barang beku/dingin selalu satu truk chiller; barang kering selalu truk terpisah — tidak boleh digabung (aturan gudang, FR-LOG-02).',
    createdSuccess: 'Surat Jalan berhasil dibuat',
    detail: {
      title: 'Detail Surat Jalan',
      timeline: 'Linimasa',
      lines: 'Barang',
      lineItem: 'Barang',
      lineQty: 'Jumlah Kirim',
      lineQtyReceived: 'Diterima',
      drops: 'Drop',
      dropOf: '{{done}} dari {{total}} drop selesai',
      dropSeq: 'Drop {{seq}} — {{location}}',
      dropDeparted: 'Berangkat',
      dropArrived: 'Tiba',
      dropReceived: 'Diterima Oleh',
      dropDiscrepancy: 'Ada selisih pada drop ini',
      dropNoActivity: 'Belum ada aktivitas',
      coldChain: 'Rantai Dingin',
      coldChainEmpty: 'Belum ada catatan suhu',
      coldChainBreach: 'Suhu di luar batas ({{class}})',
      seals: 'Nomor Segel',
      sealsEmpty: 'Belum ada segel',
      notFound: 'Surat Jalan tidak ditemukan',
      loadError: 'Gagal memuat detail Surat Jalan',
    },
  },

  // F08 `hr` (W4-10) — HR Admin/Supervisor back office: employee records,
  // shift roster, attendance review, leave approval, payroll runs, and the
  // BPJS/PPh21 rate editors. Additive-only namespace.
  hr: {
    tabs: {
      employees: 'Pegawai',
      roster: 'Jadwal Shift',
      attendance: 'Absensi',
      leaves: 'Cuti/Izin',
      payroll: 'Payroll',
      statutory: 'Tarif Statutori',
      components: 'Komponen Gaji',
      contracts: 'Kontrak Kerja',
    },
    employees: {
      searchPlaceholder: 'Cari nomor pegawai atau nama…',
      createButton: 'Tambah Pegawai',
      createTitle: 'Tambah Pegawai',
      editTitle: 'Ubah Pegawai',
      columnNumber: 'No. Pegawai',
      columnName: 'Nama',
      columnPosition: 'Jabatan',
      columnLocation: 'Lokasi',
      columnJoinDate: 'Tanggal Masuk',
      columnStatus: 'Status',
      number: 'No. Pegawai',
      name: 'Nama Lengkap',
      nik: 'NIK',
      phone: 'No. Telepon',
      email: 'Email',
      position: 'Jabatan',
      joinDate: 'Tanggal Masuk',
      locationId: 'ID Lokasi',
      locationIdHint: 'Salin ID lokasi dari layar Administrasi → Data Master → Lokasi.',
      baseSalary: 'Gaji Pokok',
      createSuccess: 'Pegawai berhasil ditambahkan.',
      updateSuccess: 'Data pegawai berhasil diperbarui.',
    },
    // Kontrak Kerja — CRUD + tanda tangan per pihak + import/export (W7
    // follow-up, owner ask 2026-08-27). Additive block inside `hr:`, added in
    // the same round as two other agents' concurrent edits to this file —
    // anchored right after `employees` so a merge conflict here is obvious.
    contracts: {
      title: 'Kontrak Kerja',
      searchPlaceholder: 'Cari nomor kontrak…',
      createButton: 'Buat Kontrak',
      createTitle: 'Buat Kontrak Baru',
      editTitle: 'Ubah Kontrak',
      columnNumber: 'No. Kontrak',
      columnEmployee: 'Pegawai',
      columnType: 'Jenis',
      columnPosition: 'Jabatan',
      columnLocation: 'Lokasi',
      columnPeriod: 'Masa Kontrak',
      columnStatus: 'Status',
      columnSigned: 'Tanda Tangan',
      columnExpiry: 'Sisa Hari',
      employee: 'Pegawai',
      contractType: 'Jenis Kontrak',
      type: {
        pkwt: 'PKWT (Waktu Tertentu)',
        pkwtt: 'PKWTT (Tetap)',
        probation: 'Masa Percobaan',
        internship: 'Magang',
      },
      // Column-width labels. The full `type.*` names wrapped every list row to
      // three lines, which is what pushed the action buttons off the right
      // edge of the table; the long form still shows in the detail dialog and
      // in the create/edit form, where there is room for it.
      typeShort: {
        pkwt: 'PKWT',
        pkwtt: 'PKWTT',
        probation: 'Percobaan',
        internship: 'Magang',
      },
      detailTitle: 'Kontrak {{number}}',
      detailHint: 'Klik baris mana pun pada daftar untuk membuka detail kontrak.',
      position: 'Jabatan',
      location: 'Penempatan',
      locationPlaceholder: 'Seluruh perusahaan',
      baseSalary: 'Gaji Pokok (sesuai kontrak)',
      startDate: 'Tanggal Mulai',
      endDate: 'Tanggal Berakhir',
      endDateHint: 'Wajib diisi kecuali PKWTT (permanen).',
      signedAtLegacy: 'Tanggal Dokumen Ditandatangani',
      notes: 'Catatan',
      createSuccess: 'Kontrak berhasil dibuat sebagai draf.',
      updateSuccess: 'Kontrak berhasil diperbarui.',
      deleteButton: 'Hapus',
      deleteConfirm: 'Hapus draf kontrak {{number}}? Tindakan ini tidak dapat dibatalkan.',
      deleteSuccess: 'Draf kontrak berhasil dihapus.',
      deleteBlockedSigned: 'Kontrak yang sudah ada tanda tangan tidak bisa dihapus.',
      deleteBlockedStatus: 'Hanya draf yang bisa dihapus — kontrak ini sudah {{status}}.',
      expiringFilter: 'Berakhir Dalam (hari)',
      expiringFilterHint: 'Kosongkan untuk menampilkan semua kontrak aktif dan draf.',
      empty: 'Belum ada kontrak tercatat.',
      // Signing (migration 252).
      signatures: {
        title: 'Status Tanda Tangan',
        employeeParty: 'Pegawai',
        companyParty: 'Perusahaan',
        signed: 'Sudah tanda tangan',
        outstanding: 'Belum tanda tangan',
        signedAt: 'pada {{when}}',
        method: {
          wet_ink_scan: 'Tanda tangan basah (dipindai)',
          digital: 'Tanda tangan digital',
          in_person_witnessed: 'Tanda tangan langsung, disaksikan',
        },
        signButton: 'Catat Tanda Tangan',
        signTitle: 'Catat Tanda Tangan — {{number}}',
        signParty: 'Pihak',
        signMethod: 'Cara Tanda Tangan',
        signSignedAt: 'Tanggal/Waktu Ditandatangani',
        signSignedAtHint: 'Kosongkan untuk memakai waktu sekarang.',
        signNotes: 'Catatan (opsional)',
        signSuccess: 'Tanda tangan berhasil dicatat.',
        alreadySigned: 'Pihak ini sudah menandatangani kontrak ini.',
        fullySigned: 'Sudah ditandatangani semua pihak',
        // Badge-sized counterparts of `fullySigned`/`outstanding` for the list.
        shortComplete: 'Lengkap',
        shortIncomplete: 'Belum lengkap',
        none: 'Belum ada tanda tangan tercatat.',
        activateHint:
          'Kontrak baru bisa diaktifkan setelah pegawai DAN perusahaan sama-sama menandatangani.',
      },
      // Terminate — a status change with a mandatory reason, never a delete.
      terminate: {
        button: 'Putus Kontrak',
        title: 'Putus Kontrak — {{number}}',
        reason: 'Alasan',
        endDate: 'Tanggal Efektif (opsional)',
        endDateHint: 'Kosongkan untuk memakai tanggal hari ini.',
        success: 'Kontrak berhasil diputus.',
      },
      status: {
        allStatuses: 'Semua Status',
      },
    },
    roster: {
      location: 'Lokasi',
      week: 'Minggu',
      employee: 'Pegawai',
      off: 'Libur',
      saveSuccess: 'Jadwal shift berhasil disimpan.',
      shiftName: 'Nama Shift',
      shiftStart: 'Mulai',
      shiftEnd: 'Selesai',
      addShift: 'Tambah Shift',
      noLocation: 'Pilih lokasi terlebih dahulu untuk mengatur jadwal shift.',
      noEmployees: 'Belum ada pegawai aktif di lokasi ini.',
      shiftBreak: 'Istirahat (mnt)',
      templatesTitle: 'Template Shift',
      templatesHint:
        'Jam pada template ini yang muncul di pilihan tiap hari. Mengubahnya berlaku untuk jadwal berikutnya; absensi yang sudah tercatat tidak dihitung ulang.',
      globalShift: 'Semua Lokasi',
      shiftUpdated: 'Template shift berhasil diperbarui.',
      shiftDeactivated: 'Template shift dinonaktifkan.',
      shiftNameRequired: 'Nama shift wajib diisi.',
      shiftSameTime: 'Jam mulai dan jam selesai tidak boleh sama.',
      inactiveShift: 'Nonaktif',
      deactivateTitle: 'Nonaktifkan template shift?',
      deactivateBody:
        'Template ini akan hilang dari pilihan shift. Jadwal yang sudah tersimpan dengan shift ini tetap ada dan tetap terbaca, tetapi tidak bisa dipilih lagi untuk hari baru. Template hanya bisa diaktifkan kembali lewat impor CSV.',
      globalEditTitle: 'Ubah template milik semua lokasi?',
      globalEditBody:
        'Template ini tidak dimiliki outlet mana pun — perubahan jam berlaku untuk SELURUH lokasi yang memakainya, bukan hanya lokasi yang sedang dipilih.',
    },
    attendance: {
      location: 'Lokasi',
      allLocations: 'Semua Lokasi',
      date: 'Tanggal',
      suspectFilter: 'Perlu Ditinjau (Jam Diragukan)',
      columnEmployee: 'Pegawai',
      columnDate: 'Tanggal',
      columnCheckIn: 'Masuk',
      columnCheckOut: 'Pulang',
      columnLate: 'Terlambat (mnt)',
      columnOvertime: 'Lembur (mnt)',
      columnGeofence: 'Lokasi',
      columnStatus: 'Status',
      geofenceOk: 'Dalam Radius',
      geofenceOut: 'Luar Radius',
      timeSuspect: 'Jam Diragukan',
      timeSuspectHint:
        'Jam pada perangkat ini tidak dapat dipastikan akurat saat absen dicatat — tinjau dan koreksi jika perlu sebelum masuk payroll.',
      noSuspectRows: 'Tidak ada baris yang perlu ditinjau.',
      correctTitle: 'Koreksi Absensi — {{name}}',
      correctionReason: 'Alasan Koreksi',
      correctSuccess: 'Absensi berhasil dikoreksi.',
    },
    leaves: {
      filterStatus: 'Status',
      allStatuses: 'Semua Status',
      filterType: 'Jenis',
      allTypes: 'Semua Jenis',
      columnEmployee: 'Pegawai',
      columnType: 'Jenis',
      columnPeriod: 'Periode',
      columnDays: 'Hari',
      columnReason: 'Alasan',
      columnStatus: 'Status',
      columnAttachment: 'Lampiran',
      viewAttachment: 'Lihat Lampiran',
      type: {
        annual: 'Cuti Tahunan',
        marriage: 'Cuti Nikah',
        sick: 'Sakit',
        permission: 'Izin',
        unpaid: 'Tanpa Gaji',
      },
      approveTitle: 'Setujui Cuti — {{name}}',
      rejectTitle: 'Tolak Cuti — {{name}}',
      approveNote: 'Catatan (opsional)',
      rejectReason: 'Alasan Penolakan',
      approveSuccess: 'Pengajuan cuti disetujui.',
      rejectSuccess: 'Pengajuan cuti ditolak.',
    },
    payroll: {
      newPeriod: 'Periode Baru',
      calculateButton: 'Hitung Payroll',
      calculateSuccess: 'Payroll berhasil dihitung.',
      noPeriods: 'Belum ada periode payroll.',
      columnPeriod: 'Periode',
      columnRuns: 'Proses',
      runDetailTitle: 'Detail Proses Payroll',
      statutoryModeOn: 'Mode statutori aktif untuk proses ini',
      employeeCount: 'Jumlah Pegawai',
      totalGross: 'Total Bruto',
      totalDeductions: 'Total Potongan',
      totalNet: 'Total Bersih',
      columnEmployee: 'Pegawai',
      columnGross: 'Bruto',
      columnDeductions: 'Potongan',
      columnNet: 'Bersih',
      approvalTitle: 'Riwayat Persetujuan',
      submitButton: 'Ajukan Persetujuan',
      submitSuccess: 'Payroll berhasil diajukan untuk persetujuan.',
      approveSuccess: 'Payroll berhasil disetujui.',
      rejectSuccess: 'Payroll dikembalikan.',
      defaultRejectReason: 'Dikembalikan untuk ditinjau ulang.',
      sendSlipsButton: 'Kirim Slip Gaji',
      sendSlipsSuccess: 'Slip gaji sedang dikirim.',
      markPaidHint: 'Tandai lunas dilakukan dari antrean verifikasi pembayaran Keuangan.',
    },
    statutory: {
      // Shown instead of the add-vintage button to a read-only holder, so the
      // screen never reads as "there is no way to change these".
      readOnlyHint:
        'Anda dapat melihat tarif ini tetapi tidak dapat mengubahnya. Menambah tarif baru memerlukan izin "payroll.statutory.config" (Pemilik, Finance, atau HR Admin) — hubungi admin bila perlu diubah.',
      addVintage: 'Tambah Vintage Baru',
      saveVintage: 'Simpan Vintage',
      saveSuccess: 'Tarif berhasil disimpan.',
      effectiveFrom: 'Berlaku Sejak',
      effectiveDuplicate:
        'Tanggal ini sudah punya tarif — pilih tanggal lain atau ubah baris yang ada.',
      effectiveBeforeLatest: 'Tanggal ini sebelum tarif terbaru yang sudah ada — periksa kembali.',
      noVintages: 'Belum ada tarif yang diatur.',
      window: 'Periode Berlaku',
      windowState: {
        active: 'Aktif',
        future: 'Akan Datang',
        past: 'Kedaluwarsa',
      },
      openEnded: 'Seterusnya',
      program: 'Program',
      employerPct: 'Persen Perusahaan',
      employeePct: 'Persen Pegawai',
      floor: 'Batas Bawah Gaji',
      cap: 'Batas Atas Gaji',
      category: 'Kategori',
      bracketMin: 'Batas Bawah',
      bracketMax: 'Batas Atas',
      ratePct: 'Tarif (%)',
      ptkpCode: 'Kode PTKP',
      annualAmount: 'Jumlah Tahunan',
      addRow: 'Tambah Baris',
      bpjsTitle: 'Tarif BPJS',
      bpjsDescription: 'Persentase iuran BPJS per program, efektif per tanggal (Amendment 1).',
      bpjsProgram: {
        kesehatan: 'Kesehatan',
        jht: 'JHT',
        jkk: 'JKK',
        jkm: 'JKM',
        jp: 'JP',
      },
      terTitle: 'Tarif PPh21 TER',
      terDescription: 'Tarif Efektif Rata-rata bulanan per kategori dan lapisan penghasilan.',
      ptkpTitle: 'Tabel PTKP',
      ptkpDescription: 'Penghasilan Tidak Kena Pajak per status, menentukan kategori TER.',
      article17Title: 'Tarif Pasal 17',
      article17Description:
        'Lapisan tarif progresif tahunan untuk perhitungan ulang PPh21 Desember.',
    },
    // `SalaryComponentsPanel` — the salary component master
    // (`payroll.component.manage`) plus per-employee assignment
    // (PIN-03..06). Additive block, own key namespace.
    components: {
      title: 'Komponen Gaji',
      masterTitle: 'Master Komponen Gaji',
      masterDescription:
        'Komponen pendapatan, potongan, dan beban perusahaan yang dipakai dalam perhitungan payroll.',
      searchPlaceholder: 'Cari kode atau nama komponen…',
      createButton: 'Tambah Komponen',
      createTitle: 'Tambah Komponen Gaji',
      editTitle: 'Ubah Komponen — {{name}}',
      columnCode: 'Kode',
      columnName: 'Nama',
      columnType: 'Jenis',
      columnCalcMethod: 'Metode Hitung',
      columnDefaultAmount: 'Nominal Default',
      columnStatus: 'Status',
      fieldCode: 'Kode',
      fieldName: 'Nama',
      fieldType: 'Jenis',
      fieldCalcMethod: 'Metode Hitung',
      fieldDefaultAmount: 'Nominal Default',
      isActiveLabel: 'Komponen aktif',
      systemBadge: 'Sistem',
      systemLockedNameHint: 'Komponen bawaan sistem — nama tidak dapat diubah.',
      immutableAfterCreateHint:
        'Jenis dan metode hitung tidak dapat diubah setelah komponen dibuat.',
      statusActive: 'Aktif',
      statusInactive: 'Nonaktif',
      createSuccess: 'Komponen berhasil ditambahkan.',
      updateSuccess: 'Komponen berhasil diperbarui.',
      typeLabel: {
        earning: 'Pendapatan',
        deduction: 'Potongan',
        employer_cost: 'Beban Perusahaan',
      },
      calcMethodLabel: {
        fixed: 'Tetap',
        per_day: 'Per Hari',
        per_hour: 'Per Jam',
        formula: 'Formula',
        manual: 'Manual',
      },
      assignmentTitle: 'Komponen per Pegawai',
      assignmentDescription:
        'Atur nominal komponen kustom untuk satu pegawai, mis. tunjangan jabatan atau insentif.',
      selectEmployee: 'Pilih Pegawai',
      selectEmployeePlaceholder: 'Cari pegawai…',
      noEmployeeSelected: 'Pilih pegawai untuk melihat dan mengatur komponennya.',
      assignmentColumnComponent: 'Komponen',
      assignmentColumnAmount: 'Nominal',
      addAssignmentRow: 'Tambah Baris',
      removeRow: 'Hapus Baris',
      saveAssignments: 'Simpan Komponen Pegawai',
      saveAssignmentsSuccess: 'Komponen pegawai berhasil disimpan.',
      noAssignments: 'Belum ada komponen kustom untuk pegawai ini.',
      useDefaultAmountHint: 'Kosongkan nominal untuk memakai nominal default komponen.',
      usesDefaultAmount: 'Pakai nominal default',
    },
  },

  // F11 `me` (W4-10) — every employee's own mobile view: Absen (GPS +
  // selfie), Slip Gaji, Ajukan Cuti/Izin. Additive-only namespace.
  me: {
    // `/me` — the personal-analytics overview the six own-data routes hang off
    // (owner, 2026-08-27).
    overview: {
      greeting: '{{name}} · {{role}}',
      thisMonth: 'Bulan ini — {{month}}',
      days: '{{n}} hari',
      times: '{{n}} kali',
      minutes: '{{m}}m',
      hoursMinutes: '{{h}}j {{m}}m',
      attendanceRate: 'Kehadiran {{rate}}%',
      absentDays: '{{n}} hari alpha',
      overtime: 'Lembur',
      leaveLeft: 'Sisa Cuti Tahunan',
      leavePending: '{{n}} pengajuan menunggu',
      attendanceStrip: 'Absensi Bulan Ini',
      noAttendance: 'Belum ada catatan absensi bulan ini.',
      lastPeriod: 'Periode {{period}}',
      openSlips: 'Lihat semua slip gaji',
      outstanding: 'Sisa pinjaman berjalan',
      openLoans: 'Lihat pinjaman',
      unavailable:
        'Data personal Anda belum tersedia — akun ini belum terhubung ke data kepegawaian.',
    },
    tabs: {
      absen: 'Absen',
      slip: 'Slip Gaji',
      cuti: 'Cuti/Izin',
      // The `employee` interface's own-data tabs (W7).
      profile: 'Data Pribadi',
      pinjaman: 'Pinjaman',
      kontrak: 'Kontrak',
    },
    absen: {
      noLocation: 'Akun Anda belum terhubung ke lokasi kerja manapun.',
      gettingLocation: 'Mengambil lokasi GPS…',
      geoUnavailable: 'Perangkat ini tidak mendukung GPS.',
      geoDenied: 'Izin lokasi ditolak — aktifkan GPS untuk absen.',
      refreshLocation: 'Perbarui Lokasi',
      distanceUnknown: 'Jarak tidak dapat dihitung.',
      distanceValue: '{{distance}} m dari lokasi (radius {{radius}} m)',
      withinRadius: 'Dalam radius outlet',
      outsideRadius: 'Di luar radius outlet',
      selfieLabel: 'Selfie',
      checkInButton: 'Absen Masuk',
      checkOutButton: 'Absen Pulang',
      checkInSuccess: 'Absen masuk berhasil.',
      checkOutSuccess: 'Absen pulang berhasil.',
      submitFailed:
        'Absen gagal disimpan — periksa foto selfie dan lokasi GPS Anda, lalu coba lagi.',
      queuedLocally: 'Tersimpan di perangkat — akan tersinkron otomatis saat koneksi tersedia',
      offlineGeofenceHint:
        'Data lokasi outlet belum dimuat (offline) — jarak akan dihitung ulang setelah tersambung.',
      queuesOfflineHint:
        'Absen tetap tersimpan meski tanpa koneksi internet, dan akan tersinkron otomatis.',
      doneToday: 'Absensi hari ini sudah lengkap.',
      inAt: 'Masuk {{time}}',
      outAt: 'Pulang {{time}}',
    },
    slip: {
      empty: 'Belum ada slip gaji.',
      grossDeductions: 'Bruto {{gross}} · Potongan {{deductions}}',
      statutory: 'statutori',
      downloadPdf: 'Unduh PDF',
    },
    cuti: {
      annualLabel: 'Cuti Tahunan',
      marriageLabel: 'Cuti Nikah',
      remaining: 'sisa hari',
      quotaUnavailable: 'Kuota belum tersedia',
      newRequest: 'Ajukan Cuti/Izin',
      empty: 'Belum ada pengajuan cuti/izin.',
      days: 'hari',
      cancelButton: 'Batalkan',
      cancelSuccess: 'Pengajuan dibatalkan.',
      createSuccess: 'Pengajuan berhasil dikirim.',
      typeLabel: 'Jenis',
      type: {
        annual: 'Cuti Tahunan',
        marriage: 'Cuti Nikah',
        sick: 'Sakit',
        permission: 'Izin',
        unpaid: 'Tanpa Gaji',
      },
      startDate: 'Tanggal Mulai',
      endDate: 'Tanggal Selesai',
      reasonLabel: 'Alasan (opsional)',
      attachmentLabel: 'Lampiran (opsional)',
      attachmentHint: 'Surat dokter, undangan, atau dokumen pendukung lain. Maks. 10 MB.',
    },
    // Data Pribadi — the employee's own HR record, read-only (corrections go
    // through Admin SDM, because these fields feed pay).
    profile: {
      location: 'Lokasi Kerja',
      joinDate: 'Tanggal Masuk',
      nik: 'NIK (KTP)',
      phone: 'Nomor HP',
      email: 'Email',
      baseSalary: 'Gaji Pokok',
      baseSalaryHint: 'Sesuai posisi Anda saat ini.',
      employmentHistory: 'Riwayat Jabatan',
      present: 'sekarang',
      correctionHint:
        'Data ini dikelola oleh Admin SDM. Bila ada yang tidak sesuai, hubungi Admin SDM untuk diperbaiki.',
      notEmployeeTitle: 'Akun ini belum terhubung ke data karyawan',
      notEmployeeDescription:
        'Minta Admin SDM menghubungkan akun Anda dengan data karyawan agar absensi, slip gaji, dan pinjaman muncul di sini.',
    },
    // Kontrak kerja — read-only view of the employee's own contracts (W7).
    kontrak: {
      history: 'Riwayat Kontrak',
      period: 'Masa Kontrak',
      noEndDate: 'Tanpa batas waktu',
      location: 'Penempatan',
      baseSalary: 'Gaji Pokok (sesuai kontrak)',
      signedAt: 'Ditandatangani',
      terminationReason: 'Alasan Pemutusan',
      viewDocument: 'Lihat Dokumen Kontrak',
      expiringIn:
        'Kontrak berakhir dalam {{days}} hari. Hubungi Admin SDM bila belum ada perpanjangan.',
      expiredAgo: 'Kontrak sudah berakhir {{days}} hari lalu. Hubungi Admin SDM.',
      emptyTitle: 'Belum ada kontrak tercatat',
      emptyDescription:
        'Hubungi Admin SDM bila Anda sudah menandatangani kontrak tetapi belum tampil di sini.',
      questionsHint:
        'Kontrak dikelola oleh Admin SDM. Untuk perpanjangan atau salinan resmi, hubungi Admin SDM.',
      type: {
        pkwt: 'PKWT (Kontrak Waktu Tertentu)',
        pkwtt: 'PKWTT (Karyawan Tetap)',
        probation: 'Masa Percobaan',
        internship: 'Magang',
      },
    },
    // Pinjaman (kasbon) — own loans plus the request form. A request goes to
    // the same Keuangan -> Manajer approval chain the office uses.
    pinjaman: {
      totalOutstanding: 'Total Sisa Pinjaman',
      activeCount: '{{count}} pinjaman berjalan',
      outstanding: 'Sisa pinjaman',
      principal: 'Jumlah Pinjaman',
      installment: 'Angsuran per Bulan',
      installmentHint: 'Dipotong otomatis dari gaji setiap bulan.',
      reason: 'Alasan Pengajuan',
      reasonPlaceholder: 'mis. biaya sekolah anak',
      requestButton: 'Ajukan Pinjaman',
      requestTitle: 'Ajukan Pinjaman (Kasbon)',
      requestDescription:
        'Pengajuan akan diperiksa oleh Keuangan lalu disetujui Manajer. Anda akan diberi tahu setelah ada keputusan.',
      requestSuccess: 'Pengajuan pinjaman terkirim.',
      emptyTitle: 'Belum ada pinjaman',
      emptyDescription: 'Pengajuan kasbon Anda akan muncul di sini beserta sisa angsurannya.',
    },
  },

  // W5-08 — the in-app notification inbox behind the header bell.
  notifications: {
    markAllRead: 'Tandai semua dibaca',
    unread: 'Belum dibaca',
    unreadCount: '{{count}} notifikasi belum dibaca',
  },

  // W5-05 print/document layer — printable Surat Jalan + slip gaji, rendered
  // as chromeless /print routes and produced via the browser's own print
  // (paper AND print-to-PDF) rather than a bundled PDF generator.
  print: {
    print: 'Cetak',
    close: 'Tutup',
    company: 'Ayam Geprek & Fried Chicken — Kalimantan',
    sj: {
      title: 'Surat Jalan',
      generatedAt: 'Dibuat: {{date}}',
      pageOf: 'Halaman {{page}} dari {{total}}',
      driver: 'Driver',
      vehicle: 'Kendaraan',
      plannedDate: 'Tgl. Rencana Kirim',
      shipmentType: 'Jenis Muatan',
      dispatchedAt: 'Berangkat',
      status: 'Status',
      seals: 'Nomor Segel',
      item: 'Barang',
      qtySent: 'Dikirim',
      qtyReceived: 'Diterima',
      tempAtDrop: 'Suhu saat serah terima',
      signDriver: 'Driver',
      signReceiver: 'Penerima di Outlet',
      // Three copies per delivery point (owner, 2026-08-21): the paper is
      // printed in gudang and split between gudang, the receiving outlet, and
      // the office — each one a complete, separately-signed sheet.
      copyFor: 'Salinan: {{holder}}',
      copyHolder: {
        gudang: 'Gudang Pusat',
        kantor: 'Kantor',
      },
      copyNotice:
        '{{drops}} tujuan × {{copies}} salinan (gudang, outlet, kantor) = {{pages}} halaman. Siapkan kertas di printer sebelum mencetak.',
      footer:
        'Dokumen ini adalah bukti pengiriman resmi. Tanda tangani ketiga salinan: satu untuk gudang pusat, satu untuk outlet penerima, satu untuk kantor.',
    },
    slip: {
      title: 'Slip Gaji',
      employee: 'Nama Karyawan',
      period: 'Periode',
      position: 'Jabatan',
      location: 'Lokasi',
      earnings: 'Pendapatan',
      deductions: 'Potongan',
      gross: 'Total Pendapatan',
      totalDeductions: 'Total Potongan',
      net: 'Gaji Bersih',
      notFound: 'Slip gaji untuk periode {{period}} tidak ditemukan',
      footer:
        'Slip ini diterbitkan oleh sistem dan sah tanpa tanda tangan basah. Hubungi Admin SDM bila ada selisih.',
    },
  },

  // F13 `driver` (W4-09) — mobile, offline-first: today's Surat Jalan,
  // multi-drop route, per-drop depart/arrive/serah-terima, cold-chain seal
  // + temperature checks. Additive-only namespace.
  driver: {
    today: 'Surat Jalan Hari Ini',
    empty: 'Tidak ada Surat Jalan untuk hari ini',
    picker: {
      label: 'Lihat rute driver',
      noFleet: 'Belum ada driver aktif yang terdaftar — tambahkan driver di Data Master.',
    },
    notADriver: {
      title: 'Layar ini menampilkan rute milik seorang driver',
      description:
        'Akun Anda tidak terdaftar sebagai driver, jadi halaman ini akan selalu kosong. Untuk melihat semua Surat Jalan — termasuk yang sedang berjalan hari ini — buka Pengiriman (Dispatcher).',
      action: 'Lihat Semua Surat Jalan',
    },
    dropSeq: 'Drop {{seq}}',
    shipmentType: {
      frozen: 'Beku/Dingin',
      dry: 'Kering (Sembako)',
    },
    actions: {
      depart: 'Berangkat',
      arrive: 'Tiba di Lokasi',
      receive: 'Serah Terima',
      skip: 'Lewati Dulu',
      fail: 'Gagal Kirim',
    },
    nav: {
      navigate: 'Navigasi',
      waze: 'Waze',
      instructions: 'Petunjuk Pengiriman',
      call: 'Telepon Tujuan',
    },
    map: {
      label: 'Peta rute pengiriman',
      focusStop: 'Tampilkan {{location}} di peta',
      missingCoords:
        '{{missing}} dari {{total}} tujuan belum punya titik koordinat dan tidak tampil di peta.',
    },
    progress: {
      summary: '{{done}} dari {{total}} tujuan selesai',
      failed: '{{count}} gagal',
      nextStop: 'Tujuan berikutnya',
    },
    cache: {
      offline: 'Menampilkan rute tersimpan di perangkat',
      cachedAt:
        'Terakhir diperbarui {{time}}. Muat ulang saat sinyal kembali untuk melihat perubahan dari gudang.',
    },
    summary: {
      title: 'Ringkasan Hari Ini',
      delivered: 'Terkirim',
      discrepancy: 'Selisih saat serah terima',
      failed: 'Gagal kirim',
      coldChainBreach: 'Pelanggaran rantai dingin',
      cleanHint: 'Semua tujuan selesai tanpa catatan. Serahkan Surat Jalan ke gudang.',
      reportHint: 'Ada catatan yang perlu dilaporkan ke gudang saat kembali.',
    },
    tracking: {
      active: 'Lokasi sedang dibagikan',
      activeHint: 'Posisi truk dikirim ke gudang selama perjalanan ini.',
      denied: 'Izin lokasi ditolak — gudang tidak bisa melacak truk ini',
      deniedHint:
        'Aktifkan izin lokasi di pengaturan browser agar gudang dapat memantau pengiriman.',
      unsupported: 'Perangkat ini tidak mendukung pelacakan lokasi',
      queued: '{{count}} posisi menunggu dikirim',
    },
    depart: {
      title: 'Berangkat ke {{location}}',
      tempLabel: 'Suhu Muat Sebelum Berangkat',
      submit: 'Konfirmasi Berangkat',
      queued: 'Keberangkatan tersimpan — akan tersinkron otomatis saat koneksi tersedia',
    },
    arrive: {
      title: 'Tiba di {{location}}',
      tempLabel: 'Suhu Saat Tiba',
      sealLabel: 'Cek Segel',
      sealIntact: 'Segel Utuh',
      sealBroken: 'Segel Rusak',
      sealNotes: 'Catatan Segel Rusak',
      submit: 'Konfirmasi Tiba',
      queued: 'Kedatangan tersimpan — akan tersinkron otomatis saat koneksi tersedia',
    },
    receive: {
      title: 'Serah Terima — {{location}}',
      item: 'Barang',
      qtySent: 'Dikirim',
      qtyReceived: 'Diterima',
      storageArea: 'Area Penyimpanan',
      discrepancyReason: 'Alasan Selisih',
      photoLabel: 'Foto Serah Terima',
      signatureLabel: 'Penerima',
      tempLabel: 'Suhu Saat Serah Terima',
      confirm: 'Konfirmasi Serah Terima',
      queued: 'Serah terima tersimpan — akan tersinkron otomatis saat koneksi tersedia',
    },
    fail: {
      title: 'Tandai Gagal Kirim — {{location}}',
      reasonLabel: 'Alasan Gagal Kirim',
      photoLabel: 'Foto Bukti (sangat disarankan)',
      submit: 'Konfirmasi Gagal Kirim',
      success: 'Drop ditandai gagal kirim',
      error: 'Gagal menyimpan — periksa koneksi lalu coba lagi',
    },
    skip: {
      title: 'Lewati Dulu — {{location}}',
      explainer:
        'Drop dipindahkan ke urutan terakhir dan tetap bisa dikirim hari ini. Barang tetap di kendaraan — tidak ada stok yang dikembalikan ke gudang.',
      reasonLabel: 'Alasan Dilewati',
      submit: 'Lewati Dulu',
      success: 'Drop dipindahkan ke urutan terakhir',
      error: 'Gagal melewati drop — periksa koneksi lalu coba lagi',
    },
    coldChain: {
      breach: 'Pelanggaran rantai dingin — di luar batas aman',
      stage: {
        load: 'Muat',
        depart: 'Berangkat',
        arrive: 'Tiba',
      },
    },
  },

  // F09 `assets` (W4-09) — asset register, jadwal perawatan, jatuh tempo,
  // penyelesaian tugas maintenance dengan bukti foto (FR-PMS-01..04).
  // Additive-only namespace.
  assets: {
    tabs: {
      register: 'Daftar Aset',
      due: 'Jatuh Tempo',
      jobs: 'Tugas Maintenance',
    },
    category: {
      machine: 'Mesin',
      vehicle: 'Kendaraan',
      equipment: 'Peralatan',
      electronics: 'Elektronik',
      furniture: 'Furnitur',
      other: 'Lainnya',
    },
    condition: {
      good: 'Baik',
      fair: 'Cukup',
      poor: 'Buruk',
    },
    jobType: {
      scheduled: 'Terjadwal',
      corrective: 'Perbaikan',
    },
    register: {
      columnNumber: 'No. Aset',
      columnName: 'Nama',
      columnCategory: 'Kategori',
      columnCondition: 'Kondisi',
      columnAssignedTo: 'Dipegang Oleh',
      searchPlaceholder: 'Cari nomor aset atau nama…',
      createButton: 'Tambah Aset',
      createTitle: 'Tambah Aset',
      createSuccess: 'Aset berhasil ditambahkan.',
      updateSuccess: 'Aset berhasil diperbarui.',
      serialNumber: 'Nomor Seri',
      brand: 'Merek',
      model: 'Model',
      purchasePrice: 'Harga Beli',
      photoLabel: 'Foto Aset',
    },
    schedules: {
      title: 'Jadwal Perawatan',
      addButton: 'Tambah Jadwal',
      empty: 'Belum ada jadwal perawatan untuk aset ini.',
      nextDue: 'Jatuh Tempo Berikutnya',
      name: 'Nama Jadwal',
      intervalType: 'Jenis Interval',
      days: 'Hari',
      months: 'Bulan',
      intervalValue: 'Setiap',
      nextDueAt: 'Jatuh Tempo Berikutnya',
      reminderDaysBefore: 'Ingatkan (hari sebelumnya)',
      createSuccess: 'Jadwal perawatan berhasil ditambahkan.',
    },
    due: {
      windowLabel: 'Rentang Waktu',
      windowDays: '{{days}} hari ke depan',
      dueDate: 'Jatuh Tempo',
      startButton: 'Mulai Kerjakan',
      empty: 'Tidak ada jadwal perawatan yang jatuh tempo.',
    },
    jobs: {
      newCorrective: 'Buat Tugas Perbaikan',
      descriptionLabel: 'Deskripsi Kerusakan/Perbaikan',
      createSuccess: 'Tugas perbaikan berhasil dibuat.',
      columnNumber: 'No. Tugas',
      columnAsset: 'Aset',
      columnType: 'Jenis',
      cost: 'Biaya',
      vendor: 'Vendor/Bengkel',
      odometerKm: 'Odometer (km)',
      conditionAfter: 'Kondisi Setelah Perawatan',
      startButton: 'Mulai',
      completeButton: 'Selesaikan',
      completeTitle: 'Selesaikan Tugas — {{name}}',
      proofPhotoLabel: 'Foto Bukti Perawatan',
      completeSubmit: 'Konfirmasi Selesai',
      completeSuccess: 'Tugas maintenance berhasil diselesaikan.',
      verifyButton: 'Verifikasi',
      verifySuccess: 'Tugas maintenance berhasil diverifikasi.',
      empty: 'Belum ada tugas maintenance.',
    },
    history: {
      title: 'Riwayat Servis',
      empty: 'Belum ada riwayat servis untuk aset ini.',
    },
  },

  // F03 `dashboard` (W5, senior-fe) — KPI Owner/Manager: pendapatan/profit,
  // produk terlaris, KPI staf, monitoring operasional, drill-down per outlet
  // (FR-DASH-01..04). Additive-only namespace.
  dashboard: {
    inventory: {
      allLocations: 'Semua Lokasi',
      location: 'Lokasi',
      search: 'Cari',
      searchPlaceholder: 'Nama barang atau SKU',
      empty: 'Tidak ada stok yang cocok',
      truncated:
        'Menampilkan {{shown}} dari {{total}} baris — persempit dengan filter lokasi atau pencarian.',
      item: 'Barang',
      area: 'Area Penyimpanan',
      onHand: 'Stok',
      minQty: 'Min',
      belowMin: 'Di bawah stok minimum',
    },
    scope: {
      companyTitle: 'Seluruh Perusahaan (Semua Outlet)',
      companyHint: 'Angka ini mencakup semua outlet — bukan satu outlet saja.',
      outletTitle: 'Outlet Anda: {{name}}',
      outletHint: 'Angka ini hanya untuk outlet ini ({{city}}) — bukan gabungan perusahaan.',
      unknownOutlet: 'Tidak Diketahui',
    },
    noOutletAssigned: 'Akun Anda belum ditugaskan ke outlet manapun.',
    refreshButton: 'Segarkan Data',
    refreshSuccess: 'Data dasbor berhasil disegarkan.',
    refreshPartialFailure: '{{count}} tampilan gagal disegarkan — data mungkin belum terbaru.',
    tabs: {
      overview: 'Ringkasan',
      sales: 'Penjualan',
      marketing: 'Pemasaran',
      outlets: 'Outlet',
      topProducts: 'Produk Terlaris',
      staffKpi: 'KPI Staf',
      inventory: 'Inventaris',
      opsStatus: 'Status Operasional',
    },
    overview: {
      revenue: 'Pendapatan',
      revenueOnline: 'Pendapatan Online',
      profitEstimate: 'Estimasi Laba',
      txCount: 'Jumlah Transaksi',
      avgTicket: 'Rata-rata Nilai Transaksi',
      activeOutlets: 'Outlet Aktif',
      vsPreviousPeriod: 'Dibanding periode sebelumnya',
    },
    trend: {
      title: 'Tren Penjualan',
      description: 'Pendapatan, transaksi, atau pemakaian bahan dari waktu ke waktu.',
      empty: 'Belum ada data tren untuk periode ini.',
      metricRevenue: 'Pendapatan',
      metricTx: 'Transaksi',
      metricUsage: 'Pemakaian Bahan',
      granularityDaily: 'Harian',
      granularityWeekly: 'Mingguan',
    },
    ops: {
      lowStockOutlets: 'Outlet Stok Menipis',
      sjInTransit: 'Surat Jalan Dalam Perjalanan',
      pendingApprovals: 'Menunggu Persetujuan',
      pendingPayments: 'Menunggu Verifikasi Pembayaran',
      offlineOutlets: 'Outlet Offline',
      openConflicts: 'Konflik Sinkronisasi Terbuka',
      coldChainBreaches24h: 'Pelanggaran Suhu (24 Jam)',
      maintenanceDue: 'Maintenance Jatuh Tempo',
    },
    outlets: {
      columnName: 'Outlet',
      openShifts: 'Shift Terbuka',
      lowStockCount: 'Item Stok Menipis',
      offlineDevices: 'Perangkat Offline',
      hourlyTrend: 'Tren Per Jam',
      topProducts: 'Produk Terlaris',
      staffOnShift: 'Staf Bertugas',
      empty: 'Belum ada data outlet untuk tanggal ini.',
    },
    topProducts: {
      columnProduct: 'Produk',
      columnQty: 'Jumlah Terjual',
      empty: 'Belum ada penjualan produk pada periode ini.',
    },
    staffKpi: {
      columnName: 'Pegawai',
      columnSalesCount: 'Jumlah Transaksi',
      columnSalesAmount: 'Total Penjualan',
      columnAttendanceRate: 'Tingkat Kehadiran',
      columnLateCount: 'Jumlah Terlambat',
      empty: 'Belum ada data KPI pegawai untuk periode ini.',
    },

    // Sales tab — `GET /api/reports/sales` (CONTRACTS §4.19), all outlets or
    // one, with CSV/PDF export.
    sales: {
      title: 'Laporan Penjualan',
      description:
        'Penjualan semua outlet atau satu outlet, dirinci per tanggal, outlet, produk, metode bayar, atau kanal.',
      outlet: 'Outlet',
      allOutlets: 'Semua Outlet',
      groupBy: 'Rincian',
      groupByDay: 'Per Tanggal',
      groupByOutlet: 'Per Outlet',
      groupByProduct: 'Per Produk',
      groupByMethod: 'Per Metode Bayar',
      groupByChannel: 'Per Kanal',
      columnDay: 'Tanggal',
      columnOutlet: 'Outlet',
      columnProduct: 'Produk',
      columnMethod: 'Metode Bayar',
      columnChannel: 'Kanal',
      columnTxCount: 'Transaksi',
      columnGross: 'Bruto',
      columnDiscount: 'Diskon',
      columnPlatformFees: 'Biaya Platform',
      columnNet: 'Neto',
      totals: 'Total',
      platformFeesNote:
        'Biaya Platform bersifat informatif — Neto sudah dikurangi biaya tersebut di sumbernya, jadi jangan dikurangi dua kali.',
      empty: 'Belum ada penjualan pada periode dan filter ini.',
      emptyHint: 'Coba perlebar rentang tanggal atau pilih Semua Outlet.',
      loadError: 'Laporan penjualan gagal dimuat',
      loadErrorHint: 'Periksa koneksi lalu muat ulang; jika tetap gagal, hubungi admin.',
      exportTitle: 'Laporan Penjualan — {{scope}} — {{from}} s/d {{to}}',
    },

    // Marketing tab — no new endpoint: kanal/diskon/biaya platform are all
    // read off `GET /api/reports/sales` + `/api/reports/online-orders`.
    marketing: {
      title: 'Laporan Pemasaran',
      description:
        'Kinerja per kanal penjualan, belanja diskon, dan biaya platform — semua outlet atau satu outlet.',
      spendTitle: 'Belanja Diskon & Biaya Platform',
      statGross: 'Bruto',
      statDiscount: 'Total Diskon',
      statDiscountPct: 'Diskon terhadap Bruto',
      statPlatformFees: 'Biaya Platform',
      statFeesPct: 'Biaya Platform terhadap Bruto',
      statNet: 'Neto',
      noBasis: '—',
      noBasisHint: 'Tidak ada penjualan pada periode ini, jadi persentase tidak dapat dihitung.',
      channelTitle: 'Kinerja per Kanal',
      channelDescription:
        'Walk-in (kasir) dibanding GoFood dan ShopeeFood. Komisi platform GoFood/ShopeeFood sejak Agustus 2026 sudah termasuk di harga jual kanal tersebut, sehingga Biaya Platform hanya terisi untuk pesanan online lama.',
      columnChannel: 'Kanal',
      columnShare: 'Kontribusi Bruto',
      columnDiscountPct: '% Diskon',
      channelWalkIn: 'Walk-in (Kasir)',
      channelGofood: 'GoFood',
      channelShopeefood: 'ShopeeFood',
      productsTitle: 'Produk Terlaris & Diskonnya',
      productsDescription:
        'Produk dengan bruto tertinggi pada periode ini, beserta diskon yang menempel padanya. Hanya penjualan kasir — item pesanan online tidak menyimpan harga per produk.',
      channelEmpty: 'Belum ada penjualan pada periode dan filter ini.',
      productsEmpty: 'Belum ada penjualan produk pada periode dan filter ini.',
      reconTitle: 'Rekonsiliasi Pesanan Online',
      reconDescription:
        'Rincian bruto → neto per pesanan untuk pesanan online: diskon, komisi platform, biaya lain, dan status penyelesaian.',
      reconEmpty: 'Tidak ada pesanan online pada periode ini.',
      reconEmptyHint:
        'Pesanan GoFood/ShopeeFood kini dicatat sebagai penjualan kasir berkanal, bukan pesanan online terpisah — lihat Kinerja per Kanal di atas. Tabel ini hanya memuat riwayat sebelum perubahan tersebut.',
      columnOrderRef: 'No. Pesanan',
      columnOrderDate: 'Tanggal',
      columnPlatform: 'Platform',
      columnOtherFee: 'Biaya Lain',
      columnStatus: 'Status',
      columnSettlement: 'Penyelesaian',
      loadError: 'Laporan pemasaran gagal dimuat',
      loadErrorHint: 'Periksa koneksi lalu muat ulang; jika tetap gagal, hubungi admin.',
      exportChannelTitle: 'Pemasaran — Kinerja per Kanal — {{scope}} — {{from}} s/d {{to}}',
      exportProductsTitle: 'Pemasaran — Produk & Diskon — {{scope}} — {{from}} s/d {{to}}',
      exportReconTitle: 'Pemasaran — Rekonsiliasi Online — {{scope}} — {{from}} s/d {{to}}',
    },
  },

  // F12 `topology` (BUILD-PLAN W5-03) — device/node tree, sync health,
  // conflict & exception queues (CONTRACTS §4.21-§4.23, §7).
  topology: {
    title: 'Topologi Perangkat',
    generatedAt: 'Diperbarui {{when}}',
    refresh: 'Segarkan',
    tabs: {
      tree: 'Pohon Topologi',
      sync: 'Sinkronisasi & Antrean',
    },
    totals: {
      devicesOnline: '{{count}} Perangkat Online',
      devicesStale: '{{count}} Tidak Merespons',
      devicesOffline: '{{count}} Offline',
      outletsOffline: '{{count}} Outlet Offline',
      openConflicts: '{{count}} Konflik Terbuka',
      openExceptions: '{{count}} Pengecualian Terbuka',
    },
    pusat: 'Pusat (Gudang)',
    city: {
      outletCount: '{{count}} outlet',
    },
    outlet: {
      deviceCount: '{{count}} perangkat',
      node: {
        none: 'Tanpa node cabang',
        pairingPending: 'Node diaktifkan, belum terpasang',
        label: 'Node: {{name}}',
      },
      syncHealth: {
        title: 'Kesehatan Sinkronisasi',
        queueDepth: 'Antrean',
        quarantineDepth: 'Karantina',
        lastSyncAt: 'Sinkron Terakhir',
        conflictsOpen: 'Konflik',
        exceptionsOpen: 'Pengecualian',
        offlineAuthPending: 'Menunggu Verifikasi Offline',
        neverSynced: 'Belum pernah',
      },
    },
    device: {
      columnName: 'Nama',
      columnCategory: 'Kategori',
      columnStatus: 'Status',
      columnAppVersion: 'Versi Aplikasi',
      columnQueueDepth: 'Antrean',
      columnLastSeen: 'Terakhir Terlihat',
      category: {
        tablet: 'Tablet',
        pos_terminal: 'Terminal POS',
        printer: 'Printer',
        laptop: 'Laptop',
        router: 'Router',
        branch_node: 'Node Cabang',
        other: 'Lainnya',
      },
      detailTitle: 'Detail Perangkat',
      lastSeen: 'Terakhir Terlihat',
      appVersion: 'Versi Aplikasi',
      queueDepth: 'Kedalaman Antrean Offline',
      ipAddress: 'Alamat IP',
      pairedToNode: 'Terhubung ke Node',
      pairedToNodeYes: 'Ya — melalui {{name}}',
      pairedToNodeNo: 'Tidak — langsung ke cloud',
      storageNote:
        'Data penyimpanan belum tersedia dari perangkat (placeholder backend) — tidak ditampilkan agar tidak menyesatkan.',
      empty: 'Belum ada perangkat terdaftar di outlet ini.',
      // Rename / recategorise / move / unpair / retire — DeviceDetailDrawer's
      // management section, gated on `device.manage`.
      manage: {
        title: 'Kelola Perangkat',
        nameLabel: 'Nama Perangkat',
        categoryLabel: 'Kategori',
        locationLabel: 'Lokasi',
        save: 'Simpan Perubahan',
        saved: 'Perangkat berhasil diperbarui',
        saveError: 'Gagal memperbarui perangkat',
        unpair: 'Lepas Pasangan',
        unpairTitle: 'Lepas pasangan perangkat ini?',
        unpairDescription:
          '"{{name}}" akan berhenti tersambung dan token perangkatnya dicabut. Perangkat ini masih bisa dipasangkan ulang nanti dengan kode pemasangan baru.',
        unpairReason: 'Alasan (opsional)',
        unpairConfirm: 'Ya, Lepas Pasangan',
        unpairSuccess: 'Perangkat dilepas pasangannya.',
        unpairError: 'Gagal melepas pasangan perangkat',
        retire: 'Pensiunkan',
        retireTitle: 'Pensiunkan perangkat ini?',
        retireDescription:
          '"{{name}}" akan ditandai pensiun dan disembunyikan dari daftar aktif. Tindakan ini bukan untuk dibatalkan dari layar ini.',
        retireConfirm: 'Ya, Pensiunkan',
        retireSuccess: 'Perangkat dipensiunkan.',
        retireError: 'Gagal mempensiunkan perangkat',
        disabledRetired: 'Perangkat ini sudah pensiun — tidak ada tindakan lebih lanjut di sini.',
        disabledUnpaired:
          'Perangkat ini sudah dilepas pasangannya. Masih bisa diganti nama, dikategorikan ulang, atau dipensiunkan.',
      },
    },
    // "Tambah Perangkat" — mints a short-lived (15 menit), sekali pakai
    // pairing token (`POST /devices/pairing-tokens`) whose display code is
    // read off to whoever is at the outlet; they redeem it on the tablet/
    // node itself (`POST /devices/register`, outside this app).
    addDevice: {
      button: 'Tambah Perangkat',
      title: 'Tambah Perangkat Baru',
      description:
        'Buat kode pemasangan sekali pakai. Bacakan kodenya ke petugas di lokasi tujuan — mereka memasukkannya saat mendaftarkan perangkat baru.',
      locationLabel: 'Lokasi',
      locationPlaceholder: 'Pilih lokasi...',
      categoryLabel: 'Kategori (opsional)',
      categoryPlaceholder: 'Biarkan perangkat menentukan sendiri',
      submit: 'Buat Kode Pemasangan',
      error: 'Gagal membuat kode pemasangan',
      resultTitle: 'Kode Pemasangan Dibuat',
      resultHint: 'Bacakan kode ini ke petugas di lokasi tersebut.',
      codeLabel: 'Kode Pemasangan',
      expiresIn: 'Berlaku {{minutes}} menit lagi — kedaluwarsa {{time}}',
      expired: 'Kode ini sudah kedaluwarsa. Buat kode baru.',
      done: 'Selesai',
      another: 'Buat Kode Lain',
    },
    // The one "network setting" this ticket found real backing for (D-26) —
    // whether an outlet runs a branch node, and pairing it. See
    // `lib/node-api.ts`'s doc comment for what has NO backing (WiFi/static
    // IP/subnet — local-only config on the node's own machine).
    nodeSetting: {
      title: 'Pengaturan Node — {{name}}',
      description: 'Node cabang menghubungkan perangkat di outlet ini ke jaringan lokal (LAN).',
      currentState: 'Status saat ini',
      ownerOnly: 'Hanya Owner yang dapat mengubah pengaturan ini.',
      enable: 'Aktifkan Node',
      disable: 'Nonaktifkan Node',
      disableHint:
        'Node akan dilepas pasangannya setelah antreannya kosong sepenuhnya. Jika masih ada data tertunda atau node tidak dapat dihubungi, permintaan ini akan ditolak — coba lagi setelah node tersambung dan antreannya kosong.',
      toggleError: 'Gagal mengubah pengaturan node',
      pairTitle: 'Pasangkan Node',
      pairHint:
        'Buat kode pemasangan sekali pakai untuk PC yang akan menjadi node cabang outlet ini.',
      mint: 'Buat Kode Pemasangan Node',
      mintError: 'Gagal membuat kode pemasangan node',
      pairedAt: 'Terlihat terakhir {{when}}',
      network: {
        title: 'Pengaturan Jaringan Node',
        hint: 'Hanya port pendengar LAN dan subnet pemindaian yang benar-benar diterapkan oleh node saat ini — perubahan disimpan dan dikonfirmasi otomatis, dengan pemulihan otomatis jika node tidak dapat dihubungi lagi.',
        status: 'Status konfigurasi',
        statusValue: {
          none: 'Belum pernah diubah',
          pending: 'Sedang diterapkan…',
          applied: 'Diterapkan',
          reverted: 'Dikembalikan (gagal dikonfirmasi)',
          failed: 'Gagal',
        },
        currentPort: 'port saat ini: {{port}}',
        disconnectedWarning: 'Node tidak terhubung — pengaturan tidak dapat diubah sekarang.',
        healthPort: 'Port LAN',
        scanSubnet: 'Subnet Pemindaian',
        save: 'Simpan',
        pushed: 'Konfigurasi terkirim ke node — menunggu konfirmasi',
        error: 'Gagal mengirim konfigurasi jaringan',
        invalidPort: 'Port harus berupa angka bulat',
        emptyPatch: 'Isi minimal satu kolom untuk disimpan',
      },
      commands: {
        title: 'Perintah Jarak Jauh',
        hint: 'Perintah ini benar-benar dijalankan oleh node — bukan sekadar tombol.',
        restart: 'Mulai Ulang Node',
        restartSent: 'Perintah mulai ulang terkirim',
        restartError: 'Gagal mengirim perintah mulai ulang',
        restartShiftOpen: 'Outlet ini memiliki shift POS yang sedang berjalan.',
        restartShiftOpenHint:
          'Mulai ulang node akan mengganggu shift yang sedang berjalan di outlet ini. Lanjutkan hanya jika benar-benar diperlukan.',
        restartOverride: 'Mulai Ulang Meski Shift Terbuka',
        pullLogs: 'Ambil Log Terbaru',
        logPullError: 'Gagal mengambil log',
        logPullWaiting: 'Menunggu log dari node…',
        logPullResult: '{{count}} baris log diterima',
        logPullEmpty: '(tidak ada baris log)',
      },
    },
    quietNote:
      'Outlet yang tutup wajar terlihat offline — perangkat tunggal yang offline tidak selalu berarti gangguan. Peringatan hanya berlaku saat seluruh outlet gelap.',
    sync: {
      title: 'Kesehatan Sinkronisasi per Outlet',
      columnLocation: 'Lokasi',
      columnQueueDepth: 'Antrean',
      columnQuarantine: 'Karantina',
      columnLastSync: 'Sinkron Terakhir',
      columnConflicts: 'Konflik',
      columnExceptions: 'Pengecualian',
      conflictsTitle: 'Antrean Konflik & Pengecualian',
      conflictsEmpty: 'Tidak ada konflik atau pengecualian terbuka.',
      filterQueue: 'Semua Antrean',
      filterStatus: 'Semua Status',
      columnKind: 'Jenis',
      columnQueue: 'Antrean',
      columnEntity: 'Entitas',
      columnDetected: 'Terdeteksi',
      columnPhysicalEffect: 'Efek Fisik',
      physicalEffectYes: 'Diduga Ya',
      physicalEffectNo: 'Tidak',
      resolveInDomain: 'Selesaikan di Layar Terkait',
      reconciliationsTitle: 'Selisih Stok (Rekonsiliasi)',
      reconciliationsEmpty: 'Tidak ada selisih stok terbuka.',
      columnItem: 'Item',
      columnStorageArea: 'Area Simpan',
      columnExpectedQty: 'Diharapkan',
      columnStoredQty: 'Tercatat',
      columnDivergence: 'Selisih',
      // Human names for the engine's conflict tokens. The raw token stays
      // visible in the drawer's payload; a queue an operator has to decode
      // token by token is a queue nobody works.
      kind: {
        double_count: 'Stok opname dihitung dua kali',
        duplicate_receipt: 'Penerimaan barang ganda',
        duplicate_inbound: 'Barang masuk ganda',
        duplicate_platform_order: 'Pesanan online ganda',
        decision_race: 'Dua keputusan bersamaan',
        attendance_overlap: 'Absensi bertumpuk',
        negative_balance: 'Stok jadi minus',
        offline_auth: 'Otorisasi offline perlu ditinjau',
        poison: 'Event gagal diproses berulang',
      },
      // Conflict detail drawer.
      detailTitle: 'Detail Konflik',
      detailEntityId: 'ID Entitas',
      detailStatus: 'Status',
      detailWinnerEvent: 'Event yang Dipakai',
      detailLoserEvent: 'Event yang Ditolak',
      detailPayload: 'Data Teknis',
      physicalEffectHint:
        'Diduga sudah ada dampak fisik: barang mungkin benar-benar berpindah atau uang sudah diterima. Periksa dokumen aslinya sebelum menutup.',
      resolveTitle: 'Tindak Lanjut',
      openOwningScreen: 'Buka Dokumen Terkait',
      domainOnlyHint:
        'Konflik jenis ini tidak bisa ditutup dari sini — perbaikannya ada di dokumen aslinya (hitung ulang opname, koreksi penerimaan, atau putuskan ulang persetujuan).',
      dismissReason: 'Alasan Menutup',
      dismissReasonHint:
        'Tercatat di jejak audit. Jelaskan mengapa hasil yang dipakai sistem sudah benar.',
      dismissButton: 'Tutup Konflik',
      dismissSuccess: 'Konflik ditutup.',
      // Stock divergence drawer (D-16).
      reconDetailTitle: 'Detail Selisih Stok',
      tier: 'Tier {{tier}}',
      divergenceShort: 'Stok fisik tercatat LEBIH SEDIKIT dari catatan pusat.',
      divergenceOver: 'Stok fisik tercatat LEBIH BANYAK dari catatan pusat.',
      reconResolveTitle: 'Tindak Lanjut',
      reconCountFirstHint:
        'Selisih hanya bisa dipastikan dengan hitung fisik. Lakukan stok opname dulu, lalu catat hasilnya di sini.',
      reconOpenOpname: 'Buka Gudang Pusat (Stok Opname)',
      reconResolutionLabel: 'Hasil Penyelesaian',
      reconResolutionHint: 'mis. hasil opname 68 kg, selisih 4 kg karena susut saat thawing',
      reconAdjustmentLabel: 'No. Dokumen Penyesuaian (opsional)',
      reconAdjustmentHint: 'Nomor opname atau penyesuaian stok yang memperbaiki selisih ini.',
      reconResolveButton: 'Tandai Selesai',
      reconResolveSuccess: 'Selisih stok ditandai selesai.',
    },
  },

  /**
   * F-DOC (2026-08-27) — the printable-document vocabulary: every label that
   * appears ON PAPER (invoice / receipt / voucher / Surat Jalan), plus the
   * designer UI that lays them out.
   *
   * WHY THIS IS `doc` AND NOT `docs`. The obvious name is taken. `docs.*` is
   * the USER MANUAL namespace (`app/docs/**`, ~20 keys above), and it already
   * owns `docs.title` as a STRING ('Panduan Pengguna') — so `docs.title.invoice`
   * cannot exist without either breaking the manual's heading or nesting a
   * document title under a namespace that means "documentation". Two different
   * things called "docs" is exactly the kind of collision `t()` resolves
   * silently and wrongly: `resolvePath` would hand `translate` an object, and
   * `translate` would warn and return the raw key — printing `docs.title` onto
   * a customer's invoice. So the printable-document vocabulary is `doc.*`,
   * singular. (Rejected alternative: renaming the manual's `docs.title` to free
   * the path. It would work, but it puts two unrelated features in one
   * namespace forever, and the next person to add a manual key would have to
   * know that half of `docs.*` is really about invoices.)
   *
   * THIS IS ALSO A WIRE CONTRACT. `DocPayload.labelKeys` (see
   * `packages/shared/src/documents/payload.ts`) carries i18n KEYS the backend
   * chooses and this dictionary resolves — the server may not hold Bahasa
   * Indonesia copy (BUILD-PLAN §6.9). Every key the resolvers emit must exist
   * below, under `doc.`. `components/documents/doc-payload.ts` degrades to the
   * server's own raw `fields` value when a key does not resolve, rather than
   * printing `doc.title.invoice` on paper — but that is a safety net, not a
   * licence to let the two drift.
   */
  doc: {
    /**
     * One entry for EVERY token in every kind's catalog
     * (`DOC_CATALOGS[kind].fields`). The designer's "add field" palette is
     * driven straight off that list, so a missing key here shows an owner a
     * button labelled with a raw token. Tokens shared by several kinds
     * (`document_title`, `company_name`, `notes`, `terms`) are declared once.
     */
    field: {
      // shared across kinds
      document_title: 'Judul Dokumen',
      company_name: 'Nama Perusahaan',
      company_address: 'Alamat Perusahaan',
      company_city: 'Kota',
      company_phone: 'Telepon Perusahaan',
      company_npwp: 'NPWP',
      notes: 'Catatan',
      terms: 'Syarat & Ketentuan',
      // invoice
      invoice_number: 'Nomor Faktur',
      invoice_date: 'Tanggal Faktur',
      due_date: 'Jatuh Tempo',
      source_label: 'Jenis Faktur',
      party_label: 'Label Pihak',
      party_name: 'Nama Pihak',
      party_address: 'Alamat Pihak',
      party_phone: 'Telepon Pihak',
      location_name: 'Lokasi',
      issued_by: 'Diterbitkan Oleh',
      payment_method: 'Metode Pembayaran',
      payment_status: 'Status Pembayaran',
      // receipt
      outlet_name: 'Nama Outlet',
      outlet_address: 'Alamat Outlet',
      outlet_phone: 'Telepon Outlet',
      receipt_number: 'Nomor Struk',
      datetime: 'Tanggal & Jam',
      kasir_name: 'Kasir',
      channel_label: 'Kanal Penjualan',
      paid_amount: 'Dibayar',
      change_amount: 'Kembalian',
      voucher_code: 'Kode Voucher',
      // voucher
      voucher_name: 'Nama Voucher',
      voucher_value: 'Nilai Voucher',
      voucher_type_label: 'Jenis Voucher',
      min_subtotal: 'Minimum Belanja',
      valid_from: 'Berlaku Mulai',
      valid_until: 'Berlaku Sampai',
      batch_code: 'Kode Batch',
      outlet_scope: 'Berlaku di Outlet',
      // surat jalan
      sj_number: 'Nomor Surat Jalan',
      sj_date: 'Tanggal Surat Jalan',
      shipment_type_label: 'Jenis Muatan',
      origin_name: 'Asal',
      destination_name: 'Tujuan',
      destination_address: 'Alamat Tujuan',
      driver_name: 'Driver',
      vehicle_plate: 'Nomor Kendaraan',
      drop_label: 'Titik Kirim',
      copy_holder_label: 'Salinan Untuk',
      seal_number: 'Nomor Segel',
      temp_c: 'Suhu',
      dispatcher_name: 'Petugas Gudang',
      page_label: 'Halaman',
    },

    /**
     * Printed table headers. An owner may override any of these per column
     * (`DocTableColumn.labelText`) — that override is THEIR copy, typed into
     * their own document, and deliberately not a translation key.
     */
    column: {
      no: 'No.',
      code: 'Kode',
      name: 'Nama Barang',
      qty: 'Jumlah',
      uom: 'Satuan',
      unit_price: 'Harga Satuan',
      discount: 'Diskon',
      line_total: 'Jumlah',
      qty_sent: 'Dikirim',
      qty_received: 'Diterima',
      notes: 'Catatan',
    },

    /** Rows of the totals block, in `DOC_TOTALS_ROWS` order. */
    total: {
      subtotal: 'Subtotal',
      discount: 'Diskon',
      total: 'TOTAL',
      paid: 'Dibayar',
      balance: 'Sisa Tagihan',
      change: 'Kembalian',
      voucher: 'Voucher',
    },

    /** Who signs, printed under the rule a `signature` element draws. */
    signature: {
      issuer: 'Hormat Kami',
      recipient: 'Diterima Oleh',
      sender: 'Pengirim (Gudang)',
      driver: 'Driver',
      receiver: 'Penerima di Outlet',
    },

    /** The `document_title` field token's value, per kind. */
    title: {
      invoice: 'FAKTUR',
      receipt: 'STRUK PEMBELIAN',
      voucher: 'VOUCHER',
      surat_jalan: 'SURAT JALAN',
    },

    /** Which of the three Surat Jalan copies a sheet is. */
    copyHolder: {
      gudang: 'Gudang Pusat',
      outlet: 'Outlet Penerima',
      kantor: 'Kantor',
    },

    /**
     * `party_label` — who the invoice is addressed to. One invoice template
     * serves three sources, so the LABEL changes rather than the token (see
     * `catalog.ts`'s note on why the tokens are `party_*`, not `customer_*`).
     */
    party: {
      customer: 'Ditagihkan Kepada',
      supplier: 'Pemasok',
      manual: 'Kepada',
    },

    /** `source_label` — where an invoice's contents came from. */
    source: {
      sale: 'Penjualan Kasir',
      purchase_order: 'Pesanan Pembelian',
      manual: 'Faktur Manual',
    },

    /** `channel_label` on a receipt. The printed twin of `pos.channel*`. */
    channel: {
      walk_in: 'Kasir',
      gofood: 'GoFood',
      shopeefood: 'ShopeeFood',
    },

    /** `shipment_type_label` on a Surat Jalan. */
    shipmentType: {
      dry: 'Kering',
      frozen: 'Beku',
    },

    paymentMethod: {
      cash: 'Tunai',
      qris: 'QRIS',
      bank_transfer: 'Transfer Bank',
    },

    paymentStatus: {
      pending: 'Menunggu Verifikasi',
      verified: 'Terverifikasi',
      paid: 'Lunas',
    },

    voucherType: {
      fixed: 'Potongan Tetap',
      percentage: 'Potongan Persen',
    },

    // ── The designer (Admin → Dokumen) ────────────────────────────────────
    designer: {
      title: 'Perancang Dokumen',
      description:
        'Atur tata letak dokumen yang dicetak. Seret elemen di kanvas, atau pilih elemen lalu gunakan tombol panah untuk menggeser satu per satu.',
      kind: {
        invoice: 'Faktur',
        receipt: 'Struk Kasir',
        voucher: 'Voucher',
        surat_jalan: 'Surat Jalan',
      },
      paletteTitle: 'Tambah Elemen',
      fieldsTitle: 'Tambah Isian',
      fieldsHint: 'Isian yang tersedia untuk dokumen ini. Klik untuk menaruhnya di kanvas.',
      layersTitle: 'Elemen di Kanvas',
      propertiesTitle: 'Properti Elemen',
      noSelection: 'Pilih sebuah elemen di kanvas untuk mengubah propertinya.',
      element: {
        text: 'Teks',
        field: 'Isian',
        logo: 'Logo',
        table: 'Tabel Barang',
        totals: 'Blok Total',
        code: 'QR / Barcode',
        divider: 'Garis',
        box: 'Kotak',
        signature: 'Tanda Tangan',
      },
      // Deliberately NOT 'Teks': that is already the name of the element TYPE
      // in the palette and in the layer list, and two controls with the same
      // accessible name in one panel is ambiguous for a screen reader (and
      // for a test) about which one is being addressed.
      propText: 'Isi Teks',
      propFontSize: 'Ukuran Huruf',
      propColor: 'Warna',
      propBackground: 'Warna Latar',
      propAlign: 'Perataan',
      propBold: 'Tebal',
      propWrap: 'Bungkus teks panjang',
      propWrapHint:
        'Aktif: teks panjang turun ke baris berikutnya di dalam kotak. Nonaktif: dipotong satu baris.',
      propX: 'Posisi X',
      propY: 'Posisi Y',
      propW: 'Lebar',
      propH: 'Tinggi',
      propField: 'Isian',
      propSignatureRole: 'Penanda Tangan',
      propCodeType: 'Jenis Kode',
      propCodeSource: 'Sumber Kode',
      propColumns: 'Kolom Tabel',
      propColumnLabel: 'Judul Kolom',
      propColumnLabelHint: 'Kosongkan untuk memakai judul bawaan.',
      propColumnWidth: 'Lebar Kolom',
      propColumnAlign: 'Perataan Kolom',
      addColumn: 'Tambah Kolom',
      removeColumn: 'Hapus Kolom',
      columnWidthNotice:
        'Lebar kolom selalu dijumlahkan pas dengan lebar tabel ({{width}} px): menambah lebar satu kolom mengurangi kolom lain, supaya kolom paling kanan tidak keluar dari kertas.',
      align: { left: 'Kiri', center: 'Tengah', right: 'Kanan' },
      codeType: { qr: 'QR Code', barcode: 'Barcode (Code 128)' },
      colorBrandPrimary: 'Warna Merek',
      colorBrandAccent: 'Warna Aksen',
      colorBrandInk: 'Warna Teks',
      colorBrandMuted: 'Warna Teks Samar',
      colorCustom: 'Warna Sendiri',
      colorNone: 'Tanpa Warna',
      colorBrandHint:
        'Warna merek mengikuti pengaturan di Admin → Merek. Pilih warna sendiri hanya bila elemen ini memang harus berbeda selamanya.',
      zoom: 'Perbesaran',
      snap: 'Kunci ke Grid',
      snapHint: 'Elemen menempel ke kelipatan {{size}} px saat digeser.',
      paper: 'Ukuran Kertas',
      background: 'Gambar Latar',
      backgroundUpload: 'Unggah Gambar Latar',
      backgroundRemove: 'Hapus Gambar Latar',
      backgroundHint: 'Untuk kop surat pra-cetak. Gambar diregangkan mengikuti ukuran kertas.',
      duplicate: 'Gandakan',
      deleteElement: 'Hapus Elemen',
      save: 'Simpan Tata Letak',
      saved: 'Tata letak tersimpan.',
      saveFailed: 'Tata letak gagal disimpan',
      resetToDefault: 'Kembalikan ke Bawaan',
      resetConfirmTitle: 'Kembalikan ke tata letak bawaan?',
      resetConfirmBody:
        'Semua perubahan pada tata letak {{kind}} akan hilang dan diganti dengan bawaan sistem. Tindakan ini tidak bisa dibatalkan.',
      resetDone: 'Tata letak dikembalikan ke bawaan.',
      unsaved: 'Ada perubahan yang belum disimpan.',
      validationTitle: 'Tata letak belum bisa disimpan',
      previewTitle: 'Pratinjau',
      previewHint: 'Pratinjau memakai data contoh, bukan data asli.',
      loadFailed: 'Gagal memuat tata letak',
      keyboardHint:
        'Panah menggeser 1 px, Shift+Panah menggeser {{step}} px, Delete menghapus elemen terpilih.',
      uploadFailed: 'Gagal mengunggah gambar',
      canvasLabel: 'Kanvas dokumen',
      elementCount: '{{count}} dari {{max}} elemen',
    },

    // ── Print routes ───────────────────────────────────────────────────────
    print: {
      loadFailed: 'Gagal memuat dokumen',
      notFound: 'Dokumen tidak ditemukan.',
      invoiceTitle: 'Faktur',
      receiptTitle: 'Struk',
      voucherTitle: 'Voucher',
      suratJalanTitle: 'Surat Jalan',
      // Manual invoice entry surface (`/print/invoice/manual`).
      manualTitle: 'Faktur Manual',
      manualDescription:
        'Buat faktur untuk penerima di luar penjualan kasir dan pesanan pembelian. Nomor faktur diterbitkan oleh sistem saat faktur dibuat.',
      manualPartyName: 'Nama Penerima',
      manualPartyAddress: 'Alamat Penerima',
      manualPartyPhone: 'Telepon Penerima',
      manualDueDate: 'Jatuh Tempo',
      manualNotes: 'Catatan',
      manualLines: 'Rincian',
      manualLineName: 'Uraian',
      manualLineQty: 'Jumlah',
      manualLineUom: 'Satuan',
      manualLineUnitPrice: 'Harga Satuan',
      manualAddLine: 'Tambah Baris',
      manualRemoveLine: 'Hapus Baris',
      manualSubmit: 'Buat & Tampilkan Faktur',
      manualNeedsLine: 'Tambahkan minimal satu baris rincian.',
      manualNeedsParty: 'Isi nama penerima.',
      manualFailed: 'Gagal membuat faktur',
      manualBack: 'Ubah Faktur',
      // Voucher sheet.
      voucherSheetNotice:
        '{{count}} voucher dicetak {{perSheet}} per halaman A4 = {{pages}} halaman. Gunting mengikuti garis putus-putus.',
      voucherEmpty: 'Batch ini belum memiliki voucher yang diterbitkan.',
      // Shown when the batch endpoint returned its maximum. Says plainly
      // that this is not the whole run, because the alternative is
      // somebody believing 24 sheets finished a batch of 500.
      voucherCapNotice:
        'Batch ini berisi lebih dari {{cap}} voucher. Hanya {{cap}} kode pertama yang dicetak di halaman ini — sisanya belum bisa dicetak dari layar ini.',
      // Surat Jalan — the three-copies rule survives the move to templates.
      sjCopyNotice:
        '{{drops}} tujuan × {{copies}} salinan (gudang, outlet, kantor) = {{pages}} halaman. Siapkan kertas di printer sebelum mencetak.',
      sjEmpty: 'Surat jalan ini belum memiliki titik kirim.',
      // Shown instead of `sjCopyNotice` when the resolver's sheet count is not
      // a whole number of copies per drop — the route refuses to state a drop
      // count it cannot derive, and says only how much paper this is.
      sjCopyNoticeFallback:
        '{{pages}} halaman akan dicetak. Siapkan kertas di printer sebelum mencetak.',
    },
  },

  /**
   * F-DOC — Admin → Merek. The brand identity: the logo every document and
   * every letterhead prints, the favicon the browser tab shows, and the four
   * colours `resolveDocColor` resolves a template's `brand.*` tokens against.
   */
  brand: {
    title: 'Merek',
    description:
      'Logo, ikon, dan warna yang dipakai di seluruh aplikasi dan di setiap dokumen yang dicetak.',
    logoTitle: 'Logo',
    logoHint:
      'Dipakai di kop faktur, struk, voucher, dan surat jalan. Format PNG dengan latar transparan memberi hasil terbaik.',
    logoUpload: 'Unggah Logo',
    logoReplace: 'Ganti Logo',
    logoRemove: 'Hapus Logo',
    logoEmpty: 'Belum ada logo.',
    faviconTitle: 'Ikon Aplikasi (Favicon)',
    faviconHint:
      'Ikon kecil di tab peramban dan di layar utama tablet. Gunakan gambar persegi, minimal 192×192 piksel.',
    faviconUpload: 'Unggah Ikon',
    faviconReplace: 'Ganti Ikon',
    faviconRemove: 'Hapus Ikon',
    faviconEmpty: 'Belum ada ikon khusus — memakai ikon bawaan sistem.',
    colorsTitle: 'Warna',
    colorsHint:
      'Empat warna ini dipakai oleh semua dokumen. Mengubahnya di sini langsung mengubah warna setiap dokumen yang belum diberi warna sendiri.',
    primaryColor: 'Warna Merek',
    primaryColorHint: 'Warna utama: judul dokumen, latar baris kepala tabel, dan warna aplikasi.',
    accentColor: 'Warna Aksen',
    accentColorHint: 'Penegas di samping warna merek: nilai voucher, label salinan.',
    inkColor: 'Warna Teks',
    inkColorHint: 'Warna teks isi dokumen.',
    mutedColor: 'Warna Teks Samar',
    mutedColorHint: 'Teks sekunder: alamat, keterangan kecil, garis pemisah.',
    previewTitle: 'Pratinjau Dokumen',
    previewHint: 'Contoh faktur dengan warna di atas.',
    save: 'Simpan Merek',
    saved: 'Pengaturan merek tersimpan.',
    saveFailed: 'Pengaturan merek gagal disimpan',
    resetToDefault: 'Kembalikan ke Bawaan',
    resetDone: 'Warna dikembalikan ke bawaan.',
    invalidColor: 'Warna harus berformat #rrggbb.',
    loadFailed: 'Gagal memuat pengaturan merek',
    uploadFailed: 'Gagal mengunggah gambar',
    unsaved: 'Ada perubahan yang belum disimpan.',
  },

  /**
   * F-DOC — vouchers. A batch is a print run; issuing mints N codes that are
   * worth real money, which is why `voucher.issue` is a narrower permission
   * than `voucher.read` and why every count on this surface is stated plainly.
   */
  voucher: {
    title: 'Voucher',
    description:
      'Kelola batch voucher diskon: buat batch, terbitkan kode, cetak, dan batalkan voucher yang salah cetak.',
    empty: 'Belum ada batch voucher.',
    emptyDescription: 'Buat batch untuk mulai menerbitkan kode voucher.',
    loadFailed: 'Gagal memuat voucher',
    detailTitle: 'Detail Batch Voucher',
    filterStatusAll: 'Semua Status',

    // Batch list columns.
    columnName: 'Nama Batch',
    columnCode: 'Kode Batch',
    columnType: 'Jenis',
    columnValue: 'Nilai',
    columnValidity: 'Masa Berlaku',
    columnIssued: 'Terbit',
    columnRedeemed: 'Terpakai',
    columnStatus: 'Status',
    validityRange: '{{from}} – {{until}}',

    // Issued-code list columns.
    columnVoucherCode: 'Kode',
    columnVoucherStatus: 'Status',
    columnRedeemedAt: 'Dipakai',

    /**
     * TWO status ladders, deliberately named apart. `batchStatus` is the print
     * run's lifecycle (draft → issued → closed); `status` is one coupon's
     * (active → redeemed | void). They are different vocabularies about
     * different things and a batch that is "closed" still contains "active"
     * codes — collapsing them into one namespace is how a screen ends up
     * telling a cashier a live voucher is closed.
     */
    batchStatus: {
      draft: 'Draf',
      issued: 'Terbit',
      closed: 'Ditutup',
    },
    status: {
      active: 'Aktif',
      redeemed: 'Terpakai',
      void: 'Dibatalkan',
    },
    type: {
      fixed: 'Potongan Tetap',
      percentage: 'Potongan Persen',
    },

    // Create / edit.
    createButton: 'Buat Batch',
    createTitle: 'Buat Batch Voucher',
    editTitle: 'Ubah Batch Voucher',
    createSuccess: 'Batch voucher dibuat.',
    updated: 'Batch voucher diperbarui.',
    saveFailed: 'Batch gagal disimpan',
    name: 'Nama Batch',
    nameHint: 'Nama yang dibaca kasir saat voucher diterima, mis. "Promo Pembukaan Samarinda".',
    value: 'Nilai Potongan',
    percentHint: 'Isi angka persen, mis. 10 untuk 10%. Maksimal dua angka di belakang koma.',
    maxDiscount: 'Potongan Maksimal',
    maxDiscountHint: 'Batas atas potongan persen. Kosongkan bila tanpa batas.',
    minSubtotal: 'Minimum Belanja',
    minSubtotalHint: 'Voucher hanya berlaku bila subtotal mencapai jumlah ini.',
    validFrom: 'Berlaku Mulai',
    validUntil: 'Berlaku Sampai',
    locationsLabel: 'Outlet',
    allOutlets: 'Semua outlet',
    locationsCount: '{{count}} outlet',
    terms: 'Syarat & Ketentuan',

    // Issue.
    issueTitle: 'Terbitkan Kode Voucher',
    issueButton: 'Terbitkan Kode',
    issueQuantity: 'Jumlah Kode',
    issueQuantityHint:
      'Setiap kode berlaku sekali pakai dan bernilai uang sungguhan. Kode yang sudah terbit tidak bisa ditarik — hanya bisa dibatalkan satu per satu.',
    issueSuccess: '{{count}} kode voucher diterbitkan.',
    issueFailed: 'Gagal menerbitkan kode',

    // Close.
    closeTitle: 'Tutup batch ini?',
    closeButton: 'Tutup Batch',
    closeConfirm:
      'Batch yang ditutup tidak bisa menerbitkan kode baru. Kode yang sudah terbit tetap berlaku sampai masa berlakunya habis.',
    closeSuccess: 'Batch ditutup.',
    closeFailed: 'Gagal menutup batch',

    printButton: 'Cetak Batch',

    // Issued codes.
    codesTitle: 'Kode dalam Batch',
    codesEmpty: 'Batch ini belum menerbitkan kode.',
    voidButton: 'Batalkan',
    voidConfirmTitle: 'Batalkan voucher ini?',
    voidConfirm:
      'Kode {{code}} tidak akan bisa dipakai lagi. Gunakan ini untuk kode yang salah cetak atau hilang.',
    voidSuccess: 'Voucher dibatalkan.',
    voidFailed: 'Gagal membatalkan voucher',

    /**
     * The till's voucher entry (`components/pos/VoucherEntry.tsx`).
     *
     * Every `ERR_VOUCHER_*` gets its OWN sentence. `checkVoucher`'s header
     * says why: "tidak berlaku" with no reason is what makes a queue argue —
     * a customer told "expired" walks away, a customer told "invalid" asks
     * the cashier to try again three times.
     */
    pos: {
      label: 'Kode Voucher',
      placeholder: 'MC-XXXX-XXXX',
      apply: 'Terapkan',
      remove: 'Hapus Voucher',
      checking: 'Memeriksa…',
      applied: 'Voucher {{code}} diterapkan: potongan {{discount}}.',
      appliedBatch: '{{batch}} — potongan {{discount}}',
      // The till shows a PREVIEW. The server recomputes the discount when the
      // sale lands, and its number is the one that reaches the ledger.
      previewNote:
        'Potongan dihitung ulang oleh sistem pusat saat transaksi tersimpan. Angka di sini adalah perkiraan.',
      malformed: 'Format kode tidak dikenali. Kode voucher berbentuk MC-XXXX-XXXX.',
      error: {
        ERR_VOUCHER_NOT_FOUND: 'Kode voucher tidak ditemukan.',
        ERR_VOUCHER_NOT_ACTIVE: 'Voucher ini sudah pernah dipakai atau sudah dibatalkan.',
        ERR_VOUCHER_NOT_STARTED: 'Voucher ini belum berlaku.',
        ERR_VOUCHER_EXPIRED: 'Masa berlaku voucher ini sudah habis.',
        ERR_VOUCHER_BELOW_MINIMUM: 'Belanja belum mencapai minimum untuk voucher ini.',
        ERR_VOUCHER_WRONG_LOCATION: 'Voucher ini tidak berlaku di outlet ini.',
        ERR_VOUCHER_OFFLINE_BLOCKED:
          'Voucher tidak bisa diperiksa saat perangkat offline. Coba lagi setelah tersambung.',
        unknown: 'Voucher tidak bisa diperiksa. Coba lagi.',
      },
    },
  },
} as const;

export type Dictionary = typeof id;
