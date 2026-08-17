/**
 * Database Seed Script — Mimi Chicken Operational System
 *
 * Realistic Indonesian demo data: 1 gudang pusat (Balikpapan) + 20 outlets
 * across 4 Kalimantan cities, storage areas, ~120 items, ~40 menu products
 * with recipes, ~130 employees across the 9 roles, 15 suppliers with price
 * history, ~30 devices in mixed states, and enough transactional history
 * (sales, shifts, replenishment at various states, an in-flight Surat
 * Jalan, attendance, a payroll period) that dashboards are not empty at G1.
 *
 * Idempotent: every insert upserts on a natural key, safe to re-run.
 *
 * Usage:
 *   npx tsx database/seed.ts
 *
 * Environment:
 *   DATABASE_MIGRATION_URL - PostgreSQL connection string for the DDL-owning
 *                  (superuser/owner) role. This script writes directly to
 *                  every table without setting any app.* RLS session
 *                  variable, so it must run as the owner/superuser
 *                  connection (DATABASE_MIGRATION_URL), never the runtime
 *                  `mimi_app` role (DATABASE_URL) — see D-21/D-22 in
 *                  docs/BUILD-PLAN.md and database/README.md.
 */

import pg from 'pg';
import bcrypt from 'bcrypt';
import { createHash } from 'node:crypto';

const { Client } = pg;

/** Deterministic UUID-shaped id from a stable seed string, so re-running the
 * seed can upsert on (client_id) natural keys instead of minting a fresh
 * random id every run (which would defeat idempotency). */
