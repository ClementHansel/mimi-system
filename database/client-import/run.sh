#!/usr/bin/env bash
# Client data import, end to end, into the database DATABASE_MIGRATION_URL names.
#
#   CLIENT_DATA_DIR=/path/to/client-folders DATABASE_MIGRATION_URL=postgres://... \
#     bash database/client-import/run.sh <out-dir> <database-name>
#
# DESTRUCTIVE for that database: it runs wipe-demo --catalog --hr --commit. Run it against a restored
# copy first (see README.md), never straight at production.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="$1"; DB="$2"
: "${CLIENT_DATA_DIR:?set CLIENT_DATA_DIR}"; : "${DATABASE_MIGRATION_URL:?set DATABASE_MIGRATION_URL}"
export PYTHONIOENCODING=utf-8
mkdir -p "$OUT"
echo "== extract"; python "$HERE/extract_so.py" "$OUT" 2>/dev/null; python "$HERE/extract_misc.py" "$OUT"; python "$HERE/extract_rincian.py" "$OUT"; python "$HERE/extract_omset.py" "$OUT"
echo "== build master data"; python "$HERE/build_locations.py" "$OUT"; python "$HERE/build_master.py" "$OUT"
cd "$HERE/.."
echo "== migrate"; npx tsx migrate.ts | tail -1
echo "== wipe demo (history + catalog + hr)"; npx tsx wipe-demo.ts --catalog --hr --commit --confirm "$DB" | tail -2
echo "== locations + menu categories"; python "$HERE/prep.py" "$OUT" --commit | tail -3
echo "== master import"; npx tsx import.ts --dir "$OUT/import" --commit | tail -9
echo "== April history"; python "$HERE/load_history.py" "$OUT" --commit
echo "== refresh dashboards"
python - <<'PY'
import os, psycopg
with psycopg.connect(os.environ["DATABASE_MIGRATION_URL"], autocommit=True) as c:
    for v in ("mv_sales_daily", "mv_item_usage_daily", "mv_employee_kpi_daily"):
        c.execute(f"REFRESH MATERIALIZED VIEW {v}")
PY
echo "== done — report: $OUT/load_log.txt, $OUT/master/notes.txt, $OUT/master/recipe_calibration.csv"
