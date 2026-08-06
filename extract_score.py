#!/usr/bin/env python3
"""Extract score.json from an MCI prostopinije PDF (Finale, Maestro/Petrucci font).
Usage: python3 extract_score.py input.pdf -o score.json [--debug]"""
import fitz, sys, json, statistics, argparse

MUSIC_FONTS = ("Maestro", "Petrucci")
NOTEHEADS = {"œ": "quarter", "˙": "half", "w": "whole", "W": "recit"}
# Maestro/Petrucci flags: j/J = eighth, k/K = sixteenth (weight)
FLAG_WEIGHT = {"j": 1, "J": 1, "k": 2, "K": 2}
ACCIDENTALS = {"#": 1, "b": -1, "n": 0}
SHARP_LETTERS = [3, 0, 4, 1, 5, 2, 6]   # F C G D A E B (letter idx, C=0)
FLAT_LETTERS = [6, 2, 5, 1, 4]          # B E A D G
LETTER_PC = [0, 2, 4, 5, 7, 9, 11]      # C D E F G A B

def find_staves(page):
    hl = []
    for dr in page.get_drawings():
        for it in dr["items"]:
            if it[0] == "l":
                a, b = it[1], it[2]
                if abs(a.y - b.y) < 1 and abs(a.x - b.x) > 50:
                    hl.append(((a.y + b.y) / 2, min(a.x, b.x), max(a.x, b.x)))
            elif it[0] == "re":
                r = it[1]
                if r.height < 1.5 and r.width > 50:
                    hl.append((r.y0 + r.height / 2, r.x0, r.x1))
    hl.sort()
    ys = [h[0] for h in hl]
    staves, i = [], 0
    while i + 4 < len(ys):
        gaps = [ys[i + k + 1] - ys[i + k] for k in range(4)]
        m = statistics.median(gaps)
        if m > 3 and all(abs(g - m) < 0.15 * m for g in gaps):
            staves.append({"lineYs": [round(y, 2) for y in ys[i:i + 5]],
                           "spacing": round(m, 3),
                           "xStart": round(min(h[1] for h in hl[i:i + 5]), 1),
                           "xEnd": round(max(h[2] for h in hl[i:i + 5]), 1)})
            i += 5
        else:
            i += 1
    return staves