function stableUuid(seed: string): string {
  const hash = createHash('md5').update(seed).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

const DEMO_PASSWORD = 'password123';
const DEMO_PIN = '123456';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function rnd(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick<T>(arr: T[]): T {
  return arr[rnd(0, arr.length - 1)];
}
function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The ONE mechanism that may ever produce a cloud-issued document number
 * (SJ, PO, PC, WST, PRUN, RR, ...) — a thin wrapper around the
 * `allocate_document_number()` DB function (migration 215), which owns
 * document_counters. Never hardcode a document number string in this file:
 * a hardcoded number and this file's own document_counters row are two
 * sources of truth that can only ever agree by accident, and disagreeing
 * is exactly the bug this function exists to make impossible. */
async function nextDocNumber(client: pg.Client, docType: string, period = '202608'): Promise<string> {
  const res = await client.query('SELECT allocate_document_number($1, $2) AS num', [docType, period]);
  return res.rows[0].num;
}

async function main(): Promise<void> {
  const connectionString =
    process.env.DATABASE_MIGRATION_URL ||
    'postgresql://mimi:mimi_secret@localhost:5432/mimi';
  const client = new Client({ connectionString });
  await client.connect();

  try {
    console.log('\nSeeding Mimi Chicken database...\n');

    const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
    const pinHash = await bcrypt.hash(DEMO_PIN, 10);

    // =========================================================================
    // ROLES (seeded by migration 009) — fetch ids
    // =========================================================================
    const roleRows = (await client.query('SELECT id, key FROM roles')).rows;
    const roleId: Record<string, string> = {};
    for (const r of roleRows) roleId[r.key] = r.id;
    console.log(`  - roles loaded (${roleRows.length})`);

    // =========================================================================
    // LOCATIONS: 1 gudang pusat + 20 outlets across 4 Kalimantan cities
    // =========================================================================
    const cityDistricts: Record<string, string[]> = {
      Balikpapan: ['Balikpapan Kota', 'Balikpapan Selatan', 'Balikpapan Utara', 'Balikpapan Timur', 'Balikpapan Barat'],
      Samarinda: ['Samarinda Ulu', 'Samarinda Ilir', 'Samarinda Kota', 'Samarinda Seberang', 'Sungai Kunjang'],
      Banjarmasin: ['Banjarmasin Tengah', 'Banjarmasin Utara', 'Banjarmasin Selatan', 'Banjarmasin Timur', 'Banjarmasin Barat'],
      Pontianak: ['Pontianak Kota', 'Pontianak Utara', 'Pontianak Selatan', 'Pontianak Timur', 'Pontianak Barat'],
    };
    const cityCoords: Record<string, [number, number]> = {
      Balikpapan: [-1.2379, 116.8529],
      Samarinda: [-0.5022, 117.1536],
      Banjarmasin: [-3.3194, 114.5908],
      Pontianak: [-0.0263, 109.3425],
    };
    const cityPrefix: Record<string, string> = {
      Balikpapan: 'BPP', Samarinda: 'SMD', Banjarmasin: 'BJM', Pontianak: 'PTK',
    };

    const locationId: Record<string, string> = {}; // code -> id
    const allLocationCodes: string[] = [];
    const outletCodesByCity: Record<string, string[]> = {};

    async function upsertLocation(code: string, name: string, type: string, city: string, lat: number, lng: number): Promise<string> {
      const res = await client.query(
        `INSERT INTO locations (code, name, type, city, address, phone, latitude, longitude, geofence_radius_m)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,100)
         ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [code, name, type, city, `Jl. ${name}, ${city}, Kalimantan`, `0542${rnd(1000000, 9999999)}`, lat, lng],
      );
      return res.rows[0].id;
    }

    const [gdgLat, gdgLng] = cityCoords.Balikpapan;
    locationId['GDG'] = await upsertLocation('GDG', 'Gudang Pusat Balikpapan', 'warehouse', 'Balikpapan', gdgLat, gdgLng);
    allLocationCodes.push('GDG');

    for (const city of Object.keys(cityDistricts)) {
      outletCodesByCity[city] = [];
      const [baseLat, baseLng] = cityCoords[city];
      const districts = cityDistricts[city];
      for (let i = 0; i < 5; i++) {
        const code = `${cityPrefix[city]}${String(i + 1).padStart(2, '0')}`;
        const jitterLat = baseLat + (Math.random() - 0.5) * 0.05;
        const jitterLng = baseLng + (Math.random() - 0.5) * 0.05;
        locationId[code] = await upsertLocation(code, `Mimi Chicken ${districts[i]}`, 'outlet', city, jitterLat, jitterLng);
        allLocationCodes.push(code);
        outletCodesByCity[city].push(code);
      }
    }
    console.log(`  - locations: 1 gudang + ${allLocationCodes.length - 1} outlets across ${Object.keys(cityDistricts).length} cities`);

    // =========================================================================
    // STORAGE AREAS — D-15. Warehouse: freezer/chiller/dry_store. Outlets: all 5.
    // =========================================================================
    const storageAreaId: Record<string, Record<string, string>> = {}; // locCode -> type -> id
    async function upsertStorageArea(locCode: string, code: string, name: string, type: string, tmin: number | null, tmax: number | null): Promise<string> {
      const res = await client.query(
        `INSERT INTO storage_areas (location_id, code, name, type, temp_min, temp_max)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (location_id, code) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [locationId[locCode], code, name, type, tmin, tmax],
      );
      if (!storageAreaId[locCode]) storageAreaId[locCode] = {};
      storageAreaId[locCode][type] = res.rows[0].id;
      return res.rows[0].id;
    }

    const areaDefs: [string, string, string, number | null, number | null][] = [
      ['FRZ', 'Freezer', 'freezer', -25.0, -15.0],
      ['CHL', 'Chiller', 'chiller', 0.0, 5.0],
      ['DRY', 'Dry Store', 'dry_store', null, null],
      ['DSP', 'Display', 'display', 0.0, 8.0],
      ['KLN', 'Kitchen Line', 'kitchen_line', null, null],
    ];
    for (const code of allLocationCodes) {
      const isWarehouse = code === 'GDG';
      for (const [areaCode, name, type, tmin, tmax] of areaDefs) {
        if (isWarehouse && (type === 'display' || type === 'kitchen_line')) continue;
        await upsertStorageArea(code, areaCode, name, type, tmin, tmax);
      }
    }
    console.log('  - storage areas seeded for all locations');

    // =========================================================================
    // USERS + USER_LOCATIONS + EMPLOYEES
    // =========================================================================
    interface SeedUser { username: string; name: string; roleKey: string; locations: string[]; withPin?: boolean; }
    const seedUsers: SeedUser[] = [];

    seedUsers.push({ username: 'owner', name: 'Bambang Wirawan', roleKey: 'owner', locations: [], withPin: true });
    seedUsers.push({ username: 'manager1', name: 'Siti Nurhaliza', roleKey: 'manager', locations: [], withPin: true });
    seedUsers.push({ username: 'manager2', name: 'Rudi Hartono', roleKey: 'manager', locations: [], withPin: true });
    seedUsers.push({ username: 'finance1', name: 'Dewi Kartika', roleKey: 'finance', locations: [] });
    seedUsers.push({ username: 'finance2', name: 'Agus Salim', roleKey: 'finance', locations: [] });
    seedUsers.push({ username: 'hradmin1', name: 'Sri Wahyuni', roleKey: 'hr_admin', locations: [] });
    seedUsers.push({ username: 'hradmin2', name: 'Bayu Pratama', roleKey: 'hr_admin', locations: [] });
    seedUsers.push({ username: 'kepalagudang1', name: 'Joko Susilo', roleKey: 'kepala_gudang', locations: ['GDG'], withPin: true });
    seedUsers.push({ username: 'kepalagudang2', name: 'Eko Prasetyo', roleKey: 'kepala_gudang', locations: ['GDG'] });

    const firstNames = ['Ahmad', 'Budi', 'Citra', 'Dian', 'Eka', 'Fajar', 'Gita', 'Hendra', 'Indah', 'Joni',
      'Kartika', 'Lestari', 'Made', 'Nia', 'Oki', 'Putri', 'Qori', 'Rian', 'Sari', 'Tono',
      'Umi', 'Vino', 'Wati', 'Yanto', 'Zainal', 'Ayu', 'Bagus', 'Cahyo', 'Dewi', 'Ella'];
    const lastNames = ['Saputra', 'Wijaya', 'Kusuma', 'Pratama', 'Santoso', 'Wibowo', 'Hidayat', 'Setiawan',
      'Rahayu', 'Gunawan', 'Nugroho', 'Permadi', 'Suryadi', 'Handayani', 'Firmansyah'];
    function randomName(): string {
      return `${pick(firstNames)} ${pick(lastNames)}`;
    }

    let driverCount = 0;
    for (const code of allLocationCodes) {
      if (code === 'GDG') continue;
      seedUsers.push({ username: `spv_${code.toLowerCase()}`, name: randomName(), roleKey: 'supervisor', locations: [code], withPin: true });
      seedUsers.push({ username: `ldr_${code.toLowerCase()}`, name: randomName(), roleKey: 'leader_outlet', locations: [code] });
      seedUsers.push({ username: `kasir1_${code.toLowerCase()}`, name: randomName(), roleKey: 'kasir', locations: [code] });
      seedUsers.push({ username: `kasir2_${code.toLowerCase()}`, name: randomName(), roleKey: 'kasir', locations: [code] });
    }
    for (let i = 1; i <= 8; i++) {
      seedUsers.push({ username: `driver${i}`, name: randomName(), roleKey: 'driver', locations: ['GDG'] });
      driverCount++;
    }

    const userIdByUsername: Record<string, string> = {};
    for (const u of seedUsers) {
      const res = await client.query(
        `INSERT INTO users (username, email, password_hash, pin_hash, name, role_id)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (username) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [u.username, `${u.username}@mimichicken.local`, passwordHash, u.withPin ? pinHash : null, u.name, roleId[u.roleKey]],
      );
      userIdByUsername[u.username] = res.rows[0].id;
      for (const loc of u.locations) {
        await client.query(
          `INSERT INTO user_locations (user_id, location_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
          [res.rows[0].id, locationId[loc]],
        );
      }
    }
    console.log(`  - users: ${seedUsers.length} across 9 roles (login: <username> / ${DEMO_PASSWORD}, PIN ${DEMO_PIN} where applicable)`);

    // Employees: one per seeded user, plus extra kitchen/general staff to reach ~130
    const positions: Record<string, string> = {
      owner: 'Owner', manager: 'Manager Operasional', finance: 'Staf Keuangan', hr_admin: 'Staf HR',
      kepala_gudang: 'Kepala Gudang', supervisor: 'Supervisor Cabang', leader_outlet: 'Leader Outlet',
      kasir: 'Kasir', driver: 'Driver',
    };
    const employeeIdByUsername: Record<string, string> = {};
    let empSeq = 1;
    async function upsertEmployee(username: string | null, name: string, position: string, locCode: string, userId: string | null, joinDaysAgo: number): Promise<string> {
      const employeeNumber = `EMP${String(empSeq++).padStart(4, '0')}`;
      const res = await client.query(
        `INSERT INTO employees (employee_number, user_id, name, nik, phone, join_date, position, location_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (employee_number) DO NOTHING
         RETURNING id`,
        [employeeNumber, userId, name, `64${rnd(1000000000000, 9999999999999)}`, `08${rnd(100000000, 999999999)}`,
         isoDate(daysAgo(joinDaysAgo)), position, locationId[locCode]],
      );
      let id = res.rows[0]?.id;
      if (!id) {
        id = (await client.query('SELECT id FROM employees WHERE employee_number = $1', [employeeNumber])).rows[0].id;
      }
      if (username) employeeIdByUsername[username] = id;
      // employments (current)
      await client.query(
        `INSERT INTO employments (employee_id, position, location_id, base_salary, start_date)
         SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS (SELECT 1 FROM employments WHERE employee_id = $1)`,
        [id, position, locationId[locCode], baseSalaryFor(position), isoDate(daysAgo(joinDaysAgo))],
      );
      return id;
    }
    function baseSalaryFor(position: string): number {
      if (position === 'Owner') return 15000000;
      if (position.includes('Manager')) return 9000000;
      if (position.includes('Kepala Gudang')) return 7000000;
      if (position.includes('Supervisor')) return 5500000;
      if (position.includes('Keuangan') || position.includes('HR')) return 6000000;
      if (position.includes('Driver')) return 3800000;
      if (position.includes('Leader')) return 4200000;
      return 3300000; // kasir / general staff
    }

    for (const u of seedUsers) {
      const homeLoc = u.locations[0] ?? 'GDG';
      await upsertEmployee(u.username, u.name, positions[u.roleKey], homeLoc, userIdByUsername[u.username], rnd(60, 1500));
    }
    // Extra staff without logins (kitchen crew, cleaning, general labour) to reach ~130 employees
    const extraPositions = ['Juru Masak', 'Asisten Dapur', 'Cleaning Service', 'Staf Gudang', 'Admin Gudang'];
    const targetTotal = 130;
    let currentTotal = seedUsers.length;
    let extraIdx = 0;
    while (currentTotal < targetTotal) {
      const locCode = pick(allLocationCodes);
      await upsertEmployee(null, randomName(), pick(extraPositions), locCode, null, rnd(30, 900));
      currentTotal++;
      extraIdx++;
    }
    console.log(`  - employees: ${currentTotal} total (${seedUsers.length} with login, ${extraIdx} staff-only)`);

    // Drivers table + vehicles
    const driverRowId: Record<string, string> = {};
    for (let i = 1; i <= driverCount; i++) {
      const username = `driver${i}`;
      const res = await client.query(
        `INSERT INTO drivers (employee_id, user_id, name, phone, license_number)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [employeeIdByUsername[username], userIdByUsername[username], seedUsers.find(u => u.username === username)!.name,
         `08${rnd(100000000, 999999999)}`, `SIM${rnd(100000, 999999)}`],
      );
      driverRowId[username] = res.rows[0].id;
    }
    const vehiclePlates = ['KT 1001 AB', 'KT 1002 AC', 'KT 1003 AD', 'KT 1004 AE', 'KT 1005 AF',
      'KT 1006 AG', 'KT 1007 AH', 'KT 1008 AI', 'KT 1009 AJ', 'KT 1010 AK'];
    const vehicleId: Record<string, string> = {};
    for (let i = 0; i < vehiclePlates.length; i++) {
      const hasFreezer = i < 3;
      const res = await client.query(
        `INSERT INTO vehicles (plate_number, type, brand, model, has_freezer)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (plate_number) DO NOTHING
         RETURNING id`,
        [vehiclePlates[i], hasFreezer ? 'truck' : 'van', pick(['Mitsubishi', 'Isuzu', 'Toyota']), pick(['Colt Diesel', 'Elf', 'HiAce']), hasFreezer],
      );
      vehicleId[vehiclePlates[i]] = res.rows[0]?.id ??
        (await client.query('SELECT id FROM vehicles WHERE plate_number=$1', [vehiclePlates[i]])).rows[0].id;
    }
    console.log(`  - drivers (${driverCount}) + vehicles (${vehiclePlates.length})`);

    // =========================================================================
    // ITEM CATEGORIES, UNITS, ITEMS
    // =========================================================================
    const categoryNames = ['Ayam Mentah', 'Bumbu', 'Sembako', 'Kemasan', 'Minuman', 'Daging Olahan'];
    const categoryId: Record<string, string> = {};
    for (const name of categoryNames) {
      const res = await client.query(
        `INSERT INTO item_categories (name) VALUES ($1) ON CONFLICT (name) DO NOTHING RETURNING id`,
        [name],
      );
      categoryId[name] = res.rows[0]?.id ?? (await client.query('SELECT id FROM item_categories WHERE name=$1', [name])).rows[0].id;
    }

    const unitDefs: [string, string][] = [
      ['kg', 'Kilogram'], ['gr', 'Gram'], ['ltr', 'Liter'], ['ml', 'Mililiter'],
      ['pcs', 'Pieces'], ['box', 'Box'], ['pack', 'Pack'], ['ekor', 'Ekor'],
    ];
    const unitId: Record<string, string> = {};
    for (const [code, name] of unitDefs) {
      const res = await client.query(
        `INSERT INTO units (code, name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING RETURNING id`,
        [code, name],
      );
      unitId[code] = res.rows[0]?.id ?? (await client.query('SELECT id FROM units WHERE code=$1', [code])).rows[0].id;
    }
    console.log(`  - item categories (${categoryNames.length}) + units (${unitDefs.length})`);

    interface ItemDef { sku: string; name: string; category: string; unit: string; storageType: string; avgCost: number; }
    const itemDefs: ItemDef[] = [];
    let skuSeq = 1;
    function addItem(name: string, category: string, unit: string, storageType: string, avgCost: number) {
      itemDefs.push({ sku: `SKU${String(skuSeq++).padStart(4, '0')}`, name, category, unit, storageType, avgCost });
    }
    // Ayam Mentah
    ['Ayam Potong Utuh', 'Ayam Fillet Dada', 'Ayam Paha Atas', 'Ayam Paha Bawah', 'Ayam Sayap',
     'Ayam Fillet Berbumbu Original', 'Ayam Fillet Berbumbu Pedas', 'Ayam Wing Berbumbu', 'Ayam Drumstick Berbumbu',
     'Ayam Karkas', 'Ayam Fillet Berbumbu Extra Crispy', 'Ayam Paha Berbumbu Madu', 'Ayam Potong Kampung',
     'Ayam Fillet Tanpa Tulang', 'Ayam Giling'].forEach((n) => addItem(n, 'Ayam Mentah', 'kg', 'frozen', rnd(28000, 42000)));
    // Bumbu
    ['Tepung Bumbu Original', 'Tepung Bumbu Pedas', 'Tepung Terigu Protein Tinggi', 'Tepung Maizena',
     'Tepung Panir', 'Bumbu Marinasi Ayam', 'Bumbu Rendang Instan', 'Sambal Bawang', 'Sambal Terasi',
     'Sambal Matah', 'Saus Sambal Botol', 'Saus Tomat Botol', 'Bawang Putih Bubuk', 'Bawang Merah Bubuk',
     'Merica Bubuk', 'Ketumbar Bubuk', 'Kunyit Bubuk', 'Kaldu Ayam Bubuk', 'Penyedap Rasa', 'Garam Halus'
    ].forEach((n) => addItem(n, 'Bumbu', pick(['kg', 'pack']), 'dry', rnd(8000, 35000)));
    // Sembako
    ['Beras Premium', 'Beras Medium', 'Minyak Goreng Kemasan', 'Minyak Goreng Curah', 'Gula Pasir',
     'Garam Dapur', 'Telur Ayam', 'Margarin', 'Mentega', 'Susu Kental Manis', 'Kecap Manis', 'Kecap Asin',
     'Mi Instan', 'Bihun', 'Kentang', 'Wortel', 'Kol', 'Tomat', 'Timun', 'Bawang Bombay'
    ].forEach((n) => addItem(n, 'Sembako', pick(['kg', 'ltr', 'pcs']), 'dry', rnd(6000, 25000)));
    // Kemasan
    ['Box Nasi Kecil', 'Box Nasi Sedang', 'Box Nasi Besar', 'Kantong Plastik Kecil', 'Kantong Plastik Besar',
     'Kertas Nasi', 'Cup Sambal', 'Cup Saus', 'Sendok Plastik', 'Garpu Plastik', 'Tisu Makan', 'Sedotan',
     'Cup Minuman 12oz', 'Cup Minuman 16oz', 'Tutup Cup Minuman', 'Kresek Bawa Pulang', 'Sticker Segel Box',
     'Paper Bag', 'Label Harga', 'Plastik Wrap'
    ].forEach((n) => addItem(n, 'Kemasan', pick(['pcs', 'pack', 'box']), 'dry', rnd(300, 3500)));
    // Minuman
    ['Teh Celup', 'Kopi Bubuk', 'Sirup Cocopandan', 'Sirup Jeruk', 'Sirup Leci', 'Air Mineral Galon',
     'Air Mineral Botol', 'Es Batu Kristal', 'Bubuk Lemon Tea', 'Susu UHT', 'Nata De Coco', 'Selasih'
    ].forEach((n) => addItem(n, 'Minuman', pick(['pack', 'ltr', 'pcs']), 'dry', rnd(4000, 30000)));
    // Daging Olahan
    ['Sosis Ayam', 'Nugget Ayam', 'Bakso Ayam', 'Kornet Ayam'].forEach((n) => addItem(n, 'Daging Olahan', 'kg', 'frozen', rnd(30000, 55000)));

    const itemId: Record<string, string> = {};
    for (const d of itemDefs) {
      const res = await client.query(
        `INSERT INTO items (sku, name, category_id, base_unit_id, storage_type, is_sellable, avg_cost, last_purchase_cost)
         VALUES ($1,$2,$3,$4,$5,false,$6,$6)
         ON CONFLICT (sku) DO NOTHING RETURNING id`,
        [d.sku, d.name, categoryId[d.category], unitId[d.unit], d.storageType, d.avgCost],
      );
      itemId[d.name] = res.rows[0]?.id ?? (await client.query('SELECT id FROM items WHERE sku=$1', [d.sku])).rows[0].id;
    }
    console.log(`  - items: ${itemDefs.length}`);

    // generic unit conversions
    const genericConversions: [string, string, number][] = [['kg', 'gr', 1000], ['ltr', 'ml', 1000], ['box', 'pcs', 50], ['pack', 'pcs', 12]];
    for (const [from, to, factor] of genericConversions) {
      await client.query(
        `INSERT INTO unit_conversions (item_id, from_unit_id, to_unit_id, factor)
         VALUES (NULL,$1,$2,$3) ON CONFLICT (item_id, from_unit_id, to_unit_id) DO NOTHING`,
        [unitId[from], unitId[to], factor],
      );
    }

    // =========================================================================
    // PRODUCTS (menu) + RECIPES
    // =========================================================================
    interface ProductDef { code: string; name: string; category: string; price: number; ingredients: string[]; }
    const productDefs: ProductDef[] = [];
    let prodSeq = 1;
    function addProduct(name: string, category: string, price: number, ingredients: string[]) {
      productDefs.push({ code: `PRD${String(prodSeq++).padStart(3, '0')}`, name, category, price, ingredients });
    }
    const fillet = 'Ayam Fillet Berbumbu Original';
    addProduct('Ayam Goreng Original 1pc', 'Ayam', 12000, ['Ayam Potong Utuh', 'Tepung Bumbu Original', 'Minyak Goreng Kemasan']);
    addProduct('Ayam Goreng Pedas 1pc', 'Ayam', 13000, ['Ayam Potong Utuh', 'Tepung Bumbu Pedas', 'Minyak Goreng Kemasan']);
    addProduct('Ayam Geprek Original', 'Ayam', 15000, [fillet, 'Sambal Bawang', 'Minyak Goreng Kemasan']);
    addProduct('Ayam Geprek Keju', 'Ayam', 18000, [fillet, 'Sambal Bawang', 'Mentega']);
    addProduct('Ayam Crispy Extra', 'Ayam', 16000, ['Ayam Fillet Berbumbu Extra Crispy', 'Tepung Panir', 'Minyak Goreng Kemasan']);
    addProduct('Wing Crispy', 'Ayam', 10000, ['Ayam Wing Berbumbu', 'Tepung Bumbu Original', 'Minyak Goreng Kemasan']);
    addProduct('Drumstick Madu', 'Ayam', 14000, ['Ayam Paha Berbumbu Madu', 'Minyak Goreng Kemasan']);
    addProduct('Paket Nasi + Ayam Original', 'Paket', 20000, ['Beras Premium', 'Ayam Potong Utuh', 'Tepung Bumbu Original', 'Box Nasi Sedang']);
    addProduct('Paket Nasi + Ayam Geprek', 'Paket', 23000, ['Beras Premium', fillet, 'Sambal Bawang', 'Box Nasi Sedang']);
    addProduct('Paket Hemat Berdua', 'Paket', 38000, ['Beras Premium', 'Ayam Potong Utuh', 'Tepung Bumbu Original', 'Box Nasi Besar']);
    addProduct('Paket Nasi + Wing', 'Paket', 19000, ['Beras Premium', 'Ayam Wing Berbumbu', 'Box Nasi Sedang']);
    addProduct('Paket Keluarga (4 potong)', 'Paket', 65000, ['Ayam Potong Utuh', 'Tepung Bumbu Original', 'Beras Premium', 'Box Nasi Besar']);
    addProduct('Nasi Putih', 'Tambahan', 6000, ['Beras Premium', 'Box Nasi Kecil']);
    addProduct('Sambal Bawang Cup', 'Tambahan', 3000, ['Sambal Bawang', 'Cup Sambal']);
    addProduct('Sambal Terasi Cup', 'Tambahan', 3000, ['Sambal Terasi', 'Cup Sambal']);
    addProduct('Sambal Matah Cup', 'Tambahan', 3500, ['Sambal Matah', 'Cup Sambal']);
    addProduct('Kentang Goreng', 'Tambahan', 12000, ['Kentang', 'Minyak Goreng Kemasan']);
    addProduct('Kol Segar', 'Tambahan', 3000, ['Kol']);
    addProduct('Kerupuk', 'Tambahan', 3000, ['Tepung Terigu Protein Tinggi']);
    addProduct('Nugget Ayam (5pc)', 'Tambahan', 10000, ['Nugget Ayam', 'Minyak Goreng Kemasan']);
    addProduct('Sosis Bakar (3pc)', 'Tambahan', 9000, ['Sosis Ayam']);
    addProduct('Bakso Goreng (5pc)', 'Tambahan', 9000, ['Bakso Ayam', 'Minyak Goreng Kemasan']);
    addProduct('Es Teh Manis', 'Minuman', 5000, ['Teh Celup', 'Gula Pasir', 'Es Batu Kristal', 'Cup Minuman 12oz']);
    addProduct('Es Jeruk', 'Minuman', 6000, ['Sirup Jeruk', 'Es Batu Kristal', 'Cup Minuman 12oz']);
    addProduct('Es Cocopandan', 'Minuman', 6000, ['Sirup Cocopandan', 'Nata De Coco', 'Es Batu Kristal', 'Cup Minuman 16oz']);
    addProduct('Es Leci', 'Minuman', 7000, ['Sirup Leci', 'Selasih', 'Es Batu Kristal', 'Cup Minuman 16oz']);
    addProduct('Es Lemon Tea', 'Minuman', 7000, ['Bubuk Lemon Tea', 'Es Batu Kristal', 'Cup Minuman 16oz']);
    addProduct('Kopi Susu Dingin', 'Minuman', 9000, ['Kopi Bubuk', 'Susu Kental Manis', 'Es Batu Kristal', 'Cup Minuman 16oz']);
    addProduct('Air Mineral Botol', 'Minuman', 4000, ['Air Mineral Botol']);
    addProduct('Teh Kotak', 'Minuman', 5000, ['Teh Celup']);
    addProduct('Susu Kotak', 'Minuman', 6000, ['Susu UHT']);
    addProduct('Ayam Goreng Original 2pc', 'Ayam', 22000, ['Ayam Potong Utuh', 'Tepung Bumbu Original', 'Minyak Goreng Kemasan']);
    addProduct('Ayam Goreng Pedas 2pc', 'Ayam', 24000, ['Ayam Potong Utuh', 'Tepung Bumbu Pedas', 'Minyak Goreng Kemasan']);
    addProduct('Ayam Geprek Sambal Matah', 'Ayam', 17000, [fillet, 'Sambal Matah', 'Minyak Goreng Kemasan']);
    addProduct('Paha Atas Crispy', 'Ayam', 13000, ['Ayam Paha Atas', 'Tepung Bumbu Original', 'Minyak Goreng Kemasan']);
    addProduct('Paha Bawah Crispy', 'Ayam', 11000, ['Ayam Paha Bawah', 'Tepung Bumbu Original', 'Minyak Goreng Kemasan']);
    addProduct('Dada Crispy', 'Ayam', 14000, ['Ayam Fillet Dada', 'Tepung Bumbu Original', 'Minyak Goreng Kemasan']);
    addProduct('Paket Ulang Tahun (8 potong)', 'Paket', 130000, ['Ayam Potong Utuh', 'Tepung Bumbu Original', 'Beras Premium', 'Box Nasi Besar']);
    addProduct('Rice Bowl Geprek', 'Paket', 21000, ['Beras Premium', fillet, 'Sambal Bawang', 'Box Nasi Kecil']);

    const productId: Record<string, string> = {};
    for (const p of productDefs) {
      const res = await client.query(
        `INSERT INTO products (code, name, category, price, sort_order)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (code) DO NOTHING RETURNING id`,
        [p.code, p.name, p.category, p.price, 0],
      );
      productId[p.name] = res.rows[0]?.id ?? (await client.query('SELECT id FROM products WHERE code=$1', [p.code])).rows[0].id;
    }
    for (const p of productDefs) {
      const recipeRes = await client.query(
        `INSERT INTO recipes (product_id, yield_qty) VALUES ($1, 1)
         ON CONFLICT (product_id) DO NOTHING RETURNING id`,
        [productId[p.name]],
      );
      const recipeId = recipeRes.rows[0]?.id ?? (await client.query('SELECT id FROM recipes WHERE product_id=$1', [productId[p.name]])).rows[0].id;
      for (const ing of p.ingredients) {
        const iid = itemId[ing];
        if (!iid) continue;
        await client.query(
          `INSERT INTO recipe_lines (recipe_id, item_id, qty, unit_id)
           VALUES ($1,$2,$3,$4) ON CONFLICT (recipe_id, item_id) DO NOTHING`,
          [recipeId, iid, (Math.round(rnd(5, 30) * 10) / 100).toFixed(3), unitId['kg']],
        );
      }
    }
    console.log(`  - products: ${productDefs.length} with recipes`);

    // =========================================================================
    // SUPPLIERS + SUPPLIER_ITEMS + PRICE HISTORY
    // =========================================================================
    const supplierDefs = [
      'CV Ayam Segar Kaltim', 'PT Sumber Protein Nusantara', 'UD Bumbu Rasa Kalimantan', 'CV Kemasan Jaya Abadi',
      'PT Sembako Borneo Makmur', 'Toko Minyak Goreng Sejahtera', 'CV Beras Kalimantan Timur', 'UD Sayur Segar Balikpapan',
      'PT Distribusi Minuman Kaltim', 'CV Bumbu Dapur Nusantara', 'Toko Grosir Sembako Samarinda', 'PT Kemasan Plastik Prima',
      'UD Ayam Potong Berkah', 'CV Rempah Kalimantan', 'PT Cold Chain Logistik Borneo',
    ];
    const supplierId: Record<string, string> = {};
    for (let i = 0; i < supplierDefs.length; i++) {
      const code = `SUP${String(i + 1).padStart(3, '0')}`;
      const outletVisible = i < 5; // a handful visible to outlet staff for petty-cash "nama toko"
      const res = await client.query(
        `INSERT INTO suppliers (code, name, contact_name, phone, email, address, payment_terms_days, bank_name, bank_account, bank_account_name, outlet_visible)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (code) DO NOTHING RETURNING id`,
        [code, supplierDefs[i], randomName(), `08${rnd(100000000, 999999999)}`, `${code.toLowerCase()}@supplier.local`,
         `Jl. Industri No. ${rnd(1, 99)}, Balikpapan`, pick([0, 7, 14, 30]), pick(['BCA', 'Mandiri', 'BNI', 'BRI']),
         `${rnd(1000000000, 9999999999)}`, supplierDefs[i], outletVisible],
      );
      supplierId[supplierDefs[i]] = res.rows[0]?.id ?? (await client.query('SELECT id FROM suppliers WHERE code=$1', [code])).rows[0].id;
    }
    // link a spread of items to suppliers
    const itemNames = Object.keys(itemId);
    let supIdx = 0;
    for (const itemName of itemNames) {
      if (rnd(0, 100) > 60) continue; // not every item has a designated supplier in seed data
      const supName = supplierDefs[supIdx % supplierDefs.length];
      supIdx++;
      const price = itemDefs.find((d) => d.name === itemName)!.avgCost * (0.85 + Math.random() * 0.2);
      await client.query(
        `INSERT INTO supplier_items (supplier_id, item_id, current_price, lead_time_days, is_preferred)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (supplier_id, item_id) DO NOTHING`,
        [supplierId[supName], itemId[itemName], price.toFixed(2), rnd(1, 5), true],
      );
      for (let h = 0; h < 3; h++) {
        await client.query(
          `INSERT INTO supplier_price_history (supplier_id, item_id, price, effective_date, source)
           VALUES ($1,$2,$3,$4,'manual')`,
          [supplierId[supName], itemId[itemName], (price * (0.92 + h * 0.04)).toFixed(2), isoDate(daysAgo(90 - h * 30))],
        );
      }
    }
    console.log(`  - suppliers: ${supplierDefs.length} with items + price history`);

    // =========================================================================
    // MIN STOCK RULES + STOCK BALANCES + OPENING MOVEMENTS
    // =========================================================================
    const coreItems = itemNames.slice(0, 30); // keep the stock-seeding volume tractable
    for (const code of allLocationCodes) {
      const areas = storageAreaId[code];
      for (const itemName of coreItems) {
        const def = itemDefs.find((d) => d.name === itemName)!;
        await client.query(
          `INSERT INTO min_stock_rules (location_id, item_id, min_qty, reorder_qty)
           VALUES ($1,$2,$3,$4) ON CONFLICT (location_id, item_id) DO NOTHING`,
          [locationId[code], itemId[itemName], rnd(10, 50), rnd(50, 150)],
        );
        const areaType = def.storageType === 'frozen' ? 'freezer' : def.storageType === 'chilled' ? 'chiller' : 'dry_store';
        const areaId = areas[areaType] ?? areas['dry_store'];
        if (!areaId) continue;
        // Idempotency: only seed the opening balance + its movement ONCE per
        // (location, area, item) — re-running must not re-post opening_balance
        // movements or the ledger invariant (balance === sum of movements) breaks.
        const already = await client.query(
          `SELECT 1 FROM stock_balances WHERE location_id=$1 AND storage_area_id=$2 AND item_id=$3`,
          [locationId[code], areaId, itemId[itemName]],
        );
        if (already.rows.length > 0) continue;
        const openingQty = rnd(20, 200);
        await client.query(
          `INSERT INTO stock_balances (location_id, storage_area_id, item_id, qty_on_hand)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (location_id, storage_area_id, item_id) DO NOTHING`,
          [locationId[code], areaId, itemId[itemName], openingQty],
        );
        await client.query(
          `INSERT INTO stock_movements (location_id, storage_area_id, item_id, movement_type, qty, unit_cost, ref_type, occurred_at)
           VALUES ($1,$2,$3,'opening_balance',$4,$5,'seed',$6)`,
          [locationId[code], areaId, itemId[itemName], openingQty, def.avgCost, daysAgo(60)],
        );
      }
    }
    console.log(`  - min-stock rules + opening stock balances for ${coreItems.length} core items across all locations`);

    // =========================================================================
    // POS: SHIFTS + SALES (last 7 days, a handful of outlets)
    // =========================================================================
    const demoOutlets = allLocationCodes.filter((c) => c !== 'GDG').slice(0, 6);
    const productNames = Object.keys(productId);
    for (const code of demoOutlets) {
      const kasirUsername = `kasir1_${code.toLowerCase()}`;
      const kasirId = userIdByUsername[kasirUsername];
      for (let day = 6; day >= 0; day--) {
        const openedAt = daysAgo(day);
        openedAt.setHours(8, 0, 0, 0);
        const closedAt = new Date(openedAt);
        closedAt.setHours(20, 0, 0, 0);
        const isToday = day === 0;
        const clientId = stableUuid(`${code}-shift-${isoDate(openedAt)}`);
        const shiftRes = await client.query(
          `INSERT INTO pos_shifts (shift_number, location_id, opened_by, opened_at, opening_cash, closed_by, closed_at,
             closing_cash_counted, expected_cash, cash_variance, status, sales_count, gross_sales, client_id)
           VALUES ($1,$2,$3,$4,300000,$5,$6,$7,$7,0,$8,0,0,$9)
           ON CONFLICT (client_id) DO NOTHING RETURNING id`,
          [`${code}-POS1-S${day === 6 ? 1 : 100 - day}`, locationId[code], kasirId, openedAt,
           isToday ? null : kasirId, isToday ? null : closedAt, isToday ? null : rnd(800000, 2500000),
           isToday ? 'open' : 'closed', clientId],
        );
        const shiftId = shiftRes.rows[0]?.id ?? (await client.query('SELECT id FROM pos_shifts WHERE client_id=$1', [clientId])).rows[0].id;
        // Deterministic (not rnd()): sales are inserted per-index with their own
        // idempotency key, so a random count here would grow on every re-run
        // as later runs roll a bigger number and add the missing indices.
        const salesToday = 6 + ((code.charCodeAt(code.length - 1) + day * 7) % 9);
        let grossTotal = 0;
        for (let s = 0; s < salesToday; s++) {
          const saleClientId = stableUuid(`${code}-sale-${isoDate(openedAt)}-${s}`);
          const lineCount = rnd(1, 4);
          let subtotal = 0;
          const lines: { product: string; qty: number; price: number }[] = [];
          for (let l = 0; l < lineCount; l++) {
            const pname = pick(productNames);
            const qty = rnd(1, 3);
            const price = productDefs.find((p) => p.name === pname)!.price;
            subtotal += price * qty;
            lines.push({ product: pname, qty, price });
          }
          const total = subtotal;
          grossTotal += total;
          const occurredAt = new Date(openedAt);
          occurredAt.setHours(rnd(8, 19), rnd(0, 59), 0, 0);
          const saleRes = await client.query(
            `INSERT INTO sales (receipt_number, client_id, location_id, shift_id, kasir_id, status, subtotal, discount, total, paid_amount, change_amount, occurred_at)
             VALUES ($1,$2,$3,$4,$5,'completed',$6,0,$6,$6,0,$7)
             ON CONFLICT (client_id) DO NOTHING RETURNING id`,
            [`${code}-${isoDate(openedAt).replace(/-/g, '')}-${String(s + 1).padStart(3, '0')}`, saleClientId,
             locationId[code], shiftId, kasirId, total, occurredAt],
          );
          const saleId = saleRes.rows[0]?.id;
          if (!saleId) continue;
          for (const line of lines) {
            await client.query(
              `INSERT INTO sale_lines (sale_id, product_id, qty, unit_price, discount, line_total)
               VALUES ($1,$2,$3,$4,0,$5)`,
              [saleId, productId[line.product], line.qty, line.price, line.price * line.qty],
            );
          }
          const method = pick(['cash', 'cash', 'qris', 'bank_transfer']);
          await client.query(
            `INSERT INTO sale_payments (sale_id, method, amount, payment_status)
             VALUES ($1,$2,$3,$4)`,
            [saleId, method, total, method === 'cash' ? 'paid' : method === 'qris' ? 'verified' : 'pending'],
          );
        }
        if (!isToday) {
          await client.query(
            `UPDATE pos_shifts SET sales_count=$1, gross_sales=$2, expected_cash = 300000::numeric + $2::numeric WHERE id=$3`,
            [salesToday, grossTotal, shiftId],
          );
        }
      }
    }
    console.log(`  - POS shifts + sales seeded for ${demoOutlets.length} outlets over 7 days`);

    // One cash-variance proposal (Amendment 2) on a closed shift with a shortfall
    {
      const code = demoOutlets[0];
      const shift = await client.query(
        `SELECT id, location_id, opened_by, expected_cash FROM pos_shifts WHERE location_id=$1 AND status='closed' ORDER BY closed_at DESC LIMIT 1`,
        [locationId[code]],
      );
      if (shift.rows[0]) {
        const s = shift.rows[0];
        const shortfall = 25000;
        await client.query(
          `UPDATE pos_shifts SET cash_variance = -($1::numeric) WHERE id=$2`,
          [shortfall, s.id],
        );
        await client.query(
          `INSERT INTO cash_variance_proposals (shift_id, location_id, kasir_user_id, amount, status)
           VALUES ($1,$2,$3,$4,'pending') ON CONFLICT (shift_id) DO NOTHING`,
          [s.id, s.location_id, s.opened_by, shortfall],
        );
      }
    }

    // =========================================================================
    // REPLENISHMENT REQUESTS — a spread of states
    // =========================================================================
    const rrStates = ['draft', 'submitted', 'awaiting_approval', 'approved', 'processing', 'shipped', 'received', 'completed', 'rejected'];
    for (const state of rrStates) {
      const code = pick(demoOutlets);
      const clientId = stableUuid(`rr-seed-${state}`);
      const requestedBy = userIdByUsername[`ldr_${code.toLowerCase()}`];
      // Allocate only when this row doesn't already exist — client_id is the
      // real idempotency key; skipping the allocation on a rerun avoids
      // burning document_counters numbers that will never be used.
      const already = await client.query('SELECT 1 FROM replenishment_requests WHERE client_id = $1', [clientId]);
      if (already.rows.length > 0) continue;
      const requestNumber = await nextDocNumber(client, 'RR');
      const res = await client.query(
        `INSERT INTO replenishment_requests (request_number, location_id, status, requested_by, submitted_at, needed_by, client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (client_id) DO NOTHING RETURNING id`,
        [requestNumber, locationId[code], state, requestedBy,
         state === 'draft' ? null : daysAgo(rnd(1, 10)), isoDate(daysAgo(-3)), clientId],
      );
      const rrId = res.rows[0]?.id;
      if (!rrId) continue;
      for (const itemName of coreItems.slice(0, 4)) {
        await client.query(
          `INSERT INTO replenishment_request_lines (request_id, item_id, unit_id, qty_requested)
           VALUES ($1,$2,$3,$4) ON CONFLICT (request_id, item_id) DO NOTHING`,
          [rrId, itemId[itemName], unitId['kg'], rnd(10, 40)],
        );
      }
      if (state === 'rejected') {
        await client.query(`UPDATE replenishment_requests SET rejection_reason=$1 WHERE id=$2`, ['Stok gudang tidak mencukupi minggu ini', rrId]);
      }
    }
    console.log(`  - replenishment requests across ${rrStates.length} states`);

    // =========================================================================
    // ONE IN-FLIGHT SURAT JALAN WITH DROPS
    // =========================================================================
    {
      const sjOutlets = demoOutlets.slice(0, 3);
      const driverUsername = 'driver1';
      // surat_jalan is a cloud-only, class-B document with no client_id
      // column of its own, so idempotency is checked via a dedicated marker
      // in `notes` — deliberately NOT the document number, which must be
      // free to come from a fresh allocate_document_number() call every
      // time this block actually runs, never from a hardcoded literal.
      const sjMarker = 'seed-demo-sj-0001';
      const existingSj = await client.query('SELECT id FROM surat_jalan WHERE notes = $1', [sjMarker]);
      let sjId: string;
      let isNewSj = false;
      if (existingSj.rows.length > 0) {
        sjId = existingSj.rows[0].id;
      } else {
        const sjNumber = await nextDocNumber(client, 'SJ');
        const sjRes = await client.query(
          `INSERT INTO surat_jalan (sj_number, origin_location_id, shipment_type_id, driver_id, vehicle_id, status, planned_date, dispatched_at, created_by, notes)
           SELECT $1, $2, st.id, $3, $4, 'in_transit', $5, $6, $7, $8
           FROM shipment_types st WHERE st.key='dry'
           RETURNING id`,
          [sjNumber, locationId['GDG'], driverRowId[driverUsername], Object.values(vehicleId)[3],
           isoDate(daysAgo(0)), daysAgo(0), userIdByUsername['kepalagudang1'], sjMarker],
        );
        sjId = sjRes.rows[0].id;
        isNewSj = true;
      }

      for (let i = 0; i < sjOutlets.length; i++) {
        const code = sjOutlets[i];
        const status = i === 0 ? 'completed' : i === 1 ? 'arrived' : 'en_route';
        const dropClientId = stableUuid(`sj0001-drop-${i}`);
        const dropRes = await client.query(
          `INSERT INTO sj_drops (sj_id, drop_seq, location_id, status, departed_at, arrived_at, received_by, received_at, client_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (client_id) DO NOTHING RETURNING id`,
          [sjId, i + 1, locationId[code], status, daysAgo(0),
           status !== 'en_route' ? daysAgo(0) : null,
           status === 'completed' ? userIdByUsername[`spv_${code.toLowerCase()}`] : null,
           status === 'completed' ? daysAgo(0) : null, dropClientId],
        );
        const dropId = dropRes.rows[0]?.id ?? (await client.query('SELECT id FROM sj_drops WHERE client_id=$1', [dropClientId])).rows[0].id;
        for (const itemName of coreItems.slice(0, 3)) {
          const qty = rnd(20, 60);
          await client.query(
            `INSERT INTO sj_lines (sj_id, drop_id, item_id, unit_id, qty, qty_received, received_storage_area_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (drop_id, item_id) DO NOTHING`,
            [sjId, dropId, itemId[itemName], unitId['kg'], qty, status === 'completed' ? qty : null,
             status === 'completed' ? storageAreaId[code]['dry_store'] : null],
          );
        }
      }
      // sj_temperature_logs / sj_seals have no natural conflict key (append-only
      // logs) — only seed them the first time this SJ is created, or a re-run
      // would pile up duplicate load-stage readings/seals indefinitely.
      if (isNewSj) {
        await client.query(
          `INSERT INTO sj_temperature_logs (sj_id, stage, temp_c, logged_by) VALUES ($1,'load',4.0,$2)`,
          [sjId, userIdByUsername['kepalagudang1']],
        );
        await client.query(
          `INSERT INTO sj_seals (sj_id, seal_number, status, checked_by) VALUES ($1,$2,'applied',$3)`,
          [sjId, `SEAL-${rnd(10000, 99999)}`, userIdByUsername['kepalagudang1']],
        );
      }
      console.log('  - one in-flight Surat Jalan with 3 drops (completed / arrived / en_route)');
    }

    // =========================================================================
    // ATTENDANCE — last 5 workdays for a sample of employees
    // =========================================================================
    let attCount = 0;
    for (const code of demoOutlets) {
      for (const roleUser of [`spv_${code.toLowerCase()}`, `kasir1_${code.toLowerCase()}`, `kasir2_${code.toLowerCase()}`]) {
        const empId = employeeIdByUsername[roleUser];
        if (!empId) continue;
        const [lat, lng] = cityCoords[Object.keys(cityDistricts).find((c) => outletCodesByCity[c].includes(code))!];
        for (let day = 4; day >= 0; day--) {
          const date = daysAgo(day);
          const checkIn = new Date(date);
          checkIn.setHours(7, rnd(45, 59), 0, 0);
          const checkOut = new Date(date);
          checkOut.setHours(20, rnd(0, 15), 0, 0);
          const late = rnd(0, 100) > 80 ? rnd(1, 20) : 0;
          await client.query(
            `INSERT INTO attendance (employee_id, location_id, date, check_in_at, check_in_lat, check_in_lng,
               check_in_distance_m, check_out_at, check_out_lat, check_out_lng, check_out_distance_m,
               status, late_minutes, work_minutes, geofence_ok)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$5,$6,$7,$9,$10,$11,true)
             ON CONFLICT (employee_id, date) DO NOTHING`,
            [empId, locationId[code], isoDate(date), checkIn, lat, lng, rnd(5, 60), checkOut,
             late > 0 ? 'late' : 'present', late, 720 - late],
          );
          attCount++;
        }
      }
    }
    console.log(`  - attendance rows: ${attCount}`);

    // A couple of leave requests
    await client.query(
      `INSERT INTO leave_requests (employee_id, type, start_date, end_date, days, reason, status)
       SELECT $1,'annual',$2,$3,2,'Acara keluarga','approved'
       WHERE NOT EXISTS (SELECT 1 FROM leave_requests WHERE employee_id=$1 AND start_date=$2)`,
      [employeeIdByUsername['kasir1_' + demoOutlets[0].toLowerCase()], isoDate(daysAgo(-10)), isoDate(daysAgo(-9))],
    );
    await client.query(
      `INSERT INTO leave_requests (employee_id, type, start_date, end_date, days, reason, status)
       SELECT $1,'sick',$2,$2,1,'Demam','pending'
       WHERE NOT EXISTS (SELECT 1 FROM leave_requests WHERE employee_id=$1 AND start_date=$2)`,
      [employeeIdByUsername['kasir2_' + demoOutlets[1].toLowerCase()], isoDate(daysAgo(1))],
    );

    // A kasbon (employee loan)
    {
      const empId = employeeIdByUsername['kasir1_' + demoOutlets[0].toLowerCase()];
      await client.query(
        `INSERT INTO employee_loans (loan_number, employee_id, principal, monthly_installment, outstanding, status, reason, disbursed_at)
         VALUES ('LOAN/202608/0001',$1,3000000,500000,2500000,'active','Kebutuhan mendesak keluarga',$2)
         ON CONFLICT (loan_number) DO NOTHING`,
        [empId, daysAgo(30)],
      );
    }

    // =========================================================================
    // PAYROLL — one period + one calculated run with base_salary lines
    // =========================================================================
    const periodCode = '2026-08';
    const periodRes = await client.query(
      `INSERT INTO payroll_periods (period_code, start_date, end_date, status)
       VALUES ($1,'2026-08-01','2026-08-31','processing')
       ON CONFLICT (period_code) DO NOTHING RETURNING id`,
      [periodCode],
    );
    const periodId = periodRes.rows[0]?.id ?? (await client.query('SELECT id FROM payroll_periods WHERE period_code=$1', [periodCode])).rows[0].id;
    // (period_id, run_seq) is the real natural key (UNIQUE per schema) —
    // check it before allocating, so a rerun never burns a fresh run_number
    // it will just throw away.
    const existingRun = await client.query('SELECT id FROM payroll_runs WHERE period_id = $1 AND run_seq = 1', [periodId]);
    let runId: string;
    if (existingRun.rows.length > 0) {
      runId = existingRun.rows[0].id;
    } else {
      const runNumber = await nextDocNumber(client, 'PRUN');
      const runRes = await client.query(
        `INSERT INTO payroll_runs (period_id, run_seq, run_number, status, statutory_mode, calculated_by, calculated_at)
         VALUES ($1,1,$2,'calculated',false,$3,NOW())
         ON CONFLICT (period_id, run_seq) DO NOTHING RETURNING id`,
        [periodId, runNumber, userIdByUsername['hradmin1']],
      );
      runId = runRes.rows[0]?.id ?? (await client.query('SELECT id FROM payroll_runs WHERE period_id = $1 AND run_seq = 1', [periodId])).rows[0].id;
    }
    const baseSalaryComponent = (await client.query(`SELECT id FROM salary_components WHERE code='base_salary'`)).rows[0].id;
    const allEmployees = (await client.query('SELECT id, employee_number FROM employees ORDER BY employee_number')).rows;
    let totalGross = 0;
    for (const emp of allEmployees) {
      const employment = (await client.query('SELECT base_salary, position FROM employments WHERE employee_id=$1 LIMIT 1', [emp.id])).rows[0];
      if (!employment) continue;
      await client.query(
        `INSERT INTO payroll_lines (run_id, employee_id, component_id, amount, source_ref_type)
         VALUES ($1,$2,$3,$4,'manual') ON CONFLICT (run_id, employee_id, component_id) DO NOTHING`,
        [runId, emp.id, baseSalaryComponent, employment.base_salary],
      );
      totalGross += Number(employment.base_salary);
    }
    await client.query(
      `UPDATE payroll_runs SET total_gross=$1, total_deductions=0, total_net=$1 WHERE id=$2`,
      [totalGross, runId],
    );
    console.log(`  - payroll period ${periodCode} with a calculated run (${allEmployees.length} lines)`);

    // =========================================================================
    // PURCHASE ORDERS + PETTY CASH + WASTE (light coverage)
    // =========================================================================
    {
      const poItems = coreItems.slice(0, 3);
      // purchase_orders has no client_id column (class-X, cloud-only);
      // `notes` carries a dedicated idempotency marker instead, kept
      // separate from the allocated document number for the same reason
      // as the Surat Jalan block above.
      const poMarker = 'seed-demo-po-0001';
      const existingPo = await client.query('SELECT id FROM purchase_orders WHERE notes = $1', [poMarker]);
      let poId: string | undefined = existingPo.rows[0]?.id;
      if (!poId) {
        const poNumber = await nextDocNumber(client, 'PO');
        const poRes = await client.query(
          `INSERT INTO purchase_orders (po_number, supplier_id, location_id, status, order_date, expected_date, created_by, subtotal, total, notes)
           VALUES ($1,$2,$3,'issued',$4,$5,$6,0,0,$7)
           RETURNING id`,
          [poNumber, supplierId[supplierDefs[0]], locationId['GDG'], isoDate(daysAgo(5)), isoDate(daysAgo(-2)),
           userIdByUsername['kepalagudang1'], poMarker],
        );
        poId = poRes.rows[0].id;
      }
      if (poId) {
        let subtotal = 0;
        for (const itemName of poItems) {
          const def = itemDefs.find((d) => d.name === itemName)!;
          const qty = rnd(50, 150);
          const unitPrice = def.avgCost;
          subtotal += qty * unitPrice;
          await client.query(
            `INSERT INTO po_lines (po_id, item_id, unit_id, qty_ordered, unit_price, line_total)
             VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (po_id, item_id) DO NOTHING`,
            [poId, itemId[itemName], unitId['kg'], qty, unitPrice, qty * unitPrice],
          );
        }
        await client.query('UPDATE purchase_orders SET subtotal=$1, total=$1 WHERE id=$2', [subtotal, poId]);
      }
    }
    {
      const code = demoOutlets[0];
      const pcClientId = stableUuid('pc-seed-0001');
      const existingPc = await client.query('SELECT 1 FROM petty_cash WHERE client_id = $1', [pcClientId]);
      if (existingPc.rows.length === 0) {
        const pcNumber = await nextDocNumber(client, 'PC');
        await client.query(
          `INSERT INTO petty_cash (pc_number, location_id, purchased_by, purchase_date, store_name, total_amount, status, client_id)
           VALUES ($1,$2,$3,$4,$5,150000,'pending',$6)
           ON CONFLICT (client_id) DO NOTHING`,
          [pcNumber, locationId[code], userIdByUsername[`ldr_${code.toLowerCase()}`], isoDate(daysAgo(1)),
           supplierDefs[0], pcClientId],
        );
      }
    }
    {
      const code = demoOutlets[1];
      const wstClientId = stableUuid('wst-seed-0001');
      const existingWst = await client.query('SELECT 1 FROM waste_records WHERE client_id = $1', [wstClientId]);
      if (existingWst.rows.length === 0) {
        const wstNumber = await nextDocNumber(client, 'WST');
        const batchId = (await client.query('SELECT gen_random_uuid() AS id')).rows[0].id;
        await client.query(
          `INSERT INTO waste_records (waste_number, batch_id, location_id, storage_area_id, item_id, qty, unit_cost, reason, reason_detail, status, reported_by, client_id)
           VALUES ($1,$2,$3,$4,$5,3.5,$6,'expired','Kadaluarsa saat stock opname','pending',$7,$8)
           ON CONFLICT (client_id) DO NOTHING`,
          [wstNumber, batchId, locationId[code], storageAreaId[code]['dry_store'], itemId[coreItems[0]],
           itemDefs.find((d) => d.name === coreItems[0])!.avgCost, userIdByUsername[`ldr_${code.toLowerCase()}`],
           wstClientId],
        );
      }
    }
    console.log('  - sample purchase order, petty cash claim, waste record');

    // =========================================================================
    // ONLINE ORDERS (GoFood / ShopeeFood)
    // =========================================================================
    for (const code of demoOutlets.slice(0, 3)) {
      for (let i = 0; i < 3; i++) {
        const gross = rnd(30000, 90000);
        const fee = Math.round(gross * 0.2);
        await client.query(
          `INSERT INTO online_orders (client_id, location_id, platform, order_ref, order_date, gross_amount, platform_fee, net_received, recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           ON CONFLICT (platform, order_ref) DO NOTHING`,
          [stableUuid(`oo-${code}-${i}`), locationId[code], i % 2 === 0 ? 'gofood' : 'shopeefood', `${code}-ORD-${1000 + i}`,
           isoDate(daysAgo(i)), gross, fee, gross - fee, userIdByUsername[`kasir1_${code.toLowerCase()}`]],
        );
      }
    }

    // =========================================================================
    // ASSETS + MAINTENANCE (a handful)
    // =========================================================================
    let assetSeq = 1;
    for (const code of [...demoOutlets.slice(0, 3), 'GDG']) {
      const assetRes = await client.query(
        `INSERT INTO assets (asset_number, name, category, location_id, condition, status)
         VALUES ($1,$2,'equipment',$3,'good','active')
         ON CONFLICT (asset_number) DO NOTHING RETURNING id`,
        [`AST${String(assetSeq++).padStart(4, '0')}`, code === 'GDG' ? 'Freezer Gudang' : 'AC Ruangan', locationId[code]],
      );
      const assetId = assetRes.rows[0]?.id;
      if (assetId) {
        await client.query(
          `INSERT INTO maintenance_schedules (asset_id, name, interval_type, interval_value, next_due_at)
           VALUES ($1,'Service Rutin','months',3,$2)`,
          [assetId, isoDate(daysAgo(-20))],
        );
      }
    }

    // =========================================================================
    // DEVICES — ~30 across locations, mixed states
    // =========================================================================
    const deviceCategories = ['tablet', 'pos_terminal', 'printer', 'laptop'];
    const deviceStatusCycle = ['online', 'online', 'online', 'stale', 'offline', 'unpaired'];
    const targetDevices = 30;
    for (let i = 0; i < targetDevices; i++) {
      // Deterministic per-index assignment (not Math.random()) so the
      // fingerprint — and therefore idempotency via ON CONFLICT — is stable
      // across re-runs of the seed.
      const code = i === 0 ? 'GDG' : allLocationCodes[i % allLocationCodes.length];
      const category = deviceCategories[i % deviceCategories.length];
      const status = deviceStatusCycle[i % deviceStatusCycle.length];
      const lastSeen = status === 'online' ? new Date() : status === 'stale' ? daysAgo(0) : daysAgo(2 + (i % 18));
      const fingerprint = `fp-seed-${String(i + 1).padStart(4, '0')}`;
      const devRes = await client.query(
        `INSERT INTO devices (location_id, category, name, fingerprint, status, app_version, queue_depth, last_seen_at, last_sync_at)
         VALUES ($1,$2,$3,$4,$5,'1.0.0',$6,$7,$7)
         ON CONFLICT (fingerprint) DO NOTHING RETURNING id`,
        [locationId[code], category, `${category}-${code}-${i + 1}`, fingerprint,
         status, status === 'offline' ? 5 + (i % 55) : 0, lastSeen],
      );
      const deviceId = devRes.rows[0]?.id;
      if (deviceId && status === 'online') {
        await client.query(
          `INSERT INTO device_heartbeats (device_id, at, app_version, queue_depth, client_time)
           VALUES ($1,NOW(),'1.0.0',0,NOW())`,
          [deviceId],
        );
      }
    }
    console.log(`  - devices: ${targetDevices} across locations (mixed online/stale/offline/unpaired)`);

    // =========================================================================
    // ACCOUNTING — journal_entries/journal_lines (D-04, carried item #1: this
    // table seeded empty, leaving the GL invariant vacuously true and the
    // finance UI (W5-02/W5-06) with nothing to build against). Every entry
    // below is constructed balanced BY HAND (Σdebit === Σcredit per entry) —
    // this script writes as the owner/superuser role (see file header),
    // outside the app's own `JournalService`/`validateJournalEntry` path, so
    // the balance guarantee here is this function's own responsibility, not
    // borrowed from the engine it is standing in for. `chart_of_accounts`
    // (090) and `fiscal_periods` (218) are both already seeded by the time
    // this script runs (migrations apply first) — looked up by code/period,
    // never assumed.
    // =========================================================================
    const acctRows = (await client.query('SELECT code, id FROM chart_of_accounts')).rows as { code: string; id: string }[];
    const acctId: Record<string, string> = {};
    for (const r of acctRows) acctId[r.code] = r.id;

    const periodRows = (await client.query('SELECT period_code, id FROM fiscal_periods')).rows as { period_code: string; id: string }[];
    const periodIdByCode: Record<string, string> = {};
    for (const r of periodRows) periodIdByCode[r.period_code] = r.id;

    const financeUserRes = await client.query(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'finance' LIMIT 1`,
    );
    const financeUserId: string | null = financeUserRes.rows[0]?.id ?? null;

    async function periodIdFor(dateStr: string): Promise<string> {
      const code = dateStr.slice(0, 7);
      if (periodIdByCode[code]) return periodIdByCode[code];
      // Defensive fallback if a demo date lands outside migration 218's seeded window (e.g. this
      // script running long after the migration's `NOW()` snapshot) — open the period rather than
      // fail the whole seed over a display-only report window.
      const [y, m] = code.split('-').map(Number);
      const start = `${code}-01`;
      const end = isoDate(new Date(Date.UTC(y!, m!, 0)));
      const res = await client.query(
        `INSERT INTO fiscal_periods (period_code, start_date, end_date, status) VALUES ($1,$2,$3,'open')
         ON CONFLICT (period_code) DO UPDATE SET period_code = EXCLUDED.period_code RETURNING id`,
        [code, start, end],
      );
      periodIdByCode[code] = res.rows[0].id;
      return res.rows[0].id;
    }

    interface SeedLine { code: string; debit: number; credit: number; memo?: string }
    interface SeedEntry {
      dateStr: string;
      eventType: string | null;
      source: 'system' | 'manual';
      refType: string | null;
      refId: string | null;
      locationCode: string | null;
      description: string;
      lines: SeedLine[];
    }

    async function insertJournalEntry(e: SeedEntry): Promise<string> {
      const totalDebit = e.lines.reduce((s, l) => s + l.debit, 0);
      const totalCredit = e.lines.reduce((s, l) => s + l.credit, 0);
      if (Math.round(totalDebit * 100) !== Math.round(totalCredit * 100)) {
        throw new Error(`Seed journal entry '${e.description}' does not balance: debit ${totalDebit} != credit ${totalCredit}`);
      }
      const period = e.dateStr.slice(0, 7).replace('-', '');
      const entryNumber = await nextDocNumber(client, 'JE', period);
      const fiscalPeriodId = await periodIdFor(e.dateStr);
      const res = await client.query(
        `INSERT INTO journal_entries (entry_number, entry_date, fiscal_period_id, event_type, source, ref_type, ref_id, location_id, description, status, posted_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'posted',$10)
         ON CONFLICT (entry_number) DO NOTHING RETURNING id`,
        [entryNumber, e.dateStr, fiscalPeriodId, e.eventType, e.source, e.refType, e.refId,
         e.locationCode ? locationId[e.locationCode] : null, e.description, e.source === 'manual' ? financeUserId : null],
      );
      const entryId = res.rows[0]?.id;
      if (!entryId) return entryNumber; // already seeded on a prior run
      let lineNo = 0;
      for (const line of e.lines) {
        lineNo += 1;
        const accountId = acctId[line.code];
        if (!accountId) throw new Error(`Seed journal entry '${e.description}' references unknown account code '${line.code}'`);
        await client.query(
          `INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, location_id, memo)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [entryId, lineNo, accountId, line.debit.toFixed(2), line.credit.toFixed(2),
           e.locationCode ? locationId[e.locationCode] : null, line.memo ?? null],
        );
      }
      return entryNumber;
    }

    const outletA = demoOutlets[0]!;
    const outletB = demoOutlets[1]!;

    await insertJournalEntry({
      dateStr: isoDate(daysAgo(20)), eventType: 'gudang_purchase', source: 'system', refType: 'po_receipt', refId: null,
      locationCode: 'GDG', description: 'Penerimaan barang dari supplier',
      lines: [{ code: '1100', debit: 5_000_000, credit: 0 }, { code: '2000', debit: 0, credit: 5_000_000 }],
    });
    await insertJournalEntry({
      dateStr: isoDate(daysAgo(14)), eventType: 'gudang_goods_out_to_outlet', source: 'system', refType: 'surat_jalan', refId: null,
      locationCode: 'GDG', description: 'Barang keluar ke outlet via Surat Jalan',
      lines: [{ code: '1120', debit: 2_000_000, credit: 0 }, { code: '1100', debit: 0, credit: 2_000_000 }],
    });
    await insertJournalEntry({
      dateStr: isoDate(daysAgo(13)), eventType: 'outlet_goods_in_from_warehouse', source: 'system', refType: 'sj_drops', refId: null,
      locationCode: outletA, description: 'Barang diterima outlet dari Surat Jalan',
      lines: [{ code: '1110', debit: 2_000_000, credit: 0 }, { code: '1120', debit: 0, credit: 2_000_000 }],
    });
    await insertJournalEntry({
      dateStr: isoDate(daysAgo(3)), eventType: 'outlet_sales', source: 'system', refType: 'sale_day', refId: null,
      locationCode: outletA, description: 'Penjualan harian outlet (tunai + QRIS)',
      lines: [
        { code: '1000', debit: 3_000_000, credit: 0, memo: 'Tunai' },
        { code: '1031', debit: 1_500_000, credit: 0, memo: 'QRIS' },
        { code: '4000', debit: 0, credit: 4_500_000 },
      ],
    });
    await insertJournalEntry({
      dateStr: isoDate(daysAgo(3)), eventType: 'outlet_ingredient_usage', source: 'system', refType: 'sale_day', refId: null,
      locationCode: outletA, description: 'Pemakaian bahan baku harian outlet',
      lines: [{ code: '5000', debit: 1_800_000, credit: 0 }, { code: '1110', debit: 0, credit: 1_800_000 }],
    });
    await insertJournalEntry({
      dateStr: isoDate(daysAgo(2)), eventType: 'outlet_waste', source: 'system', refType: 'waste_records', refId: null,
      locationCode: outletB, description: 'Waste/kerusakan barang outlet',
      lines: [{ code: '5100', debit: 250_000, credit: 0 }, { code: '1110', debit: 0, credit: 250_000 }],
    });
    // X1/X1s payroll accrual — genuinely multi-leg (gross debited; net-to-liability + loan + SO-shortfall
    // claim legs credited) so 50,000,000 = 45,000,000 + 3,000,000 + 2,000,000 still balances as ONE entry.
    await insertJournalEntry({
      dateStr: isoDate(daysAgo(15)), eventType: 'payroll_accrual', source: 'system', refType: 'payroll_run', refId: null,
      locationCode: null, description: 'Akrual gaji periode berjalan',
      lines: [
        { code: '6000', debit: 50_000_000, credit: 0, memo: 'Beban gaji (gross)' },
        { code: '2100', debit: 0, credit: 45_000_000, memo: 'Hutang gaji (net)' },
        { code: '1210', debit: 0, credit: 3_000_000, memo: 'Potongan cicilan kasbon' },
        { code: '1220', debit: 0, credit: 2_000_000, memo: 'Potongan selisih stok (piutang klaim)' },
      ],
    });
    await insertJournalEntry({
      dateStr: isoDate(daysAgo(10)), eventType: 'payroll_payment', source: 'system', refType: 'payment_verification', refId: null,
      locationCode: null, description: 'Pembayaran gaji',
      lines: [{ code: '2100', debit: 45_000_000, credit: 0 }, { code: '1020', debit: 0, credit: 45_000_000 }],
    });
    // X6 sale_void_reversal — both legs (revenue+cash-back, HPP+inventory-back) in one entry.
    await insertJournalEntry({
      dateStr: isoDate(daysAgo(1)), eventType: 'sale_void_reversal', source: 'system', refType: 'void_refund', refId: null,
      locationCode: outletA, description: 'Reversal penjualan (void)',
      lines: [
        { code: '4000', debit: 50_000, credit: 0, memo: 'Reversal pendapatan' },
        { code: '1000', debit: 0, credit: 50_000 },
        { code: '1110', debit: 20_000, credit: 0, memo: 'Bahan baku kembali' },
        { code: '5000', debit: 0, credit: 20_000, memo: 'Reversal HPP' },
      ],
    });
    // A manual entry (source='manual', Finance-posted) — the shape `POST /api/accounting/journal` produces.
    const manualEntryNumber = await insertJournalEntry({
      dateStr: isoDate(daysAgo(4)), eventType: null, source: 'manual', refType: null, refId: null,
      locationCode: 'GDG', description: 'Pembayaran servis AC gudang',
      lines: [{ code: '6200', debit: 500_000, credit: 0 }, { code: '1020', debit: 0, credit: 500_000 }],
    });
    // ...and its reversal, demonstrating the `status='reversed'` + `reversed_by_entry_id` lifecycle.
    const originalRes = await client.query('SELECT id FROM journal_entries WHERE entry_number = $1', [manualEntryNumber]);
    const originalId = originalRes.rows[0]?.id;
    if (originalId) {
      const reversalNumber = await insertJournalEntry({
        dateStr: isoDate(daysAgo(0)), eventType: null, source: 'manual', refType: null, refId: null,
        locationCode: 'GDG', description: `Reversal of ${manualEntryNumber}: dicatat dua kali`,
        lines: [{ code: '1020', debit: 500_000, credit: 0 }, { code: '6200', debit: 0, credit: 500_000 }],
      });
      const reversalRes = await client.query('SELECT id FROM journal_entries WHERE entry_number = $1', [reversalNumber]);
      const reversalId = reversalRes.rows[0]?.id;
      if (reversalId) {
        await client.query(`UPDATE journal_entries SET status = 'reversed', reversed_by_entry_id = $2 WHERE id = $1 AND status <> 'reversed'`, [originalId, reversalId]);
      }
    }
    console.log('  - accounting: 11 seeded journal entries across gudang/outlet/payroll/void/manual (incl. one reversed pair)');

    console.log('\n✓ Seed completed successfully.\n');
    console.log(`Demo login: any seeded username (e.g. "owner", "manager1", "spv_bpp01") / password "${DEMO_PASSWORD}"`);
    console.log(`Demo PIN (owner/manager/kepala_gudang/supervisor): "${DEMO_PIN}"\n`);
  } catch (error) {
    console.error('\n✗ Seed failed:', error);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
