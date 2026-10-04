#!/usr/bin/env python3
# Copyright 2026 Alexander Komarov
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""
Debug script: print all facts from the Iyye long-term memory (LanceDB),
including the relation graph edges each fact carries.
Run from the project root:  python dump_memory.py [db_path]
"""

import json
import sys
import lancedb

DB_PATH = sys.argv[1] if len(sys.argv) > 1 else "./iyye_memory"
TABLE   = "facts"


def _relations(row):
    """Parse a row's relation edges (tolerant of missing/old schema / bad json)."""
    raw = row.get("relations_json", "[]")
    if not isinstance(raw, str) or not raw.strip():
        return []
    try:
        rels = json.loads(raw)
    except (ValueError, TypeError):
        return []
    return [r for r in rels if isinstance(r, dict) and r.get("target")]


db = lancedb.connect(DB_PATH)
if TABLE not in db.table_names():
    print(f"No '{TABLE}' table found in {DB_PATH}")
    sys.exit(0)

rows = db.open_table(TABLE).to_pandas()
total = len(rows)

# Resolve edge targets to a readable snippet, and check graph integrity.
id_to_text = {row.get("id"): str(row.get("text", "")) for _, row in rows.iterrows()}
all_relations = {row.get("id"): _relations(row) for _, row in rows.iterrows()}
edge_count = sum(len(r) for r in all_relations.values())
facts_with_edges = sum(1 for r in all_relations.values() if r)
dangling = sum(1 for rels in all_relations.values()
               for r in rels if r["target"] not in id_to_text)

print(f"=== Long-term memory: {total} fact(s) in {DB_PATH} ===")
print(f"graph: {edge_count} edge(s) across {facts_with_edges} fact(s) with "
      f"relations; {dangling} dangling"
      + ("  <-- INTEGRITY VIOLATION" if dangling else "") + "\n")

for i, row in rows.iterrows():
    conf = row.get('confidence', None)
    conf_s = f"{conf:.2f}" if isinstance(conf, (int, float)) else "?"
    print(f"[{i+1}/{total}]")
    print(f"  id:         {row.get('id', '?')}")
    print(f"  timestamp:  {row.get('timestamp', '?')}")
    print(f"  confidence: {conf_s}")
    print(f"  time_frame: {row.get('time_frame', '?')}")
    print(f"  source:     {row.get('source', '?')}")
    print(f"  provenance: {row.get('provenance', '?')}")
    mp = row.get('media_path', '')
    if mp:
        print(f"  media:      {mp}")
    print(f"  text:       {row.get('text', '?')}")
    rels = all_relations.get(row.get("id")) or []
    if rels:
        print(f"  relations:  ({len(rels)})")
        for r in rels:
            tid = r["target"]
            target_text = id_to_text.get(tid)
            snippet = (f'"{target_text[:60]}"' if target_text is not None
                       else "<MISSING — dangling>")
            print(f"     —[{r.get('rel', '')}]→ {snippet}  ({str(tid)[:8]})")
    print()
