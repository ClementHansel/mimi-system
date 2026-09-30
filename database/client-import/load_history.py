"""Load the client's April 2026 period (29 Mar - 28 Apr) into a wiped + master-imported database.

Run AFTER:  wipe-demo --catalog --hr --commit,  remap_locations.sql,  import.ts --commit (units..recipes).
One transaction; deterministic UUIDs (uuid5) so a failed run leaves nothing and a re-run on a fresh
wipe produces identical ids.

    python load_history.py <out_dir> [--commit]
"""
import csv, os, sys, uuid, math, datetime as dt, collections, re
from decimal import Decimal, ROUND_HALF_UP
import pandas as pd
import psycopg

OUT = sys.argv[1]
COMMIT = "--commit" in sys.argv
NS = uuid.UUID("5b1f3a52-8c1e-4d7a-9f00-a11c0a7e2026")
SALE_DAY_NS = uuid.UUID("6f9c8a52-3f4f-5c1e-9a7b-2d0e6c1b8f43")  # daily-posting.service.ts ref_id namespace
uid = lambda *parts: str(uuid.uuid5(NS, "|".join(map(str, parts))))
WITA = dt.timezone(dt.timedelta(hours=8))
def ts(date, hh=0, mm=0): return dt.datetime.fromisoformat(date).replace(hour=hh, minute=mm, tzinfo=WITA)
def money(x): return Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
def qty3(x): return Decimal(str(x)).quantize(Decimal("0.001"), rounding=ROUND_HALF_UP)
PERIOD_START, PERIOD_END = "2026-03-29", "2026-04-28"
BPP = {"M1","M3","M7","M16","M17","M18","M20","M24","M25"}
log = []
def note(msg): log.append(msg); print(msg)

url = os.environ["DATABASE_MIGRATION_URL"]
con = psycopg.connect(url, autocommit=False)
cur = con.cursor()
q = lambda sql, *a: cur.execute(sql, a if a else None)
one = lambda sql, *a: (cur.execute(sql, a if a else None), cur.fetchone())[1]
rows = lambda sql, *a: (cur.execute(sql, a if a else None), cur.fetchall())[1]

# ------------------------------------------------------------------ lookups
tenant = one("SELECT app_the_only_tenant()")[0]
loc = {c: i for c, i in rows("SELECT code, id FROM locations")}
area = {(l, c): i for l, c, i in rows("SELECT location_id, code, id FROM storage_areas WHERE is_active")}
item = {s: dict(id=i, unit=u, storage=st) for s, i, u, st in rows("SELECT sku, id, base_unit_id, storage_type FROM items")}
prod = {c: i for c, i in rows("SELECT code, id FROM products")}
acct = {c: i for c, i in rows("SELECT code, id FROM chart_of_accounts")}
comp = {c: i for c, i in rows("SELECT code, id FROM salary_components")}
role_users = collections.defaultdict(list)
for uid_, rk, lcode in rows("""SELECT u.id, r.key, l.code FROM users u JOIN roles r ON r.id = u.role_id
                               LEFT JOIN user_locations ul ON ul.user_id = u.id LEFT JOIN locations l ON l.id = ul.location_id
                               WHERE u.is_active ORDER BY u.username"""):
    role_users[(rk, lcode)].append(uid_)
owner = one("SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE r.key='owner' ORDER BY u.created_at LIMIT 1")[0]
finance = (one("SELECT u.id FROM users u JOIN roles r ON r.id=u.role_id WHERE r.key='finance' ORDER BY u.username LIMIT 1") or (owner,))[0]
AREA_FOR = {"frozen": "FRZ", "chilled": "CHL", "dry": "DRY"}
outlets = sorted([c for c in loc if re.fullmatch(r"M\d+", c)], key=lambda c: int(c[1:]))
assert len(outlets) == 22, outlets
def area_of(lcode, sku): return area[(loc[lcode], AREA_FOR[item[sku]["storage"]])]
def staff(lcode, *roles):
    for r in roles:
        if role_users.get((r, lcode)): return role_users[(r, lcode)][0]
    return owner

