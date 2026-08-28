/**
 * THE ORG MODEL — one definition of how this company is staffed.
 *
 * The owner's business, as described 2026-08-23: managers over REGIONS rather
 * than the whole chain, every outlet staffed as a crew PER SHIFT (supervisor +
 * cashier + 2 cooks), Gudang Pusat with 2 staff and 2 drivers.
 *
 * It lives here, apart from both callers, because there are two of them and they
 * must never disagree about what the org is:
 *
 *   - `seed.ts` calls it so a fresh dev or CI database IS the business rather
 *     than a placeholder that has to be reshaped afterwards;
 *   - `simulate-org.ts` calls it to converge an ALREADY-seeded database (the
 *     demo box) without a reset.
 *
 * Two copies of "supervisor + cashier + 2 cooks" would drift the first time a
 * shift or a region changed, and the drift would show up as a test suite that
 * passes locally and fails on a freshly seeded machine.
 *
 * `applyOrgModel` is idempotent and manages NO transaction — the caller owns
 * that, because `seed.ts` runs inside its own and the CLI needs a dry run.
 */
import type pg from 'pg';
import bcrypt from 'bcrypt';

export const DEMO_PASSWORD = 'password123';
export const DEMO_PIN = '123456';

/** The three shifts `seed.ts` created per location, by name. */
export const SHIFTS = ['Pagi', 'Siang', 'Malam'] as const;
type ShiftName = (typeof SHIFTS)[number];
/** Short suffix per shift, so a username says which crew it belongs to. */
const SHIFT_SUFFIX: Record<ShiftName, string> = { Pagi: 'p', Siang: 's', Malam: 'm' };

/**
 * Who runs which branches. The point of the exercise: a manager owns a REGION,
 * not the company. Two managers, four cities, ten outlets each.
 */
export const REGIONS: Record<string, { label: string; prefixes: string[] }> = {
  manager1: { label: 'Kalimantan Timur (Balikpapan + Samarinda)', prefixes: ['BPP', 'SMD'] },
  manager2: {
    label: 'Kalimantan Selatan/Barat (Banjarmasin + Pontianak)',
    prefixes: ['BJM', 'PTK'],
  },
};

/** Crew composition per shift, in the owner's words: supervisor + cashier + 2 cooks. */
export const CREW: Array<{ slot: string; roleKey: string; position: string; withPin: boolean }> = [
  { slot: 'spv', roleKey: 'supervisor', position: 'Supervisor Cabang', withPin: true },
  { slot: 'kasir', roleKey: 'kasir', position: 'Kasir', withPin: true },
  // Two cooks, on the `koki` role added for them (migration 234).
  { slot: 'koki1', roleKey: 'koki', position: 'Juru Masak', withPin: false },
  { slot: 'koki2', roleKey: 'koki', position: 'Juru Masak', withPin: false },
];

const GUDANG_STAFF = 2;
const GUDANG_DRIVERS = 2;

/** How many days of roster to write, centred on today — enough for "yesterday, today, tomorrow" screens. */
const ROSTER_DAYS_BACK = 3;
const ROSTER_DAYS_FORWARD = 7;

const FIRST_NAMES = [
  'Ahmad',
  'Budi',
  'Citra',
  'Dian',
  'Eka',
  'Fajar',
  'Gita',
  'Hendra',
  'Indah',
  'Joni',
  'Kartika',
  'Lestari',
  'Made',
  'Nia',
  'Oki',
  'Putri',
  'Qori',
  'Rian',
  'Sari',
  'Tono',
  'Umi',
  'Vino',
  'Wati',
  'Yanto',
  'Zainal',
  'Ayu',
  'Bagus',
  'Cahyo',
  'Dewi',
  'Ella',
  'Farid',
  'Gilang',
  'Hana',
  'Ilham',
  'Jihan',
  'Kiki',
  'Lukman',
  'Mira',
  'Nanda',
  'Okta',
];
const LAST_NAMES = [
  'Saputra',
  'Wijaya',
  'Kusuma',
  'Pratama',
  'Santoso',
  'Wibowo',
  'Hidayat',
  'Setiawan',
  'Rahayu',
  'Gunawan',
  'Nugroho',
  'Permadi',
  'Suryadi',
  'Handayani',
  'Firmansyah',
  'Maulana',
  'Ramadhan',
  'Siregar',
  'Nasution',
  'Halim',
];

