"""Generate tests/text_cases.tsv from the pinned upstream Python helpers.

Run with the reference venv (see scripts/run-reference.sh):
    PYTHONPATH=reference/shim:.cache/r2t2-upstream .cache/venv-ref/bin/python tests/gen_text_cases.py

Each record: fn \x1f input \x1f arg \x1f expected, records separated by \x1e.
"""
import re
import sys
from pathlib import Path

from qwen_asr.inference.utils import detect_and_fix_repetitions, parse_asr_output
from r2t2.r2t2_asr import _normalize_punct_by_context

HAN_SPACE = re.compile(r'(?<=[一-鿿])\s+(?=[一-鿿])')

inputs = [
    "", " ", "你好,世界.", "hello，world。", "价格是100,好吗?", "Hi(你好)ok!", "  前导空格。 ",
    "你 好 世 界", "中文 English 混合 文本", "中　文\t字", "A. B, 中:", "他说\"好\",然后.",
    "language Chinese<asr_text>之前有顾客", "language English<asr_text> hello world ",
    "language None<asr_text>", "language None<asr_text>噪声", "no tag at all", "LANGUAGE chinese<asr_text>x",
    "language Chinese\n<asr_text>换行", "\nlanguage japanese\n<asr_text>こんにちは",
    "啊" * 25, "ab" * 25 + "尾巴", "嗯嗯嗯" + "哈" * 30 + "好的", "x" * 20, "abc" * 19,
    "中文（括号）,end.", "1,2;3:4?5!6(7)8", "¥,€.", "你好|多余#后缀", "�坏字符.",
]

rows = []
for s in inputs:
    rows.append(("punct", s, "", _normalize_punct_by_context(s)))
    rows.append(("hanspace", s, "", HAN_SPACE.sub("", s)))
    rows.append(("rep", s, "", detect_and_fix_repetitions(s)))
    for lang in ("", "Chinese", "English"):
        out_lang, out_text = parse_asr_output(s, user_language=lang or None)
        rows.append(("parse", s, lang, f"{out_lang}\x1d{out_text}"))

out = Path(__file__).with_name("text_cases.tsv")
out.write_text("\x1e".join("\x1f".join(r) for r in rows), encoding="utf-8")
print(f"wrote {len(rows)} cases to {out}", file=sys.stderr)
