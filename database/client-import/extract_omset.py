"""Per-outlet daily sales by payment channel, from the outlets' own OMSET workbooks (SO/<outlet>/*OMSET*).

The finance-side "Sales All Resto" sheet is only filled to 8 Apr; the outlets' omset reports cover the
whole period with GoFood / GrabFood / ShopeeFood / GoPay / ShopeePay / QRIS / transfer / voucher / cash
columns. Their headers and even their dates are inconsistent (M20 typed 2025, M24's April sheet still
carries January dates), so a row is NOT placed by its date cell: it is matched to the outlet-day whose
product-mix total (qty x price from PM-WASTE, see extract_so.py) equals the row's TOTAL. A row whose
total matches no day is ignored, and every day left unmatched is listed.

    python extract_omset.py <out_dir>        (needs <out_dir>/pmix.csv)
Writes <out_dir>/omset.csv: outlet,date,cash,qris,gopay,shopeepay,gofood,grabfood,shopeefood,transfer,voucher,total,source
"""
import openpyxl, glob, re, csv, sys, os, datetime, warnings, collections
import pandas as pd
warnings.filterwarnings("ignore")
DATA = os.environ["CLIENT_DATA_DIR"]
OUT = sys.argv[1]

ALIASES = {
    "cash": ["CASH", "UANG TUNAI", "TUNAI"],
    "qris": ["QRIS BTN", "QRIS", "BTN"],
    "gopay": ["GOPAY", "GPAY"],
    "shopeepay": ["SPAY", "SHOPEEPAY", "SHOPEPAY", "SHOPEE"],
    "gofood": ["GOFOOD", "GFOD", "GFOOD", "GOJEK"],
    "grabfood": ["GRAB", "GRABFOOD"],
    "shopeefood": ["SFOOD", "SFOD", "SHOPEFOOD", "SHOPEEFOOD", "SHOPEE FOOD", "SHOPE FOOD"],
    "transfer": ["TRANSFER", "TRASFER", "TF"],
    "voucher": ["VOUCHER", "VOCER"],
    "total": ["TOTAL", "TOTAL SALES", "TOTAL PER HARI"],
}
KEY = {a: k for k, al in ALIASES.items() for a in al}
METHODS = [k for k in ALIASES if k != "total"]

pm = pd.read_csv(f"{OUT}/pmix.csv")
day_total = (pm.qty * pm.price).groupby([pm.outlet, pm.date]).sum()
by_outlet = collections.defaultdict(dict)
for (o, d), v in day_total.items(): by_outlet[o][d] = float(v)

def outlet_of(path):
    name = os.path.basename(path).upper()
    m = re.search(r"\bM(?:C)?\s*(\d+)\b", name.replace("MC ", "MC").replace("-", " "))
    return f"M{int(m.group(1))}" if m else None

def num(v):
    if isinstance(v, (int, float)): return float(v)
    try: return float(str(v).replace(",", "")) if v not in (None, "") else 0.0
    except ValueError: return 0.0

rows_out, report = [], []
files = sorted(set(glob.glob(f"{DATA}/SO/**/*OMSET*.xlsx", recursive=True) + glob.glob(f"{DATA}/SO/**/*Omset*.xlsx", recursive=True)))
for f in files:
    o = outlet_of(f)
    if o not in by_outlet: report.append(f"skip {os.path.basename(f)} (outlet {o})"); continue
    days = by_outlet[o]
    wb = openpyxl.load_workbook(f, read_only=True, data_only=True)
    best = None
    for ws in wb.worksheets:
        grid = list(ws.iter_rows(min_row=1, max_row=80, max_col=25, values_only=True))
        for hi, r in enumerate(grid):
            cols = {}
            for j, v in enumerate(r):
                k = KEY.get(re.sub(r"\s+", " ", str(v)).strip().upper()) if v is not None else None
                if k and k not in cols.values(): cols[j] = k
            if "total" not in cols.values() or len(cols) < 3: continue
            matched = {}
            for r2 in grid[hi + 1:]:
                vals = {k: num(r2[j]) for j, k in cols.items() if j < len(r2)}
                t = vals.get("total", 0)
                if t <= 0: continue
                hit = [d for d, v in days.items() if abs(v - t) <= max(1000, 0.001 * v) and d not in matched]
                if len(hit) == 1: matched[hit[0]] = vals
                elif len(hit) > 1:
                    dc = next((c for c in r2 if isinstance(c, datetime.datetime)), None)
                    pick = [d for d in hit if dc and d[5:] == dc.strftime("%m-%d")]
                    if pick: matched[pick[0]] = vals
            if best is None or len(matched) > len(best[1]): best = (ws.title, matched, cols)
            break
    if not best or not best[1]:
        report.append(f"{o}: no omset rows matched ({os.path.basename(f)})"); continue
    title, matched, cols = best
    for d, vals in sorted(matched.items()):
        split = {m: vals.get(m, 0.0) for m in METHODS}
        rows_out.append([o, d] + [split[m] for m in METHODS] + [vals["total"], f"{os.path.basename(f)}#{title}"])
    missing = sorted(set(days) - set(matched))
    report.append(f"{o}: {len(matched)}/{len(days)} days matched from '{title}' (columns {sorted(set(cols.values()))})" + (f"; unmatched {missing}" if missing else ""))

# one file per outlet: if an outlet appears twice, keep the file that matched more days
df = pd.DataFrame(rows_out, columns=["outlet", "date"] + METHODS + ["total", "source"])
df["n"] = df.groupby(["outlet", "source"]).date.transform("count")
df = df.sort_values("n", ascending=False).drop_duplicates(["outlet", "date"]).drop(columns="n").sort_values(["outlet", "date"])
# A row whose method columns do not add up to its TOTAL: in every case seen the cash cell is the one left
# empty or stale (M8 23-25 Apr have no cash at all), so the difference is booked to cash and the row is
# listed in omset_report.txt. A difference larger than the cash cell itself would make cash negative —
# those rows keep their methods scaled to TOTAL instead.
df["residual"] = df.total - df[METHODS].sum(axis=1)
fix = df.residual.abs() > 1000
for i in df[fix].index:
    if df.at[i, "cash"] + df.at[i, "residual"] >= 0:
        df.at[i, "cash"] += df.at[i, "residual"]
    else:
        s = df.loc[i, METHODS].sum()
        df.loc[i, METHODS] = df.loc[i, METHODS] * (df.at[i, "total"] / s)
df.to_csv(f"{OUT}/omset.csv", index=False)
with open(f"{OUT}/omset_report.txt", "w", encoding="utf-8") as fh:
    fh.write("\n".join(report) + "\n")
    bad = df[df.residual.abs() > 1000]
    fh.write(f"\nrows whose method columns do not sum to TOTAL: {len(bad)}\n" + bad[["outlet", "date", "total", "residual"]].to_string() + "\n")
print("\n".join(report))
print(f"omset rows {len(df)}; residual rows {int((df.residual.abs() > 1000).sum())}")