# ------------------------------------------------------------------ inputs
item_costs = pd.read_csv(f"{OUT}/master/item_costs.csv").set_index("sku")
item_map = pd.read_csv(f"{OUT}/master/item_map.csv")
imap = {(r.outlet, r.item): r.sku for r in item_map.itertuples()}
pmap = {(r.outlet, r.raw_name): r.code for r in pd.read_csv(f"{OUT}/master/product_map.csv").itertuples()}
recipes = pd.read_csv(f"{OUT}/import/recipes.csv")
per_portion = collections.defaultdict(dict)  # product code -> sku -> qty per portion (as the system will compute it)
for r in recipes.itertuples(): per_portion[r.product_code][r.item_sku] = float(r.qty) / float(r.yield_qty)
nkey = lambda s: re.sub(r"[^a-z0-9]+", " ", str(s).lower()).strip()
name_map = dict(pd.read_csv(f"{OUT}/master/name_map.csv").values)
so = pd.read_csv(f"{OUT}/so_items.csv"); so["sku"] = [imap[(o, i)] for o, i in zip(so.outlet, so["item"])]
sin = pd.read_csv(f"{OUT}/stock_in.csv"); sin["sku"] = [imap.get((o, i)) or name_map.get(nkey(i)) for o, i in zip(sin.outlet, sin["item"])]
if sin.sku.isna().any():
    x = sin[sin.sku.isna()]
    note(f"stock-in rows for things that are not stock items, NOT imported: {x.groupby('item').qty.sum().to_dict()} (Rp {x.qty.mul(x.price).sum():,.0f})")
sin = sin.dropna(subset=["sku"])
pm = pd.read_csv(f"{OUT}/pmix.csv"); pm["code"] = [pmap.get((o, n)) for o, n in zip(pm.outlet, pm.raw_name)]
dropped = pm[pm.code.isna()]; pm = pm[pm.code.notna()]
note(f"pmix rows kept {len(pm)}, dropped (add-ons/unpriced) {len(dropped)} worth Rp {dropped.qty.mul(dropped.price).sum():,.0f}")
pay = pd.read_csv(f"{OUT}/sales_payments.csv")
avg = {s: float(item_costs.loc[s, "avg_cost"]) for s in item_costs.index}

# ------------------------------------------------------------------ helpers
counters = collections.Counter()
def docno(prefix, when):
    return one("SELECT allocate_document_number(%s, %s)", prefix, when[:7].replace("-", ""))[0]
movements = []   # (id, loc, area, item, type, qty, unit_cost, ref_type, ref_id, reason, occurred_at, actor, counterparty_loc)
def move(lcode, sku, mtype, qty, cost, ref_type, ref_id, when, reason=None, actor=None):
    if qty <= 0: return
    movements.append((uid("mv", ref_type, ref_id, sku, mtype), loc[lcode], area_of(lcode, sku), item[sku]["id"], mtype,
                      qty3(qty), money(cost), ref_type, ref_id, reason, when, actor))
journals = []    # (je_id, date, event_type, ref_type, ref_id, location_id, description, [(acct, dr, cr, memo)])
def je(date, event, ref_type, ref_id, lcode, desc, legs):
    legs = [(a, money(d), money(c), m) for a, d, c, m in legs if money(d) != 0 or money(c) != 0]
    if not legs: return
    dr = sum(l[1] for l in legs); cr = sum(l[2] for l in legs)
    assert dr == cr, (event, ref_id, dr, cr)
    journals.append((uid("je", event, ref_type, ref_id), date, event, ref_type, ref_id, loc.get(lcode) if lcode else None, desc, legs))

def copy(table, cols, data):
    if not data: return 0
    with cur.copy(f"COPY {table} ({', '.join(cols)}) FROM STDIN") as cp:
        for r in data: cp.write_row(r)
    return len(data)

# ================================================================== 1. periods + costs
for code, start, end in [("2026-03", "2026-03-01", "2026-03-31"), ("2026-04", "2026-04-01", "2026-04-30")]:
    q("""INSERT INTO fiscal_periods (period_code, start_date, end_date, status) VALUES (%s, %s, %s, 'open')
         ON CONFLICT (period_code) DO NOTHING""", code, start, end)
fp = {c: i for c, i in rows("SELECT period_code, id FROM fiscal_periods")}
for sku, r in item_costs.iterrows():
    q("UPDATE items SET avg_cost = %s, last_purchase_cost = %s WHERE sku = %s", money(r.avg_cost), money(r.avg_cost), sku)

# ================================================================== 2. suppliers
sups = pd.read_csv(f"{OUT}/master/suppliers.csv"); sitems = pd.read_csv(f"{OUT}/master/supplier_items.csv")
sup_id = {}
for r in sups.itertuples():
    sup_id[r.name] = uid("supplier", r.code)
    q("""INSERT INTO suppliers (id, code, name, payment_terms_days, outlet_visible, notes)
         VALUES (%s, %s, %s, 7, true, 'Imported from weekly outlet bills, April 2026')""", sup_id[r.name], r.code, r.name.title())