def music_chars(page):
    out = []
    for b in page.get_text("rawdict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                is_music = s["font"] in MUSIC_FONTS
                for ch in s["chars"]:
                    c = ch["c"]
                    if is_music and c.strip():
                        out.append({"c": c, "x": ch["origin"][0], "y": ch["origin"][1]})
    out.sort(key=lambda k: k["x"])
    return out

def text_words(page):
    words = []  # (x, y, text)
    for b in page.get_text("dict")["blocks"]:
        for l in b.get("lines", []):
            for s in l["spans"]:
                if s["font"] in MUSIC_FONTS:
                    continue
                for w in s["text"].split():
                    pass
    for x0, y0, x1, y1, w, *_ in page.get_text("words"):
        words.append({"x": x0, "y": (y0 + y1) / 2, "yTop": y0, "text": w})
    return words

def step_to_midi(step, key_fifths, inline=None):
    """Treble clef: step 0 = E4. Returns MIDI."""
    abs_step = 30 + step                # E4 = 4*7 + 2
    octave, letter = divmod(abs_step, 7)
    pc = LETTER_PC[letter]
    alter = 0
    if key_fifths > 0 and letter in SHARP_LETTERS[:key_fifths]:
        alter = 1
    elif key_fifths < 0 and letter in FLAT_LETTERS[:-key_fifths]:
        alter = -1
    if inline is not None:
        alter = ACCIDENTALS[inline]
    return 12 * (octave + 1) + pc + alter

def extract(path):
    doc = fitz.open(path)
    pages_out = []
    gidx = 0
    for pno in range(len(doc)):
        page = doc[pno]
        staves = find_staves(page)
        if not staves:
            continue
        chars = music_chars(page)
        words = text_words(page)

        def staff_of(y):
            best, bd = None, 1e9
            for si, st in enumerate(staves):
                mid = (st["lineYs"][0] + st["lineYs"][4]) / 2
                d = abs(y - mid)
                if d < bd:
                    bd, best = d, si
            return best if bd < 6 * staves[best]["spacing"] else None

        per = [{"clef": None, "keysig": 0, "keyx": None, "notes": [], "flags": [],
                "pending_acc": None, "raw": st} for st in staves]

        for ch in chars:  # sorted by x; but staves interleave, handle per-staff x order later
            si = staff_of(ch["y"])
            if si is None:
                continue
            st = per[si]
            c = ch["c"]
            if c in ("&", "?"):
                st["clef"] = "treble" if c == "&" else "bass"
                st["keyx"] = ch["x"]
            elif c in ACCIDENTALS:
                sp = st["raw"]["spacing"]
                if st["keyx"] is not None and ch["x"] - st["keyx"] < 8 * sp and not st["notes"]:
                    st["keysig"] += 1 if c == "#" else (-1 if c == "b" else 0)
                else:
                    st["pending_acc"] = c
            elif c in NOTEHEADS:
                st["notes"].append({"c": c, "x": ch["x"], "y": ch["y"],
                                    "acc": st["pending_acc"], "flagCount": 0})
                st["pending_acc"] = None
            elif c in FLAG_WEIGHT:
                st["flags"].append({"x": ch["x"], "y": ch["y"],
                                    "weight": FLAG_WEIGHT[c]})

        staves_out = []
        for si, st in enumerate(per):
            if st["clef"] == "bass" or not st["notes"]:
                continue
            raw = st["raw"]
            sp = raw["spacing"]
            bottom = raw["lineYs"][4]
            st["notes"].sort(key=lambda n: (n["x"], n["y"]))
            # Multi-voice: collapse each column to top head only (monophonic play).
            # Wider x tolerance than 1pt — Finale sometimes staggers chord tones.
            x_tol = max(4.5, sp * 1.05)
            y_stack_min = sp * 0.4
            clusters = []
            for n in st["notes"]:
                if clusters and abs(n["x"] - clusters[-1]["ref_x"]) <= x_tol:
                    clusters[-1]["members"].append(n)
                    m = clusters[-1]["members"]
                    clusters[-1]["ref_x"] = sum(t["x"] for t in m) / len(m)
                else:
                    clusters.append({"members": [n], "ref_x": n["x"]})
            filtered = []
            for cl in clusters:
                mem = cl["members"]
                top = min(mem, key=lambda t: t["y"])  # smaller y = higher on page
                y_span = max(t["y"] for t in mem) - min(t["y"] for t in mem)
                x_span = max(t["x"] for t in mem) - min(t["x"] for t in mem)
                if len(mem) >= 2 and y_span > y_stack_min:
                    filtered.append(top)  # multi-voice column
                elif len(mem) >= 2 and x_span < 1.25:
                    filtered.append(top)  # duplicate
                else:
                    mem_sorted = sorted(mem, key=lambda t: (t["x"], t["y"]))
                    filtered.extend(mem_sorted)
            # Attach flags (j/J = 8th, k/K = 16th) to nearest filled head
            for f in st["flags"]:
                best, best_score = None, 1e9
                for n in filtered:
                    if n["c"] != "œ":
                        continue
                    dx = f["x"] - n["x"]
                    dy = abs(f["y"] - n["y"])
                    if abs(dx) > sp * 2.8 or dy > sp * 6.5:
                        continue
                    score = abs(dx) * 1.4 + dy * 0.35
                    if score < best_score:
                        best_score, best = score, n
                if best is not None:
                    best["flagCount"] = best.get("flagCount", 0) + f["weight"]
            # lyrics: words below staff within 4 spacings, first verse line only
            band = [w for w in words
                    if raw["xStart"] - 5 <= w["x"] <= raw["xEnd"] + 20
                    and bottom + 0.5 * sp < w["yTop"] < bottom + 5.5 * sp]
            band.sort(key=lambda w: w["x"])
            notes_out = []
            for n in filtered:
                step = round((bottom - n["y"]) / (sp / 2))
                midi = step_to_midi(step, st["keysig"], n["acc"])
                glyph = NOTEHEADS[n["c"]]
                if glyph == "quarter" and n.get("flagCount"):
                    glyph = "sixteenth" if n["flagCount"] >= 2 else "eighth"
                notes_out.append({
                    "index": gidx, "type": "recit" if n["c"] == "W" else "note",
                    "glyph": glyph,
                    "x": round(n["x"] + sp * 0.6, 2), "y": round(n["y"], 2),
                    "step": step, "midi": midi,
                    "accidental": n["acc"], "lyric": ""})
                gidx += 1
            # attach lyrics: word belongs to last note with x <= wx + 2
            for w in band:
                target = None
                for no in notes_out:
                    if no["x"] <= w["x"] + 4:
                        target = no
                    else:
                        break
                if target is not None:
                    target["lyric"] = (target["lyric"] + " " + w["text"]).strip()
            staves_out.append({
                "index": len(staves_out), "xStart": raw["xStart"], "xEnd": raw["xEnd"],
                "lineYs": raw["lineYs"], "spacing": raw["spacing"],
                "clef": st["clef"] or "treble",
                "keySig": {"fifths": st["keysig"]}, "label": None,
                "notes": notes_out})
        if staves_out:
            pages_out.append({"index": pno, "width": round(page.rect.width, 1),
                              "height": round(page.rect.height, 1), "staves": staves_out})
    doc.close()
    return {"version": 1, "source": path.split("/")[-1], "pages": pages_out}

def debug_png(pdf_path, score, out_png, page_index=0):
    NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    doc = fitz.open(pdf_path)
    page = doc[page_index]
    pg = next((p for p in score["pages"] if p["index"] == page_index), None)
    if pg:
        for st in pg["staves"]:
            for n in st["notes"]:
                page.draw_circle(fitz.Point(n["x"], n["y"]), 2.2, color=(0, 0, 1), width=0.8)
                nm = NAMES[n["midi"] % 12] + str(n["midi"] // 12 - 1)
                page.insert_text(fitz.Point(n["x"] - 4, n["y"] - st["spacing"] * 2.2),
                                 nm, fontsize=4.5, color=(1, 0, 0))
    pix = page.get_pixmap(dpi=160)
    pix.save(out_png)
    doc.close()

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("pdf")
    ap.add_argument("-o", "--out", default="score.json")
    ap.add_argument("--debug", action="store_true")
    a = ap.parse_args()
    score = extract(a.pdf)
    with open(a.out, "w") as f:
        json.dump(score, f, indent=1)
    n = sum(len(s["notes"]) for p in score["pages"] for s in p["staves"])
    print(f"{a.pdf}: {len(score['pages'])} music pages, {n} notes -> {a.out}")
    if a.debug:
        png = a.out.replace(".json", "_debug_p1.png")
        debug_png(a.pdf, score, png, score["pages"][0]["index"])
        print("debug:", png)
