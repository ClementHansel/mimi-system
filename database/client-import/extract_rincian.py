"""Outlet expense ledger (4. Rincian pengeluaran April 2026, sheets M*): left = invoices paid, right = ops transfers."""
import openpyxl, csv, sys, re, datetime, warnings
warnings.filterwarnings("ignore")
OUT = sys.argv[1]
import os
DATA = os.environ["CLIENT_DATA_DIR"]  # folder holding SO/, Gaji/, Pembukuan/, "Tagihan mingguan"/ (the client's Drive folders)
f = f"{DATA}/Pembukuan/4. Rincian pengeluaran April 2026.xlsx"
wb = openpyxl.load_workbook(f, read_only=True, data_only=True)
w = csv.writer(open(f"{OUT}/expenses.csv", "w", newline="", encoding="utf-8"))
w.writerow(["outlet","side","transfer_date","transfer_label","invoice_date","description","qty","amount","note","category"])
clean = lambda s: re.sub(r"\s+", " ", str(s)).strip() if s is not None else ""
iso = lambda d: d.date().isoformat() if isinstance(d, datetime.datetime) else ""
for ws in wb.worksheets:
    if not re.fullmatch(r"M\d+", ws.title): continue
    lt = None; rt = None
    for r in ws.iter_rows(min_row=5, max_col=20, values_only=True):
        if r[1] not in (None, ""): lt = r[1]
        if r[3] and isinstance(r[7], (int, float)) and r[7]:
            w.writerow([ws.title, "invoice", iso(lt), clean(lt) if not isinstance(lt, datetime.datetime) else "", iso(r[5]), clean(r[3]), r[6] if isinstance(r[6], (int, float)) else "", r[7], clean(r[8]), clean(r[9])])
        if r[12] not in (None, ""): rt = r[12]
        if r[14] and isinstance(r[15], (int, float)) and r[15]:
            w.writerow([ws.title, "transfer", iso(rt), "", "", clean(r[14]), "", r[15], "", clean(r[16])])
