// Shared config for every k6 script in this suite.
//
// BASE_URL is the only thing that decides where load goes. It defaults to
// localhost:4000 (apps/backend/src/main.ts: `app.setGlobalPrefix('api')`,
// `PORT ?? 4000`) so that running a script with no env vars at all is safe —
// it can only ever hit a stack on this machine, never the shared VPS.
//
// DO NOT set BASE_URL to the production VPS (http://150.109.15.108:8080) —
// see perf/README.md. That host runs seven other projects; a 150-VU run
// against it would be a real incident, not a test.
export const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000';

// The 20 seeded outlets (`database/seed.ts`: 4 cities x 5 districts each),
// plus the one warehouse. Kept here, not re-derived per script, so every
// scenario samples the same fleet.
export const OUTLET_CODES = [
  'BPP01',
  'BPP02',
  'BPP03',
  'BPP04',
  'BPP05',
  'SMD01',
  'SMD02',
  'SMD03',
  'SMD04',
  'SMD05',
  'BJM01',
  'BJM02',
  'BJM03',
  'BJM04',
  'BJM05',
  'PTK01',
  'PTK02',
  'PTK03',
  'PTK04',
  'PTK05',
];

export const WAREHOUSE_CODE = 'GDG';

/** Pick a stable-but-spread outlet code for VU `n` (1-indexed by k6). */
export function outletCodeForVu(vu) {
  return OUTLET_CODES[(vu - 1) % OUTLET_CODES.length];
}
