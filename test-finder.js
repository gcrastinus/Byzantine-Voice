/**
 * test-finder.js — headless checks on the bug fixes and Finder mode.
 *
 *   node test-finder.js
 *
 * Loads follow.js against a DOM stub and a *virtual clock*, so the octave
 * hysteresis, the y smoother, the tone gate and the hold-to-advance loop can be
 * exercised deterministically and instantly instead of in real time. This is
 * the same logic ?selftest=3 drives in the browser.
 */
"use strict";

const fs = require("fs");
const path = require("path");

// ——— virtual clock ————————————————————————————————————————————————
let clock = 1000;
const advance = (ms) => {
  clock += ms;
};

// ——— minimal DOM stub ————————————————————————————————————————————
const win = {
  addEventListener() {},
  dispatchEvent() {},
  requestAnimationFrame() {
    return 0;
  },
  cancelAnimationFrame() {},
  AudioContext: null,
};
global.window = win;
global.document = {
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {} } }),
  body: { appendChild() {} },
};
global.location = { search: "" };
global.performance = { now: () => clock };
global.requestAnimationFrame = win.requestAnimationFrame;
global.cancelAnimationFrame = win.cancelAnimationFrame;
global.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
};

// ——— score + trainer stub ————————————————————————————————————————
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

const scoreFile = process.argv[2] || "08-16-26_Sunday_Vespers.json";
const score = JSON.parse(fs.readFileSync(path.join(__dirname, scoreFile), "utf8"));
const notes = flattenNotes(score);

const bursts = [];
let haloOn = false;
const trainer = {
  notes,
  completed: new Set(),
  currentNoteIndex: 0,
  lastPitch: null,
  focusNote(i) {
    trainer.currentNoteIndex = i;
  },
  drawBall(x, y) {
    trainer.ball = x == null ? null : { x, y };
  },
  ball: null,
  setBallScale() {},
  setBallColor() {},
  setHalo(on) {
    haloOn = !!on;
  },
  burstAt(i) {
    bursts.push(i);
  },
  get pageNum() {
    return notes[trainer.currentNoteIndex]
      ? notes[trainer.currentNoteIndex].pdfPage
      : 1;
  },
  mode: "absolute",
  sensitivityCents: 50,
  advanceHoldMs: 400,
};
win.trainer = trainer;

eval(fs.readFileSync(path.join(__dirname, "follow.js"), "utf8"));

const core = win.followCore;
const fp = win.followPlayback;
if (!fp) {
  console.error("follow.js did not expose window.followPlayback");
  process.exit(1);
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else {
    failures++;
    console.log("  FAIL " + name + (extra ? " — " + extra : ""));
  }
}

console.log(`score: ${scoreFile} — ${notes.length} notes\n`);

// ——— 1. fixOctave: nearest multiple of 12 ————————————————————————
console.log("fixOctave (nearest octave, any distance):");
const f = core.fixOctave;
check("one octave down 53→65", f(53, 65) === 65);
check("two octaves down 41→65", f(41, 65) === 65);
check("in range 63 stays 63", f(63, 65) === 63);
check("one octave up 77→65", f(77, 65) === 65);
// The fold is deliberately capped at ±2 octaves: an unlimited nearest-octave
// fold made a climbing voice wrap around and read as in tune.
check("three octaves down is NOT folded (cap is ±2)", f(29, 65) === 29);
check("a fourth off is not folded", f(60, 65) === 60);

// ——— 2. octave hysteresis ————————————————————————————————————————
console.log("\noctave hysteresis (200 ms to switch, 400 ms silence resets):");
fp.resetOctave();
// Singing an octave down: fold seeds to -1 immediately on the first frame.
let fold = fp.stableFold(53, 65, clock, "n1");
check("seeds from the first voiced frame", fold === -1);

// A boundary wobble implying fold 0 for 100 ms must NOT flip the ball.
let flipped = false;
for (let k = 0; k < 5; k++) {
  advance(20);
  if (fp.stableFold(59.4, 65, clock, "n1") !== -1) flipped = true;
}
check("100 ms of a rival fold does not switch", !flipped);

// Sustained past 200 ms, it should win.
for (let k = 0; k < 8; k++) {
  advance(20);
  fold = fp.stableFold(59.4, 65, clock, "n1");
}
check("a rival fold sustained past 200 ms does switch", fold === 0, "fold=" + fold);

// A note change re-seeds immediately.
advance(20);
fold = fp.stableFold(41, 65, clock, "n2");
check("note change re-seeds immediately", fold === -2, "fold=" + fold);

// A gap longer than 400 ms re-seeds too.
advance(500);
fold = fp.stableFold(65, 65, clock, "n2");
check("silence > 400 ms re-seeds", fold === 0, "fold=" + fold);

// ——— 3. displayed-y smoothing ————————————————————————————————————
console.log("\nball y smoothing (EMA, tau 70 ms):");
fp.resetBallSmoothing();
let y = fp.smoothBallY(100, clock);
check("first sample is taken as-is", y === 100);
advance(70);
y = fp.smoothBallY(200, clock);
check("one tau covers ~63% of the step", y > 155 && y < 175, "y=" + y.toFixed(1));
let prev = y;
let monotone = true;
for (let k = 0; k < 10; k++) {
  advance(20);
  const next = fp.smoothBallY(200, clock);
  if (next < prev - 1e-9) monotone = false;
  prev = next;
}
check("approaches the target monotonically", monotone && prev > 195, "y=" + prev.toFixed(1));

