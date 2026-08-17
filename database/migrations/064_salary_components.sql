-- Migration: 064_salary_components
-- Block: 060-069 (HR & payroll)
-- Description: salary component master (PIN-01..07, POUT-01..09, + Amendment
--              1 statutory codes) + per-employee assignment overrides.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE salary_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(40) UNIQUE NOT NULL,              -- PayrollComponentCode enum (§2)
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('earning','deduction','employer_cost')),
    -- 'employer_cost' (Amendment 1): BPJS employer shares — company cost lines, never net-pay-affecting;
    -- shown as an info section on the slip, posted Dr Beban BPJS / Cr Hutang BPJS
  is_statutory BOOLEAN NOT NULL DEFAULT false,   -- Amendment 1: statutory rows compute only when payroll.statutory enabled
  calc_method VARCHAR(20) NOT NULL CHECK (calc_method IN ('fixed','per_day','per_hour','formula','manual')),
  formula_key VARCHAR(50),                       -- calculator in packages/shared: 'overtime','late_penalty',
                                                  -- 'absence','so_shortfall','loan_installment','attendance_bonus','tenure'
  default_amount NUMERIC(18,2),
  is_system BOOLEAN NOT NULL DEFAULT false,      -- seeded rows are system rows (non-deletable)
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON salary_components
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE employee_salary_components (        -- per-employee amount overrides (tunjangan jabatan, insentif, dll)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  component_id UUID NOT NULL REFERENCES salary_components(id),
  amount NUMERIC(18,2),                          -- NULL = use component default/formula
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, component_id, effective_from)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON employee_salary_components
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =============================================================================
-- SEED — the 16 base PRD components (always active) + Amendment 2's
-- deduction_cash_variance + the 9 Amendment 1 statutory rows (is_statutory
-- = true; dormant until settings 'payroll.statutory.enabled' = true).
-- =============================================================================

INSERT INTO salary_components (code, name, type, is_statutory, calc_method, formula_key, is_system, sort_order) VALUES
  ('base_salary',               'Gaji Pokok',                 'earning',   false, 'fixed',   NULL,                 true, 10),
  ('overtime',                  'Lembur',                     'earning',   false, 'formula', 'overtime',           true, 20),
  ('attendance_allowance',      'Tunjangan Kehadiran',        'earning',   false, 'formula', 'attendance_bonus',   true, 30),
  ('performance_incentive',     'Insentif Kinerja',           'earning',   false, 'manual',  NULL,                 true, 40),
  ('tenure_allowance',          'Tunjangan Masa Kerja',       'earning',   false, 'formula', 'tenure',             true, 50),
  ('position_allowance',        'Tunjangan Jabatan',          'earning',   false, 'fixed',   NULL,                 true, 60),
  ('other_earning',             'Pendapatan Lainnya',         'earning',   false, 'manual',  NULL,                 true, 70),
  ('deduction_sick',            'Potongan Sakit',              'deduction', false, 'formula', 'late_penalty',       true, 110),
  ('deduction_permission',      'Potongan Izin',               'deduction', false, 'formula', 'late_penalty',       true, 120),
  ('deduction_absence',         'Potongan Alpha',              'deduction', false, 'formula', 'absence',            true, 130),
  ('deduction_leave_excess',    'Potongan Cuti Melebihi Kuota', 'deduction', false, 'formula', 'absence',           true, 140),
  ('deduction_stock_shortfall', 'Potongan Selisih Stok',       'deduction', false, 'formula', 'so_shortfall',       true, 150),
  ('deduction_loan_installment','Potongan Cicilan Kasbon',     'deduction', false, 'formula', 'loan_installment',   true, 160),
  ('deduction_late',            'Potongan Keterlambatan',      'deduction', false, 'formula', 'late_penalty',       true, 170),
  ('other_deduction',           'Potongan Lainnya',            'deduction', false, 'manual',  NULL,                 true, 180),
  ('deduction_cash_variance',   'Potongan Selisih Kas Shift',  'deduction', false, 'formula', 'so_shortfall',       true, 190),
  -- Amendment 1 — statutory (dormant unless payroll.statutory.enabled = true)
  ('bpjs_kesehatan_employee',   'BPJS Kesehatan (Karyawan)',   'deduction',     true, 'formula', 'bpjs_employee',   true, 210),
  ('bpjs_jht_employee',         'BPJS JHT (Karyawan)',         'deduction',     true, 'formula', 'bpjs_employee',   true, 220),
  ('bpjs_jp_employee',          'BPJS JP (Karyawan)',          'deduction',     true, 'formula', 'bpjs_employee',   true, 230),
  ('pph21',                     'PPh 21',                      'deduction',     true, 'formula', 'pph21',           true, 240),
  ('bpjs_kesehatan_employer',   'BPJS Kesehatan (Perusahaan)', 'employer_cost', true, 'formula', 'bpjs_employer',   true, 310),
  ('bpjs_jht_employer',         'BPJS JHT (Perusahaan)',       'employer_cost', true, 'formula', 'bpjs_employer',   true, 320),
  ('bpjs_jkk_employer',         'BPJS JKK (Perusahaan)',       'employer_cost', true, 'formula', 'bpjs_employer',   true, 330),
  ('bpjs_jkm_employer',         'BPJS JKM (Perusahaan)',       'employer_cost', true, 'formula', 'bpjs_employer',   true, 340),
  ('bpjs_jp_employer',          'BPJS JP (Perusahaan)',        'employer_cost', true, 'formula', 'bpjs_employer',   true, 350)
ON CONFLICT (code) DO NOTHING;

COMMIT;
