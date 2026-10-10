"""Summarize real-time chunk-sweep reports: python3 scripts/summarize_sweep.py DIR/*.json"""
import json
import re
import sys
from pathlib import Path

rows = []
for p in sys.argv[1:]:
    name = Path(p).name  # e.g. zh.metal.chunk320.json
    m = re.match(r"(?P<clip>[^.]+)\.(?P<cfg>[^.]+)\.chunk(?P<chunk>\d+)\.json", name)
    s = json.loads(Path(p).read_text())["stream"]
    rows.append((m["cfg"], int(m["chunk"]), s))
print("| config | chunk ms | audio s | steps | step p50/p90/max ms | compute RTF | max lag ms | final lag ms "
      "| first commit (audio s / wall ms) | regressions | final text (last clip) |")
print("|---|---|---|---|---|---|---|---|---|---|---|")
for cfg, chunk, s in sorted(rows, key=lambda r: (r[0], r[1])):
    print(f"| {cfg} | {chunk} | {s['audio_sec']:.1f} | {s['steps']} | {s['step_ms_p50']:.0f}/{s['step_ms_p90']:.0f}/"
          f"{s['step_ms_max']:.0f} | {s['compute_rtf']:.2f} | {s['max_lag_ms']:.0f} | {s['final_lag_ms']:.0f} "
          f"| {s['first_commit_audio_sec']:.2f} / {s['first_commit_wall_ms']:.0f} | {s['fixed_regressions']} | {s['final_text']} |")
