# Prompt for Grok — in-browser score extraction + no-terminal deployment

Run this AFTER the Opus 5 playback rebuild (opus5-playback-prompt.md), so you're editing the current files. Copy everything below the line to Grok.

---

Make this chant sight-singing web app fully self-contained: when the user loads a PDF, the app must extract the score itself, in the browser, and start immediately — no Python, no terminal, no separate score.json step. All files are in the current folder. `extract_score.py` is the reference implementation of the extraction algorithm — port its logic faithfully to JavaScript. `08-16-26_Sunday_Vespers.pdf` + `08-16-26_Sunday_Vespers.json` are the golden test pair: your port must reproduce that JSON.

## Background you need

These PDFs (Metropolitan Cantor Institute, mci.archpitt.org) are native Finale engravings. Every musical symbol is a text glyph in the font **Maestro** or **Petrucci** (identical encoding): `&` treble clef, `?` bass clef, `#`/`b`/`n` accidentals, `œ` quarter, `˙` half, `w` whole, `W` reciting note, `j`/`J` eighth flags (ignore; pitch comes from the adjacent `œ`), `.` dot, `,` breath (ignore). Staff lines are vector lines. The Python script documents every rule: staff grouping (5 lines, equal gaps ±15%), y→step (half-spacing per step, treble bottom line = E4), key signature (accidentals within 8 spacings right of the clef, before any note), inline accidentals (apply to next notehead), chord filter (same x ±1 pt → keep top note), bass staves skipped, recit type, lyric band (first verse line only, syllable belongs to last note left of it).

## Part 1 — extractor.js (new file)

Port extract_score.py to a browser module using the pdf.js instance the app already loads. Output must match the frozen score.json schema exactly (see the golden file).

**Glyphs.** Use `page.getTextContent()`. The real font name is NOT `item.fontName` (that's an internal id like `g_d0_f2`) — resolve it through `textContent.styles[item.fontName].fontFamily` and check it contains "Maestro" or "Petrucci". Positions: `item.transform[4]` = x, `item.transform[5]` = y **in PDF space with origin at BOTTOM-left, y up**. The schema uses top-left origin, y down: convert with `yTop = page.view[3] - y` (and glyph size = transform[0] or [3]). If an item.str contains multiple characters (Finale sometimes emits pairs like "jœ" or "##"), split it: distribute x by `item.width / str.length` per char; all chars share the item's y.

**Staff lines.** Don't parse the operator list. Render the page to an offscreen canvas at scale 2 (white background), read ImageData, and scan pixel rows: a row is a "line row" if its longest horizontal dark run (luminance < 128) exceeds 30% of the page width. Merge vertically adjacent line rows (line thickness) into single line centers; convert back to PDF points (divide by 2); record each line's x extent from the run bounds. Then group into staves of 5 exactly as the Python does. This is font- and drawing-agnostic and works because these PDFs render perfectly cleanly.

**Everything else** — clef/keysig/accidental/notehead classification, chord filter, step→midi, recit, lyrics — port line-by-line from extract_score.py. For lyrics use `getTextContent()` items in NON-music fonts, same band rules.

## Part 2 — wiring

- On PDF load (picker or drag-drop): run the extractor on all pages, then call `trainer.setScore(result)` automatically. Show a small status line: "Score extracted: N notes".
- Cache: store the extracted JSON in IndexedDB keyed by `fileName + fileSize`; on reload of the same PDF, use the cache (instant).
- Keep the Score button as an OVERRIDE (a hand-edited score.json takes precedence) and add a small "Save score" button that downloads the extracted JSON (Blob + a.download) so the user can keep or share it.
- If extraction finds zero staves or zero notes, show a clear error banner instead of failing silently.

## Part 3 — verification (must actually run)

Add `?extracttest=1`: the app fetches `08-16-26_Sunday_Vespers.pdf`, extracts it in-browser, fetches the golden `08-16-26_Sunday_Vespers.json`, and compares: same total note count, and zero mismatches in (midi, step, type) per note index. x/y may differ by up to 1.5 pt (different text engines). Show PASS with counts, or FAIL listing the first 10 mismatches. This test runs when the folder is served over http(s) — run it on the deployed site (Part 4) and report the result.

Also add `?debug=1`: after extraction, draw a small dot on every detected notehead position and its pitch name on the overlay, so misreads are visible at a glance.

## Part 4 — deployment without a terminal (write these instructions into a README.md)

1. Go to **app.netlify.com/drop** in a browser (free account).
2. Drag the whole project folder onto the page. Done — you get a permanent https URL. Bookmark it on Mac/iPad.
3. To update the app later, open the site's "Deploys" page and drag the folder again.
4. Usage from then on: open the URL, click PDF, choose any MCI service PDF, allow the mic once (https remembers the permission), sing. No terminal, no server, no json files.
   (Alternative: GitHub Pages via the github.com web uploader — also terminal-free — include brief steps.)

## Constraints

- Vanilla JS, no build step, no new dependencies beyond what's already loaded.
- Do not modify followCore math, pitch.js detection, or the playback engine — only the loading path and the new extractor.
- List every file you changed and why. Report the ?extracttest=1 result from the deployed URL — a claim without the PASS banner doesn't count.
