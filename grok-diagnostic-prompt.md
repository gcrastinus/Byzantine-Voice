# Prompt for Grok — "unknown notation" diagnostic report

Purpose: Finale is discontinued; when MCI eventually re-engraves PDFs in Dorico/MuseScore/Sibelius, extraction will find staves but no recognizable glyphs. This feature turns that future failure into a copyable report that makes writing the new glyph map a ten-minute job. Copy everything below the line to Grok, run from the project folder.

---

Add a notation-diagnostic report to this chant app. All files are in the current folder and working. HARD CONSTRAINTS: no ES modules, no new dependencies, and extraction output for current PDFs must be byte-identical — the golden regression (`python3 scripts/dump_ops.py 08-16-26_Sunday_Vespers.pdf /tmp/v.json && node scripts/glyph-harness.js /tmp/v.json 08-16-26_Sunday_Vespers.json`) must still print PASS, and all five `node test-*.js` suites must pass. The diagnostic is a read-only tap on data the extractor already sees; it must never change what gets extracted.

## 1. Data collection (extractor.js)

While `musicChars()` walks the operator list it already resolves a font name for every shown glyph and computes its position. Tap that stream (do not add another pass):

- Build per-page `fontStats`: for EVERY font encountered (music or not): `{ resolvedName, isMusicFont, glyphCount, chars }` where `chars` is a map of char → `{ count, codepoint }` capped at 40 distinct chars per font (then just count).
- In `extractPage()`, after staves are known, compute for each font how many of its glyphs fell inside a staff band (within `lineYs[0] − 6·spacing … lineYs[4] + 6·spacing` of any staff) — field `nearStaffCount`. Non-music text (lyrics, titles) will show high counts too; that's fine, the report reader can tell Times from a music font.
- Assemble `window.ScoreExtractor.lastDiagnostic` after every extraction run:

```
{
  when: ISO timestamp,
  source, fileSize, pages: N,
  totalStaves, totalNotes,
  pageDiags: [{ page, staves, fonts: [{ resolvedName, isMusicFont, glyphCount,
      nearStaffCount, chars: [{ ch, codepoint: "U+0153", count }] }] }],
  smuflSuspected: boolean   // any non-music-font glyphs in U+E000–U+F8FF near staves
}
```

Keep it small: cap chars at 40/font, drop fonts with glyphCount 0.

## 2. Trigger + banner (app.js)

After extraction completes:

- `totalStaves > 0 && totalNotes === 0` → error banner: **“Found N staves but no readable notes. This PDF may use a newer notation format (Finale was retired in 2024).”** with a **Copy diagnostic report** button.
- `totalNotes > 0 && totalNotes < totalStaves × 2` → warning variant: “Very few notes were read (N from M staves) — the notation may be partially unsupported.” Same copy button.
- Normal extractions: no banner change, but `lastDiagnostic` is still populated (so a curious user can copy it from a small “Diagnostic” item in the Settings/Tools menu — add that menu item, always available once a PDF is loaded).
- If `smuflSuspected`, append one line to the banner: “SMuFL-style glyphs detected (Dorico/MuseScore family) — the report below is exactly what’s needed to add support.”

## 3. The report (clipboard)

Plain text, human-readable, self-contained (no PDF needed to act on it):

```
Byzantine Voice notation diagnostic — 2026-08-XXTXX:XX
File: something.pdf (123456 bytes, 4 pages)
Result: 12 staves, 0 notes extracted
SMuFL suspected: yes

Page 1 — 3 staves
  Font "Bravura" (music-font match: no) — 214 glyphs, 208 near staves
    U+E050 ×3, U+E0A4 ×88, U+E260 ×6, U+ED41 ×2, ...
  Font "Academico" (music-font match: no) — 402 glyphs, 231 near staves
    'a' U+0061 ×44, 'e' U+0065 ×39, ...
...
```

Copy via `navigator.clipboard.writeText`, with a hidden-textarea `execCommand("copy")` fallback (file:// + older Safari). Confirm with a brief “Copied ✓” on the button.

## 4. Verify (must actually run, not just claim)

1. Golden regression + all five test suites pass (commands above).
2. New `test-diagnostic.js` (node, follows the harness stub pattern in `scripts/glyph-harness.js`): feed `extractPage` a synthetic operator list using font name "Bravura" with PUA chars (U+E0A4 ×20 at staff-band y positions) plus staff lines via `ScoreExtractor.staffLineProvider`. Assert: 0 notes extracted, `lastDiagnostic.totalStaves > 0`, the Bravura entry has `nearStaffCount ≥ 20` with `U+E0A4` listed, and `smuflSuspected === true`. Second case: run a normal Finale-style ops fixture and assert `lastDiagnostic.totalNotes > 0` and no banner-trigger condition.
3. Load `08-16-26_Sunday_Vespers.pdf` in the browser and confirm no new banner appears and the Tools “Diagnostic” item copies a sane report.
4. List every file changed and why.
