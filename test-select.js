/**
 * test-select.js — hit-testing for click and drag selection.
 *
 *   node test-select.js
 *
 * The case that keeps breaking: a reciting tone is ONE note whose glyph covers
 * a whole clause of words. Its x is a single point at the left of that stretch,
 * so a point-radius hit test misses everywhere else along it — you cannot click
 * it, and a drag sweeping across it stops extending. These checks run against
 * the real score's actual recit spans.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const win = {
  addEventListener() {},
  dispatchEvent() {},
  requestAnimationFrame: () => 0,
  cancelAnimationFrame() {},
  AudioContext: null,
  pdfScale: 1, // 1 css px per PDF point keeps the arithmetic readable
};
global.window = win;
global.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
  body: { appendChild() {} },
};
global.location = { search: "" };
global.performance = { now: () => Date.now() };
global.requestAnimationFrame = win.requestAnimationFrame;
global.cancelAnimationFrame = win.cancelAnimationFrame;
global.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
};

function flattenNotes(score) {
  const out = [];
  for (const page of score.pages || []) {
    const pageIndex = page.index != null ? page.index : 0;
    for (const staff of page.staves || []) {
      for (const note of staff.notes || []) {
        out.push({
          globalIndex: out.length,
          pageIndex,
          pdfPage: pageIndex + 1,
          staffIndex: staff.index != null ? staff.index : 0,
          staffSpacing: staff.spacing != null ? staff.spacing : 4.32,
          staffLineYs: staff.lineYs || null,
          staffXEnd: staff.xEnd != null ? staff.xEnd : null,
          keySig: staff.keySig || null,
          type: note.type || "note",
          glyph: note.glyph || null,
          x: note.x,
          y: note.y,
          step: note.step,
          midi: note.midi,
          lyric: note.lyric != null ? note.lyric : null,
        });
      }
    }
  }
  return out;
}

const scoreFile = process.argv[2] || "08-16-26_Sunday_Vespers.json";
const score = JSON.parse(fs.readFileSync(path.join(__dirname, scoreFile), "utf8"));
const notes = flattenNotes(score);

let currentPage = 1;
win.trainer = {
  notes,
  completed: new Set(),
  currentNoteIndex: 0,
  focusNote() {},
  drawBall() {},
  setBallScale() {},
  get pageNum() {
    return currentPage;
  },
  get ball() {
    return null;
  },
  mode: "absolute",
  sensitivityCents: 50,
};

eval(fs.readFileSync(path.join(__dirname, "follow.js"), "utf8"));
const fp = win.followPlayback;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else {
    failures++;
    console.log("  FAIL " + name + (extra ? " — " + extra : ""));
  }
}

// Find a recit that has a following note on the same staff (a real stretch).
let ri = -1;
for (let i = 0; i < notes.length; i++) {
  const n = notes[i];
  if (n.type !== "recit") continue;
  const nx = notes[i + 1];
  if (nx && nx.staffIndex === n.staffIndex && nx.pageIndex === n.pageIndex && nx.x > n.x + 40) {
    ri = i;
    break;
  }
}
if (ri < 0) {
  console.error("no recit with a measurable span in " + scoreFile);
  process.exit(1);
}

const recit = notes[ri];
currentPage = recit.pdfPage;
const span = fp.noteSpanX(ri);
const width = span[1] - span[0];

console.log(`score: ${scoreFile}`);
console.log(
  `recit #${ri} "${(recit.lyric || "").slice(0, 40)}" spans ` +
    `x ${span[0].toFixed(1)} → ${span[1].toFixed(1)} (${width.toFixed(1)}pt)\n`
);

console.log("recit span:");
check("a recit spans to the next note on its staff", width > 40, width.toFixed(1) + "pt");
check("an ordinary note is still a point", (() => {
  const s = fp.noteSpanX(ri + 1);
  return s && s[0] === s[1];
})());

console.log("\nclicking along the recitation:");
const midY = recit.y;
for (const frac of [0.05, 0.25, 0.5, 0.75, 0.95]) {
  const x = span[0] + width * frac;
  const hit = fp.nearestNoteToPoint(x, midY);
  check(`click at ${Math.round(frac * 100)}% across the stretch selects the recit`,
        hit === ri, `got ${hit}`);
}

console.log("\ndragging across the recitation:");
// Sweep the pointer along the staff, as a drag would, and collect what the
// selection would cover.
const swept = new Set();
for (let x = span[0] - 10; x <= span[1] + 10; x += 3) {
  const j = fp.dragNoteAt(x, midY);
  if (j >= 0) swept.add(j);
}
check("a sweep across the stretch includes the recit itself", swept.has(ri),
      "swept [" + [...swept].join(",") + "]");
check("the sweep never loses the note (no gaps returning -1)",
      ![...Array(Math.floor(width / 3))].some((_, k) => fp.dragNoteAt(span[0] + k * 3, midY) < 0));

// Dragging along the lyric line, below the staff, must also work.
const lyricY = recit.staffLineYs[4] + (recit.staffSpacing || 4.32) * 3;
check("dragging along the lyric line below the staff still hits the recit",
      fp.dragNoteAt(span[0] + width * 0.5, lyricY) === ri,
      "got " + fp.dragNoteAt(span[0] + width * 0.5, lyricY));

// A selection from before the recit to after it must contain it.
const before = ri > 0 ? ri - 1 : ri;
const after = ri + 1;
const a = fp.dragNoteAt(notes[before].x, notes[before].y);
const b = fp.dragNoteAt(notes[after].x, notes[after].y);
check("a drag from the note before to the note after brackets the recit",
      Math.min(a, b) <= ri && Math.max(a, b) >= ri, `range ${a}..${b}`);

console.log("\nordinary notes are unaffected:");
const plain = notes[after];
check("clicking an ordinary notehead still selects it",
      fp.nearestNoteToPoint(plain.x, plain.y) === after,
      "got " + fp.nearestNoteToPoint(plain.x, plain.y));
check("clicking far from any note still selects nothing",
      fp.nearestNoteToPoint(plain.x, plain.y - 400) < 0);

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nall selection checks passed\n");
process.exit(failures ? 1 : 0);
