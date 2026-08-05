/**
 * test-timeline.js — headless checks on follow.js's playback timing model.
 *
 *   node test-timeline.js
 *
 * Loads follow.js against a minimal DOM stub (every getElementById returns
 * null; follow.js guards each one), flattens the real score the way app.js
 * does, and exercises buildTimeline / durationMs / syllableCount.
 */
"use strict";

const fs = require("fs");
const path = require("path");

// ——— minimal DOM stub ————————————————————————————————————————————
const listeners = new Map();
const win = {
  addEventListener(type, fn) {
    listeners.set(type, fn);
  },
  dispatchEvent() {},
  requestAnimationFrame() {
    return 0;
  },
  cancelAnimationFrame() {},
  performance: { now: () => Date.now() },
  AudioContext: null,
};
global.window = win;
global.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
  body: { appendChild() {} },
};
global.location = { search: "" };
global.performance = win.performance;
global.requestAnimationFrame = win.requestAnimationFrame;
global.cancelAnimationFrame = win.cancelAnimationFrame;
global.setTimeout = setTimeout;
global.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
};

// ——— flatten, mirroring app.js flattenNotes ———————————————————————
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
          keySig: staff.keySig || null,
          type: note.type || "note",
          glyph: note.glyph || null,
          x: note.x,
          y: note.y,
          step: note.step,
          midi: note.midi,
          dotted: !!note.dotted,
          lyric: note.lyric != null ? note.lyric : null,
        });
      }
    }
  }
  return out;
}

const scoreFile =
  process.argv[2] ||
  fs.readdirSync(__dirname).find((f) => f.endsWith(".json") && !f.includes("package"));
if (!scoreFile) {
  console.error("no score .json found");
  process.exit(1);
}
const score = JSON.parse(fs.readFileSync(path.join(__dirname, scoreFile), "utf8"));
const notes = flattenNotes(score);

win.trainer = {
  notes,
  completed: new Set(),
  currentNoteIndex: 0,
  focusNote() {},
  drawBall() {},
  setBallScale() {},
  get pageNum() {
    return 1;
  },
  get ball() {
    return null;
  },
  mode: "absolute",
  sensitivityCents: 50,
};

eval(fs.readFileSync(path.join(__dirname, "follow.js"), "utf8"));

const fp = win.followPlayback;
if (!fp) {
  console.error("follow.js did not expose window.followPlayback");
  process.exit(1);
}

// ——— assertions ——————————————————————————————————————————————————
let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log("  ok   " + name);
  } else {
    failures++;
    console.log("  FAIL " + name + (extra ? " — " + extra : ""));
  }
}

console.log(`score: ${scoreFile} — ${notes.length} notes, ${score.pages.length} pages\n`);

console.log("duration model @120bpm (quarter = 500 ms) — computer Play only:");
const at120 = (n) => fp.durationMs(n, 120);
check("quarter = 500ms", at120({ type: "note", glyph: "quarter" }) === 500);
check("half = 1000ms", at120({ type: "note", glyph: "half" }) === 1000);
check("whole = 2000ms", at120({ type: "note", glyph: "whole" }) === 2000);
check("eighth = 250ms", at120({ type: "note", glyph: "eighth" }) === 250);
check(
  "dotted quarter = 750ms",
  at120({ type: "note", glyph: "quarter", dotted: true }) === 750
);
check("unknown glyph falls back to a quarter", at120({ type: "note", glyph: "blob" }) === 500);

console.log("\nsinger hold units (Begin — doubles ~50% longer, not 2×):");
check("quarter unit = 1", fp.noteUnits({ type: "note", glyph: "quarter" }) === 1);
check(
  "half unit = 1.5 (50% longer than quarter)",
  fp.noteUnits({ type: "note", glyph: "half" }) === 1.5
);
check(
  "whole unit = 2.5",
  fp.noteUnits({ type: "note", glyph: "whole" }) === 2.5
);
check(
  "eighth unit floored ≥ 0.55",
  fp.noteUnits({ type: "note", glyph: "eighth" }) === 0.55
);
// After calibrating on a 900ms half: unitMs = 900/1.5 = 600; quarter needs 600ms
fp.resetCalibration();
fp.calibrateFromHold({ type: "note", glyph: "half" }, 900);
check(
  "calibrate from double → unitMs = hold/1.5",
  Math.abs(fp.play.unitMs - 600) < 1e-6,
  `unitMs=${fp.play.unitMs}`
);
check(
  "quarter after double-calibrate needs ~2/3 of that hold",
  Math.abs(fp.requiredHoldMs({ type: "note", glyph: "quarter" }) - 600) < 1e-6,
  `need=${fp.requiredHoldMs({ type: "note", glyph: "quarter" })}`
);
check(
  "next half after double-calibrate needs same ~900ms",
  Math.abs(fp.requiredHoldMs({ type: "note", glyph: "half" }) - 900) < 1e-6,
  `need=${fp.requiredHoldMs({ type: "note", glyph: "half" })}`
);
fp.resetCalibration();

