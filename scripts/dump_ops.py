#!/usr/bin/env python3
"""Emit pdf.js-style operator lists + staff lines + truth chars for a PDF,
so the browser extractor can be driven headlessly in node.
Output JSON: { pages: [ { ops: [[fn, args], ...], view, staffLines, truth, fonts } ] }
fn names: beginText, setFont, setCharSpacing, setTextMatrix, moveText,
setLeadingMoveText, setLeading, nextLine, showText.
showText args: [ [ {unicode, width} | number, ... ] ]
"""
import fitz, re, json, sys, statistics

def parse_tounicode(doc, xref):
    """xref of a font dict -> {cid_int: unicode_str}"""
    m = {}
    tu = doc.xref_get_key(xref, "ToUnicode")
    if not tu or tu[0] != "xref":
        return m
    tu_xref = int(tu[1].split()[0])
    data = doc.xref_stream(tu_xref).decode("latin-1", "replace")
    for blk in re.findall(r"beginbfchar(.*?)endbfchar", data, re.S):
        for src, dst in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
            cid = int(src, 16)
            uni = "".join(chr(int(dst[i:i+4], 16)) for i in range(0, len(dst), 4))
            m[cid] = uni
    for blk in re.findall(r"beginbfrange(.*?)endbfrange", data, re.S):
        for lo, hi, dst in re.findall(r"<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>", blk):
            lo_i, hi_i, d = int(lo, 16), int(hi, 16), int(dst, 16)
            for c in range(lo_i, hi_i + 1):
                m[c] = chr(d + (c - lo_i))
    return m

def parse_widths(doc, xref):
    """Type0 /W array -> {cid: width_thousandths}; also /DW default."""
    w = {}
    dw = 1000
    desc = doc.xref_get_key(xref, "DescendantFonts")
    if desc and desc[0] == "array":
        m = re.search(r"(\d+) 0 R", desc[1])
        if m:
            dxref = int(m.group(1))
            dwv = doc.xref_get_key(dxref, "DW")
            if dwv and dwv[0] == "int":
                dw = int(dwv[1])
            wv = doc.xref_get_key(dxref, "W")
            if wv and wv[0] == "array":
                toks = re.findall(r"[\[\]]|-?\d+\.?\d*", wv[1])
                i = 0
                nums = []
                # parse structure: c [w1 w2 ...] | c1 c2 w
                seq = []
                depth = 0
                cur = []
                for t in toks:
                    if t == "[":
                        depth += 1
                        if depth == 2:
                            cur = []
                    elif t == "]":
                        if depth == 2:
                            seq.append(cur)
                        depth -= 1
                    else:
                        v = float(t)
                        if depth == 2:
                            cur.append(v)
                        else:
                            seq.append(v)
                i = 0
                while i < len(seq):
                    if isinstance(seq[i], float) and i + 1 < len(seq) and isinstance(seq[i+1], list):
                        start = int(seq[i])
                        for k, wid in enumerate(seq[i+1]):
                            w[start + k] = wid
                        i += 2
                    elif (i + 2 < len(seq) and isinstance(seq[i], float)
                          and isinstance(seq[i+1], float) and isinstance(seq[i+2], float)):
                        for c in range(int(seq[i]), int(seq[i+1]) + 1):
                            w[c] = seq[i+2]
                        i += 3
                    else:
                        i += 1
    return w, dw

NUM = r"-?(?:\d+\.?\d*|\.\d+)"

def tokenize_ops(stream):
    """Very small tokenizer for Finale-style content streams (text ops only)."""
    ops = []
    # Split into BT..ET blocks and process all text ops inside
    for blk in re.findall(r"BT(.*?)ET", stream, re.S):
        ops.append(["beginText", []])
        pos = 0
        pattern = re.compile(
            r"/(\S+)\s+(" + NUM + r")\s+Tf"
            r"|(" + NUM + r")\s+(" + NUM + r")\s+(" + NUM + r")\s+(" + NUM + r")\s+(" + NUM + r")\s+(" + NUM + r")\s+Tm"
            r"|(" + NUM + r")\s+(" + NUM + r")\s+TD"
            r"|(" + NUM + r")\s+(" + NUM + r")\s+Td"
            r"|(" + NUM + r")\s+TL"
            r"|(" + NUM + r")\s+Tc"
            r"|T\*"
            r"|\[((?:[^\[\]]|\[[^\]]*\])*?)\]\s*TJ"
            r"|<([0-9A-Fa-f]+)>\s*Tj"
            r"|\(((?:[^()\\]|\\.)*)\)\s*Tj"
        )
        for m in pattern.finditer(blk):
            if m.group(1) is not None:
                ops.append(["setFont", [m.group(1), float(m.group(2))]])
            elif m.group(3) is not None:
                ops.append(["setTextMatrix", [float(m.group(i)) for i in range(3, 9)]])
            elif m.group(9) is not None:
                ops.append(["setLeadingMoveText", [float(m.group(9)), float(m.group(10))]])
            elif m.group(11) is not None:
                ops.append(["moveText", [float(m.group(11)), float(m.group(12))]])
            elif m.group(13) is not None:
                ops.append(["setLeading", [float(m.group(13))]])
            elif m.group(14) is not None:
                ops.append(["setCharSpacing", [float(m.group(14))]])
            elif m.group(0) == "T*":
                ops.append(["nextLine", []])
            elif m.group(15) is not None:
                ops.append(["TJ", [m.group(15)]])
            elif m.group(16) is not None:
                ops.append(["TjHex", [m.group(16)]])
            elif m.group(17) is not None:
                ops.append(["TjStr", [m.group(17)]])
    return ops