best = sitems.sort_values("n", ascending=False).drop_duplicates("sku").set_index(["sup","sku"]).index
for r in sitems.itertuples():
    if r.sup not in sup_id or r.sku not in item: continue
    q("""INSERT INTO supplier_items (supplier_id, item_id, current_price, lead_time_days, is_preferred)
         VALUES (%s, %s, %s, 1, %s)""", sup_id[r.sup], item[r.sku]["id"], money(r.price), (r.sup, r.sku) in best)
    q("""INSERT INTO supplier_price_history (supplier_id, item_id, price, effective_date, source, recorded_by)
         VALUES (%s, %s, %s, %s, 'manual', %s)""", sup_id[r.sup], item[r.sku]["id"], money(r.price), r.last_date if isinstance(r.last_date, str) and r.last_date else PERIOD_START, finance)

# ================================================================== 3. employees + link logins
pr = pd.read_csv(f"{OUT}/payroll.csv", dtype={"bank_account": str})
pr = pr[pr.period.str.upper().str.contains("APRIL")]
UNIT_LOC = {"LOG_BPP": "GDG-BPP", "LOG_STAFF": "GDG-SMD"}
def join_date(tenure):
    t = str(tenure).lower(); y = re.search(r"(\d+)\s*tahun", t); m = re.search(r"(\d+)\s*bulan", t); d = re.search(r"(\d+)\s*hari", t)
    days = (int(y.group(1)) * 365 if y else 0) + (int(m.group(1)) * 30.4 if m else 0) + (int(d.group(1)) if d else 0)
    return (dt.date(2026, 4, 28) - dt.timedelta(days=int(days))) if days else dt.date(2026, 4, 1)
RANK = lambda p: 0 if re.search(r"SPV|KEPALA", p, re.I) else 1 if re.search(r"LEADER", p, re.I) else 2
emp_rows = []
for r in pr.itertuples():
    lcode = UNIT_LOC.get(r.unit, r.unit)
    eid = uid("employee", r.unit, int(r.no), r.name)
    emp_rows.append(dict(id=eid, number=f"{r.unit.replace('_','-')}-{int(r.no):03d}", name=str(r.name).title(), position=str(r.position).strip().title(),
                         loc=lcode, join=join_date(r.tenure), bank=None if pd.isna(r.bank_account) else str(r.bank_account).split(".")[0], row=r))
for e in emp_rows:
    q("""INSERT INTO employees (id, employee_number, name, join_date, employment_status, position, location_id, bank_account_number, bank_account_name)
         VALUES (%s, %s, %s, %s, 'active', %s, %s, %s, %s)""", e["id"], e["number"], e["name"], e["join"], e["position"], loc[e["loc"]], e["bank"], e["name"])
    r = e["row"]
    q("""INSERT INTO employments (employee_id, position, location_id, base_salary, start_date, notes)
         VALUES (%s, %s, %s, %s, %s, 'Imported from April 2026 payroll')""", e["id"], e["position"], loc[e["loc"]], money(r.gaji_pokok or 0), e["join"])
    for code, val in [("base_salary", r.gaji_pokok), ("position_allowance", r.tunj_jabatan), ("tenure_allowance", r.tunj_masa_kerja), ("attendance_allowance", r.tunj_kehadiran)]:
        if val and float(val) > 0:
            q("""INSERT INTO employee_salary_components (employee_id, component_id, amount, effective_from) VALUES (%s, %s, %s, '2026-04-01')""",
              e["id"], comp[code], money(val))
# link existing logins to real people at the same location, by role
linked = 0
by_loc = collections.defaultdict(list)
for e in emp_rows: by_loc[e["loc"]].append(e)
for lcode, emps in by_loc.items():
    emps.sort(key=lambda e: (RANK(e["position"]), e["number"]))
    pools = {"lead": [e for e in emps if RANK(e["position"]) < 2], "crew": [e for e in emps if RANK(e["position"]) == 2]}
    wanted = [("supervisor", "lead"), ("kepala_gudang", "lead"), ("kasir", "crew"), ("koki", "crew"), ("driver", "crew")]
    if lcode.startswith("GDG"):
        pools["crew"] = [e for e in emps if re.search(r"SOPIR|DRIVER", e["position"], re.I)] + [e for e in emps if not re.search(r"SOPIR|DRIVER", e["position"], re.I) and RANK(e["position"]) == 2]
    for role, pool in wanted:
        for u in role_users.get((role, lcode), []):
            if not pools[pool]: break
            e = pools[pool].pop(0)
            q("UPDATE employees SET user_id = %s WHERE id = %s", u, e["id"])
            q("UPDATE users SET name = %s WHERE id = %s", e["name"], u)
            e["user"] = u; linked += 1
            if role == "driver":
                q("INSERT INTO drivers (id, employee_id, user_id, name) VALUES (%s, %s, %s, %s)", uid("driver", e["id"]), e["id"], u, e["name"])
