/**
 * test-assess.js — headless checks for Assess Singing DP aligner + dual pitch.
 *
 *   node test-assess.js
 */
"use strict";

const fs = require("fs");
const path = require("path");

const win = {
  addEventListener() {},
  dispatchEvent() {},
  requestAnimationFrame() {
    return 0;
  },
  cancelAnimationFrame() {},
  performance: { now: () => 0 },
  AudioContext: null,
};
global.window = win;
global.document = {
  getElementById: () => null,
  createElement: () => ({
    style: {},
    classList: { add() {}, remove() {} },
    appendChild() {},
  }),
  body: { appendChild() {} },
  addEventListener() {},
};
global.location = { search: "" };
global.performance = win.performance;
global.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
};

eval(fs.readFileSync(path.join(__dirname, "pitch.js"), "utf8"));
eval(fs.readFileSync(path.join(__dirname, "diagnose.js"), "utf8"));

const core = win.diagnoseCore;
const MPM = win.MPM;
if (!core) {
  console.error("diagnoseCore not exported");
  process.exit(1);
}
if (!MPM || typeof MPM.findPitchYin !== "function") {
  console.error("MPM dual detector not exported");
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

// —— Dual pitch on synthetic sine ——
console.log("dual pitch detector (synthetic 220 Hz):");
function sineBuf(freq, sr, n) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = 0.3 * Math.sin((2 * Math.PI * freq * i) / sr);
  return b;
}
const sr = 44100;
const buf = sineBuf(220, sr, 4096);
const [fY, cY] = MPM.findPitchYin(buf, sr);
const [fM, cM] = MPM.findPitchMcLeod(buf, sr);
const [fD, cD] = MPM.findPitch(buf, sr);
check("YIN finds ~220 Hz", Math.abs(fY - 220) < 3, `f=${fY}`);
check("McLeod finds ~220 Hz", Math.abs(fM - 220) < 3, `f=${fM}`);
check("dual finds ~220 Hz", Math.abs(fD - 220) < 3, `f=${fD}`);
check("dual clarity usable", cD > 0.5, `c=${cD}`);

// —— Same-pitch reciting tone covers many score notes ——
console.log("\nDP align: long same-pitch hold covers many quarters:");
const notes = [];
for (let i = 0; i < 12; i++) {
  notes.push({ midi: 60, lyric: "a" }); // 12 quarters on C
}
// One long plateau at C, ~2s
const samples = [];
const t0 = 1000;
for (let f = 0; f < 100; f++) {
  samples.push({ t: t0 + f * 20, midi: 60.05 + (Math.random() - 0.5) * 0.05 });
}
const r = core.analyzeSection(notes, 0, 11, samples);
check("12 expected notes", r.expectedCount === 12);
check("at least 1 plateau", r.plateauCount >= 1, `plateaus=${r.plateauCount}`);
check(
  "most notes not missing (same-pitch cover)",
  r.summary.missing <= 3,
  JSON.stringify(r.summary)
);
check(
  "ok+near is majority",
  r.summary.ok + r.summary.near >= 8,
  JSON.stringify(r.summary)
);

// —— Melodic steps ——
console.log("\nDP align: simple ascending line:");
const melNotes = [
  { midi: 60 },
  { midi: 62 },
  { midi: 64 },
  { midi: 65 },
];
const melSamples = [];
const pitches = [60, 62, 64, 65];
let t = 0;
for (const p of pitches) {
  for (let f = 0; f < 15; f++) {
    melSamples.push({ t: t, midi: p + 0.02 });
    t += 25;
  }
  t += 80; // gap
}
const r2 = core.analyzeSection(melNotes, 0, 3, melSamples);
check("4 expected", r2.expectedCount === 4);
check(
  "all four matched ok/near",
  r2.summary.missing === 0 && r2.summary.wrong === 0,
  JSON.stringify(r2.summary)
);

// —— Octave down singing ——
console.log("\noctave fold:");
const octNotes = [{ midi: 72 }, { midi: 74 }];
const octSamples = [];
t = 0;
for (const p of [60, 62]) {
  // sung an octave down
  for (let f = 0; f < 20; f++) {
    octSamples.push({ t: t, midi: p });
    t += 20;
  }
  t += 100;
}
const r3 = core.analyzeSection(octNotes, 0, 1, octSamples);
check(
  "octave-down still matches",
  r3.summary.ok + r3.summary.near === 2,
  JSON.stringify(r3.summary)
);

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nall assess checks passed\n");
process.exit(failures ? 1 : 0);
