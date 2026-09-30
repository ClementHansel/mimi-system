"""Extract the 22 outlet S.O workbooks (April 2026 period, 29 Mar - 28 Apr) into flat CSVs.

Outputs (in OUT):
  so_items.csv    outlet,section,item,unit,price,stock_awal,stock_masuk,stock_akhir,pemakaian,waste,row
  stock_in.csv    outlet,date,item,unit,price,qty
  pmix.csv        outlet,date,group,product,raw_name,tw,price,waste_before,waste_after,double,sisa,meal,jumat,qty,amount
  recipes_raw.csv outlet,item,unit,product_raw,coef
"""
import openpyxl, glob, re, csv, sys, os, datetime, warnings
from openpyxl.utils import column_index_from_string, get_column_letter
warnings.filterwarnings("ignore")

DATA = os.environ["CLIENT_DATA_DIR"]  # folder holding SO/, Gaji/, Pembukuan/, "Tagihan mingguan"/ (the client's Drive folders)
SRC = f"{DATA}/SO"
OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
START = datetime.date(2026, 3, 29)
DAYS = 31

def num(v):
    if v is None or v == "": return 0.0
    if isinstance(v, (int, float)): return float(v)
    try: return float(str(v).replace(",", ""))
    except ValueError: return 0.0

def clean(s):
    return re.sub(r"\s+", " ", str(s)).strip() if s is not None else ""

def outlet_code(path):
    m = re.search(r"S\.O (M\d+)", os.path.basename(path))
    return m.group(1)

files = sorted(glob.glob(f"{SRC}/**/S.O M*.xlsx", recursive=True))
w_items = csv.writer(open(f"{OUT}/so_items.csv", "w", newline="", encoding="utf-8"))
w_items.writerow("outlet,section,item,unit,price,stock_awal,stock_masuk,stock_akhir,pemakaian,waste,row".split(","))
w_in = csv.writer(open(f"{OUT}/stock_in.csv", "w", newline="", encoding="utf-8"))
w_in.writerow("outlet,date,item,unit,price,qty".split(","))
w_pm = csv.writer(open(f"{OUT}/pmix.csv", "w", newline="", encoding="utf-8"))
w_pm.writerow("outlet,date,group,product,raw_name,tw,price,waste_before,waste_after,double,sisa,meal,jumat,qty,amount".split(","))
w_rc = csv.writer(open(f"{OUT}/recipes_raw.csv", "w", newline="", encoding="utf-8"))
w_rc.writerow("outlet,item,unit,product_raw,coef".split(","))
w_ri = csv.writer(open(f"{OUT}/recipes_item.csv", "w", newline="", encoding="utf-8"))
w_ri.writerow("outlet,item,qty_group,product_raw,coef".split(","))