note(f"employees {len(emp_rows)}, logins linked to a real employee {linked}")
emp_by_unit_no = {(e["row"].unit, int(e["row"].no)): e for e in emp_rows}

# ================================================================== 4. stock: opening balances
opening_ref = {o: uid("opening", o) for o in outlets}
open_val = collections.Counter()
for r in so.groupby(["outlet","sku"]).stock_awal.sum().reset_index().itertuples():
    if r.stock_awal > 0:
        move(r.outlet, r.sku, "opening_balance", r.stock_awal, avg[r.sku], "import_opening", opening_ref[r.outlet], ts(PERIOD_START, 0, 1), "Stok awal April 2026 (S.O)")
        open_val[r.outlet] += float(qty3(r.stock_awal)) * float(money(avg[r.sku]))
for o in outlets:
    je(PERIOD_START, "opening_stock", "import_opening", opening_ref[o], o, f"Stok awal outlet {o} per 29 Mar 2026 (impor S.O)",
       [(acct["1110"], open_val[o], 0, "Persediaan outlet"), (acct["3000"], 0, open_val[o], "Saldo awal")])

# ================================================================== 5. receipts (STOK MASUK)
rec = sin.groupby(["outlet","date","sku"]).agg(qty=("qty","sum"), val=("qty", lambda s: 0)).reset_index()
sin["v"] = sin.qty * sin.price
rec = sin.groupby(["outlet","date","sku"]).agg(qty=("qty","sum"), v=("v","sum")).reset_index()
for (o, d), g in rec.groupby(["outlet","date"]):
    ref = uid("receipt", o, d); total = Decimal(0)
    for r in g.itertuples():
        cost = r.v / r.qty if r.qty else avg[r.sku]
        move(o, r.sku, "purchase_in", r.qty, cost, "import_receipt", ref, ts(d, 10), "Stok masuk (S.O)")
        total += qty3(r.qty) * money(cost)
    je(d, "outlet_direct_purchase", "import_receipt", ref, o, f"Stok masuk {o} {d} (impor S.O)",
       [(acct["1110"], total, 0, "Persediaan outlet"), (acct["2000"], 0, total, "Hutang pemasok / gudang")])

