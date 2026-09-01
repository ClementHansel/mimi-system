/**
 * THE CREW — real seeded accounts, one per job, all at ONE outlet.
 *
 * The functional suites (`ops-*.spec.ts`) simulate a working day, so they need
 * the people who actually do the work, not a convenient all-access login.
 * Owner and superadmin can do everything, which makes them useless for finding
 * out what a supervisor's screen is really like: a flow that only ever runs as
 * owner proves the feature exists, never that the person whose job it is can
 * reach it.
 *
 * The usernames follow `database/simulate-org.ts`: `<slot>_<outlet><nn>_<shift>`,
 * where shift is `p`/`m`/`s` (pagi/malam/siang). Everyone below is on the SAME
 * outlet — `bpp01`, "Mimi Chicken Balikpapan Kota" — because a replenishment
 * raised at one outlet and approved by a supervisor at another is not a test of
 * the flow, it is a test of RLS refusing it.
 *
 * Overridable by env so the same suites can run against a box with a different
 * org (the demo VPS reshapes it), without editing a spec.
 */
export const CREW = {
  /** Raises replenishments, approves them at step 1, runs the outlet. */
  supervisor: process.env.E2E_SUPERVISOR ?? 'spv_bpp01_p',
  /** Opens the till, sells, closes the shift. */
  kasir: process.env.E2E_KASIR ?? 'kasir_bpp01_p',
  /** Kitchen: reads the menu, moves stock between areas, records spoilage. */
  koki: process.env.E2E_KOKI ?? 'koki1_bpp01_p',
  /** Central warehouse: approves the warehouse step, builds the Surat Jalan. */
  kepalaGudang: process.env.E2E_KEPALA_GUDANG ?? 'gudang1',
  /** Delivers it. */
  driver: process.env.E2E_DRIVER ?? 'driver1',
  /** Head office. */
  manager: process.env.E2E_MANAGER ?? 'manager1',
  finance: process.env.E2E_FINANCE ?? 'finance1',
  hrAdmin: process.env.E2E_HR_ADMIN ?? 'hradmin1',
  owner: process.env.E2E_OWNER ?? 'owner',
} as const;

/** The outlet the crew above works at, as it appears in the UI. */
export const CREW_OUTLET = process.env.E2E_OUTLET_NAME ?? 'Mimi Chicken Balikpapan Kota';

/**
 * Whether this run may write to the box under test.
 *
 * A functional simulation IS writing — a shift that opens no shift and a
 * request that requests nothing tests nothing. But the same suite can be
 * pointed at production, where a fake sale lands in a real day's takings and a
 * fake replenishment lands in a real supervisor's queue. So every writing spec
 * is gated, and the default is off.
 */
export const ALLOW_WRITES = process.env.E2E_ALLOW_WRITES === '1';

/** A label that makes test-created rows obvious to a human reading the data. */
export function e2eMarker(what: string): string {
  return `E2E ${what}`;
}
