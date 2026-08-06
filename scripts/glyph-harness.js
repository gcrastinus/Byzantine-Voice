#!/usr/bin/env node
/**
 * Headless extractor regression harness.
 *
 * Drives the REAL extractor.js with operator lists parsed from a PDF by
 * scripts/dump_ops.py (pymupdf) — no pdf.js, no browser. Verifies every
 * music glyph lands within 1pt of pymupdf ground truth, then runs full
 * extraction using vector staff lines.
 *
 * Usage:
 *   python3 scripts/dump_ops.py Some.pdf /tmp/some_ops.json
 *   node scripts/glyph-harness.js /tmp/some_ops.json [golden.json]
 *
 * With a golden JSON, also compares midi/step/type per note.
 */
const fs = require("fs");
const path = require("path");
const APPDIR = path.join(__dirname, "..");

const OPS = {
  beginText: 31, setFont: 37, setCharSpacing: 32, setTextMatrix: 42,
  setLeading: 36, moveText: 40, setLeadingMoveText: 41, nextLine: 43,
  showText: 44, showSpacedText: 45, nextLineShowText: 46,
  nextLineSetSpacingShowText: 47,
};
global.window = { pdfjsLib: { OPS } };
global.document = { createElement: () => { throw new Error("no canvas in node"); } };
eval(fs.readFileSync(path.join(APPDIR, "extractor.js"), "utf8"));
const SE = window.ScoreExtractor;

function makePage(pd) {
  const fnArray = [], argsArray = [];
  for (const [fn, args] of pd.ops) {
    if (!(fn in OPS)) continue;
    fnArray.push(OPS[fn]);
    argsArray.push(args);
  }
  return {
    view: pd.view,
    commonObjs: {
      has: (id) => id in pd.fontNames,
      get: (id) => ({ name: pd.fontNames[id] || "" }),
    },
    getOperatorList: async () => ({ fnArray, argsArray }),
    getTextContent: async () => ({ items: [], styles: {} }),
    getViewport: ({ scale }) => ({ width: pd.view[2] * scale, height: pd.view[3] * scale }),
  };
}

(async () => {
  const dumpFile = process.argv[2];
  const goldenFile = process.argv[3];
  if (!dumpFile) {
    console.error("usage: node scripts/glyph-harness.js ops.json [golden.json]");
    process.exit(2);
  }
  const dump = JSON.parse(fs.readFileSync(dumpFile, "utf8"));
  let bad = 0, tot = 0, phant = 0;
  for (const pd of dump.pages) {
    const js = await SE.musicChars(makePage(pd));
    const used = new Set();
    for (const t of pd.truth) {
      tot++;
      let bd = 1e9, bi = -1;
      js.forEach((g, i) => {
        if (used.has(i) || g.c !== t.c) return;
        const d = Math.hypot(g.x - t.x, g.y - t.y);
        if (d < bd) { bd = d; bi = i; }
      });
      if (bi >= 0 && bd <= 1.0) { used.add(bi); continue; }
      bad++;
      if (bad <= 10) console.log(`  MISPLACED p${pd.index + 1} '${t.c}' truth(${t.x},${t.y}) d=${bd === 1e9 ? "none" : bd.toFixed(2)}`);
    }
    phant += js.length - used.size;
  }
  console.log(`glyphs: ${tot}  misplaced: ${bad}  phantoms: ${phant}  -> ${bad === 0 && phant === 0 ? "PASS" : "FAIL"}`);

  SE.staffLineProvider = async (page) => dump.pages[page.__idx].staffLines;
  const pagesOut = [];
  let gidx = 0;
  for (let i = 0; i < dump.pages.length; i++) {
    const page = makePage(dump.pages[i]);
    page.__idx = i;
    const r = await SE.extractPage(page, dump.pages[i].index, gidx);
    gidx = r.gidx;
    if (r.pageOut) pagesOut.push(r.pageOut);
  }
  const score = { version: 1, source: path.basename(dumpFile), pages: pagesOut };
  const flat = SE.flattenNotes(score);
  console.log(`extracted notes: ${flat.length}`);

  let fail = bad > 0 || phant > 0;
  if (goldenFile) {
    const cmp = SE.compareToGolden(score, JSON.parse(fs.readFileSync(goldenFile, "utf8")));
    console.log(`golden: extracted=${cmp.extractedCount} golden=${cmp.goldenCount} pitch-mismatches=${cmp.pitchMismatches.length} -> ${cmp.pass ? "PASS" : "FAIL"}`);
    cmp.pitchMismatches.slice(0, 8).forEach((m) => console.log("  ", JSON.stringify(m)));
    fail = fail || !cmp.pass;
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
