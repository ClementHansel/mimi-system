import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { EmployeeTaxProfilesEditor } from './EmployeeTaxProfilesEditor';
import * as hrApi from './lib/hr-api';

/**
 * THE STEP OF THE STATUTORY WIZARD THAT HAD AN API AND NO SCREEN.
 *
 * MA-186: "Payroll Statutori belum bisa di aktifkan di halaman Administrasi >
 * Pengaturan > Payroll Statutori."
 *
 * Not a broken button. `StatutoryService.getStatus` withholds `ready` until
 * every ACTIVE employee has a row in `employee_tax_profiles`, and the Settings
 * card wires "Aktifkan" to `disabled={!status.ready}`. `seed-extended.ts`
 * writes a profile for each employee it seeds, so a fresh database looks
 * healthy — and then the first person HR adds for real has no profile,
 * coverage falls below 100%, and the button greys out permanently.
 * `getTaxProfile`/`putTaxProfile` had sat in `hr-api.ts` with no caller and
 * `PUT /payroll/employees/:id/tax-profile` had no UI anywhere.
 *
 * It was not only an enablement gate either: with statutory mode ON,
 * `buildCalculationInputs` throws `ERR_STATUTORY_NOT_READY` for an employee
 * with no profile and `computeAndPersistLines` does not catch it, so one new
 * hire fails the entire month's payroll run.
 *
 * These assert the two things that make the gap closable rather than just
 * visible: the blocking set can be FOUND (a count with 295 employees behind it
 * is not a workflow), and a profile can be SAVED with a tax status somebody
 * actually chose.
 */
vi.mock('./lib/hr-api', () => ({
  listTaxProfiles: vi.fn(),
  getTaxProfile: vi.fn(),
  putTaxProfile: vi.fn(),
  getStatutoryPtkp: vi.fn(),
}));

const PTKP_TABLE = [
  { id: 'p1', ptkpCode: 'TK/0', annualAmount: '54000000.00', terCategory: 'A' },
  { id: 'p2', ptkpCode: 'K/2', annualAmount: '67500000.00', terCategory: 'B' },
  // The table is effective-dated, so the same code recurs once per vintage —
  // the picker must not offer "TK/0" twice.
  { id: 'p3', ptkpCode: 'TK/0', annualAmount: '50000000.00', terCategory: 'A' },
];

const NO_PROFILE = {
  employeeId: 'emp-1',
  employeeNumber: 'EMP0296',
  name: 'Sari Baru',
  locationName: 'Mimi Chicken Balikpapan Kota',
  hasProfile: false,
  ptkpCode: null,
  npwp: null,
};

function rosterOf(rows: (typeof NO_PROFILE)[], total = rows.length) {
  return { rows, total, page: 1, pageSize: 25 };
}

describe('EmployeeTaxProfilesEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(hrApi.getStatutoryPtkp).mockResolvedValue(PTKP_TABLE as never);
    vi.mocked(hrApi.putTaxProfile).mockResolvedValue({} as never);
  });

  it('opens on the employees who are BLOCKING enablement, and says how many', async () => {
    vi.mocked(hrApi.listTaxProfiles).mockResolvedValue(rosterOf([NO_PROFILE], 283) as never);

    render(<EmployeeTaxProfilesEditor />);

    // Defaulting to "all" would bury 283 blockers among 295 rows. The whole
    // reason this screen exists is to answer "who is stopping me".
    await waitFor(() => expect(hrApi.listTaxProfiles).toHaveBeenCalled());
    expect(vi.mocked(hrApi.listTaxProfiles).mock.calls[0]![0]).toMatchObject({
      profile: 'missing',
    });

    expect(await screen.findByText(/283 pegawai aktif belum punya profil pajak/i)).toBeVisible();
    expect(screen.getByText('Sari Baru')).toBeInTheDocument();
  });

  it('says so plainly when nothing is missing', async () => {
    vi.mocked(hrApi.listTaxProfiles).mockResolvedValue(rosterOf([], 0) as never);

    render(<EmployeeTaxProfilesEditor />);

    expect(
      await screen.findByText(/Semua pegawai aktif sudah punya profil pajak/i),
    ).toBeInTheDocument();
  });

  it('saves a profile with the PTKP code the user chose, and derives dependants from it', async () => {
    vi.mocked(hrApi.listTaxProfiles).mockResolvedValue(rosterOf([NO_PROFILE]) as never);

    render(<EmployeeTaxProfilesEditor />);
    fireEvent.click(await screen.findByText('Sari Baru'));

    const ptkp = await waitFor(() => screen.getByLabelText(/Kode PTKP/i));

    // One option per distinct code, not one per vintage.
    const offered = Array.from((ptkp as HTMLSelectElement).querySelectorAll('option'))
      .map((o) => (o as HTMLOptionElement).value)
      .filter(Boolean);
    expect(offered).toEqual(['K/2', 'TK/0']);

    fireEvent.change(ptkp, { target: { value: 'K/2' } });
    // "K/2" IS two dependants — the count is read off the code rather than
    // typed, so the two can never disagree.
    expect(screen.getByText(/2 tanggungan/)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText(/Kesehatan/i));
    fireEvent.click(screen.getByLabelText(/^JHT$/i));
    fireEvent.click(screen.getByRole('button', { name: /Simpan/i }));

    await waitFor(() => expect(hrApi.putTaxProfile).toHaveBeenCalled());
    const [employeeId, profile] = vi.mocked(hrApi.putTaxProfile).mock.calls[0]!;
    expect(employeeId).toBe('emp-1');
    expect(profile).toMatchObject({
      ptkpCode: 'K/2',
      dependantsCount: 2,
      // Genuinely optional — a third of the roster has no NPWP on file, and an
      // empty box must reach the server as null, not "".
      npwp: null,
    });
    expect(Object.keys(profile.bpjsEnrollments).sort()).toEqual(['jht', 'kesehatan']);
    expect(profile.bpjsEnrollments.kesehatan?.endedAt).toBeNull();
  });

  it('will not save without a PTKP code — there is no defensible default', async () => {
    vi.mocked(hrApi.listTaxProfiles).mockResolvedValue(rosterOf([NO_PROFILE]) as never);

    render(<EmployeeTaxProfilesEditor />);
    fireEvent.click(await screen.findByText('Sari Baru'));

    // A guessed PTKP code is a wrong PPh21 withholding for a real person that
    // looks exactly like a right one. Blocking beats defaulting.
    const save = await waitFor(() => screen.getByRole('button', { name: /Simpan/i }));
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(hrApi.putTaxProfile).not.toHaveBeenCalled();
  });

  it('points at the PTKP table when there is nothing to pick from', async () => {
    // The ordering dependency, made visible instead of presenting an empty
    // dropdown: the server rejects any code absent from `pph21_ptkp`, so with
    // no table there is no valid choice and the fix is one card up the page.
    vi.mocked(hrApi.getStatutoryPtkp).mockResolvedValue([] as never);
    vi.mocked(hrApi.listTaxProfiles).mockResolvedValue(rosterOf([NO_PROFILE]) as never);

    render(<EmployeeTaxProfilesEditor />);
    fireEvent.click(await screen.findByText('Sari Baru'));

    expect(await screen.findByText(/Tabel PTKP belum diatur/i)).toBeInTheDocument();
  });

  it('loads an existing profile for editing instead of starting blank', async () => {
    const withProfile = {
      ...NO_PROFILE,
      hasProfile: true,
      ptkpCode: 'TK/0',
      npwp: '01.234.567.8-901.000',
    };
    vi.mocked(hrApi.listTaxProfiles).mockResolvedValue(rosterOf([withProfile]) as never);
    vi.mocked(hrApi.getTaxProfile).mockResolvedValue({
      employeeId: 'emp-1',
      npwp: '01.234.567.8-901.000',
      ptkpCode: 'TK/0',
      dependantsCount: 0,
      bpjsEnrollments: {
        kesehatan: { enrolledSince: '2026-01-01', endedAt: null },
        // An ENDED enrolment is not a current one — it must come back
        // unchecked, or re-saving would silently revive it.
        jp: { enrolledSince: '2026-01-01', endedAt: '2026-06-30' },
      },
      bpjsSalaryBase: '4500000.00',
    } as never);

    render(<EmployeeTaxProfilesEditor />);
    fireEvent.click(await screen.findByText('Sari Baru'));

    await waitFor(() =>
      expect((screen.getByLabelText(/Kode PTKP/i) as HTMLSelectElement).value).toBe('TK/0'),
    );
    expect(screen.getByLabelText(/Kesehatan/i)).toBeChecked();
    expect(screen.getByLabelText(/^JP$/i)).not.toBeChecked();
    expect(screen.getByLabelText(/NPWP/i)).toHaveValue('01.234.567.8-901.000');
  });
});