# ================================================================== 6. sales (one recap receipt per outlet-day)
METHODS = ["cash","shopeepay","shopeefood","grabfood","gofood","gopay","transfer","qris","voucher"]
SYS_METHOD = {"cash":"cash","shopeepay":"qris","gopay":"qris","qris":"qris","gofood":"qris","grabfood":"qris","shopeefood":"qris","transfer":"bank_transfer","voucher":"cash"}
REF = {"shopeepay":"ShopeePay","gopay":"GoPay","qris":"QRIS BTN","gofood":"GoFood","grabfood":"GrabFood","shopeefood":"ShopeeFood","transfer":"Transfer","voucher":"Voucher"}
known = pay[pay.total > 0].set_index(["outlet","date"])
shares = {o: (g[METHODS].sum() / g[METHODS].sum().sum()) for o, g in pay[pay.total > 0].groupby("outlet")}
shifts, sales, lines, pays = [], [], [], []
usage_cost_day = collections.Counter(); estimated_days = 0
pm["line_total"] = (pm.qty.map(qty3) * pm.price.map(money))
for (o, d), g in pm.groupby(["outlet","date"]):
    kasir = staff(o, "kasir", "supervisor")
    sid, shid = uid("sale", o, d), uid("shift", o, d)
    agg = g.groupby("code").agg(qty=("qty","sum"), price=("price", lambda s: s.value_counts().index[0]), line_total=("line_total","sum")).reset_index()
    agg = agg[agg.qty > 0]
    total = Decimal(0)
    for i, r in enumerate(agg.sort_values("code").itertuples()):
        lt = money(r.line_total); qy = qty3(r.qty)
        unit_price = (lt / qy).quantize(Decimal("0.01")) if qy else money(r.price)
        lines.append((uid("line", sid, r.code), sid, prod[r.code], qy, unit_price, Decimal(0), lt, i))
        total += lt
    # payments: the finance sheet's split where it exists, else this outlet's own April mix (estimated)
    if (o, d) in known.index:
        split = {m: Decimal(str(known.loc[(o, d), m])) for m in METHODS}; est = False
    else:
        split = {m: money(float(total) * float(shares[o][m])) for m in METHODS}; est = True; estimated_days += 1
    stot = sum(split.values())
    grouped = collections.defaultdict(lambda: Decimal(0)); refs = collections.defaultdict(list)
    for m, v in split.items():
        if v <= 0: continue
        v = money(float(v) * float(total) / float(stot)) if stot else Decimal(0)  # scale to the line total
        grouped[SYS_METHOD[m]] += v;
        if m in REF: refs[SYS_METHOD[m]].append(REF[m])
    diff = total - sum(grouped.values()); grouped["cash"] += diff   # rounding lands on cash
    for m, v in grouped.items():
        if v <= 0: continue
        pays.append((uid("pay", sid, m), sid, m, v, ("ESTIMASI · " if est else "") + ", ".join(refs[m]) if (refs[m] or est) else None,
                     {"cash":"paid","qris":"verified","bank_transfer":"verified"}[m]))
    when = ts(d, 21)
    shifts.append((shid, f"{o}-REKAP-{d.replace('-','')}", loc[o], kasir, ts(d, 8), Decimal(0), kasir, ts(d, 23),
                   grouped.get("cash", Decimal(0)), grouped.get("cash", Decimal(0)), Decimal(0), "closed", 1, total, uid("shiftclient", o, d),
                   "Rekap harian impor April 2026"))
    sales.append((sid, f"{o}-{d.replace('-','')}-REKAP", uid("saleclient", o, d), loc[o], shid, kasir, "completed", total, Decimal(0), total, total, Decimal(0),
                  when, "walk_in", "Rekap penjualan harian (impor PM-WASTE April 2026)" + (" · metode bayar estimasi" if est else "")))
    # usage from the SAME recipes the system holds, so COGS and the ledger agree with what POS would post
    use = collections.Counter()
    for r in agg.itertuples():
        for sku, per in per_portion.get(r.code, {}).items(): use[sku] += per * float(r.qty)
    ucost = Decimal(0)
    for sku, qy in use.items():
        move(o, sku, "usage_out", qy, avg[sku], "sale", sid, when, "Pemakaian resep (rekap harian)", kasir)
        ucost += qty3(qy) * money(avg[sku])
    sday = str(uuid.uuid5(SALE_DAY_NS, f"{loc[o]}:{d}"))
    DR = {"cash": "1000", "qris": "1031", "bank_transfer": "1032"}
    je(d, "outlet_sales", "sale_day", sday, o, f"Penjualan {o} {d}",
       [(acct[DR[m]], v, 0, m) for m, v in grouped.items() if v > 0] + [(acct["4000"], 0, total, "Pendapatan penjualan")])
    je(d, "outlet_ingredient_usage", "usage_day", sday, o, f"HPP pemakaian bahan {o} {d}",
       [(acct["5000"], ucost, 0, "HPP"), (acct["1110"], 0, ucost, "Persediaan outlet")])
note(f"sales days {len(sales)}, lines {len(lines)}, payment rows {len(pays)}, days with ESTIMATED payment split {estimated_days}")

# ================================================================== 7. waste, staff meals, Jumat Berkah (product units -> items via recipe)
WASTE_KIND = [("waste", ["waste_before","waste_after"], "production_error", "Waste produksi (sebelum/sesudah)"),
              ("meal", ["meal"], "other", "Makan karyawan"), ("jumat", ["jumat"], "other", "Jum'at Berkah")]
waste_rows = []
for (o, d), g in pm.groupby(["outlet","date"]):
    spv = staff(o, "supervisor", "kasir")
    for kind, cols, reason, detail in WASTE_KIND:
        use = collections.Counter()
        for r in g.itertuples():
            n = sum(float(getattr(r, c) or 0) for c in cols)
            if n <= 0: continue
            for sku, per in per_portion.get(r.code, {}).items():
                # wasted food does not waste its box/bag/cup; staff meals and Jum'at Berkah are served, so they do
                if kind == "waste" and sku.startswith("WDP-"): continue
                use[sku] += per * n
        if not use: continue
        batch = uid("wastebatch", o, d, kind)
        for sku, qy in use.items():
            if qty3(qy) <= 0: continue
            wid = uid("waste", o, d, kind, sku); when = ts(d, 22)
            num = docno("WST", d)
            waste_rows.append((wid, num, batch, loc[o], area_of(o, sku), item[sku]["id"], qty3(qy), money(avg[sku]), reason, detail, "approved", spv, spv, when, when, uid("wasteclient", wid)))
            move(o, sku, "waste_out", qy, avg[sku], "waste_record", wid, when, detail, spv)
            v = qty3(qy) * money(avg[sku])
            je(d, "outlet_waste", "waste_record", wid, o, f"{detail} {o} {d}", [(acct["5100"], v, 0, detail), (acct["1110"], 0, v, "Persediaan outlet")])
