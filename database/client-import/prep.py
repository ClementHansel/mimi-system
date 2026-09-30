"""Rename the demo locations in place to the client's real outlets (keeps every login's scope), add the
outlets the demo did not have, give every location its storage areas, create the menu categories, and
write the importer's products.csv."""
import os, sys, csv, uuid, psycopg, pandas as pd
OUT = sys.argv[1]; COMMIT = "--commit" in sys.argv
con = psycopg.connect(os.environ["DATABASE_MIGRATION_URL"]); cur = con.cursor()
locs = pd.read_csv(f"{OUT}/locations.csv").fillna(""); remap = dict(pd.read_csv(f"{OUT}/location_remap.csv").values)
cur.execute("SELECT code FROM locations"); existing = {r[0] for r in cur.fetchall()}
real = {r.code: r for r in locs.itertuples()}
for demo, code in remap.items():
    if demo not in existing: continue
    r = real[code]
    cur.execute("""UPDATE locations SET code=%s, name=%s, type=%s, city=%s, address=NULLIF(%s,''), phone=NULL,
                   latitude=NULL, longitude=NULL, is_active=true WHERE code=%s""", (code, r.name, r.type, r.city, r.address, demo))
    print(f"  {demo:7} -> {code:8} {r.name}")
for code, r in real.items():
    cur.execute("SELECT 1 FROM locations WHERE code=%s", (code,))
    if not cur.fetchone():
        # deterministic id: journal ref_ids for the daily sales/usage entries are derived from the location id
        lid = str(uuid.uuid5(uuid.UUID("5b1f3a52-8c1e-4d7a-9f00-a11c0a7e2026"), f"location|{code}"))
        cur.execute("""INSERT INTO locations (id, code, name, type, city, address, tenant_id) VALUES (%s,%s,%s,%s,%s,NULLIF(%s,''), app_the_only_tenant())""",
                    (lid, code, r.name, r.type, r.city, r.address)); print(f"  new     -> {code:8} {r.name}")
cur.execute("SELECT code FROM locations WHERE code <> ALL(%s)", (list(real),)); stray = [r[0] for r in cur.fetchall()]
if stray: print("  deactivated (not a real location):", stray); cur.execute("UPDATE locations SET is_active=false WHERE code = ANY(%s)", (stray,))
AREAS = {"outlet": [("FRZ","Freezer","freezer",-25,-15,1),("CHL","Chiller","chiller",0,5,2),("DRY","Rak Kering","dry_store",None,None,3),("DSP","Display","display",0,8,4),("KLN","Kitchen Line","kitchen_line",None,None,5)],
         "warehouse": [("FRZ","Freezer","freezer",-25,-15,1),("CHL","Chiller","chiller",0,5,2),("DRY","Gudang Kering","dry_store",None,None,3)]}
for code, r in real.items():
    for a in AREAS[r.type]:
        cur.execute("""INSERT INTO storage_areas (location_id, code, name, type, temp_min, temp_max, sort_order)
                       SELECT id, %s, %s, %s, %s, %s, %s FROM locations WHERE code=%s ON CONFLICT (location_id, code) DO NOTHING""", (*a, code))
pc = pd.read_csv(f"{OUT}/master/product_categories.csv")
for r in pc.itertuples():
    cur.execute("INSERT INTO product_categories (name, sort_order) VALUES (%s,%s) ON CONFLICT (name) DO NOTHING", (r.name, r.sort_order))
p = pd.read_csv(f"{OUT}/master/products.csv")
with open(f"{OUT}/import/products.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["code","name","category","price","sort_order"])
    for i, r in enumerate(p.itertuples(), 1): w.writerow([r.code, r.name, r.group, int(r.price), i * 10])
(con.commit() if COMMIT else con.rollback()); print("committed" if COMMIT else "dry run")