console.log("\nreciting notes (1 quarter-note beat per syllable, scales with tempo):");
// 4 syllables × 1 beat = 4 quarters; @120 BPM → 2000ms
check("4 syllables @120 = 2000ms", at120({ type: "recit", lyric: "thy lips we praise" }) === 2000);
check("1 syllable @120 = 500ms (one quarter)", at120({ type: "recit", lyric: "the" }) === 500);
check("empty lyric falls back to 6 syllables @120 = 3000ms", at120({ type: "recit", lyric: null }) === 3000);
check("leading-hyphen lyric '- ble' = 1 syllable", fp.syllableCount({ lyric: "- ble" }) === 1);
check(
  "recit duration scales with tempo (faster = shorter)",
  fp.durationMs({ type: "recit", lyric: "a b c d" }, 40) >
    fp.durationMs({ type: "recit", lyric: "a b c d" }, 140)
);
check(
  "4-syllable recit lasts as long as 4 quarters at same tempo",
  fp.durationMs({ type: "recit", lyric: "a b c d" }, 80) ===
    4 * fp.durationMs({ type: "note", glyph: "quarter" }, 80)
);
check(
  "doubling tempo halves recit duration",
  Math.abs(
    fp.durationMs({ type: "recit", lyric: "a b c d" }, 80) -
      2 * fp.durationMs({ type: "recit", lyric: "a b c d" }, 160)
  ) < 1e-6
);

// ——— recit pulse grid —————————————————————————————————————————————
//
// A reciting tone must sound as one quarter note per syllable, on the beat.
// This has regressed to a single sustained tone more than once, so pin it.
console.log("\nrecit pulse grid (one quarter note per syllable, on the beat):");

function fakeCtx() {
  const scheduled = [];
  return {
    state: "running",
    currentTime: 10,
    destination: {},
    createGain() {
      return {
        gain: {
          setValueAtTime() {},
          linearRampToValueAtTime() {},
          exponentialRampToValueAtTime() {},
          setTargetAtTime() {},
          cancelScheduledValues() {},
          value: 0,
        },
        // Web Audio's connect() returns the destination so calls can chain.
        connect: (target) => target,
        disconnect() {},
      };
    },
    createOscillator() {
      const osc = {
        type: "sine",
        frequency: { setValueAtTime() {}, value: 0 },
        detune: { setValueAtTime() {}, value: 0 },
        connect: (target) => target,
        disconnect() {},
        start(t) {
          osc._t0 = t;
        },
        stop(t) {
          scheduled.push({ t0: osc._t0, t1: t });
        },
      };
      return osc;
    },
    scheduled,
  };
}

const recit5 = { type: "recit", lyric: "thy lips we praise the", midi: 65 };
check("5-syllable recit counts 5 pulses", fp.pulseCountForNote(recit5) === 5,
      "got " + fp.pulseCountForNote(recit5));
check("an ordinary note counts 1 pulse",
      fp.pulseCountForNote({ type: "note", glyph: "half", midi: 65 }) === 1);

const ctx = fakeCtx();
const total = fp.durationMs(recit5, 120); // 5 quarters @120bpm = 2500ms
fp.scheduleMidiPulses(ctx, 65, total, fp.pulseCountForNote(recit5));
// One tone may stack several oscillators (a harmonic layer), so collapse to
// distinct onsets — what matters is when the ear hears a re-attack.
function onsets(list) {
  const seen = new Map();
  for (const e of list) {
    const key = e.t0.toFixed(4);
    if (!seen.has(key) || e.t1 > seen.get(key).t1) seen.set(key, e);
  }
  return [...seen.values()].sort((a, b) => a.t0 - b.t0);
}
const ev = onsets(ctx.scheduled);