note(f"waste/meal/jumat records {len(waste_rows)}")

# ================================================================== 8. write movements so far, then the closing count (S.O stok akhir)
copy("stock_movements", ["id","location_id","storage_area_id","item_id","movement_type","qty","unit_cost","ref_type","ref_id","reason","occurred_at","actor_id"], movements)
n_before = len(movements); movements.clear()
SIGN = "CASE WHEN movement_type IN ('opening_balance','purchase_in','transfer_in','return_in','adjustment_in') THEN qty ELSE -qty END"
sysq = {(l, s): Decimal(v) for l, s, v in rows(f"""SELECT l.code, i.sku, SUM({SIGN}) FROM stock_movements m JOIN locations l ON l.id=m.location_id
                                                  JOIN items i ON i.id=m.item_id GROUP BY 1,2""")}
counted = {(r.outlet, r.sku): qty3(r.stock_akhir) for r in so.groupby(["outlet","sku"]).stock_akhir.sum().reset_index().itertuples()}
opn, opn_lines, adjs = [], [], []
adj_val = collections.Counter()
for o in outlets:
    spv = staff(o, "supervisor", "kasir")
    oid = uid("opname", o); num = docno("OPN", PERIOD_END); when = ts(PERIOD_END, 23, 30)
    opn.append((oid, num, loc[o], None, "adjusted", spv, ts(PERIOD_END, 22), ts(PERIOD_END, 23), owner, when, "Stock opname akhir periode April 2026 (impor S.O)", uid("opnclient", o)))
    skus = sorted({s for (l, s) in sysq if l == o} | {s for (l, s) in counted if l == o})
    n = 0
    for sku in skus:
        sq = qty3(sysq.get((o, sku), 0)); cq = counted.get((o, sku), Decimal(0))
        if sq == 0 and cq == 0: continue
        diff = cq - sq
        opn_lines.append((uid("opnline", oid, sku), oid, area_of(o, sku), item[sku]["id"], sq, cq, diff, "Selisih S.O akhir periode" if diff else None))
        if diff != 0:
            n += 1
            aid = uid("adj", oid, sku)
            adjs.append((aid, f"{num}-ADJ{n}", loc[o], area_of(o, sku), item[sku]["id"], diff, money(avg[sku]), "Selisih stock opname akhir April 2026", "opname", oid, spv, owner, when))
            move(o, sku, "adjustment_in" if diff > 0 else "adjustment_out", abs(diff), avg[sku], "stock_adjustment", aid, when, "Selisih S.O", spv)
            v = abs(diff) * money(avg[sku])
            je(PERIOD_END, "outlet_stock_adjustment", "stock_adjustment", aid, o, f"Selisih stok {o} {sku}",
               [(acct["6400"], v, 0, "Selisih stok"), (acct["1110"], 0, v, "Persediaan outlet")] if diff < 0 else
               [(acct["1110"], v, 0, "Persediaan outlet"), (acct["4100"], 0, v, "Selisih lebih stok")])
copy("stock_opname", ["id","opname_number","location_id","storage_area_id","status","counted_by","started_at","submitted_at","approved_by","approved_at","notes","client_id"], opn)
copy("stock_opname_lines", ["id","opname_id","storage_area_id","item_id","system_qty","counted_qty","diff_qty","variance_reason"], opn_lines)
copy("stock_adjustments", ["id","adjustment_number","location_id","storage_area_id","item_id","qty_delta","unit_cost","reason","source","opname_id","created_by","approved_by","applied_at"], adjs)
copy("stock_movements", ["id","location_id","storage_area_id","item_id","movement_type","qty","unit_cost","ref_type","ref_id","reason","occurred_at","actor_id"], movements)
note(f"stock movements {n_before + len(movements)} (adjustments {len(adjs)}), opname lines {len(opn_lines)}")

