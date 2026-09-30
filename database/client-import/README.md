# Client data import (Mimi Chicken, April 2026 period)

Turns the client's own working spreadsheets into a live database: master data plus one full
accounting period (29 Mar – 28 Apr 2026). It replaced the demo data on production on
2026-10-01 so the client could try the system with their real numbers.

The spreadsheets are **not** in git. They hold payslips and bank account numbers. Point
`CLIENT_DATA_DIR` at a folder containing the client's four Drive folders, unzipped:

```
$CLIENT_DATA_DIR/
  SO/                 per-outlet S.O workbooks (QTY, PM-WASTE, STOK MASUK, SO sheets) + waste/omset files
  Gaji/               per-outlet payslip workbooks (TABEL GAJI sheet)
  Pembukuan/          "Sales All Resto dan Store", "4. Rincian pengeluaran", transfer proofs
  Tagihan mingguan/   weekly supplier/outlet bills
```

## Running it

It is destructive: it wipes demo history, catalog and HR records in the target database. Always
run it against a restored copy first, then ship that verified copy.

```bash
pg_restore ... into a scratch database            # a fresh copy of the target
CLIENT_DATA_DIR=... DATABASE_MIGRATION_URL=postgres://owner@host/scratch \
  bash database/client-import/run.sh ./out scratch
```

Steps, all in `run.sh`:

1. `extract_*.py` read the workbooks into flat CSVs in `out/`. `extract_so.py` also recovers
   the recipes by evaluating the QTY sheet's formulas. Each ingredient row is linear in the
   PM-WASTE sold-quantity column, so setting one menu row to 1 gives its per-portion usage.
2. `build_locations.py` and `build_master.py` normalise units, items (SKUs by category prefix,
   April weighted average cost), menu products, recipes, suppliers and supplier prices into the
   shape `database/import.ts` takes (`out/import/`).
3. `migrate.ts`, then `wipe-demo.ts --catalog --hr`. Logins, roles, settings and the chart of
   accounts survive.
4. `prep.py` renames the demo locations in place to the real outlets. Every login keeps its
   outlet scope because the location ids do not change. It also adds missing outlets and their
   storage areas, and creates the menu categories.
5. `import.ts --commit` loads units, categories, locations, items, products and recipes.
6. `load_history.py --commit` loads the period in one transaction with deterministic ids:
   - opening stock
   - daily receipts
   - one recap sale per outlet per day, with payment rows
   - recipe usage
   - waste, staff meals and Jum'at Berkah
   - the closing stock count with its adjustments
   - the 7 Apr payment run as paid PVs
   - the April payroll run
   - employees, with existing logins re-linked to real people
   - a journal entry for every one of these

   It asserts that every outlet × item closing balance equals the counted S.O stock and that
   the trial balance nets to zero, otherwise it rolls back.

Read `out/load_log.txt`, `out/master/notes.txt` and `out/master/recipe_calibration.csv` after
every run. They list everything the data forced a decision on.

## Decisions baked in

- **Sales are daily recaps, not receipts.** The files only have per-day product mix and
  per-day payment totals. Inventing individual transactions would be fabricated data, so the
  dashboards show 1 transaction per outlet per day.
- **Payment split.** Finance filled the per-method sheet only up to 8 Apr. Later days use
  that outlet's own April mix, and those payment rows are marked `ESTIMASI` in their reference.
- **Online platforms have no payment method.** GoFood, GrabFood, ShopeeFood, GoPay and
  ShopeePay are recorded as `qris` with the platform name in the reference.
- **Line value is qty × price.** The sheet's amount column has 7 formula errors (M5
  Chicken Fire 6 Apr reads Rp 492 million), so it is not used.
- **Dine-in and take-away rows merge into one product.** The recipe is the sales-weighted
  average of the two rows, not their sum.
- **Recipes are stored per 100 portions (`yield_qty = 100`).** `recipe_lines.qty` has 3
  decimals, and per-portion amounts like 1/1100 box of frying fat would otherwise round 10%
  off.
- **Calibrated recipes.** Where a sheet formula is plainly in the wrong unit (Teh Saring =
  "1 pack per glass"), the ingredient's per-portion quantity is scaled so April's modelled
  usage equals actual usage. This applies only beyond ±50%, and every case is listed in
  `recipe_calibration.csv`.
- **Closing stock is the count.** Recipe usage is theoretical. The 28 Apr opname brings
  every balance to the counted S.O figure and books the difference as a stock variance.
  Modelled cost of goods plus waste plus net variance equals the sheets' own consumed value
  (64.2% of sales).
- **Payroll** is approved, not paid, because the files carry no payment date. It is posted
  directly because the app's own payroll GL path posts zero (`resolvePayrollAccrualLegs` reads
  context keys the run never publishes).
- **MinIO is left alone.** Demo photo objects stay in the bucket, orphaned, so restoring the
  pre-cut-over dump still finds them. Clear the bucket once there is no going back.
- **Not imported:**
  - the sister brand Arizona (A1–A3 sheets)
  - warehouse purchasing (outlets pay the warehouse; importing both would double count)
  - attendance (the payslips carry day counts, not dates)
  - employment contracts (they need signatures)
