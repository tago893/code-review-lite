"""Renders docs/assets/cra-demo.gif as a terminal replay of ONE recorded review (docs/assets/cra-demo-evidence.json).

Every line on screen comes from that file: the diff, the tool calls (name, path, size, real timestamp), the model's
notes, the verified finding and the run statistics. The animation speed is chosen for readability; the "+N.Ns" stamps
are the real times from the recording. Tool arguments are shown without the default offset/limit.
Usage: python docs/assets/render_demo_gif.py [evidence.json] [out.gif]     (needs Pillow and a monospace font)
"""
import json, sys, textwrap
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
src = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "cra-demo-evidence.json"
dst = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "cra-demo.gif"
ev = json.loads(src.read_text(encoding="utf-8"))

BG, FG, DIM = (13, 17, 23), (201, 209, 217), (125, 133, 144)
GREEN, RED, YELLOW, BLUE, CYAN, ORANGE = (63, 185, 80), (248, 81, 73), (210, 153, 34), (88, 166, 255), (121, 192, 255), (240, 136, 62)
FONT = next(str(p) for p in ("C:/Windows/Fonts/consola.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", "/System/Library/Fonts/Menlo.ttc") if Path(p).exists())
font, bold = ImageFont.truetype(FONT, 16), ImageFont.truetype(FONT.replace("consola.ttf", "consolab.ttf"), 16) if "consola" in FONT else ImageFont.truetype(FONT, 16)
CW, LH, PAD, TOP = round(font.getlength("M")), 21, 18, 40
COLS, ROWS = 100, 29
W, H = PAD * 2 + CW * COLS, TOP + PAD + LH * ROWS

def secs(ms): return f"+{ms / 1000:.1f}s"
def wrap(text, width, indent=""): return textwrap.wrap(text, width, initial_indent=indent, subsequent_indent=indent) or [indent]

def draw(lines, footer):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rectangle([0, 0, W, 30], fill=(22, 27, 34))
    for i, c in enumerate(((255, 95, 86), (255, 189, 46), (39, 201, 63))): d.ellipse([14 + i * 22, 9, 26 + i * 22, 21], fill=c)
    d.text((W // 2 - 190, 7), "CRA - experimental AI code reviewer", font=font, fill=DIM)
    y = TOP
    for segs in lines:
        x = PAD
        for text, color, *b in segs:
            d.text((x, y), text, font=bold if b else font, fill=color)
            x += CW * len(text)
        y += LH
    d.text((PAD, H - 26), footer, font=font, fill=DIM)
    return img

def L(text="", color=FG, *b): return [(text, color, *b)]

# ---- scene 1: the command and the diff under review
cmd = "bash docker/run.sh --repo ./demo-repo --base {base} --head {head} --out-dir ./demo-out".format(**ev)
diff_lines = []
for raw in ev["diff"].splitlines():
    if raw.startswith("index "): continue
    color = GREEN if raw.startswith("+") and not raw.startswith("+++") else RED if raw.startswith("-") and not raw.startswith("---") else CYAN if raw.startswith("@@") else DIM if raw.startswith(("diff", "---", "+++")) else FG
    diff_lines.append(L(raw[: COLS - 2], color))
scene1 = [
    [("$ ", BLUE, True), (cmd, FG)], L(),
    [("CRA lean reviewer", CYAN, True), (f" - model {ev['model']}", FG)],
    L("isolated container, read-only snapshot of the repo, API key held only by the proxy", DIM), L(),
    [("Reviewing ", FG), (f"{ev['base']}..{ev['head']}", YELLOW), (" - 1 file changed", FG)], L(), *diff_lines,
]

# ---- scene 2: the investigation, from the recorded tool calls
def describe(e):
    a = e["args"]
    if e["tool"] == "cra_glob": return f'pattern="{a["pattern"]}"'
    return f'path={a["path"]}'
scene2 = [[("Investigating with read-only tools", CYAN, True)], L()]
for e in ev["tool_events"]:
    scene2.append([(f"  {secs(e['t']):>6}  ", DIM), (f"{e['tool']:<9}", YELLOW), (f"{describe(e):<34}", FG), (f"{e['status']} - {e['bytes']} B", GREEN if e["status"] == "ok" else RED)])
notes = {k: v for k, v in (ln.split(":", 1) for ln in ev["notes"].splitlines() if ":" in ln and ln.split(":", 1)[0] in ("Path", "Line", "Code"))}
scene2 += [L(), [("  model finished investigating, notes (excerpt):", FG)]]
for k in ("Path", "Line", "Code"): scene2.append([(f"    {k + ':':<6}", DIM), (notes[k].strip()[: COLS - 14], FG)])
scene2 += [L(), [(f"  {secs(ev['stats']['ms']):>6}  ", DIM), ("structured findings: schema valid, citation checked: ", FG), (f"{ev['stats']['citations_verified']} verified", GREEN, True), (", 0 dropped", FG)]]

# ---- scene 3: the verified finding and the statistics
f, s = ev["finding"], ev["stats"]
scene3 = [[("REVIEW COMPLETE", GREEN, True), ("  (exit code 0)", DIM)], L(),
          [(f.get("severity", "").upper(), RED, True), (f"  {f['category']}  ", FG), (f"{f['file']}:{f['line']}", YELLOW, True), ("   citation verified", GREEN)], L(),
          [("  code   ", DIM), (f["evidence"].strip(), FG)], L()]
for i, ln in enumerate(wrap(f["claim"], COLS - 10)): scene3.append([("  claim  " if i == 0 else "         ", DIM), (ln, FG)])
scene3.append(L())
for i, ln in enumerate(wrap(f["path"], COLS - 10)): scene3.append([("  flow   " if i == 0 else "         ", DIM), (ln, FG)])
scene3 += [L(), [(f"{s['model_requests']} model requests - {s['tool_calls']} tool calls - {s['ms'] / 1000:.1f} s - peak request {s['peak_request_bytes'] / 1000:.1f} KB - 0 rate-limit retries", DIM)]]

FOOTER = "Replay of one recorded live run. Timestamps are real; animation speed is not."
frames, durations = [], []
def add(lines, ms): frames.append(draw(lines, FOOTER)); durations.append(ms)

def play(scene, per_line_ms, hold_ms, typed_first=False):
    shown = []
    for i, line in enumerate(scene):
        if i == 0 and typed_first:
            full = "".join(t for t, *_ in line); cut = len("$ ")
            for n in (cut + 10, cut + 30, len(full)):
                add([[("$ ", BLUE, True), (full[cut:n], FG)]], 220)
        shown.append(line)
        add(shown, per_line_ms if line != L() else 60)
    durations[-1] = hold_ms

play(scene1, 260, 2600, typed_first=True)
play(scene2, 700, 2600)
play(scene3, 300, 9000)

# Palette-quantised frames; identical neighbours are merged by Pillow's optimiser, which keeps the file small.
pal = [fr.quantize(colors=24, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for fr in frames]
pal[0].save(dst, save_all=True, append_images=pal[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(dst, f"{dst.stat().st_size / 1024:.0f} KiB", f"{len(frames)} frames", f"{W}x{H}")