# ================================================================== 9. POS rows, waste rows
copy("pos_shifts", ["id","shift_number","location_id","opened_by","opened_at","opening_cash","closed_by","closed_at","closing_cash_counted","expected_cash","cash_variance","status","sales_count","gross_sales","client_id","notes"], shifts)
copy("sales", ["id","receipt_number","client_id","location_id","shift_id","kasir_id","status","subtotal","discount","total","paid_amount","change_amount","occurred_at","channel","notes"], sales)
copy("sale_lines", ["id","sale_id","product_id","qty","unit_price","discount","line_total","sort_order"], lines)
copy("sale_payments", ["id","sale_id","method","amount","reference","payment_status"], pays)
copy("waste_records", ["id","waste_number","batch_id","location_id","storage_area_id","item_id","qty","unit_cost","reason","reason_detail","status","reported_by","approved_by","approved_at","occurred_at","client_id"], waste_rows)

# ================================================================== 10. expenses (7 Apr payment run) as paid payment vouchers
ex = pd.read_csv(f"{OUT}/expenses.csv")
pvs = []
for i, r in enumerate(ex.itertuples()):
    d = r.transfer_date if isinstance(r.transfer_date, str) and r.transfer_date else "2026-04-07"
    pid = uid("pv", i, r.outlet, r.description, r.amount)
    cat = str(r.category).upper()
    if r.side == "invoice" and cat in ("BAHAN BAKU", "NON-BAHAN BAKU"):
        event, dr, payee = "supplier_payment", "2000", "supplier"
    elif cat == "SDM":
        event, dr, payee = "employee_compensation_payment", "6010", "other"
    else:
        event, dr, payee = "outlet_operating_expense", "6100", "other"
    memo = f"{r.category}: {r.description}" + (f" ({r.note})" if isinstance(r.note, str) and r.note else "") + (f" inv {r.invoice_date}" if isinstance(r.invoice_date, str) else "")
    pvs.append((pid, docno("PV", d), "other", None, payee, money(r.amount), "paid", finance, finance, ts(d, 12), finance, ts(d, 12), "bank_transfer", loc[r.outlet], memo[:500]))
    je(d, event, "payment_verification", pid, r.outlet, memo[:200], [(acct[dr], r.amount, 0, str(r.category)), (acct["1020"], 0, r.amount, "Bank")])
copy("payment_verifications", ["id","pv_number","ref_type","ref_id","payee_type","amount","status","submitted_by","verified_by","verified_at","paid_by","paid_at","paid_via","location_id","notes"], pvs)
note(f"expense PVs {len(pvs)} total Rp {ex.amount.sum():,.0f}")

# ================================================================== 11. payroll April 2026 (approved, payment date not in the files)
per_id = uid("payroll_period", "2026-04")
q("INSERT INTO payroll_periods (id, period_code, start_date, end_date, status) VALUES (%s, '2026-04', '2026-04-01', '2026-04-30', 'closed')", per_id)
run_id = uid("payroll_run", "2026-04")
EARN = {"gaji_pokok":"base_salary","lembur":"overtime","insentif_performa":"performance_incentive","tunj_kehadiran":"attendance_allowance",
        "tunj_masa_kerja":"tenure_allowance","tunj_jabatan":"position_allowance"}
DED = {"pot_izin":"deduction_permission","pot_alpa":"deduction_absence","minus_barang":"deduction_stock_shortfall","pinjaman":"deduction_loan_installment","pot_finger":"other_deduction"}
pl = []; gross = Decimal(0); ded = collections.Counter(); net = Decimal(0)
for e in emp_rows:
    r = e["row"]
    for col, code in {**EARN, **DED}.items():
        v = getattr(r, col)
        if pd.notna(v) and float(v) > 0:
            ot = re.match(r"\s*(\d+(?:[.,]\d+)?)", str(r.overtime_hours)) if col == "lembur" and pd.notna(r.overtime_hours) else None
            qty = Decimal(ot.group(1).replace(",", ".")) if ot and float(ot.group(1).replace(",", ".")) > 0 else Decimal(1)  # "26" or "4 TRIP"
            pl.append((uid("pline", run_id, e["id"], code), run_id, e["id"], comp[code], qty, (money(v) / qty).quantize(Decimal("0.01")), money(v), "manual"))
            if col in EARN: gross += money(v)
            else: ded[col] += money(v)
    net += money(max(0.0, float(r.gaji_bersih or 0)))