check("schedules one tone per syllable, not one sustain", ev.length === 5,
      "scheduled " + ev.length);
if (ev.length === 5) {
  // Onsets must sit exactly one quarter apart — no accumulated drift.
  let onGrid = true;
  let worst = 0;
  for (let i = 1; i < ev.length; i++) {
    const delta = ev[i].t0 - ev[i - 1].t0;
    worst = Math.max(worst, Math.abs(delta - 0.5));
    if (Math.abs(delta - 0.5) > 1e-6) onGrid = false;
  }
  check("onsets are exactly one beat apart @120bpm", onGrid,
        "worst deviation " + worst.toFixed(4) + "s");
  check("each pulse is shorter than its beat (audible re-attack)",
        ev.every((e) => e.t1 - e.t0 < 0.5 && e.t1 - e.t0 > 0.2));
  check("the train spans the segment's full duration",
        Math.abs((ev[4].t0 - ev[0].t0) - 4 * 0.5) < 1e-6);
}

// Tempo must actually change the grid.
const ctxSlow = fakeCtx();
fp.scheduleMidiPulses(ctxSlow, 65, fp.durationMs(recit5, 60), 5);
const evSlow = onsets(ctxSlow.scheduled);
check("halving the tempo doubles the gap between onsets",
      evSlow.length === 5 && Math.abs((evSlow[1].t0 - evSlow[0].t0) - 1.0) < 1e-6,
      evSlow.length ? (evSlow[1].t0 - evSlow[0].t0).toFixed(3) + "s" : "none");

console.log("\ntimeline over the real score:");
const tl = fp.buildTimeline(0, 120);
// Recits expand to one segment per quarter-beat, so length ≥ note count
check(
  "timeline has at least one segment per note (recits expand)",
  tl.length >= notes.length,
  `${tl.length} vs ${notes.length}`
);
const recitSegs = tl.filter((s) => s.isRecitPulse);
check("recit notes expand into multiple quarter-beat segments", recitSegs.length > 0);
if (recitSegs.length) {
  const byNote = new Map();
  for (const s of recitSegs) {
    byNote.set(s.i, (byNote.get(s.i) || 0) + 1);
  }
  let multi = false;
  for (const c of byNote.values()) if (c > 1) multi = true;
  check("at least one recit has more than one beat", multi);
  // Every recit pulse is exactly one quarter @120 = 500ms
  check(
    "each recit pulse is one quarter @120bpm",
    recitSegs.every((s) => Math.abs(s.durMs - 500) < 1e-6),
    "dur=" + (recitSegs[0] && recitSegs[0].durMs)
  );
}
check("starts at t=0", tl[0].t0 === 0);
let contiguous = true;
let monotonic = true;
for (let i = 0; i < tl.length; i++) {
  if (tl[i].t1 <= tl[i].t0) monotonic = false;
  if (i && Math.abs(tl[i].t0 - tl[i - 1].t1) > 1e-9) contiguous = false;
}
check("segments are contiguous (no gaps or overlaps)", contiguous);
check("every segment has positive duration", monotonic);

const firstOnPage2 = tl.find((s) => s.n.pdfPage === 2);
check("score reaches page 2", !!firstOnPage2);
if (firstOnPage2) {
  console.log(
    `       page 1→2 boundary at note ${firstOnPage2.i}, ` +
      `t=${(firstOnPage2.t0 / 1000).toFixed(1)}s at 120bpm`
  );
}

const startIdx = 5;
const tl2 = fp.buildTimeline(startIdx, 120);
check("seeking shifts the start", tl2[0].i === startIdx);
check("seeked timeline also starts at t=0", tl2[0].t0 === 0);

const slow = fp.buildTimeline(0, 40);
const fast = fp.buildTimeline(0, 140);
check("slower tempo makes a longer run", slow[slow.length - 1].t1 > fast[fast.length - 1].t1);

console.log(
  failures ? `\n${failures} FAILURE(S)\n` : "\nall timeline checks passed\n"
);
process.exit(failures ? 1 : 0);
