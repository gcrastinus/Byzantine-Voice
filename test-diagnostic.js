#!/usr/bin/env node
/**
 * test-diagnostic.js — notation diagnostic (read-only extractor tap).
 *
 * Pattern matches scripts/glyph-harness.js (no ES modules, eval extractor.js).
 *
 *   node test-diagnostic.js
 */
const fs = require("fs");
const path = require("path");
const APPDIR = __dirname;

const OPS = {
  beginText: 31,
  setFont: 37,
  setCharSpacing: 32,
  setTextMatrix: 42,
  setLeading: 36,
  moveText: 40,
  setLeadingMoveText: 41,
  nextLine: 43,
  showText: 44,
  showSpacedText: 45,
  nextLineShowText: 46,
  nextLineSetSpacingShowText: 47,
};
global.window = { pdfjsLib: { OPS } };
global.document = {
  createElement: () => {
    throw new Error("no canvas in node");
  },
};
eval(fs.readFileSync(path.join(APPDIR, "extractor.js"), "utf8"));
const SE = window.ScoreExtractor;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log("  ok   " + name + (detail ? "  (" + detail + ")" : ""));
  } else {
    failures += 1;
    console.log("  FAIL " + name + (detail ? "  (" + detail + ")" : ""));
  }
}

function makePage(pd) {
  const fnArray = [];
  const argsArray = [];
  for (const [fn, args] of pd.ops) {
    if (!(fn in OPS)) continue;
    fnArray.push(OPS[fn]);
    argsArray.push(args);
  }
  return {
    view: pd.view || [0, 0, 612, 792],
    commonObjs: {
      has: (id) => id in (pd.fontNames || {}),
      get: (id) => ({ name: (pd.fontNames && pd.fontNames[id]) || "" }),
    },
    getOperatorList: async () => ({ fnArray, argsArray }),
    getTextContent: async () => ({ items: [], styles: {} }),
    getViewport: ({ scale }) => {
      const v = pd.view || [0, 0, 612, 792];
      return { width: v[2] * scale, height: v[3] * scale };
    },
  };
}

/** Equal-gap staff lines (top-left y, spacing 4.32). */
function staffLinesAt(y0, sp, x0, x1) {
  const lines = [];
  for (let i = 0; i < 5; i++) {
    lines.push({ y: y0 + i * sp, x0: x0, x1: x1 });
  }
  return lines;
}

/**
 * PDF bottom-left y for a top-left y on a default 792-tall page.
 */
function pdfYFromTop(yTop, pageH) {
  return (pageH || 792) - yTop;
}

// ——— Case 1: Bravura / SMuFL PUA near staves, no Finale notes ————————
console.log("Bravura / SMuFL synthetic page:");

const sp = 4.32;
const staffY0 = 100;
const lines = staffLinesAt(staffY0, sp, 40, 560);
// Place noteheads mid-staff band
const yTopGlyph = staffY0 + 2 * sp;
const yPdf = pdfYFromTop(yTopGlyph, 792);

const bravuraOps = [];
bravuraOps.push(["beginText", []]);
bravuraOps.push(["setFont", ["F0", 1]]);
// 20 × U+E0A4 (SMuFL black notehead) at staff y
for (let i = 0; i < 20; i++) {
  bravuraOps.push([
    "setTextMatrix",
    [1, 0, 0, 1, 80 + i * 12, yPdf],
  ]);
  bravuraOps.push([
    "showText",
    [[{ unicode: "\uE0A4", width: 500 }]],
  ]);
}

const bravuraPage = makePage({
  view: [0, 0, 612, 792],
  fontNames: { F0: "Bravura" },
  ops: bravuraOps,
});

SE.staffLineProvider = async () => lines;
SE._diag.resetDiagAcc("bravura-test.pdf", {
  fileSize: 1234,
  pagesExpected: 1,
  source: "bravura-test.pdf",
});