tot_ded = sum(ded.values())
q("""INSERT INTO payroll_runs (id, period_id, run_seq, run_number, status, statutory_mode, calculated_by, calculated_at, approved_by, approved_at, total_gross, total_deductions, total_net, notes)
     VALUES (%s, %s, 1, %s, 'approved', false, %s, %s, %s, %s, %s, %s, %s, 'Impor slip gaji April 2026 (periode 29 Mar - 28 Apr). Tanggal pembayaran tidak ada di file.')""",
  run_id, per_id, docno("PRUN", "2026-04-28"), finance, ts(PERIOD_END, 18), owner, ts(PERIOD_END, 18), gross, tot_ded, gross - tot_ded)
copy("payroll_lines", ["id","run_id","employee_id","component_id","qty","rate","amount","source_ref_type"], pl)
je(PERIOD_END, "payroll_accrual", "payroll_run", run_id, None, "Akrual gaji April 2026 (impor)",
   [(acct["6000"], gross, 0, "Beban gaji"), (acct["2100"], 0, gross, "Hutang gaji"),
    (acct["2100"], ded["pinjaman"], 0, "Potongan pinjaman"), (acct["1210"], 0, ded["pinjaman"], "Kasbon"),
    (acct["2100"], ded["minus_barang"], 0, "Potongan minus barang"), (acct["1220"], 0, ded["minus_barang"], "Piutang klaim"),
    (acct["2100"], ded["pot_izin"] + ded["pot_alpa"] + ded["pot_finger"], 0, "Potongan kehadiran"), (acct["6000"], 0, ded["pot_izin"] + ded["pot_alpa"] + ded["pot_finger"], "Potongan kehadiran")])
note(f"payroll lines {len(pl)}: gross Rp {gross:,.0f}, deductions Rp {tot_ded:,.0f}, net Rp {gross - tot_ded:,.0f} (sheet net Rp {net:,.0f})")

# ================================================================== 12. journals
je_rows, jl_rows = [], []
for je_id, date, event, rtype, rid, lid, desc, legs in journals:
    num = docno("JE", date)
    je_rows.append((je_id, num, date, fp[date[:7]], event, "system", rtype, rid, lid, desc[:500], "posted", ts(date, 23, 59)))
    for n, (a, d_, c_, m) in enumerate(legs, 1):
        jl_rows.append((uid("jl", je_id, n), je_id, n, a, d_, c_, lid, (m or "")[:200]))
copy("journal_entries", ["id","entry_number","entry_date","fiscal_period_id","event_type","source","ref_type","ref_id","location_id","description","status","posted_at"], je_rows)
copy("journal_lines", ["id","entry_id","line_no","account_id","debit","credit","location_id","memo"], jl_rows)
note(f"journal entries {len(je_rows)}, lines {len(jl_rows)}")

# ================================================================== 13. balances (signed sum, NO clamp) + checks
q(f"""INSERT INTO stock_balances (location_id, storage_area_id, item_id, qty_on_hand)
      SELECT location_id, storage_area_id, item_id, SUM({SIGN}) FROM stock_movements GROUP BY 1,2,3""")
neg = one("SELECT count(*) FROM stock_balances WHERE qty_on_hand < 0")[0]
mismatch = one("""SELECT count(*) FROM (SELECT l.code, i.sku, SUM(b.qty_on_hand) q FROM stock_balances b JOIN locations l ON l.id=b.location_id
                  JOIN items i ON i.id=b.item_id GROUP BY 1,2) x""")[0]
end_ok = sum(1 for (o, s), v in counted.items() if v != 0)
chk = rows("""SELECT l.code, i.sku, SUM(b.qty_on_hand) FROM stock_balances b JOIN locations l ON l.id=b.location_id JOIN items i ON i.id=b.item_id GROUP BY 1,2""")
bad = [(o, s, v, counted.get((o, s), 0)) for o, s, v in chk if qty3(v) != counted.get((o, s), Decimal(0))]
note(f"closing balances equal to the counted S.O stock: {len(chk) - len(bad)}/{len(chk)} cells; negative cells {neg}")
if bad: note(f"MISMATCH sample: {bad[:5]}")
tb = one("SELECT SUM(debit) - SUM(credit) FROM journal_lines")[0]
note(f"trial balance difference: {tb}")
assert tb == 0 and not bad

if COMMIT:
    con.commit(); note("COMMITTED")
else:
    con.rollback(); note("dry run — rolled back")
open(f"{OUT}/load_log.txt", "w", encoding="utf-8").write("\n".join(log) + "\n")
