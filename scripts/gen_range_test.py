#!/usr/bin/env python3
"""Generate range-test.pdf + range-test.json — "Happy Birthday to You".

The Find-your-range flow displays the PDF but takes all note data from the
bundled JSON (score override), so the PDF only needs to LOOK right; the
extractor never reads it. Coordinates in the JSON match the drawing exactly.

Run from the project root:  python3 scripts/gen_range_test.py
"""
import fitz, json, os

OUT_PDF = "range-test.pdf"
OUT_JSON = "range-test.json"
DEJAVU = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"

W, H = 612, 792
SP = 6.0                 # staff line spacing
HALF = SP / 2
X_START, X_END = 70, 545
STAFF_TOPS = [150, 240, 330, 420]
BLACK = (0, 0, 0)

# F major, E4(bottom line) = step 0
STEP = {"C4": -2, "D4": -1, "E4": 0, "F4": 1, "G4": 2, "A4": 3, "Bb4": 4, "C5": 5}
MIDI = {"C4": 60, "D4": 62, "E4": 64, "F4": 65, "G4": 67, "A4": 69, "Bb4": 70, "C5": 72}

# (pitch, glyph, lyric) per phrase; e=eighth q=quarter h=half
PHRASES = [
    [("C4","e","Hap-"),("C4","e","py"),("D4","q","birth-"),("C4","q","day"),("F4","q","to"),("E4","h","you,")],
    [("C4","e","Hap-"),("C4","e","py"),("D4","q","birth-"),("C4","q","day"),("G4","q","to"),("F4","h","you,")],
    [("C4","e","Hap-"),("C4","e","py"),("C5","q","birth-"),("A4","q","day"),("F4","q","dear"),("E4","q","friend,"),("D4","q","")],
    [("Bb4","e","Hap-"),("Bb4","e","py"),("A4","q","birth-"),("F4","q","day"),("G4","q","to"),("F4","h","you!")],
]
GLYPH_NAME = {"e": "eighth", "q": "quarter", "h": "half"}

doc = fitz.open()
page = doc.new_page(width=W, height=H)
font = fitz.Font(fontfile=DEJAVU)
page.insert_font(fontname="dv", fontbuffer=font.buffer)

def text(x, y, s, size, bold=False, center=None):
    if center is not None:
        tl = fitz.get_text_length(s, fontname="helv", fontsize=size)
        x = center - tl / 2
    page.insert_text(fitz.Point(x, y), s, fontsize=size, fontname="helv", color=BLACK)

def dvtext(x, y, s, size, center=None):
    if center is not None:
        tl = font.text_length(s, fontsize=size)
        x = center - tl / 2
    page.insert_text(fitz.Point(x, y), s, fontsize=size, fontname="dv", color=BLACK)

# Title
text(0, 72, "Happy Birthday to You", 22, center=W / 2)
text(0, 94, "Traditional  ·  Sing it however feels comfortable — any key, any speed.", 11, center=W / 2)

def draw_clef(bottom):
    """Stylized treble clef centered on the staff (bezier approximation)."""
    gy = bottom - 2 * HALF * 2       # G line (step 2)
    x = 84
    top = bottom - 4 * SP - 8
    bot = bottom + 7
    sh = page.new_shape()
    # main swash: from below the staff up over the top, one S-curve
    sh.draw_bezier(fitz.Point(x - 1, bot), fitz.Point(x + 9, bot - 14),
                   fitz.Point(x - 9, top + 16), fitz.Point(x + 1, top))
    # upper hook
    sh.draw_bezier(fitz.Point(x + 1, top), fitz.Point(x + 6, top + 3),
                   fitz.Point(x + 6, top + 9), fitz.Point(x + 1, top + 12))
    # loop around the G line
    sh.draw_bezier(fitz.Point(x - 1, gy - 8), fitz.Point(x - 8, gy + 1),
                   fitz.Point(x - 5, gy + 8), fitz.Point(x + 2, gy + 6))
    sh.draw_bezier(fitz.Point(x + 2, gy + 6), fitz.Point(x + 8, gy + 4),
                   fitz.Point(x + 6, gy - 4), fitz.Point(x - 1, gy - 2))
    # bottom curl
    sh.draw_bezier(fitz.Point(x - 1, bot), fitz.Point(x - 6, bot + 1),
                   fitz.Point(x - 6, bot - 5), fitz.Point(x - 2, bot - 5))
    sh.finish(width=1.6, color=BLACK)
    sh.commit()