/**
 * Names are DERIVED FROM THE USERNAME, not random.
 *
 * `seed.ts` uses `Math.random()` for names, which means every re-run renames
 * everybody. For a simulation the owner is going to look at repeatedly, a crew
 * that changes names each time it is regenerated is unreadable — you cannot
 * tell "the same cook" from "a new cook". A hash of the username is stable
 * across runs and still spreads names evenly.
 */
function nameFor(username: string): string {
  let h = 0;
  for (let i = 0; i < username.length; i++) h = (h * 31 + username.charCodeAt(i)) >>> 0;
  return `${FIRST_NAMES[h % FIRST_NAMES.length]} ${LAST_NAMES[(h >>> 5) % LAST_NAMES.length]}`;
}

/**
 * The WITA (Asia/Makassar, UTC+8) calendar date — the business day, never
 * `toISOString().slice(0,10)`.
 *
 * `@mimi/shared`'s `businessDateOf` is the canonical implementation and this is
 * a deliberate 3-line copy of it: this script has to run inside a disposable
 * node container on the server, where the workspace package is not built, and a
 * missing `dist/` would fail an ops task for no reason. The offset is fixed —
 * Indonesia has no daylight saving — so there is nothing here to drift.
 */
const WITA_OFFSET_MS = 8 * 60 * 60 * 1000;
function isoDate(d: Date): string {
  return new Date(d.getTime() + WITA_OFFSET_MS).toISOString().slice(0, 10);
}
function dayOffset(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

function baseSalaryFor(position: string): number {
  if (position.includes('Manager')) return 9_000_000;
  if (position.includes('Kepala Gudang')) return 7_000_000;
  if (position.includes('Supervisor')) return 5_500_000;
  if (position.includes('Driver')) return 3_800_000;
  if (position.includes('Juru Masak')) return 3_600_000;
  return 3_300_000;
}

interface PlannedUser {
  username: string;
  roleKey: string;
  position: string;
  locations: string[];
  withPin: boolean;
  /** The outlet + shift this person's crew belongs to; null for gudang and office. */
  crew: { locationCode: string; shift: ShiftName } | null;
}

/**
 * `seed.ts`'s people, mapped onto their slot in the new model.
 *
 * The alternative was to create 242 fresh logins and deactivate the 88 that
 * `seed.ts` made, which is technically the same org and operationally much
 * worse: every deactivated account keeps its attendance, its sales and its
 * signature on documents, so HR screens would open onto 88 "resigned" staff who
 * never resigned, and today's sales would be attributed to people no longer on
 * the roster. Renaming keeps the person — same `users.id`, same history — and
 * just moves them into a named crew. Every mapping below is role-compatible, so
 * nobody silently gains or loses permissions:
 *
 *   spv_<code>      -> spv_<code>_p     supervisor    (leads the morning crew)
 *   kasir1_<code>   -> kasir_<code>_p   kasir
 *   kasir2_<code>   -> kasir_<code>_s   kasir         (already the second shift)
 *   ldr_<code>      -> koki1_<code>_p   leader_outlet (cooks hold this role too)
 *   kepalagudang1/2 -> gudang1/2        kepala_gudang
 *
 * Drivers 1 and 2 keep their names and are the two the model asks for; 3-8 fall
 * out of the model and are stood down by the surplus pass.
 */
export function legacyRenames(outletCodes: string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [
    ['kepalagudang1', 'gudang1'],
    ['kepalagudang2', 'gudang2'],
  ];
  for (const code of outletCodes) {
    const c = code.toLowerCase();
    pairs.push([`spv_${c}`, `spv_${c}_p`]);
    pairs.push([`kasir1_${c}`, `kasir_${c}_p`]);
    pairs.push([`kasir2_${c}`, `kasir_${c}_s`]);
    pairs.push([`ldr_${c}`, `koki1_${c}_p`]);
  }
  return pairs;
}

/** Builds the target org as data, so the plan can be printed before anything is written. */
function planOrg(outletCodes: string[]): PlannedUser[] {
  const planned: PlannedUser[] = [];

  for (const [username, region] of Object.entries(REGIONS)) {
    planned.push({
      username,
      roleKey: 'manager',
      position: 'Manager Operasional',
      locations: outletCodes.filter((c) => region.prefixes.some((p) => c.startsWith(p))),
      withPin: true,
      crew: null,
    });
  }

  // A head-office manager with NO region, which is not padding — it is what
  // makes the regional managers safe to introduce.
  //
  // Since migration 235 a manager is confined to the branches assigned to them,
  // so once every manager has a region there is nobody who can approve a
  // document at an arbitrary outlet. A real chain has exactly this person, and
  // without them a purchase request from an outlet outside both regions has no
  // approver at all.
  planned.push({
    username: 'manager_pusat',
    roleKey: 'manager',
    position: 'Manager Operasional Pusat',
    locations: [],
    withPin: true,
    crew: null,
  });

  for (const code of outletCodes) {
    for (const shift of SHIFTS) {
      for (const member of CREW) {
        planned.push({
          username: `${member.slot}_${code.toLowerCase()}_${SHIFT_SUFFIX[shift]}`,
          roleKey: member.roleKey,
          position: member.position,
          locations: [code],
          withPin: member.withPin,
          crew: { locationCode: code, shift },
        });
      }
    }
  }

  for (let i = 1; i <= GUDANG_STAFF; i++) {
    planned.push({
      username: `gudang${i}`,
      roleKey: 'kepala_gudang',
      position: i === 1 ? 'Kepala Gudang' : 'Staf Gudang',
      locations: ['GDG'],
      withPin: true,
      crew: null,
    });
  }
  for (let i = 1; i <= GUDANG_DRIVERS; i++) {
    planned.push({
      username: `driver${i}`,
      roleKey: 'driver',
      position: 'Driver',
      locations: ['GDG'],
      withPin: false,
      crew: null,
    });
  }

  return planned;
}

export interface OrgModelResult {
  /** One line per action taken, ready to print. */
  summary: string[];
  /** Every username the model defines, for a caller that wants to report or verify. */
  usernames: string[];
}

/**
 * Converges the database onto the org model. Idempotent: a second run reports
 * nothing to do.
 *
 * Manages NO transaction on purpose. `seed.ts` calls this inside its own, and
 * the CLI wraps it in one it can roll back for `--dry-run`; opening a nested one
 * here would silently commit half of a dry run.
 */
export async function applyOrgModel(client: pg.Client): Promise<OrgModelResult> {
  const summary: string[] = [];
  const locRows = (
    await client.query<{ id: string; code: string; type: string }>(
      `SELECT id, code, type FROM locations ORDER BY code`,
    )
  ).rows;
  const locationId: Record<string, string> = {};
  for (const l of locRows) locationId[l.code] = l.id;
  const outletCodes = locRows.filter((l) => l.type === 'outlet').map((l) => l.code);
  if (outletCodes.length === 0) throw new Error('No outlets found — run `pnpm db:seed` first.');

  const roleRows = (await client.query<{ id: string; key: string }>(`SELECT id, key FROM roles`))
    .rows;
  const roleId: Record<string, string> = {};
  for (const r of roleRows) roleId[r.key] = r.id;

  const planned = planOrg(outletCodes);
  const plannedUsernames = new Set(planned.map((p) => p.username));

  // ── users, locations, employees, contracts ───────────────────────────────
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const pinHash = await bcrypt.hash(DEMO_PIN, 10);

  let renamed = 0;
  for (const [from, to] of legacyRenames(outletCodes)) {
    // Skipped rather than forced if the destination already exists: a second
    // run finds the new name in place and must not collapse two people into
    // one. `username` is unique, so this would otherwise throw.
    const res = await client.query(
      `UPDATE users SET username = $2, email = $3
        WHERE username = $1
          AND NOT EXISTS (SELECT 1 FROM users WHERE username = $2)`,
      [from, to, `${to}@mimichicken.local`],
    );
    renamed += res.rowCount ?? 0;
  }
  if (renamed > 0)
    summary.push(`reused ${renamed} existing logins by moving them into a named crew`);

  let usersCreated = 0;
  let usersUpdated = 0;
  const employeeIdByUsername: Record<string, string> = {};

  for (const p of planned) {
    if (!roleId[p.roleKey]) throw new Error(`Unknown role "${p.roleKey}"`);
    const res = await client.query<{ id: string; inserted: boolean }>(
      `INSERT INTO users (username, email, password_hash, pin_hash, name, role_id, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,true)
       ON CONFLICT (username) DO UPDATE
         SET name = EXCLUDED.name,
             role_id = EXCLUDED.role_id,
             -- A person moved back into the model is reactivated; this is what
             -- makes the script safe to re-run after a shrink.
             is_active = true,
             pin_hash = COALESCE(users.pin_hash, EXCLUDED.pin_hash)
       RETURNING id, (xmax = 0) AS inserted`,
      [
        p.username,
        `${p.username}@mimichicken.local`,
        passwordHash,
        p.withPin ? pinHash : null,
        nameFor(p.username),
        roleId[p.roleKey],
      ],
    );
    const userId = res.rows[0]!.id;
    if (res.rows[0]!.inserted) usersCreated++;
    else usersUpdated++;

    // Location scope is REPLACED, not added to: a manager whose region
    // changed must lose the outlets they no longer run, and an additive
    // upsert would quietly leave them behind.
    await client.query(`DELETE FROM user_locations WHERE user_id = $1`, [userId]);
    for (const code of p.locations) {
      await client.query(
        `INSERT INTO user_locations (user_id, location_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [userId, locationId[code]],
      );
    }

    const homeLoc = p.locations[0] ?? 'GDG';
    const joinDate = dayOffset(-(200 + ((p.username.length * 37) % 900)));
    // `employees` is unique on BOTH `employee_number` and `user_id`, and
    // `seed.ts` numbers its people `EMP0001…`. Upserting on my own number
    // would therefore violate the user_id constraint for everyone who
    // already exists (manager1, driver1, spv_bpp01 …), so an existing
    // employee is matched by user_id and only reshaped.
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM employees WHERE user_id = $1`,
      [userId],
    );
    const empRes = existing.rows[0]
      ? await client.query<{ id: string }>(
          `UPDATE employees
              SET position = $2, location_id = $3, employment_status = 'active', name = $4
            WHERE id = $1
            RETURNING id`,
          [existing.rows[0].id, p.position, locationId[homeLoc], nameFor(p.username)],
        )
      : await client.query<{ id: string }>(
          `INSERT INTO employees
         (employee_number, user_id, name, nik, phone, email, join_date, employment_status, position, location_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9)
       ON CONFLICT (employee_number) DO UPDATE
         SET position = EXCLUDED.position,
             location_id = EXCLUDED.location_id,
             employment_status = 'active'
       RETURNING id`,
          [
            `EMP-${p.username.toUpperCase().slice(0, 18)}`,
            userId,
            nameFor(p.username),
            // Deterministic 16-digit NIK — a real one encodes birth date and
            // region, which is not something to fabricate convincingly.
            `6471${String(Math.abs(hash(p.username)) % 1_000_000_000_000).padStart(12, '0')}`,
            `08${String(Math.abs(hash(p.username + 'phone')) % 1_000_000_000).padStart(10, '0')}`,
            `${p.username}@mimichicken.local`,
            isoDate(joinDate),
            p.position,
            locationId[homeLoc],
          ],
        );
    const employeeId = empRes.rows[0]!.id;
    employeeIdByUsername[p.username] = employeeId;

    await client.query(
      `INSERT INTO employments (employee_id, position, location_id, base_salary, start_date)
       SELECT $1,$2,$3,$4,$5 WHERE NOT EXISTS (SELECT 1 FROM employments WHERE employee_id = $1)`,
      [employeeId, p.position, locationId[homeLoc], baseSalaryFor(p.position), isoDate(joinDate)],
    );

    const daysEmployed = Math.round((Date.now() - joinDate.getTime()) / 86_400_000);
    const contractType = daysEmployed < 90 ? 'probation' : daysEmployed < 730 ? 'pkwt' : 'pkwtt';
    const contractEnd =
      contractType === 'pkwtt'
        ? null
        : isoDate(
            new Date(joinDate.getTime() + (contractType === 'probation' ? 90 : 365) * 86_400_000),
          );
    await client.query(
      `INSERT INTO employment_contracts
         (contract_number, employee_id, contract_type, position, location_id, base_salary,
          start_date, end_date, status, signed_at)
       SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$7
        WHERE NOT EXISTS (SELECT 1 FROM employment_contracts WHERE employee_id = $2)`,
      [
        // The FULL username, not a slice: truncating to 12 characters made
        // kasir_bpp01_p, _s and _m collide on one contract number (the column
        // is unique, so the third crew broke the whole transaction).
        `KONTRAK/${isoDate(joinDate).slice(0, 7).replace('-', '')}/${p.username.toUpperCase()}`,
        employeeId,
        contractType,
        p.position,
        locationId[homeLoc],
        baseSalaryFor(p.position),
        isoDate(joinDate),
        contractEnd,
        contractEnd && contractEnd < isoDate(new Date()) ? 'expired' : 'active',
      ],
    );
  }
  summary.push(`users: ${usersCreated} created, ${usersUpdated} already existed (now aligned)`);

  // ── people the model no longer has a place for ───────────────────────────
  // Deactivated, never deleted: every one of them has attendance, sales or
  // documents attached, and deleting the actor would leave history that
  // nobody signed.
  const surplus = (
    await client.query<{ username: string }>(
      `SELECT u.username
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.is_active
          AND r.key NOT IN ('owner', 'superadmin', 'finance', 'hr_admin')
        ORDER BY u.username`,
    )
  ).rows
    .map((r) => r.username)
    .filter((username) => !plannedUsernames.has(username));

  if (surplus.length > 0) {
    await client.query(`UPDATE users SET is_active = false WHERE username = ANY($1::text[])`, [
      surplus,
    ]);
    await client.query(
      `UPDATE employees SET employment_status = 'resigned'
        WHERE user_id IN (SELECT id FROM users WHERE username = ANY($1::text[]))`,
      [surplus],
    );
    summary.push(
      `deactivated ${surplus.length} logins outside the model (${surplus.slice(0, 4).join(', ')}${surplus.length > 4 ? ', …' : ''})`,
    );
  } else {
    summary.push('no surplus logins to deactivate');
  }

  // ── the roster: every crew on its own shift, every day in the window ─────
  const shiftIdByLocAndName: Record<string, string> = {};
  for (const row of (
    await client.query<{ location_id: string; name: string; id: string }>(
      `SELECT location_id, name, id FROM work_shifts WHERE is_active`,
    )
  ).rows) {
    shiftIdByLocAndName[`${row.location_id}|${row.name}`] = row.id;
  }

  const ownerUserId = (
    await client.query<{ id: string }>(`SELECT id FROM users WHERE username = 'owner'`)
  ).rows[0]?.id;
  if (!ownerUserId) throw new Error('No `owner` user — run `pnpm db:seed` first.');

  let rosterRows = 0;
  let rosterSkipped = 0;
  for (let offset = -ROSTER_DAYS_BACK; offset <= ROSTER_DAYS_FORWARD; offset++) {
    const date = isoDate(dayOffset(offset));
    for (const p of planned) {
      if (!p.crew) continue;
      const shiftId = shiftIdByLocAndName[`${locationId[p.crew.locationCode]}|${p.crew.shift}`];
      if (!shiftId) {
        rosterSkipped++;
        continue;
      }
      // One assignment per person per day: the crew a person belongs to is
      // fixed, which is the whole point of "a set per shift".
      const res = await client.query(
        `INSERT INTO shift_assignments (employee_id, work_shift_id, location_id, date, assigned_by, notes)
         SELECT $1,$2,$3,$4,$5,$6
          WHERE NOT EXISTS (
            SELECT 1 FROM shift_assignments WHERE employee_id = $1 AND date = $4
          )`,
        [
          employeeIdByUsername[p.username],
          shiftId,
          locationId[p.crew.locationCode],
          date,
          ownerUserId,
          `Kru ${p.crew.shift} ${p.crew.locationCode}`,
        ],
      );
      rosterRows += res.rowCount ?? 0;
    }
  }
  summary.push(
    `roster: ${rosterRows} assignments written across ${ROSTER_DAYS_BACK + ROSTER_DAYS_FORWARD + 1} days` +
      (rosterSkipped > 0 ? ` (${rosterSkipped} skipped — no matching work_shift)` : ''),
  );

  // ── the driver records the delivery screen needs ─────────────────────────
  for (let i = 1; i <= GUDANG_DRIVERS; i++) {
    const username = `driver${i}`;
    await client.query(
      `INSERT INTO drivers (employee_id, name, license_number, is_active)
       SELECT $1,$2,$3,true
        WHERE NOT EXISTS (SELECT 1 FROM drivers WHERE employee_id = $1)`,
      [employeeIdByUsername[username], nameFor(username), `SIM-B1-${String(1000 + i)}`],
    );
    // A driver who was stood down and is back in the model must be drivable
    // again, or the delivery screen has nobody to assign.
    await client.query(`UPDATE drivers SET is_active = true WHERE employee_id = $1`, [
      employeeIdByUsername[username],
    ]);
  }
  await client.query(
    `UPDATE drivers SET is_active = false
      WHERE employee_id IN (
        SELECT e.id FROM employees e JOIN users u ON u.id = e.user_id WHERE NOT u.is_active
      )`,
  );
  summary.push(`drivers: ${GUDANG_DRIVERS} active, the rest stood down`);

  return { summary, usernames: planned.map((p) => p.username) };
}

/** Prints what the org now looks like. Read-only — safe to call before a commit or a rollback. */
export async function describeOrg(client: pg.Client): Promise<void> {
  // ── what the org now looks like ──────────────────────────────────────────
  // Read INSIDE the transaction, before the commit-or-rollback below: a dry
  // run has to describe the org it would produce, not the one it is about to
  // roll back to. Reporting after the ROLLBACK printed the OLD shape under a
  // heading that said "Result", which is worse than printing nothing.
  console.log('Result\n');

  const shape = (
    await client.query<{ role: string; position: string; n: string }>(
      `SELECT r.key AS role, e.position, count(*)::text AS n
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN employees e ON e.user_id = u.id
        WHERE u.is_active
        GROUP BY r.key, e.position
        ORDER BY r.key, e.position`,
    )
  ).rows;
  console.log('\n  Active logins by role and job title');
  for (const row of shape)
    console.log(`    ${row.role.padEnd(16)} ${(row.position ?? '—').padEnd(22)} ${row.n}`);

  console.log('\n  Regions');
  for (const [username, region] of Object.entries(REGIONS)) {
    const n = (
      await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM user_locations ul
           JOIN users u ON u.id = ul.user_id WHERE u.username = $1`,
        [username],
      )
    ).rows[0]!.n;
    console.log(`    ${username.padEnd(10)} ${n} branches — ${region.label}`);
  }
}

/** Small stable hash, so a generated NIK or phone number does not change between runs. */
export function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}