(async () => {
  const r1 = await SE.extractPage(bravuraPage, 0, 0);
  SE._diag.appendPageDiag(r1.pageDiag, r1.noteCount);
  const d1 = SE.lastDiagnostic;

  check("0 notes extracted from Bravura page", r1.noteCount === 0, "notes=" + r1.noteCount);
  check(
    "lastDiagnostic.totalStaves > 0",
    d1 && d1.totalStaves > 0,
    d1 ? "staves=" + d1.totalStaves : "no diag"
  );
  check("lastDiagnostic.totalNotes === 0", d1 && d1.totalNotes === 0);

  const brav = d1 && d1.pageDiags[0] && d1.pageDiags[0].fonts.find((f) =>
    /Bravura/i.test(f.resolvedName)
  );
  check("Bravura font entry present", !!brav, brav ? brav.resolvedName : "missing");
  check(
    "Bravura nearStaffCount ≥ 20",
    brav && brav.nearStaffCount >= 20,
    brav ? "near=" + brav.nearStaffCount : ""
  );
  const hasE0A4 =
    brav &&
    brav.chars.some(
      (c) => c.codepoint === "U+E0A4" || (c.ch && c.ch.codePointAt(0) === 0xe0a4)
    );
  check("U+E0A4 listed in Bravura chars", !!hasE0A4);
  check("smuflSuspected === true", d1 && d1.smuflSuspected === true);
  check(
    "banner-trigger: staves>0 && notes===0",
    d1 && d1.totalStaves > 0 && d1.totalNotes === 0
  );

  const report = SE.formatDiagnosticReport(d1);
  check("report mentions Bravura", /Bravura/i.test(report));
  check("report mentions U+E0A4", /U\+E0A4/i.test(report));

  // ——— Case 2: Finale-style Maestro ops → notes + no banner trigger ———
  console.log("\nFinale-style Maestro synthetic page:");

  // Treble clef + several filled heads on the staff
  const maestroOps = [];
  maestroOps.push(["beginText", []]);
  maestroOps.push(["setFont", ["F1", 1]]);
  // Clef slightly left of notes
  maestroOps.push(["setTextMatrix", [1, 0, 0, 1, 50, yPdf]]);
  maestroOps.push(["showText", [[{ unicode: "&", width: 500 }]]]);
  for (let i = 0; i < 8; i++) {
    const yt = staffY0 + (i % 4) * (sp / 2);
    const yp = pdfYFromTop(yt, 792);
    maestroOps.push(["setTextMatrix", [1, 0, 0, 1, 100 + i * 18, yp]]);
    maestroOps.push(["showText", [[{ unicode: "\u0153", width: 500 }]]]);
  }

  const maestroPage = makePage({
    view: [0, 0, 612, 792],
    fontNames: { F1: "ABCDEF+Maestro" },
    ops: maestroOps,
  });

  SE.staffLineProvider = async () => lines;
  SE._diag.resetDiagAcc("maestro-test.pdf", {
    fileSize: 999,
    pagesExpected: 1,
    source: "maestro-test.pdf",
  });

  const r2 = await SE.extractPage(maestroPage, 0, 0);
  SE._diag.appendPageDiag(r2.pageDiag, r2.noteCount);
  const d2 = SE.lastDiagnostic;

  check(
    "Maestro page extracts notes",
    r2.noteCount > 0 && d2 && d2.totalNotes > 0,
    "notes=" + r2.noteCount
  );
  check(
    "Maestro isMusicFont match",
    d2 &&
      d2.pageDiags[0] &&
      d2.pageDiags[0].fonts.some((f) => f.isMusicFont && /Maestro/i.test(f.resolvedName))
  );
  const noBanner =
    d2 &&
    !(d2.totalStaves > 0 && d2.totalNotes === 0) &&
    !(d2.totalNotes > 0 && d2.totalNotes < d2.totalStaves * 2);
  check(
    "no banner-trigger condition (enough notes vs staves)",
    noBanner,
    d2 ? "notes=" + d2.totalNotes + " staves=" + d2.totalStaves : ""
  );
  check("smuflSuspected false on Maestro-only page", d2 && d2.smuflSuspected === false);

  // ——— Case 3: musicChars return value unchanged (array of music glyphs only) ——
  console.log("\nExtraction stream isolation:");
  SE.staffLineProvider = null;
  // musicChars without beginFontTap should still return only music glyphs
  const onlyMusic = await SE.musicChars(maestroPage);
  check(
    "musicChars still returns an array",
    Array.isArray(onlyMusic),
    "len=" + (onlyMusic && onlyMusic.length)
  );
  check(
    "musicChars includes œ noteheads",
    onlyMusic.some((g) => g.c === "\u0153"),
    "count=" + onlyMusic.filter((g) => g.c === "\u0153").length
  );

  // Bravura alone must NOT pollute music stream
  const bravOnly = await SE.musicChars(bravuraPage);
  check(
    "Bravura PUA not emitted into musicChars out",
    bravOnly.length === 0,
    "len=" + bravOnly.length
  );

  console.log(failures ? "\n" + failures + " FAILURE(S)\n" : "\nall diagnostic checks passed\n");
  process.exit(failures ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