score_staves = []
gidx = 0
for si, (top, phrase) in enumerate(zip(STAFF_TOPS, PHRASES)):
    line_ys = [top + i * SP for i in range(5)]
    bottom = line_ys[4]
    # staff lines
    sh = page.new_shape()
    for y in line_ys:
        sh.draw_line(fitz.Point(X_START, y), fitz.Point(X_END, y))
    # end barline + final double bar
    sh.draw_line(fitz.Point(X_END, line_ys[0]), fitz.Point(X_END, bottom))
    if si == len(STAFF_TOPS) - 1:
        sh.draw_line(fitz.Point(X_END - 4, line_ys[0]), fitz.Point(X_END - 4, bottom))
    sh.finish(width=0.9, color=BLACK)
    sh.commit()

    draw_clef(bottom)
    # key signature: one flat on the B line (step 4)
    dvtext(101, (bottom - 4 * HALF) + 4.2, "♭", 15)

    # note x layout
    n = len(phrase)
    x0, x1 = 132, X_END - 26
    dx = (x1 - x0) / (n - 1)
    notes_json = []
    heads = []
    for i, (pitch, g, lyric) in enumerate(phrase):
        x = x0 + i * dx
        step = STEP[pitch]
        y = bottom - step * HALF
        heads.append((x, y, g))
        # ledger line (middle C)
        if step <= -2:
            sh = page.new_shape()
            sh.draw_line(fitz.Point(x - 7.5, y), fitz.Point(x + 7.5, y))
            sh.finish(width=0.9, color=BLACK)
            sh.commit()
        # notehead
        rect = fitz.Rect(x - 4.6, y - 3.4, x + 4.6, y + 3.4)
        sh = page.new_shape()
        sh.draw_oval(rect)
        if g == "h":
            sh.finish(width=1.3, color=BLACK)              # hollow
        else:
            sh.finish(width=0.8, color=BLACK, fill=BLACK)  # filled
        sh.commit()
        # stem up
        sh = page.new_shape()
        sh.draw_line(fitz.Point(x + 4.3, y - 1.2), fitz.Point(x + 4.3, y - 22))
        sh.finish(width=1.1, color=BLACK)
        sh.commit()
        # lyric ("-" shown on melisma notes, but JSON keeps lyric "")
        dvtext(0, bottom + 17, lyric if lyric else "-", 10.5, center=x)
        notes_json.append({
            "index": gidx,
            "type": "note",
            "glyph": GLYPH_NAME[g],
            "x": round(x, 2),
            "y": round(y, 2),
            "step": step,
            "midi": MIDI[pitch],
            "accidental": None,
            "lyric": lyric,
        })
        gidx += 1
    # beam the eighth pair (first two notes of each phrase)
    (bx1, by1, _), (bx2, by2, _) = heads[0], heads[1]
    sh = page.new_shape()
    sh.draw_line(fitz.Point(bx1 + 4.3, by1 - 22), fitz.Point(bx2 + 4.3, by2 - 22))
    sh.finish(width=3.2, color=BLACK)
    sh.commit()

    score_staves.append({
        "index": si,
        "xStart": float(X_START),
        "xEnd": float(X_END),
        "lineYs": [round(y, 2) for y in line_ys],
        "spacing": SP,
        "clef": "treble",
        "keySig": {"fifths": -1},
        "label": "Happy Birthday to You" if si == 0 else None,
        "notes": notes_json,
    })

# footer hint (below the last staff's lyric line)
text(0, 500, "Click anywhere when you are ready — sing at your own pitch and pace.", 10, center=W / 2)

doc.save(OUT_PDF)
score = {
    "version": 1,
    "source": OUT_PDF,
    "pages": [{
        "index": 0,
        "width": float(W),
        "height": float(H),
        "staves": score_staves,
    }],
}
with open(OUT_JSON, "w") as f:
    json.dump(score, f, indent=1)
total = sum(len(s["notes"]) for s in score_staves)
print(f"wrote {OUT_PDF} + {OUT_JSON}: {total} notes, range C4-C5, key F major")
