"""The client's 22 outlets + 2 warehouses, and how the demo locations map onto them.

Demo locations are RENAMED in place (prep.py) rather than replaced: every existing login's
user_locations row points at a location id, so renaming keeps each account scoped to a real outlet.
Names/cities come from the S.O sheet titles, addresses from the payroll workbooks' "Alamat" cell.
"""
import csv, sys, pandas as pd
OUT = sys.argv[1]
NAMES = {"M1":"Mimi Gn. Guntur","M3":"Mimi Strat 1","M7":"Mimi Sepinggan","M16":"Mimi Ring Road","M17":"Mimi Soekarno Hatta Km 3","M18":"Mimi Karang Rejo",
         "M20":"Mimi Kampung Baru","M24":"Mimi Manggar","M25":"Mimi Prapatan","M2":"Mimi Cendana","M5":"Mimi Bung Tomo","M6":"Mimi Suryanata",
         "M8":"Mimi Loa Janan","M9":"Mimi Lambung","M10":"Mimi Loa Bakung","M11":"Mimi Sungai Dama","M12":"Mimi Pasundan","M15":"Mimi Sempaja",
         "M19":"Mimi A. Wahab Syahrani","M21":"Mimi Pattimura","M22":"Mimi M. Said","M23":"Mimi Handil 2"}
BPP = {"M1","M3","M7","M16","M17","M18","M20","M24","M25"}
CITY = {k: ("Balikpapan" if k in BPP else "Samarinda") for k in NAMES}; CITY["M23"] = "Kutai Kartanegara"
# demo code -> real code. Balikpapan/Samarinda demo outlets land on real outlets of the same city first.
REMAP = {"BPP01":"M1","BPP02":"M3","BPP03":"M7","BPP04":"M16","BPP05":"M17","SMD01":"M2","SMD02":"M5","SMD03":"M6","SMD04":"M8","SMD05":"M9",
         "BJM01":"M18","BJM02":"M20","BJM03":"M24","BJM04":"M25","BJM05":"M10","PTK01":"M11","PTK02":"M12","PTK03":"M15","PTK04":"M19",
         "PTK05":"M21","TGR001":"M22","GDG":"GDG-BPP","GDGTGR":"GDG-SMD"}
addr = pd.read_csv(f"{OUT}/payroll.csv").groupby("unit").address.first().to_dict()
with open(f"{OUT}/locations.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["code","name","type","city","address","phone","latitude","longitude","geofence_radius_m"])
    for k in sorted(NAMES, key=lambda c: int(c[1:])): w.writerow([k, NAMES[k], "outlet", CITY[k], addr.get(k, ""), "", "", "", ""])
    w.writerow(["GDG-BPP","Gudang Balikpapan","warehouse","Balikpapan",addr.get("LOG_BPP",""),"","","",""])
    w.writerow(["GDG-SMD","Gudang Samarinda","warehouse","Samarinda","","","","",""])
with open(f"{OUT}/location_remap.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f); w.writerow(["demo_code","real_code"]); [w.writerow(kv) for kv in REMAP.items()]
import shutil, os; os.makedirs(f"{OUT}/import", exist_ok=True); shutil.copy(f"{OUT}/locations.csv", f"{OUT}/import/locations.csv")
