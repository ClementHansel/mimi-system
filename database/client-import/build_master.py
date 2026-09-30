"""Normalize the extracted CSVs into master data.

Writes to OUT/import/ (importer-shaped): units.csv, item_categories.csv, locations.csv, items.csv, recipes.csv
and to OUT/master/: product_categories.csv, products.csv (with group + regional prices), item_costs.csv,
product_map.csv (pmix raw name -> product code), item_map.csv (outlet item name -> sku), suppliers.csv,
supplier_items.csv, report.md fragments.
"""
import pandas as pd, numpy as np, re, os, sys, csv, collections

OUT = sys.argv[1]
os.makedirs(f"{OUT}/import", exist_ok=True); os.makedirs(f"{OUT}/master", exist_ok=True)
BPP = {"M1","M3","M7","M16","M17","M18","M20","M24","M25"}
region = lambda o: "BPP" if o in BPP else "SMD"
notes = []

def key(s): return re.sub(r"[^a-z0-9]+", " ", str(s).lower()).strip()

# ---------------------------------------------------------------- units
UNIT = {"KG":"kg","PCS":"pcs","PACK":"pack","BOX":"box","LITER":"ltr","LTR":"ltr","JRG":"jrg","PIL":"pail","IKAT":"ikat",
        "BTL":"btl","CUP":"cup","ROLL":"roll","IKT":"ikat","KARUNG":"karung","SAK":"sak","DUS":"dus","BAL":"bal","SLOP":"slop","TABUNG":"tabung"}
UNIT_NAMES = {"kg":"Kilogram","pcs":"Pieces","pack":"Pack","box":"Box","ltr":"Liter","jrg":"Jerigen","pail":"Pail","ikat":"Ikat",
              "btl":"Botol","cup":"Cup","roll":"Roll"}

# ---------------------------------------------------------------- items
it = pd.read_csv(f"{OUT}/so_items.csv")
it["k"] = it.item.map(key)
it["unit_n"] = it.unit.map(lambda u: UNIT.get(str(u).strip().upper(), None) if pd.notna(u) else None)
sin = pd.read_csv(f"{OUT}/stock_in.csv"); sin["k"] = sin.item.map(key)

SECTION_PREFIX = {"Bahan Baku Makanan":"BBM","Bahan Baku Minuman":"BBN","Bahan Pelengkap Makanan":"BPM","Cleaning Supply":"CLS",
                  "Perlengkapan Dan Lain-Lain":"PLL","Wadah dan Plastik":"WDP"}
FROZEN = {"cu 13","french fries","beef patties","ikan dorry","kulit crispy"}
CHILLED = {"selada","timun","tomat","cabe rawit","sambel cabe hijau","choco pudding","coconut puding","mango pudding","susu uht"}
UNIT_OVERRIDE = {"ikan dorry":"kg", "pulpen":"pcs"}

rows = []
for k, g in it.groupby("k", sort=False):
    name = g.item.value_counts().index[0]
    # prefer a Title-cased spelling when two spellings exist ("Kulit crispy" / "Kulit Crispy")
    spell = [s for s in g.item.unique() if s[:1].isupper() and not s.islower()]
    name = max(spell, key=lambda s: (sum(c.isupper() for c in s), (g.item == s).sum())) if spell else name
    section = g.section.value_counts().index[0]
    unit = UNIT_OVERRIDE.get(k) or (g.unit_n.dropna().value_counts().index[0] if g.unit_n.notna().any() else "pcs")
    s = sin[sin.k == k]
    w = s.qty.sum()
    avg = float((s.qty * s.price).sum() / w) if w > 0 else float(g.price[g.price > 0].mean() if (g.price > 0).any() else 0)
    rows.append(dict(k=k, name=name, section=section, unit=unit, avg_cost=round(avg, 2), first_row=g.row.min(),
                     storage="frozen" if k in FROZEN else "chilled" if k in CHILLED else "dry",
                     outlets=g.outlet.nunique()))
items = pd.DataFrame(rows)
items["prefix"] = items.section.map(SECTION_PREFIX)
items = items.sort_values(["prefix", "first_row", "name"]).reset_index(drop=True)
items["sku"] = items.groupby("prefix").cumcount().add(1).map("{:03d}".format)
items["sku"] = items.prefix + "-" + items.sku

