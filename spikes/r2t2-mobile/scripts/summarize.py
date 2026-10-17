"""Summarize r2t2-cli / harness JSON reports as a Markdown table row each.

    python3 scripts/summarize.py reference/results/perf-macos/*.json
"""
import json
import sys
from pathlib import Path

print("| run | load ms | mem after load MB | one-shot latency ms (enc/prefill/dec) | decode tok/s | one-shot RTF "
      "| stream steps | step p50/p90/max ms | stream compute RTF | fixed regressions | peak MB |")
print("|---|---|---|---|---|---|---|---|---|---|---|")
for path in sys.argv[1:]:
    d = json.loads(Path(path).read_text())
    load, one, st = d.get("load", {}), d.get("oneshot"), d.get("stream")
    row = [Path(path).stem, f"{load.get('load_ms', 0):.0f}", f"{load.get('mem_current_mb', 0):.0f}"]
    if one:
        row += [f"{one['latency_ms']:.0f} ({one['encode_ms']:.0f}/{one['prefill_ms']:.0f}/{one['decode_ms']:.0f})",
                f"{one['tok_per_s']:.1f}", f"{one['rtf']:.2f}"]
    else:
        row += ["-", "-", "-"]
    if st:
        row += [str(st["steps"]), f"{st['step_ms_p50']:.0f}/{st['step_ms_p90']:.0f}/{st['step_ms_max']:.0f}",
                f"{st['compute_rtf']:.2f}", str(st["fixed_regressions"])]
    else:
        row += ["-", "-", "-", "-"]
    peak = max(x.get("mem_peak_mb", 0) for x in (load, one or {}, st or {}))
    row.append(f"{peak:.0f}")
    print("| " + " | ".join(row) + " |")