// A single wild sample must not throw the ball all the way there.
fp.resetBallSmoothing();
fp.smoothBallY(100, clock);
advance(20);
const jolted = fp.smoothBallY(300, clock);
check("a one-frame outlier moves the ball < 40% of the way", jolted < 100 + 0.4 * 200,
      "y=" + jolted.toFixed(1));

// ——— 4. free-follow: hold to advance across consonant gaps ————————
//
// The advance pause between notes is a real setTimeout, so this section has to
// yield to the event loop; the virtual clock still drives the pitch frames.
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Put follow.js into a free-follow run with a fixed, fast pace unit. */
function armFreeFollow(fromIndex) {
  trainer.focusNote(fromIndex);
  fp.play.active = true;
  fp.play.freeFollow = true;
  fp.play.listen = false;
  fp.resetFinder();
  fp.resetCalibration();
  fp.play.unitMs = 200; // fixed unit so the test doesn't depend on calibration
  fp.play.needHoldMs = fp.requiredHoldMs(notes[fromIndex]);
  fp.resetOctave();
  fp.resetBallSmoothing();
}

async function main() {
console.log("\nfree-follow — hold to advance (consonant gaps must not reset):");
trainer.completed.clear();
bursts.length = 0;
armFreeFollow(0);

const N = 8;
const startIndex = trainer.currentNoteIndex;
let voicedSince = clock;
let guard = 0;

// ~50 Hz singer; every 250 ms of voicing, 80 ms of silence (a consonant).
while (trainer.currentNoteIndex < startIndex + N && guard++ < 20000) {
  if (fp.play.advancing) {
    await realSleep(30); // let the inter-note pause timer fire
    continue;
  }
  const n = notes[trainer.currentNoteIndex];
  if (clock - voicedSince > 250) {
    for (let k = 0; k < 4; k++) {
      advance(20);
      fp.onPitch(null, 0);
    }
    voicedSince = clock;
    continue;
  }
  advance(20);
  fp.onPitch(n.midi + (Math.random() - 0.5) * 0.4, 0.97);
}

const advanced = trainer.currentNoteIndex - startIndex;
check(`advances through all ${N} notes`, advanced === N, `advanced ${advanced}`);
const missing = [];
for (let i = startIndex; i < startIndex + N; i++) if (!trainer.completed.has(i)) missing.push(i);
check("every advanced note earns a green ring", missing.length === 0,
      "missing " + missing.join(","));
check("every advanced note fires a scored burst", bursts.length >= N,
      "bursts=" + bursts.length);

// ——— 5. wrong pitch must not advance ——————————————————————————————
console.log("\nfree-follow — a fourth off the target:");
const held = trainer.currentNoteIndex;
const ringsBefore = trainer.completed.size;
fp.resetFinder();
fp.resetOctave();
for (let k = 0; k < 100; k++) {
  advance(20); // 2 s
  const n = notes[trainer.currentNoteIndex];
  fp.onPitch(n.midi + 5 + (Math.random() - 0.5) * 0.4, 0.97);
}
check("2 s of wrong pitch does not advance", trainer.currentNoteIndex === held,
      `${held} → ${trainer.currentNoteIndex}`);
check("2 s of wrong pitch scores nothing", trainer.completed.size === ringsBefore);
check("halo is off while out of tolerance", haloOn === false);

// ——— 6. the app must not score its own tones ——————————————————————
console.log("\ntone gate (the app must never score its own synth):");
armFreeFollow(trainer.currentNoteIndex);
check("gate is open when nothing is sounding", fp.tonesActive() === false);

// The app starts sounding: 500 ms of *perfect* pitch arrives from the mic,
// which is really our own speaker. Nothing may move.
const gateIdx = trainer.currentNoteIndex;
const gateRings = trainer.completed.size;
trainer.lastPitch = null;
trainer.ball = null;
fp.blankMicFor(600);
check("gate is closed while sounding", fp.tonesActive() === true);
for (let k = 0; k < 25; k++) {
  advance(20); // 500 ms of the app hearing itself, all inside the window
  fp.onPitch(notes[trainer.currentNoteIndex].midi, 0.99);
}
check("blanked perfect pitch does not advance", trainer.currentNoteIndex === gateIdx);
check("blanked perfect pitch scores no ring", trainer.completed.size === gateRings);
check("blanked frames do not even reach lastPitch", trainer.lastPitch === null);
check("blanked frames do not move the ball", trainer.ball === null);

// Same input once the gate reopens must advance — proves the gate, not the
// pitch, was the thing blocking it.
advance(150);
check("gate reopens after the blanking window", fp.tonesActive() === false);
let ctrlGuard = 0;
while (trainer.currentNoteIndex === gateIdx && ctrlGuard++ < 400) {
  if (fp.play.advancing) {
    await realSleep(30); // the advance itself is asynchronous
    continue;
  }
  advance(20);
  fp.onPitch(notes[trainer.currentNoteIndex].midi, 0.97);
}
check("control: the same pitch unblanked does advance",
      trainer.currentNoteIndex === gateIdx + 1,
      `idx ${gateIdx} → ${trainer.currentNoteIndex}`);

// ——— 7. resting position ————————————————————————————————————————
console.log("\nresting position:");
const rest = notes[0];
check("bottom-line rest equals lineYs[4]",
      Math.abs(fp.bottomLineY(rest) - rest.staffLineYs[4]) < 1e-9,
      `${fp.bottomLineY(rest)} vs ${rest.staffLineYs[4]}`);

fp.stopPlayback();
console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nall free-follow/bugfix checks passed\n");
process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