def main(pdf_path):
    doc = fitz.open(pdf_path)
    # font resources: name -> (unicode map, widths, basefont)
    out_pages = []
    for pno in range(len(doc)):
        page = doc[pno]
        fonts = {}
        for f in page.get_fonts(full=True):
            xref, basefont, refname, enc = f[0], f[3], f[4], f[5]
            # simple-font /Widths + /FirstChar
            sw = {}
            fc = doc.xref_get_key(xref, "FirstChar")
            wv = doc.xref_get_key(xref, "Widths")
            if fc and fc[0] == "int" and wv and wv[0] == "array":
                first = int(fc[1])
                vals = [float(t) for t in re.findall(NUM, wv[1])]
                for k, wid in enumerate(vals):
                    sw[first + k] = wid
            t0w, t0dw = parse_widths(doc, xref)
            sw.update(t0w)
            codec = None
            if enc and "WinAnsi" in enc:
                codec = "cp1252"
            elif enc and "MacRoman" in enc:
                codec = "mac_roman"
            fonts[refname] = {
                "name": basefont,
                "uni": parse_tounicode(doc, xref),
                "widths": (sw, t0dw),
                "codec": codec,
            }
        stream = page.read_contents().decode("latin-1")
        raw_ops = tokenize_ops(stream)
        # resolve show-text ops into glyph arrays
        ops = []
        cur_font = None
        for fn, args in raw_ops:
            if fn == "setFont":
                cur_font = args[0]
                ops.append(["setFont", [args[0], args[1]]])
            elif fn in ("TjHex", "TJ", "TjStr"):
                fi = fonts.get(cur_font, {"uni": {}, "widths": ({}, 1000)})
                wmap, dw = fi["widths"]
                glyphs = []
                def emit_hex(hexstr):
                    step = 4 if len(fi["uni"]) and max(fi["uni"]) > 255 else 4
                    # Finale CID fonts use 2-byte codes
                    for i in range(0, len(hexstr), 4):
                        cid = int(hexstr[i:i+4], 16)
                        glyphs.append({
                            "unicode": fi["uni"].get(cid, ""),
                            "width": wmap.get(cid, dw),
                        })
                if fn == "TjHex":
                    emit_hex(args[0])
                elif fn == "TjStr":
                    # Literal string: decode escapes, then map bytes → unicode
                    # via the font's ToUnicode CMap (single-byte codes),
                    # matching what pdf.js provides as glyph.unicode.
                    s = args[0]
                    bytes_out = []
                    i = 0
                    while i < len(s):
                        ch = s[i]
                        if ch == "\\" and i + 1 < len(s):
                            nxt = s[i+1]
                            if nxt in "()\\":
                                bytes_out.append(ord(nxt)); i += 2
                            elif nxt.isdigit():
                                j = i + 1
                                oct_s = ""
                                while j < len(s) and len(oct_s) < 3 and s[j].isdigit():
                                    oct_s += s[j]; j += 1
                                bytes_out.append(int(oct_s, 8) & 0xFF); i = j
                            elif nxt == "n": bytes_out.append(10); i += 2
                            elif nxt == "r": bytes_out.append(13); i += 2
                            elif nxt == "t": bytes_out.append(9); i += 2
                            else: i += 2
                        else:
                            bytes_out.append(ord(ch)); i += 1
                    codec = fi.get("codec")
                    for bv in bytes_out:
                        uni = fi["uni"].get(bv)
                        if uni is None and codec:
                            try:
                                uni = bytes([bv]).decode(codec)
                            except Exception:
                                uni = chr(bv)
                        if uni is None:
                            uni = chr(bv)
                        glyphs.append({
                            "unicode": uni,
                            "width": wmap.get(bv, dw),
                        })
                else:  # TJ array
                    for part in re.finditer(r"<([0-9A-Fa-f]+)>|(" + NUM + r")", args[0]):
                        if part.group(1):
                            emit_hex(part.group(1))
                        else:
                            glyphs.append(float(part.group(2)))
                ops.append(["showText", [glyphs]])
            else:
                ops.append([fn, args])
        # staff lines
        hl = []
        for dr in page.get_drawings():
            for it in dr["items"]:
                if it[0] == "l":
                    a, b = it[1], it[2]
                    if abs(a.y - b.y) < 1 and abs(a.x - b.x) > 50:
                        hl.append({"y": round((a.y + b.y) / 2, 2), "x0": round(min(a.x, b.x), 1), "x1": round(max(a.x, b.x), 1)})
                elif it[0] == "re":
                    r = it[1]
                    if r.height < 1.5 and r.width > 50:
                        hl.append({"y": round(r.y0 + r.height / 2, 2), "x0": round(r.x0, 1), "x1": round(r.x1, 1)})
        # truth chars (music fonts)
        truth = []
        for b in page.get_text("rawdict")["blocks"]:
            for l in b.get("lines", []):
                for s in l["spans"]:
                    if s["font"] in ("Maestro", "Petrucci"):
                        for ch in s["chars"]:
                            if ch["c"].strip():
                                truth.append({"c": ch["c"], "x": round(ch["origin"][0], 2), "y": round(ch["origin"][1], 2)})
        out_pages.append({
            "index": pno,
            "view": [0, 0, round(page.rect.width, 2), round(page.rect.height, 2)],
            "fontNames": {k: v["name"] for k, v in fonts.items()},
            "ops": ops,
            "staffLines": hl,
            "truth": truth,
        })
    json.dump({"pages": out_pages}, open(sys.argv[2], "w"))
    print(f"{pdf_path}: {len(out_pages)} pages -> {sys.argv[2]}")

main(sys.argv[1])
