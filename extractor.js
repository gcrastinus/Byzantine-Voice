/**
 * In-browser score extraction for MCI Finale PDFs (Maestro/Petrucci).
 * Port of extract_score.py — same rules, same score.json schema.
 *
 * Staff lines: render page at scale 2, scan dark horizontal runs.
 * Glyphs: pdf.js getTextContent(), resolve font via styles[id].fontFamily.
 * Coordinates in schema: PDF points, origin top-left, y down.
 *
 * API: window.ScoreExtractor.extractPdf(pdfDoc, sourceName) → scoreJson
 */
(() => {
  "use strict";

  const MUSIC_FONTS = ["Maestro", "Petrucci"];
  // Maestro/Petrucci notehead code points (must stay as UTF-8 string keys)
  const NOTEHEADS = {
    "\u0153": "quarter", // œ  (filled head — also used under flags for 8ths/16ths)
    "\u02D9": "half", // ˙  (dot above — Finale half-note head)
    w: "whole",
    W: "recit",
  };
  /**
   * Flag characters (Maestro/Petrucci). Filled head œ + flag ⇒ shorter duration.
   * j/J = eighth flag (up/down stem); k/K = sixteenth flag when present.
   * Beamed 8ths often have no flag glyph (beams are drawings) — those still
   * look like quarters unless a flag is present.
   */
  const FLAG_WEIGHT = {
    j: 1,
    J: 1,
    k: 2,
    K: 2,
  };
  const ACCIDENTALS = { "#": 1, b: -1, n: 0 };
  const SHARP_LETTERS = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
  const FLAT_LETTERS = [6, 2, 5, 1, 4]; // B E A D G
  const LETTER_PC = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B

  const STAFF_SCAN_SCALE = 2;
  const DARK_LUMA = 128;
  const MIN_RUN_FRAC = 0.3;

  function isMusicFont(family) {
    if (!family) return false;
    const f = String(family);
    return MUSIC_FONTS.some((m) => f.indexOf(m) !== -1);
  }

  // —— Notation diagnostic (read-only tap; never affects extraction) ——
  /** @type {Map<string, object>|null} filled during musicChars, consumed by extractPage */
  let fontTapActive = null;
  /** Accumulator across progressive / full extract runs */
  const diagAcc = {
    source: "",
    fileSize: null,
    pagesExpected: 0,
    pageDiags: [],
    totalNotes: 0,
    totalStaves: 0,
  };

  const FONT_CHAR_CAP = 40;
  const SMUFL_LO = 0xe000;
  const SMUFL_HI = 0xf8ff;

  function codepointLabel(ch) {
    if (!ch) return "U+0000";
    const cp = ch.codePointAt(0);
    const hex = cp.toString(16).toUpperCase();
    return "U+" + (hex.length < 4 ? ("0000" + hex).slice(-4) : hex);
  }

  function resetDiagAcc(sourceName, opts) {
    const o = opts || {};
    diagAcc.source = sourceName || (o.source != null ? o.source : "") || "";
    diagAcc.fileSize = o.fileSize != null ? o.fileSize : null;
    diagAcc.pagesExpected = o.pagesExpected != null ? o.pagesExpected | 0 : 0;
    diagAcc.pageDiags = [];
    diagAcc.totalNotes = 0;
    diagAcc.totalStaves = 0;
  }

  function beginFontTap() {
    fontTapActive = new Map();
  }

  /**
   * Record every shown glyph (music or not). Does not touch extraction output.
   * @param {string} resolvedName
   * @param {boolean} musicFont
   * @param {string} c single character
   * @param {number} yTop top-left origin y
   */
  function tapFontGlyph(resolvedName, musicFont, c, yTop) {
    if (!fontTapActive) return;
    const key = resolvedName || "(unknown)";
    let f = fontTapActive.get(key);
    if (!f) {
      f = {
        resolvedName: key,
        isMusicFont: !!musicFont,
        glyphCount: 0,
        chars: new Map(),
        ys: [],
      };
      fontTapActive.set(key, f);
    }
    // If the same name was seen as music later, keep the OR
    if (musicFont) f.isMusicFont = true;
    f.glyphCount += 1;
    f.ys.push(yTop);
    if (f.chars.has(c)) {
      f.chars.get(c).count += 1;
    } else if (f.chars.size < FONT_CHAR_CAP) {
      f.chars.set(c, { count: 1, codepoint: codepointLabel(c) });
    }
    // else: cap hit — only glyphCount continues
  }

  function nearStaffCountForYs(ys, staves) {
    if (!ys || !ys.length || !staves || !staves.length) return 0;
    let n = 0;
    for (let i = 0; i < ys.length; i++) {
      const y = ys[i];
      for (let s = 0; s < staves.length; s++) {
        const st = staves[s];
        const sp = st.spacing > 0 ? st.spacing : 4.32;
        const lineYs = st.lineYs;
        if (!lineYs || lineYs.length < 5) continue;
        const top = lineYs[0] - 6 * sp;
        const bot = lineYs[4] + 6 * sp;
        if (y >= top && y <= bot) {
          n += 1;
          break;
        }
      }
    }
    return n;
  }

  /**
   * Finalize per-page font stats from the active tap + detected staves.
   * Drops fonts with glyphCount 0; strips raw y arrays from the published form.
   */
  function finalizeFontTap(staves) {
    const tap = fontTapActive;
    fontTapActive = null;
    if (!tap) return [];
    const fonts = [];
    for (const f of tap.values()) {
      if (!f.glyphCount) continue;
      const nearStaffCount = nearStaffCountForYs(f.ys, staves);
      const chars = [];
      for (const [ch, info] of f.chars) {
        chars.push({ ch: ch, codepoint: info.codepoint, count: info.count });
      }
      chars.sort((a, b) => b.count - a.count || a.codepoint.localeCompare(b.codepoint));
      fonts.push({
        resolvedName: f.resolvedName,
        isMusicFont: !!f.isMusicFont,
        glyphCount: f.glyphCount,
        nearStaffCount: nearStaffCount,
        chars: chars,
      });
    }
    fonts.sort((a, b) => b.glyphCount - a.glyphCount || a.resolvedName.localeCompare(b.resolvedName));
    return fonts;
  }

  function computeSmuflSuspected(pageDiags) {
    for (const pd of pageDiags) {
      for (const f of pd.fonts || []) {
        if (f.isMusicFont) continue;
        if (!(f.nearStaffCount > 0)) continue;
        for (const c of f.chars || []) {
          const cp = c.ch && c.ch.codePointAt(0);
          if (cp >= SMUFL_LO && cp <= SMUFL_HI) return true;
        }
      }
    }
    return false;
  }

  function publishLastDiagnostic() {
    const pageDiags = diagAcc.pageDiags;
    const diag = {
      when: new Date().toISOString(),
      source: diagAcc.source || "",
      fileSize: diagAcc.fileSize,
      pages: diagAcc.pagesExpected || pageDiags.length,
      totalStaves: diagAcc.totalStaves,
      totalNotes: diagAcc.totalNotes,
      pageDiags: pageDiags,
      smuflSuspected: computeSmuflSuspected(pageDiags),
    };
    window.ScoreExtractor.lastDiagnostic = diag;
    return diag;
  }

  function appendPageDiag(pageDiag, noteCount) {
    if (!pageDiag) return;
    diagAcc.pageDiags.push(pageDiag);
    diagAcc.totalStaves += pageDiag.staves | 0;
    diagAcc.totalNotes += noteCount | 0;
    publishLastDiagnostic();
  }

  /**
   * Plain-text report for clipboard (self-contained; no PDF required).
   * @param {object} [diag] defaults to lastDiagnostic
   */
  function formatDiagnosticReport(diag) {
    const d = diag || (window.ScoreExtractor && window.ScoreExtractor.lastDiagnostic);
    if (!d) return "Byzantine Voice notation diagnostic — (no diagnostic available yet)\n";
    const lines = [];
    lines.push("Byzantine Voice notation diagnostic — " + (d.when || ""));
    const sizePart =
      d.fileSize != null && Number.isFinite(Number(d.fileSize))
        ? Number(d.fileSize) + " bytes, "
        : "";
    lines.push(
      "File: " +
        (d.source || "(unknown)") +
        " (" +
        sizePart +
        (d.pages | 0) +
        " pages)"
    );
    lines.push(
      "Result: " +
        (d.totalStaves | 0) +
        " staves, " +
        (d.totalNotes | 0) +
        " notes extracted"
    );
    lines.push("SMuFL suspected: " + (d.smuflSuspected ? "yes" : "no"));
    lines.push("");
    for (const pd of d.pageDiags || []) {
      lines.push("Page " + pd.page + " — " + (pd.staves | 0) + " staves");
      for (const f of pd.fonts || []) {
        lines.push(
          '  Font "' +
            f.resolvedName +
            '" (music-font match: ' +
            (f.isMusicFont ? "yes" : "no") +
            ") — " +
            f.glyphCount +
            " glyphs, " +
            f.nearStaffCount +
            " near staves"
        );
        if (f.chars && f.chars.length) {
          const parts = f.chars.map((c) => {
            const printable =
              c.ch && /^[A-Za-z0-9]$/.test(c.ch) ? "'" + c.ch + "' " : "";
            return printable + c.codepoint + " ×" + c.count;
          });
          lines.push("    " + parts.join(", "));
        }
      }
      lines.push("");
    }
    return lines.join("\n").replace(/\n+$/, "\n");
  }

  /**
   * Glyphs we may keep when the music font name failed to resolve (pdf.js
   * commonObjs lag). Must NOT include ordinary Latin letters from lyrics:
   *   w/W → false whole/recit heads under the staff
   *   j/J/k/K → false eighth flags on nearby noteheads (e.g. “James”, “John”)
   *
   * Safe without font: œ, half-head (˙), clefs, augmentation dots.
   * Flags and w/W/accidentals require a Maestro/Petrucci font.
   */
  function isSafeUnresolvedMusicChar(c) {
    if (!c) return false;
    if (c === "\u0153" || c === "\u02D9") return true; // filled / half heads
    if (c === "&" || c === "?" || c === ".") return true;
    return false;
  }

  /** @deprecated use isSafeUnresolvedMusicChar — kept for tests / exports */
  function isKnownMusicChar(c) {
    return isSafeUnresolvedMusicChar(c);
  }

  function round(n, d) {
    const p = Math.pow(10, d);
    return Math.round(n * p) / p;
  }

  function median(arr) {
    if (!arr.length) return 0;
    const s = arr.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /**
   * Treble clef: step 0 = E4. Port of step_to_midi.
   * @param {number} step
   * @param {number} keyFifths
   * @param {string|null} inline  '#', 'b', 'n', or null
   */
  function stepToMidi(step, keyFifths, inline) {
    const absStep = 30 + step; // E4 = 4*7 + 2
    const octave = Math.floor(absStep / 7);
    const letter = ((absStep % 7) + 7) % 7;
    let pc = LETTER_PC[letter];
    let alter = 0;
    if (keyFifths > 0 && SHARP_LETTERS.slice(0, keyFifths).indexOf(letter) !== -1) {
      alter = 1;
    } else if (
      keyFifths < 0 &&
      FLAT_LETTERS.slice(0, -keyFifths).indexOf(letter) !== -1
    ) {
      alter = -1;
    }
    if (inline != null && Object.prototype.hasOwnProperty.call(ACCIDENTALS, inline)) {
      alter = ACCIDENTALS[inline];
    }
    return 12 * (octave + 1) + pc + alter;
  }

  /** PDF bottom-left y → top-left y (page.view = [x0,y0,x1,y1]). */
  function yToTop(page, yPdf) {
    const v = page.view;
    return v[3] - yPdf;
  }

  /**
   * Scan a rendered page for horizontal staff-line candidates.
   * Returns [{ y, x0, x1 }] in PDF points, top-left origin, y down.
   */
  async function findStaffLinesByCanvas(page) {
    const scale = STAFF_SCAN_SCALE;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    const w = canvas.width;
    const h = canvas.height;
    const img = ctx.getImageData(0, 0, w, h);
    const data = img.data;
    const minRun = Math.floor(w * MIN_RUN_FRAC);

    // Per-row: longest dark horizontal run + its bounds
    const lineRows = []; // { row, x0, x1, run }
    for (let row = 0; row < h; row++) {
      let best = 0;
      let bestX0 = 0;
      let bestX1 = 0;
      let run = 0;
      let runStart = 0;
      const base = row * w * 4;
      for (let col = 0; col < w; col++) {
        const i = base + col * 4;
        const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        if (luma < DARK_LUMA) {
          if (run === 0) runStart = col;
          run++;
          if (run > best) {
            best = run;
            bestX0 = runStart;
            bestX1 = col;
          }
        } else {
          run = 0;
        }
      }
      if (best >= minRun) {
        lineRows.push({ row, x0: bestX0, x1: bestX1, run: best });
      }
    }

    // Merge vertically adjacent rows (line thickness) → center y + union x
    const lines = [];
    let i = 0;
    while (i < lineRows.length) {
      let j = i + 1;
      let sumRow = lineRows[i].row;
      let count = 1;
      let x0 = lineRows[i].x0;
      let x1 = lineRows[i].x1;
      while (j < lineRows.length && lineRows[j].row === lineRows[j - 1].row + 1) {
        sumRow += lineRows[j].row;
        count++;
        x0 = Math.min(x0, lineRows[j].x0);
        x1 = Math.max(x1, lineRows[j].x1);
        j++;
      }
      const centerRow = sumRow / count;
      lines.push({
        y: centerRow / scale,
        x0: x0 / scale,
        x1: x1 / scale,
      });
      i = j;
    }
    return lines;
  }

  /** Group 5 equal-gap lines into staves (port of find_staves grouping). */
  function groupStaves(hl) {
    hl = hl.slice().sort((a, b) => a.y - b.y);
    const ys = hl.map((h) => h.y);
    const staves = [];
    let i = 0;
    while (i + 4 < ys.length) {
      const gaps = [];
      for (let k = 0; k < 4; k++) gaps.push(ys[i + k + 1] - ys[i + k]);
      const m = median(gaps);
      if (m > 3 && gaps.every((g) => Math.abs(g - m) < 0.15 * m)) {
        const slice = hl.slice(i, i + 5);
        staves.push({
          lineYs: ys.slice(i, i + 5).map((y) => round(y, 2)),
          spacing: round(m, 3),
          xStart: round(Math.min(...slice.map((h) => h.x0)), 1),
          xEnd: round(Math.max(...slice.map((h) => h.x1)), 1),
        });
        i += 5;
      } else {
        i += 1;
      }
    }
    return staves;
  }

  /**
   * pdf.js styles[].fontFamily is often a generic fallback ("sans-serif").
   * The real embedded name (e.g. "OLEIGD+Maestro") lives on page.commonObjs.
   */
  function resolveFontName(page, fontId, styles) {
    try {
      if (page.commonObjs && page.commonObjs.has(fontId)) {
        const font = page.commonObjs.get(fontId);
        if (font && font.name) return font.name;
      }
    } catch (_) {
      /* ignore */
    }
    const style = (styles && styles[fontId]) || {};
    return style.fontFamily || style.fontName || fontId || "";
  }

  function getPdfjs() {
    return window["pdfjs-dist/build/pdf"] || window.pdfjsLib;
  }

  /**
   * Music glyphs via the operator list (NOT getTextContent).
   *
   * getTextContent merges consecutive noteheads into one item with a single y.
   * Finale also uses TD (setLeadingMoveText) between glyphs instead of a fresh
   * Tm — we must track the full text matrix like a PDF consumer.
   */
  async function musicChars(page) {
    const pdfjs = getPdfjs();
    const OPS = pdfjs.OPS;
    const opList = await page.getOperatorList();
    const out = [];

    let fontId = null;
    let fontSize = 1; // Tf size; Finale bakes scale into Tm and uses size 1
    let charSpacing = 0; // Tc
    // Text matrix [a b c d e f] maps text space → user space
    let textMatrix = [1, 0, 0, 1, 0, 0];
    let textLineMatrix = [1, 0, 0, 1, 0, 0];
    let leading = 0;

    function cloneM(m) {
      return m.slice();
    }

    /**
     * PDF Td/TD/T* semantics (spec 9.4.2): the translation applies to the
     * TEXT LINE MATRIX — i.e. relative to the START of the current line —
     * and the text matrix is reset to the new line matrix.
     *
     * The old code translated the post-advance text matrix instead. Finale
     * positions key-signature sharps and chord voices with TD after showing
     * a glyph, so every glyph after the first in such a block landed shifted
     * right by the previous glyph's advance: displaced sharps turned into
     * phantom inline accidentals on the SECOND note of a staff, and chord
     * voices stopped sharing an x column (Play arpeggiated all voices).
     */
    function moveTextLine(tx, ty) {
      const a = textLineMatrix[0];
      const b = textLineMatrix[1];
      const c = textLineMatrix[2];
      const d = textLineMatrix[3];
      const e = textLineMatrix[4];
      const f = textLineMatrix[5];
      textLineMatrix = [a, b, c, d, e + tx * a + ty * c, f + tx * b + ty * d];
      textMatrix = cloneM(textLineMatrix);
    }

    /** Pen advance within the line (does NOT touch the line matrix). */
    function movePen(tx) {
      const a = textMatrix[0];
      const b = textMatrix[1];
      textMatrix = [
        textMatrix[0],
        textMatrix[1],
        textMatrix[2],
        textMatrix[3],
        textMatrix[4] + tx * a,
        textMatrix[5] + tx * b,
      ];
    }

    function nextLine() {
      moveTextLine(0, -leading);
    }

    /** Advance pen by glyph width (thousandths of em × font size + Tc). */
    function advanceByWidth(widthThou) {
      const w = widthThou != null ? widthThou : 500;
      movePen((w / 1000) * fontSize + charSpacing);
    }

    function emitGlyphs(glyphs) {
      const fontName = fontId ? resolveFontName(page, fontId, null) : "";
      const musicFont = !!(fontId && isMusicFont(fontName));
      // The safe-char fallback exists for the rare case where pdf.js hasn't
      // resolved the real font name yet. It must apply ONLY when the name is
      // truly unresolved — if it resolved to a text font (Times etc.), lyric
      // characters like "?", "&" and "." must NOT enter the music stream
      // (a lyric "?" would be read as a bass clef and drop the whole staff).
      const unresolved = !fontName || fontName === fontId;
      const list = Array.isArray(glyphs) ? glyphs : [glyphs];

      // Always walk the list so the text matrix advances correctly.
      // Emit if font is Maestro/Petrucci, OR a *safe* unresolved music glyph
      // (flags/œ — not Latin w/W from lyrics). Unresolved font names used to
      // drop all flags; the first fix was too broad and pulled lyric “w” in as
      // whole notes under the staff.
      // Diagnostic tap (fontTapActive): records EVERY shown glyph for every
      // font — does not change what enters `out` / extraction.
      for (const g of list) {
        if (g == null) continue;
        // TJ numbers: horizontal displacement in thousandths of text space
        if (typeof g === "number") {
          movePen((-g / 1000) * fontSize);
          continue;
        }

        let ch = "";
        let widthThou = 500;
        if (typeof g === "string") {
          ch = g;
        } else if (typeof g === "object") {
          // Prefer unicode; fall back to fontChar (Maestro single-byte glyphs)
          if (g.unicode != null && String(g.unicode).length) {
            ch = String(g.unicode);
          } else if (g.fontChar != null && String(g.fontChar).length) {
            ch = String(g.fontChar);
          }
          widthThou = g.width != null ? g.width : 500;
        }

        // Record position of this glyph, then advance
        const x = textMatrix[4];
        const yTop = yToTop(page, textMatrix[5]);
        for (let i = 0; i < ch.length; i++) {
          const c = ch[i];
          if (!c || !c.trim()) continue;
          // Read-only diagnostic: all fonts, all glyphs
          tapFontGlyph(fontName || fontId || "(unknown)", musicFont, c, yTop);
          if (musicFont || (unresolved && isSafeUnresolvedMusicChar(c))) {
            out.push({ c, x, y: yTop });
          }
        }
        advanceByWidth(widthThou);
      }
    }

    for (let i = 0; i < opList.fnArray.length; i++) {
      const fn = opList.fnArray[i];
      const args = opList.argsArray[i];

      if (fn === OPS.beginText) {
        textMatrix = [1, 0, 0, 1, 0, 0];
        textLineMatrix = [1, 0, 0, 1, 0, 0];
      } else if (fn === OPS.setFont) {
        fontId = args[0];
        fontSize = typeof args[1] === "number" && args[1] > 0 ? args[1] : 1;
      } else if (fn === OPS.setCharSpacing) {
        charSpacing = typeof args[0] === "number" ? args[0] : 0;
      } else if (fn === OPS.setTextMatrix) {
        if (args && args.length >= 6) {
          textMatrix = [
            args[0],
            args[1],
            args[2],
            args[3],
            args[4],
            args[5],
          ];
          textLineMatrix = cloneM(textMatrix);
        }
      } else if (fn === OPS.setLeading) {
        leading = args[0];
      } else if (fn === OPS.moveText) {
        // Td — relative to the line matrix, NOT the advanced pen position
        moveTextLine(args[0], args[1]);
      } else if (fn === OPS.setLeadingMoveText) {
        // TD: set leading = -ty, then Td(tx, ty)
        leading = -args[1];
        moveTextLine(args[0], args[1]);
      } else if (fn === OPS.nextLine) {
        nextLine();
      } else if (fn === OPS.showText) {
        emitGlyphs(args[0]);
      } else if (fn === OPS.showSpacedText) {
        emitGlyphs(args[0]);
      } else if (fn === OPS.nextLineShowText) {
        nextLine();
        emitGlyphs(args[0]);
      } else if (fn === OPS.nextLineSetSpacingShowText) {
        // args: [wordSpacing, charSpacing, text]
        charSpacing = typeof args[1] === "number" ? args[1] : charSpacing;
        nextLine();
        emitGlyphs(args[2]);
      }
    }

    out.sort((a, b) => a.x - b.x || a.y - b.y);
    return out;
  }

  /**
   * Lyric / text words (non-music fonts) via getTextContent.
   * Port of text_words: x, y (mid), yTop, text.
   */
  async function textWords(page) {
    try {
      await page.getOperatorList();
    } catch (_) {
      /* optional */
    }
    const tc = await page.getTextContent({ includeMarkedContent: false });
    const styles = tc.styles || {};
    const words = [];

    for (const item of tc.items) {
      if (!item || item.str == null) continue;
      const realName = resolveFontName(page, item.fontName, styles);
      if (isMusicFont(realName)) continue;

      const raw = String(item.str).trim();
      if (!raw) continue;

      const tx = item.transform[4];
      const ty = item.transform[5];
      const yTop = yToTop(page, ty); // baseline from top
      const fs = Math.abs(item.transform[3] || item.transform[0] || 10);
      // Python yTop is the top of the word bbox; approximate from baseline.
      const wordYTop = yTop - fs;

      const parts = raw.split(/\s+/).filter(Boolean);
      const totalW =
        item.width != null ? item.width : Math.abs(item.transform[0]) * raw.length;
      if (parts.length === 1) {
        words.push({
          x: tx,
          y: wordYTop + fs / 2,
          yTop: wordYTop,
          text: parts[0],
        });
      } else {
        const fullLen = raw.length || 1;
        let searchFrom = 0;
        for (const p of parts) {
          const idx = raw.indexOf(p, searchFrom);
          const charIdx = idx >= 0 ? idx : searchFrom;
          if (idx >= 0) searchFrom = idx + p.length;
          const x = tx + (charIdx / fullLen) * totalW;
          words.push({
            x,
            y: wordYTop + fs / 2,
            yTop: wordYTop,
            text: p,
          });
        }
      }
    }
    return words;
  }

  function staffOf(y, staves) {
    let best = null;
    let bd = 1e9;
    for (let si = 0; si < staves.length; si++) {
      const st = staves[si];
      const mid = (st.lineYs[0] + st.lineYs[4]) / 2;
      const d = Math.abs(y - mid);
      if (d < bd) {
        bd = d;
        best = si;
      }
    }
    if (best == null) return null;
    return bd < 6 * staves[best].spacing ? best : null;
  }

  /**
   * Collapse multi-voice columns to a single top-voice notehead.
   * @param {Array<{x:number,y:number,c:string}>} notes sorted-ish by x
   * @param {number} spacing staff space
   * @returns {{ notes: typeof notes, stacks: number }}
   */
  function collapseToTopVoice(notes, spacing) {
    if (!notes || !notes.length) return { notes: [], stacks: 0 };
    const sp = spacing > 0 ? spacing : 4.32;
    // Finale sometimes offsets chord tones by 0–5pt in x; keep them one column
    const xTol = Math.max(4.5, sp * 1.05);
    const yStackMin = sp * 0.4; // min vertical span to count as a chord
    const sorted = notes.slice().sort((a, b) => a.x - b.x || a.y - b.y);

    // Sequential clusters by x proximity
    const clusters = [];
    for (let i = 0; i < sorted.length; i++) {
      const n = sorted[i];
      const cur = clusters[clusters.length - 1];
      if (cur && Math.abs(n.x - cur.refX) <= xTol) {
        cur.members.push(n);
        // running mean keeps staggered columns together
        cur.refX =
          (cur.refX * (cur.members.length - 1) + n.x) / cur.members.length;
      } else {
        clusters.push({ members: [n], refX: n.x });
      }
    }

    let stacks = 0;
    const out = [];
    for (const cl of clusters) {
      const mem = cl.members;
      let yMin = mem[0].y;
      let yMax = mem[0].y;
      let xMin = mem[0].x;
      let xMax = mem[0].x;
      let top = mem[0];
      for (let i = 1; i < mem.length; i++) {
        const m = mem[i];
        if (m.y < yMin) yMin = m.y;
        if (m.y > yMax) yMax = m.y;
        if (m.x < xMin) xMin = m.x;
        if (m.x > xMax) xMax = m.x;
        // top of page = smaller y (top-left coords)
        if (m.y < top.y) top = m;
      }
      if (mem.length >= 2 && yMax - yMin > yStackMin) {
        // Real multi-voice column → highest head on the page (top voice)
        stacks += 1;
        out.push(top);
      } else if (mem.length >= 2 && xMax - xMin < 1.25) {
        // Exact duplicate heads at one point
        out.push(top);
      } else {
        // Close in x but same staff height → successive monophonic notes; keep all
        mem.sort((a, b) => a.x - b.x || a.y - b.y);
        for (let i = 0; i < mem.length; i++) out.push(mem[i]);
      }
    }
    out.sort((a, b) => a.x - b.x || a.y - b.y);
    return { notes: out, stacks };
  }

  /**
   * Pair flag glyphs with the nearest filled notehead (œ).
   * Flags may sit above or below the head (stem up/down).
   * Validated on 08-15_Dormition_DL.pdf staff 1 (notes 1,2,5,6,9,10,13,14):
   *   |dx|≈5pt, |dy|≈11pt with sp≈4.32 (~2.5× spacing).
   * Lyric letters “j/J” under the staff are ~22–30pt below heads — reject those
   * with a tighter dy cap so “James” / “John” / “likewise” are not eighths.
   */
  function attachFlagsToNotes(notes, flags, spacing) {
    if (!notes || !notes.length || !flags || !flags.length) return;
    const sp = spacing > 0 ? spacing : 4.32;
    const maxDx = sp * 3.5;
    // Real stem flags: ~2–3× spacing; lyrics sit much farther below the head
    const maxDy = sp * 3.8;
    for (const f of flags) {
      let best = null;
      let bestScore = Infinity;
      for (const n of notes) {
        // Only filled heads take flags (half/whole/recit do not)
        if (n.c !== "\u0153") continue;
        const dx = f.x - n.x;
        const dy = Math.abs(f.y - n.y);
        if (Math.abs(dx) > maxDx) continue;
        if (dy > maxDy) continue;
        // Prefer closer in x; y can run along the stem
        const score = Math.abs(dx) * 1.4 + dy * 0.35;
        if (score < bestScore) {
          bestScore = score;
          best = n;
        }
      }
      if (best) {
        best.flagCount = (best.flagCount || 0) + (f.weight || 1);
      }
    }
  }

  /** Map notehead + flags → duration glyph name for Play / holds. */
  function glyphForExtractedNote(n) {
    if (!n) return "quarter";
    if (n.c === "W") return "recit";
    let g = NOTEHEADS[n.c];
    if (g == null) g = "quarter";
    // Filled head + flag(s) → eighth / sixteenth
    if (g === "quarter" && n.flagCount) {
      if (n.flagCount >= 2) g = "sixteenth";
      else g = "eighth";
    }
    return g;
  }

  async function extractPage(page, pageIndex, gidxStart) {
    let gidx = gidxStart;
    // staffLineProvider: test/alt hook — returns [{y,x0,x1}] like the scanner.
    const provider =
      window.ScoreExtractor && window.ScoreExtractor.staffLineProvider;
    const hl = provider
      ? await provider(page, pageIndex)
      : await findStaffLinesByCanvas(page);
    const staves = groupStaves(hl);

    // Always walk operators once (musicChars): extraction uses music glyphs only;
    // the diagnostic tap records every font/glyph (including non-music).
    beginFontTap();
    let chars;
    try {
      chars = await musicChars(page);
    } catch (e) {
      fontTapActive = null;
      throw e;
    }
    const fontStats = finalizeFontTap(staves);
    const pageDiag = {
      page: (pageIndex | 0) + 1,
      staves: staves.length,
      fonts: fontStats,
    };

    if (!staves.length) {
      return {
        pageOut: null,
        gidx,
        noteCount: 0,
        staffCount: 0,
        pageDiag,
      };
    }

    const words = await textWords(page);

    const per = staves.map((st) => ({
      clef: null,
      keysig: 0,
      keyx: null,
      notes: [],
      flags: [],
      pending_acc: null,
      raw: st,
    }));

    for (const ch of chars) {
      const si = staffOf(ch.y, staves);
      if (si == null) continue;
      const st = per[si];
      const c = ch.c;

      if (c === "&" || c === "?") {
        st.clef = c === "&" ? "treble" : "bass";
        st.keyx = ch.x;
      } else if (Object.prototype.hasOwnProperty.call(ACCIDENTALS, c)) {
        const sp = st.raw.spacing;
        if (st.keyx != null && ch.x - st.keyx < 8 * sp && st.notes.length === 0) {
          st.keysig += c === "#" ? 1 : c === "b" ? -1 : 0;
        } else {
          st.pending_acc = c;
        }
      } else if (Object.prototype.hasOwnProperty.call(NOTEHEADS, c)) {
        st.notes.push({
          c,
          x: ch.x,
          y: ch.y,
          acc: st.pending_acc,
          flagCount: 0,
        });
        st.pending_acc = null;
      } else if (Object.prototype.hasOwnProperty.call(FLAG_WEIGHT, c)) {
        // Eighth/sixteenth flags (up or down stem) — attach to nearest filled head
        st.flags.push({
          x: ch.x,
          y: ch.y,
          weight: FLAG_WEIGHT[c],
        });
      }
      // ignore breaths, ornaments, etc.
    }

    const stavesOut = [];
    for (let si = 0; si < per.length; si++) {
      const st = per[si];
      if (st.clef === "bass" || !st.notes.length) continue;
      const raw = st.raw;
      const sp = raw.spacing;
      const bottom = raw.lineYs[4];
      st.notes.sort((a, b) => a.x - b.x || a.y - b.y);

      // Multi-voice / harmony: several noteheads in one column (same-ish x,
      // different y). Monophonic trainer keeps ONLY the top voice (smallest y
      // in top-left coords). Clustering is wider than 1pt so slightly staggered
      // Finale columns still collapse — otherwise Play arpeggiates all voices.
      // Monophonic pages have no vertical stacks → this is a no-op for them.
      const collapsed = collapseToTopVoice(st.notes, sp);
      const filtered = collapsed.notes;
      st.harmonyStacks = collapsed.stacks;

      // Attach flags to nearest filled notehead on this staff
      attachFlagsToNotes(filtered, st.flags, sp);

      // lyrics: first verse band below staff
      const band = words
        .filter(
          (w) =>
            raw.xStart - 5 <= w.x &&
            w.x <= raw.xEnd + 20 &&
            bottom + 0.5 * sp < w.yTop &&
            w.yTop < bottom + 5.5 * sp
        )
        .sort((a, b) => a.x - b.x);

      const notesOut = [];
      for (const n of filtered) {
        const step = Math.round((bottom - n.y) / (sp / 2));
        const midi = stepToMidi(step, st.keysig, n.acc);
        notesOut.push({
          index: gidx,
          type: n.c === "W" ? "recit" : "note",
          glyph: glyphForExtractedNote(n),
          x: round(n.x + sp * 0.6, 2),
          y: round(n.y, 2),
          step,
          midi,
          accidental: n.acc != null ? n.acc : null,
          lyric: "",
        });
        gidx += 1;
      }

      for (const w of band) {
        let target = null;
        for (const no of notesOut) {
          if (no.x <= w.x + 4) target = no;
          else break;
        }
        if (target != null) {
          target.lyric = (target.lyric + " " + w.text).trim();
        }
      }

      stavesOut.push({
        index: stavesOut.length,
        xStart: raw.xStart,
        xEnd: raw.xEnd,
        lineYs: raw.lineYs,
        spacing: raw.spacing,
        clef: st.clef || "treble",
        keySig: { fifths: st.keysig },
        label: null,
        notes: notesOut,
      });
    }

    const vp1 = page.getViewport({ scale: 1 });
    const harmonyStacks = per.reduce((s, st) => s + (st.harmonyStacks || 0), 0);
    // Enough stacks to mean “this page is multi-voice,” not a stray collision
    const hasHarmonyStacks = harmonyStacks >= 2;
    const pageOut =
      stavesOut.length > 0
        ? {
            index: pageIndex,
            width: round(vp1.width, 1),
            height: round(vp1.height, 1),
            staves: stavesOut,
            hasHarmonyStacks,
            harmonyStackCount: harmonyStacks,
          }
        : null;

    const noteCount = stavesOut.reduce((s, st) => s + st.notes.length, 0);
    // staffCount stays stavesOut (treble staves that produced notes) — unchanged
    // for callers. Detected staff-line groups live on pageDiag.staves.
    return {
      pageOut,
      gidx,
      noteCount,
      staffCount: stavesOut.length,
      pageDiag,
    };
  }

  /**
   * Extract a half-open range of PDF pages [from0, to0).
   * @param {number} from0 0-based start page
   * @param {number} to0 exclusive end page
   * @param {number} gidxStart sequential note index to continue from
   */
  async function extractPdfRange(pdfDoc, sourceName, from0, to0, gidxStart, opts) {
    const pagesOut = [];
    let gidx = gidxStart | 0;
    let totalNotes = 0;
    let totalStaves = 0;
    const numPages = pdfDoc.numPages;
    const start = Math.max(0, Math.min(numPages, from0 | 0));
    const end = Math.max(start, Math.min(numPages, to0 | 0));
    const o = opts || {};

    // Fresh diagnostic at the start of a full/progressive run
    if (start === 0 && (gidxStart | 0) === 0) {
      resetDiagAcc(sourceName, {
        fileSize: o.fileSize,
        pagesExpected: numPages,
        source: sourceName,
      });
    } else if (o.fileSize != null && diagAcc.fileSize == null) {
      diagAcc.fileSize = o.fileSize;
    }
    if (sourceName && !diagAcc.source) diagAcc.source = sourceName;
    if (!diagAcc.pagesExpected) diagAcc.pagesExpected = numPages;

    for (let pno = start; pno < end; pno++) {
      if (o.onProgress) o.onProgress(pno + 1, numPages);
      if (o.shouldCancel && o.shouldCancel()) {
        publishLastDiagnostic();
        return {
          pages: pagesOut,
          gidx,
          totalNotes,
          totalStaves,
          from: start,
          to: pno,
          cancelled: true,
        };
      }
      const page = await pdfDoc.getPage(pno + 1);
      const { pageOut, gidx: next, noteCount, staffCount, pageDiag } =
        await extractPage(page, pno, gidx);
      gidx = next;
      totalNotes += noteCount;
      totalStaves += staffCount;
      if (pageOut) pagesOut.push(pageOut);
      if (pageDiag) appendPageDiag(pageDiag, noteCount);

      // Yield so the UI can paint / respond between heavy page scans
      await new Promise((r) => setTimeout(r, 0));
    }

    publishLastDiagnostic();
    return {
      pages: pagesOut,
      gidx,
      totalNotes,
      totalStaves,
      from: start,
      to: end,
      cancelled: false,
    };
  }

  /**
   * Extract a full score from a pdf.js PDFDocumentProxy.
   * @param {PDFDocumentProxy} pdfDoc
   * @param {string} sourceName
   * @param {{ onProgress?: (p: number, n: number) => void }} [opts]
   */
  async function extractPdf(pdfDoc, sourceName, opts) {
    const numPages = pdfDoc.numPages;
    const batch = await extractPdfRange(pdfDoc, sourceName, 0, numPages, 0, opts);
    return {
      score: {
        version: 1,
        source: sourceName || "document.pdf",
        pages: batch.pages,
      },
      totalNotes: batch.totalNotes,
      totalStaves: batch.totalStaves,
    };
  }

  /**
   * Progressive extractor: process `batchSize` pages at a time so the user can
   * start singing on early pages while later pages finish in the background.
   *
   *   const job = ScoreExtractor.createProgressive(pdf, name, { batchSize: 3 });
   *   await job.ensureThrough(2);  // pages 0..2 ready
   *   job.cancel();
   */
  function createProgressive(pdfDoc, sourceName, opts) {
    const options = opts || {};
    const batchSize = Math.max(1, options.batchSize || 3);
    const numPages = pdfDoc.numPages;
    let nextPage = 0; // next 0-based page to extract
    let gidx = 0;
    let totalNotes = 0;
    let totalStaves = 0;
    const pagesAcc = [];
    let busy = null; // in-flight promise
    let cancelled = false;

    function scoreSnapshot() {
      return {
        version: 1,
        source: sourceName || "document.pdf",
        pages: pagesAcc.slice(),
      };
    }

    function status() {
      return {
        pagesDone: nextPage,
        pagesTotal: numPages,
        totalNotes,
        totalStaves,
        complete: nextPage >= numPages,
        cancelled,
        score: scoreSnapshot(),
      };
    }

    function cancel() {
      cancelled = true;
    }

    /**
     * Extract the next batch (up to batchSize pages). No-op if complete/busy.
     * @returns {Promise<object|null>} status after the batch, or null if skipped
     */
    async function extractNextBatch() {
      if (cancelled || nextPage >= numPages) return status();
      if (busy) return busy;

      busy = (async () => {
        try {
          const from = nextPage;
          const to = Math.min(nextPage + batchSize, numPages);
          const batch = await extractPdfRange(pdfDoc, sourceName, from, to, gidx, {
            onProgress: options.onProgress,
            shouldCancel: () => cancelled,
            fileSize: options.fileSize,
          });
          if (cancelled) return status();

          gidx = batch.gidx;
          totalNotes += batch.totalNotes;
          totalStaves += batch.totalStaves;
          for (const p of batch.pages) pagesAcc.push(p);
          nextPage = batch.cancelled ? batch.to : to;

          if (options.onBatch) {
            try {
              options.onBatch(status());
            } catch (e) {
              console.warn("onBatch", e);
            }
          }
          return status();
        } finally {
          busy = null;
        }
      })();

      return busy;
    }

    /**
     * Ensure pages 0..pageIndexInclusive (0-based) are extracted.
     * Keeps pulling batches until that page is covered (or cancelled).
     */
    async function ensureThrough(pageIndexInclusive) {
      const need = Math.min(numPages - 1, Math.max(0, pageIndexInclusive | 0));
      while (!cancelled && nextPage <= need) {
        await extractNextBatch();
      }
      return status();
    }

    /**
     * Prefer having `lookahead` pages beyond `pageIndex` ready.
     * Non-blocking if already far enough; otherwise extracts until ahead.
     */
    async function ensureAhead(pageIndex, lookahead) {
      const ahead = lookahead != null ? lookahead : batchSize;
      const target = Math.min(numPages - 1, (pageIndex | 0) + ahead);
      return ensureThrough(target);
    }

    return {
      batchSize,
      numPages,
      extractNextBatch,
      ensureThrough,
      ensureAhead,
      cancel,
      status,
      get complete() {
        return nextPage >= numPages;
      },
      get cancelled() {
        return cancelled;
      },
    };
  }

  /** Flatten notes for tests / debug. */
  function flattenNotes(score) {
    const out = [];
    if (!score || !score.pages) return out;
    for (const p of score.pages) {
      for (const st of p.staves || []) {
        for (const n of st.notes || []) out.push(n);
      }
    }
    return out;
  }

  /**
   * Compare extracted score to golden: note count + (midi, step, type) per index.
   * x/y may differ by up to 1.5 pt.
   */
  function compareToGolden(extracted, golden) {
    const a = flattenNotes(extracted);
    const b = flattenNotes(golden);
    const mismatches = [];
    if (a.length !== b.length) {
      mismatches.push({
        kind: "count",
        message: `note count ${a.length} vs golden ${b.length}`,
      });
    }
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const ea = a[i];
      const gb = b[i];
      if (ea.midi !== gb.midi || ea.step !== gb.step || ea.type !== gb.type) {
        mismatches.push({
          kind: "pitch",
          index: i,
          got: { midi: ea.midi, step: ea.step, type: ea.type },
          want: { midi: gb.midi, step: gb.step, type: gb.type },
          xy: { got: [ea.x, ea.y], want: [gb.x, gb.y] },
        });
      } else {
        const dx = Math.abs((ea.x || 0) - (gb.x || 0));
        const dy = Math.abs((ea.y || 0) - (gb.y || 0));
        if (dx > 1.5 || dy > 1.5) {
          mismatches.push({
            kind: "xy",
            index: i,
            got: [ea.x, ea.y],
            want: [gb.x, gb.y],
            d: [round(dx, 2), round(dy, 2)],
          });
        }
      }
    }
    // For PASS criteria: same total note count, zero mismatches in (midi, step, type).
    // xy mismatches are reported but do not fail the hard PASS if within tolerance.
    const pitchMismatches = mismatches.filter((m) => m.kind === "pitch" || m.kind === "count");
    const xyMismatches = mismatches.filter((m) => m.kind === "xy");
    return {
      pass: pitchMismatches.length === 0 && a.length === b.length,
      extractedCount: a.length,
      goldenCount: b.length,
      pitchMismatches,
      xyMismatches,
      mismatches, // all
    };
  }

  window.ScoreExtractor = {
    extractPdf,
    extractPdfRange,
    /** Exposed for headless testing (node harness). */
    musicChars,
    textWords,
    extractPage,
    /** Optional override: async (page, pageIndex) => [{y,x0,x1}] */
    staffLineProvider: null,
    createProgressive,
    flattenNotes,
    compareToGolden,
    stepToMidi,
    attachFlagsToNotes,
    collapseToTopVoice,
    glyphForExtractedNote,
    MUSIC_FONTS,
    NOTEHEADS,
    FLAG_WEIGHT,
    /** Default pages per progressive batch (UI may override). */
    DEFAULT_BATCH_SIZE: 3,
    /** Populated after each extractPage / extractPdfRange page. Read-only. */
    lastDiagnostic: null,
    formatDiagnosticReport,
    /** Test hooks (do not use from app UI). */
    _diag: {
      resetDiagAcc,
      publishLastDiagnostic,
      appendPageDiag,
      beginFontTap,
      finalizeFontTap,
      codepointLabel,
      computeSmuflSuspected,
    },
  };
})();