STOP_GROUPS = {"Other"}  # component rows (bags, grams) — not sellable menu
for f in files:
    code = outlet_code(f)
    wb = openpyxl.load_workbook(f, read_only=True, data_only=True)

    # ---- SO sheet: item master + period totals
    ws = wb["SO"]
    section = ""
    for i, r in enumerate(ws.iter_rows(min_row=6, max_col=21, values_only=True), start=6):
        a, b = r[0], r[1]
        if a not in (None, "") and b in (None, ""):
            section = clean(a); continue
        if b in (None, "") or not isinstance(r[3], (int, float)) and r[3] not in (None, ""):
            # header repeats / totals
            if b in (None, ""): continue
        name = clean(b)
        if not name or name.upper().startswith("TOTAL"): continue
        w_items.writerow([code, section, name, clean(r[2]).upper(), num(r[3]), num(r[4]), num(r[6]), num(r[8]), num(r[10]), num(r[12]), i])

    # ---- STOK MASUK: daily receipts per item
    ws = wb["STOK MASUK"]
    for r in ws.iter_rows(min_row=6, max_col=37, values_only=True):
        name = clean(r[1])
        if not name: continue
        for d in range(DAYS):
            q = num(r[4 + d])
            if q:
                w_in.writerow([code, (START + datetime.timedelta(days=d)).isoformat(), name, clean(r[2]).upper(), num(r[3]), q])

    # ---- PM-WASTE: daily product mix
    ws = wb["PM-WASTE"]
    group = ""
    rowname = {}
    for i, r in enumerate(ws.iter_rows(min_row=7, max_col=3 + 8 * DAYS, values_only=True), start=7):
        a, b = r[0], r[1]
        if a not in (None, "") and b in (None, ""):
            group = clean(a); continue
        raw = clean(b)
        if not raw: continue
        if raw.upper() in ("NETT SALES", "BILL FOC", "BILL DISCOUNT", "ITEM SALES", "S E L I S I H"): continue
        rowname[i] = (group, raw, num(r[2]))
        if group in STOP_GROUPS: continue
        tw = bool(re.search(r"\bTW$", raw, re.I))
        product = re.sub(r"\s*\bTW$", "", raw, flags=re.I).strip()
        product = re.sub(r"^Es The$", "Es Teh", product, flags=re.I)
        for d in range(DAYS):
            base = 3 + 8 * d
            vals = [num(r[base + k]) for k in range(8)]
            if any(vals):
                w_pm.writerow([code, (START + datetime.timedelta(days=d)).isoformat(), group, product, raw, int(tw), num(r[2])] + vals)
    wb.close()

    # ---- QTY formulas -> recipe coefficients. Columns D..G ("Take Away/Dine
    # In") are linear in the TOTAL-block sold-qty column IR of PM-WASTE; the
    # sum of their IR coefficients per menu row is the per-portion usage.
    wbf = openpyxl.load_workbook(f, read_only=True, data_only=False)
    wbv = openpyxl.load_workbook(f, read_only=True, data_only=True)
    qty_names = {i: clean(r[1]) for i, r in enumerate(wbv["QTY"].iter_rows(min_row=1, max_col=3, values_only=True), 1)}
    so_names = {i: clean(r[1]) for i, r in enumerate(wbv["SO"].iter_rows(min_row=1, max_col=3, values_only=True), 1)}
    wbv.close()
    qty_coefs = {}  # qty row -> {pm row: coef}
    for qrow, r in enumerate(wbf["QTY"].iter_rows(min_row=1, max_col=7, values_only=True), 1):
        if qrow < 6 or not qty_names.get(qrow): continue
        name = qty_names[qrow]
        coefs = {}
        for formula in r[3:7]:
            if not isinstance(formula, str) or not formula.startswith("="): continue
            expr = formula[1:]
            e = re.sub(r"SUM\('PM-WASTE'!([A-Z]+)(\d+):([A-Z]+)(\d+)\)",
                       lambda m: "(" + "+".join(f"V('{m.group(1)}',{k})" for k in range(int(m.group(2)), int(m.group(4)) + 1)) + ")"
                       if m.group(1) == m.group(3) else "0", expr)
            e = re.sub(r"'PM-WASTE'!([A-Z]+)(\d+)", lambda m: f"V('{m.group(1)}',{m.group(2)})", e)
            e = re.sub(r"(?<![A-Za-z'])([A-Z]{1,2})(\d+)(?![\d(])", "0", e)  # same-sheet refs (subtotals)
            rows_ir = {int(k) for k in re.findall(r"V\('IR',(\d+)\)", e)}
            for row in rows_ir:
                try:
                    val = eval(e, {"V": lambda c, k, row=row: 1.0 if (c == "IR" and k == row) else 0.0})
                except Exception as ex:
                    print("formula fail", code, name, formula[:80], ex, file=sys.stderr); continue
                coefs[row] = coefs.get(row, 0.0) + val
        qty_coefs[qrow] = coefs
        for row, coef in sorted(coefs.items()):
            if abs(coef) > 1e-12 and row in rowname:
                w_rc.writerow([code, name, "", rowname[row][1], round(coef, 6)])
    # SO item -> QTY row (+ divisor), read from the SO sheet's TW / DINE IN formulas
    for srow, r in enumerate(wbf["SO"].iter_rows(min_row=1, max_col=17, values_only=True), 1):
        item = so_names.get(srow)
        if srow < 7 or not item: continue
        for formula in (r[15], r[16]):
            if not isinstance(formula, str): continue
            fx = formula.replace(" ", "")
            m = re.match(r"^=\(?QTY!([A-Z]+)(\d+)(?:\+QTY!([A-Z]+)(\d+))?\)?(?:/(\d+(?:\.\d+)?))?$", fx)                 or re.match(r"^=SUM\(QTY!([A-Z]+)(\d+):([A-Z]+)(\d+)\)(?:/(\d+(?:\.\d+)?))?$", fx)
            if not m: continue
            qrow = int(m.group(2)); div = float(m.group(5) or 1)
            for row, coef in qty_coefs.get(qrow, {}).items():
                if abs(coef) > 1e-12 and row in rowname:
                    w_ri.writerow([code, item, qty_names.get(qrow, ""), rowname[row][1], round(coef / div, 8)])
            break
    wbf.close()
    print("done", code, file=sys.stderr)