units_used = sorted(set(items.unit))
with open(f"{OUT}/import/units.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["code","name"])
    for u in units_used: w.writerow([u, UNIT_NAMES.get(u, u.title())])

cats = [c for c in SECTION_PREFIX]
with open(f"{OUT}/import/item_categories.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["name","sort_order"])
    for i, c in enumerate(cats, 1): w.writerow([c, i * 10])

with open(f"{OUT}/import/items.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["sku","name","category","base_unit","storage_type","is_sellable","shelf_life_days","barcode"])
    for r in items.itertuples(): w.writerow([r.sku, r.name, r.section, r.unit, r.storage, "no", "", ""])
items[["sku","name","unit","avg_cost","storage","outlets"]].to_csv(f"{OUT}/master/item_costs.csv", index=False)
it.merge(items[["k","sku"]], on="k")[["outlet","item","sku"]].drop_duplicates().to_csv(f"{OUT}/master/item_map.csv", index=False)
# name -> sku for every spelling seen anywhere (S.O, STOK MASUK), so a receipt typed "Crystaline" finds Cystaline
NAME_ALIAS = {"crystaline": "cystaline", "bubuk puding": "bubuk pudding", "le mineral": "le mineral"}
nm = {r.k: r.sku for r in items.itertuples()}
for a, b in NAME_ALIAS.items():
    if b in nm: nm[a] = nm[b]
pd.DataFrame(sorted(nm.items()), columns=["key","sku"]).to_csv(f"{OUT}/master/name_map.csv", index=False)

# ---------------------------------------------------------------- products
pm = pd.read_csv(f"{OUT}/pmix.csv")
FIX = {"es the":"Es Teh", "smoothies greantea":"Smoothies Greentea", "bevereges":"Beverages"}
def pname(p):
    p = re.sub(r"\s+", " ", str(p)).strip()
    return FIX.get(p.lower(), p)
pm["product_n"] = pm["product"].map(pname)
# ".++X" rows are zero-price add-on choices (extra sauce, drink swap) and the "Other" block is components:
# neither is a menu product. Nothing priced is dropped.
pm = pm[~pm.product_n.str.startswith(".++")]
pm = pm[pm.groupby(pm.product_n.map(key)).price.transform("max") > 0]
pm["pk"] = pm.product_n.map(key)
pm["group_n"] = pm.group.map(lambda g: "Beverages" if key(g) == "bevereges" else ("Menu Special" if key(g) == "menu special" else str(g).strip()))
pm["region"] = pm.outlet.map(region)
GROUP_PREFIX = {"Paket Hemat":"PH","Alacarte":"AL","Beverages":"BV","Menu Special":"MS"}
unknown_groups = set(pm.group_n) - set(GROUP_PREFIX)
if unknown_groups: notes.append(f"product groups not mapped: {unknown_groups}")

prods = []
for pk, g in pm.groupby("pk", sort=False):
    name = g.product_n.value_counts().index[0]
    if name.isupper() and len(name) > 4: name = name  # keep POS spelling (PAHE, PAKET GEPREK ...)
    grp = g.group_n.value_counts().index[0]
    by_region = g.groupby("region").apply(lambda x: x.price.value_counts().index[0]).to_dict()
    price = g.price.value_counts().index[0]
    qty = g.qty.sum()
    prods.append(dict(pk=pk, name=name, group=grp, price=price, price_bpp=by_region.get("BPP"), price_smd=by_region.get("SMD"),
                      qty_bpp=g[g.region == "BPP"].qty.sum(), qty_smd=g[g.region == "SMD"].qty.sum(),
                      first=g.index.min()))
products = pd.DataFrame(prods)
products["prefix"] = products.group.map(GROUP_PREFIX).fillna("MN")
products = products.sort_values(["prefix", "first"]).reset_index(drop=True)
products["code"] = products.prefix + "-" + products.groupby("prefix").cumcount().add(1).map("{:03d}".format)
products[["code","name","group","price","price_bpp","price_smd","qty_bpp","qty_smd"]].to_csv(f"{OUT}/master/products.csv", index=False)
with open(f"{OUT}/master/product_categories.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["name","sort_order"])
    for i, gname in enumerate(GROUP_PREFIX, 1): w.writerow([gname, i * 10])
pm.merge(products[["pk","code"]], on="pk")[["outlet","raw_name","code"]].drop_duplicates().to_csv(f"{OUT}/master/product_map.csv", index=False)

# ---------------------------------------------------------------- recipes (one per product: dominant region)
ri = pd.read_csv(f"{OUT}/recipes_item.csv")
ri["region"] = ri.outlet.map(region)
ri["k"] = ri["item"].map(key)
ri["pk"] = ri.product_raw.map(lambda p: key(pname(re.sub(r"\s*\bTW$", "", str(p), flags=re.I))))
ri = ri.merge(items[["k","sku","unit"]], on="k", how="left")
missing = ri[ri.sku.isna()]["item"].unique()
if len(missing): notes.append(f"recipe items without SKU: {list(missing)}")
ri = ri.dropna(subset=["sku"])
stock_by_region = sin.assign(region=sin.outlet.map(region)).merge(items[["k","sku"]], on="k").groupby(["region","sku"]).qty.sum()

# Resolve a usage group mapped to several SKUs in a region (e.g. Chili Sachet -> Delmonte AND Mimi,
# which the sheet double counts): prefer the SKU whose name IS the group, else the one most stocked.
def pick(sub, reg):
    grp_k = key(sub.qty_group.iloc[0])
    same = sub[sub.k == grp_k]
    if len(same): return same.sku.iloc[0]
    return max(sub.sku.unique(), key=lambda s: stock_by_region.get((reg, s), 0))
chosen = {}
for (reg, grp), sub in ri.groupby(["region","qty_group"]):
    chosen[(reg, grp)] = pick(sub, reg)
ri = ri[ri.apply(lambda r: chosen[(r.region, r.qty_group)] == r.sku, axis=1)]

YIELD = 100
recipe_rows = []
# Sold qty per (outlet, raw menu row): the weights for merging the dine-in and "TW" rows of one product.
pm["raw_n"] = pm.raw_name.map(lambda s: re.sub(r"\s+", " ", str(s)).strip())
ri["raw_n"] = ri.product_raw.map(lambda s: re.sub(r"\s+", " ", str(s)).strip())
sold = pm.groupby(["outlet","raw_n"]).qty.sum()
coef_ov = ri.groupby(["outlet","raw_n","sku"]).coef.sum()  # sum over usage groups of ONE menu row
chain_qty = pm.merge(products[["pk","code"]], on="pk").groupby(["outlet","code"]).qty.sum()
theo = collections.Counter()
per_prod = {}
for r in products.itertuples():
    reg = "BPP" if r.qty_bpp >= r.qty_smd else "SMD"
    variants = pm[(pm.pk == r.pk) & (pm.region == reg)][["outlet","raw_n"]].drop_duplicates()
    if variants.empty:
        reg = "SMD" if reg == "BPP" else "BPP"
        variants = pm[(pm.pk == r.pk) & (pm.region == reg)][["outlet","raw_n"]].drop_duplicates()
    # A merged product's usage = sales-weighted average of its rows (dine-in row + TW row), NOT their sum:
    # both rows carry the same 1/13 pack of chicken; only packaging differs between them.
    w = {(v.outlet, v.raw_n): float(sold.get((v.outlet, v.raw_n), 0)) for v in variants.itertuples()}
    wt = sum(w.values()) or 1.0
    acc = collections.Counter()
    for (o, raw), wv in w.items():
        if (o, raw) in coef_ov.index.droplevel(2):
            for sku, c in coef_ov.loc[(o, raw)].items(): acc[sku] += c * (wv if wt > 1 else 1.0)
    per_prod[r.code] = {sku: v / wt for sku, v in acc.items() if v > 0}
    per_prod[r.code]["__region"] = reg
# Calibrate ingredients whose sheet formula is in the wrong unit (Teh Saring = "1 pack per glass"):
# modelled April usage vs actual usage (S.O opening + in - closing - waste). Only gaps beyond 50%.
actual = it.merge(items[["k","sku"]], on="k").assign(u=lambda d: d.pemakaian - d.waste).groupby("sku").u.sum()
for (o, code), qv in chain_qty.items():
    for sku, c in per_prod.get(code, {}).items():
        if sku != "__region": theo[sku] += c * qv
calib = {}
for sku, t in theo.items():
    a = float(actual.get(sku, 0))
    if t > 0 and a > 0 and not (1 / 1.5 <= t / a <= 1.5):
        calib[sku] = a / t
names = dict(zip(items.sku, items.name))
notes.append("recipe calibration (sheet formula vs actual S.O usage, factor applied): " +
             "; ".join(f"{names[k]} x{v:.3f} (model {theo[k]:,.0f} vs actual {actual[k]:,.0f})" for k, v in sorted(calib.items(), key=lambda kv: kv[1])))
pd.DataFrame([(k, names[k], theo[k], float(actual.get(k, 0)), v) for k, v in calib.items()],
             columns=["sku","name","modelled","actual","factor"]).to_csv(f"{OUT}/master/recipe_calibration.csv", index=False)
for r in products.itertuples():
    pp = per_prod[r.code]; reg = pp.pop("__region")
    for sku, q in sorted(pp.items()):
        q *= calib.get(sku, 1.0)
        # recipe_lines.qty is NUMERIC(14,3); per-portion usage like 1/1100 box of frying fat would round
        # 10% off, so every recipe is expressed per YIELD portions (consumption = qty x sold / yield).
        if round(q * YIELD, 3) > 0:
            recipe_rows.append([r.code, sku, round(q * YIELD, 3), items.set_index("sku").unit[sku], YIELD, reg, q])
rec = pd.DataFrame(recipe_rows, columns=["product_code","item_sku","qty","unit","yield_qty","region","per_portion"])
rec["rounding_err"] = (rec.qty / YIELD - rec.per_portion).abs() / rec.per_portion
worst = rec.rounding_err.max()
notes.append(f"recipe rounding: worst relative error {worst:.4%} at yield {YIELD}")
rec.to_csv(f"{OUT}/master/recipes_full.csv", index=False)
rec[["product_code","item_sku","qty","unit","yield_qty"]].to_csv(f"{OUT}/import/recipes.csv", index=False)

# ---------------------------------------------------------------- suppliers (weekly outlet bills)
ob = pd.read_csv(f"{OUT}/outlet_bills.csv")
ob = ob[(ob.supplier.astype(str).str.strip() != "0") & ob.supplier.notna() & (ob.qty > 0)]
ob = ob[ob.sheet.astype(str).str.fullmatch(r"M\d+")]  # A1-A3 / ARIZONA sheets are the sister brand, not Mimi
NOT_SUPPLIER = {"PC", "SAYURAN", "GAS", "SAUS", "SPRITE"}  # petty cash / categories typed into the supplier column
ob["sup"] = ob.supplier.astype(str).str.strip().str.upper().str.replace(r"\s+SMD$", "", regex=True).replace({"BERNADI": "BERNARDY"})
sup_names = sorted(s for s in ob.sup.unique() if s not in NOT_SUPPLIER)
def scode(n):
    n = re.sub(r"^(PT|CV)\.?\s+", "", n)
    return "SUP-" + re.sub(r"[^A-Z0-9]+", "", n)[:12]
sups = pd.DataFrame({"name": sup_names}); sups["code"] = sups.name.map(scode)
sups.loc[sups.code.duplicated(keep=False), "code"] = sups.code + sups.index.astype(str)
sups.to_csv(f"{OUT}/master/suppliers.csv", index=False)
ob["pk"] = ob["product"].map(key)
alias = {key(a): key(b) for a, b in [("Minyak Sayur","Minyak Goreng"),("Chili sachet Mimi","Chili Sachet Mimi"),("Tomat sachet Mimi","Tomat Sachet Mimi"),
                                      ("Chili galon","Chili Galon"),("Tomat galon","Tomat Galon"),
    ("BUN","Bun Burger"),("BEEF PATHIES","Beef Patties"),("Beef Patties SMD","Beef Patties"),("Nutrijel","Nutrijell"),("Tissu Lobby","Tisu Lobby"),
    ("TRASHBAG","Trash Bag"),("BROWNBAG","Brown Bag Mimi"),("Crystalin","Cystaline"),("DIAMON SQUASH","Diamond Squash"),("SMOOTHIES COKLAT","Smoothies Chocolate"),
    ("Susu Ultra","Susu UHT"),("Sambal Ijo","Sambel Cabe hijau"),("Soft Mix Vanilla 2","Soft Mix Vanilla"),("pink float","Pink Coconut"),("Pink Float","Pink Coconut"),
    ("Topping Chocolate","Topping Coklat"),("SENDOK SUNDAE","Sendok Ice Cream"),("Tutup Cup Float/Pudding","Tutup Cup Float"),("Beras Lebah Madu","Beras Lebah"),("TEPUNG","Breader Mimi"),("BUBUK PUDING","Bubuk Pudding"),("CUP CONE","Cone Cup"),("Thousand Island 2","Thousand Island"),("BUN 2","Bun Burger")]}
ob["k"] = ob.pk.map(lambda k: alias.get(k, k))
si = ob[ob.sup.isin(sup_names)].rename(columns={"unit": "bill_unit"}).merge(items[["k","sku","unit"]], on="k", how="inner")
unmatched = ob[ob.sup.isin(sup_names) & ~ob.k.isin(items.k)].groupby("product").size().sort_values(ascending=False)
si = si.groupby(["sup","sku"]).agg(price=("price","median"), n=("qty","count"), last_date=("date","max"),
                                   bill_unit=("bill_unit", lambda s: s.value_counts().index[0]), unit=("unit","first")).reset_index()
si.to_csv(f"{OUT}/master/supplier_items.csv", index=False)
with open(f"{OUT}/master/notes.txt", "w", encoding="utf-8") as f:
    f.write("\n".join(notes) + "\n")
    f.write(f"\nbill lines whose product is not an SO item ({len(unmatched)} names):\n" + unmatched.head(60).to_string() + "\n")
print(f"items {len(items)}, products {len(products)}, recipe lines {len(rec)}, suppliers {len(sups)}, supplier_items {len(si)}")
print("\n".join(notes))
