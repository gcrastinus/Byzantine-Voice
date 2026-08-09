/**
 * test-range.js — RangeFinder: range/offset estimation and tempo estimation.
 *
 *   node test-range.js
 *
 * Synthetic singers are generated at the app's real frame rate (50 Hz) so the
 * weighting, gap and onset logic sees the same shape of data it will see live.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const RangeFinder = require("./range.js");

// ——— fixture score ————————————————————————————————————————————————
function inlineScore() {
  // One beat per syllable throughout: every note is a quarter with a
  // single-syllable lyric, so Bw / Sw === 1 and the tempo maths is legible.
  const midis = [65, 67, 69, 67, 65, 64, 62, 64, 65, 67, 69, 71, 69, 67, 65, 64, 62, 60, 62, 64];
  return {
    version: 1,
    pages: [
      {
        index: 0,
        staves: [
          {
            index: 0,
            lineYs: [256.86, 261.18, 265.5, 269.82, 274.14],
            spacing: 4.32,
            keySig: { fifths: 0 },
            notes: midis.map((m, i) => ({
              index: i,
              type: "note",
              glyph: "quarter",
              midi: m,
              lyric: "la",
            })),
          },
        ],
      },
    ],
  };
}

const realPath = path.join(__dirname, "range-test.json");
const score = fs.existsSync(realPath)
  ? JSON.parse(fs.readFileSync(realPath, "utf8"))
  : inlineScore();
const usingReal = fs.existsSync(realPath);

function scoreNotes(s) {
  const out = [];
  for (const p of s.pages || []) for (const st of p.staves || []) for (const n of st.notes || []) out.push(n);
  return out;
}
const NOTES = scoreNotes(score);

/** Duration-weighted median of the written melody — the target the singer is compared to. */
function writtenMedian() {
  const int = RangeFinder._internals;
  const samples = NOTES.map((n) => ({ v: Number(n.midi), w: int.noteBeats(n) }));
  return int.weightedQuantile(samples, 0.5);
}
const W = writtenMedian();

// ——— synthetic singers ————————————————————————————————————————————
const FRAME_MS = 20; // 50 Hz, matching the app's detector

/**
 * Sing the written melody (duration-weighted), transposed, for `seconds`.
 * Options: gapEveryMs/gapMs punch silences; glitchRate flips frames up an octave.
 */
function singMelody(opts) {
  const o = opts || {};
  const transpose = o.transpose || 0;
  const seconds = o.seconds != null ? o.seconds : 30;
  const beatMs = o.beatMs != null ? o.beatMs : 600;
  const glitchRate = o.glitchRate || 0;
  const gapEveryMs = o.gapEveryMs || 0;
  const gapMs = o.gapMs || 0;
  const jitter = o.jitter != null ? o.jitter : 0.12;

  let rnd = o.seed || 12345;
  const rand = () => {
    rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
    return rnd / 0x7fffffff;
  };

  const int = RangeFinder._internals;
  const frames = [];
  let t = 0;
  let k = 0;
  let nextGapAt = gapEveryMs || Infinity;

  while (t < seconds * 1000) {
    const note = NOTES[k % NOTES.length];
    k++;
    const holdMs = int.noteBeats(note) * beatMs;
    const end = t + holdMs;
    while (t < end) {
      if (gapEveryMs && t >= nextGapAt) {
        t += gapMs;
        nextGapAt = t + gapEveryMs;
        continue;
      }
      let midi = Number(note.midi) + transpose + (rand() - 0.5) * 2 * jitter;
      if (glitchRate && rand() < glitchRate) midi += 12;
      frames.push({ t, midi, clarity: 0.97 });
      t += FRAME_MS;
    }
  }
  return frames;
}

/**
 * A singer whose syllables land every `spacingMs`: a held pitch, then a short
 * dip of silence. The dip is ≥120 ms (so it registers as an onset) but ≤250 ms
 * (so it is not treated as a phrase break).
 */
function singSyllables(opts) {
  const o = opts || {};
  const spacingMs = o.spacingMs || 750;
  const dipMs = o.dipMs != null ? o.dipMs : 140;
  const count = o.count != null ? o.count : 40;
  const base = o.base != null ? o.base : 65;
  const breakAfter = o.breakAfter || []; // syllable indices followed by a long break
  const breakMs = o.breakMs || 3000;

  const frames = [];
  let t = 0;
  const shape = [0, 2, 4, 2, 0, -1, -3, -1];
  for (let i = 0; i < count; i++) {
    const midi = base + shape[i % shape.length];
    const holdMs = spacingMs - dipMs;
    for (let u = 0; u < holdMs; u += FRAME_MS) {
      frames.push({ t: t + u, midi: midi + (u % 40 === 0 ? 0.03 : -0.03), clarity: 0.97 });
    }
    t += spacingMs;
    if (breakAfter.indexOf(i) >= 0) t += breakMs;
  }
  return frames;
}

// ——— harness ——————————————————————————————————————————————————————
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log("  ok   " + name);
  else {
    failures++;
    console.log("  FAIL " + name + (extra ? " — " + extra : ""));
  }
}

console.log(
  `score: ${usingReal ? "range-test.json" : "inline fixture"} — ` +
    `${NOTES.length} notes, written median W = ${W}\n`
);

// ——— 1. range / offset ————————————————————————————————————————————
console.log("offset from a clean sample:");
const clean = RangeFinder.estimate(singMelody({ transpose: 0 }), score);
check("a singer at the melody's own median → offset 0",
      clean.ok && clean.offsetSemitones === 0,
      clean.ok ? "offset " + clean.offsetSemitones : clean.reason);
check("reports a plausible centre", clean.ok && Math.abs(clean.center - W) <= 1,
      clean.ok ? "center " + clean.center : "");
check("low < centre < high", clean.ok && clean.low < clean.center && clean.center < clean.high);
check("debug is always present", !!clean.debug && clean.debug.M != null);

const octaveDown = RangeFinder.estimate(singMelody({ transpose: -12 }), score);
check("an octave down → offset −12", octaveDown.ok && octaveDown.offsetSemitones === -12,
      octaveDown.ok ? "offset " + octaveDown.offsetSemitones : octaveDown.reason);

const fifthDown = RangeFinder.estimate(singMelody({ transpose: -7 }), score);
check("a fifth down → offset −7", fifthDown.ok && fifthDown.offsetSemitones === -7,
      fifthDown.ok ? "offset " + fifthDown.offsetSemitones : fifthDown.reason);

// Low male register: often −15…−16 on written HBD (C-major midi ~60–72)
const deep = RangeFinder.estimate(singMelody({ transpose: -16 }), score);
check("16 semis down → offset −16 (within −18 slider)", deep.ok && deep.offsetSemitones === -16,
      deep.ok ? "offset " + deep.offsetSemitones : deep.reason);

const deep18 = RangeFinder.estimate(singMelody({ transpose: -18 }), score);
check("18 semis down → offset −18", deep18.ok && deep18.offsetSemitones === -18,
      deep18.ok ? "offset " + deep18.offsetSemitones : deep18.reason);

// Frames at pitch.js CLARITY_MIN (0.72) must count — previously CLARITY_MIN 0.9
// threw away honest lower-register samples as “not enough singing”.
const softClarity = RangeFinder.estimate(
  singMelody({ transpose: -15 }).map((f) => ({ ...f, clarity: 0.75 })),
  score
);
check("clarity 0.75 frames still yield a range", softClarity.ok,
      softClarity.ok ? "offset " + softClarity.offsetSemitones : softClarity.reason);
check("clarity 0.75 → offset ≈ −15",
      softClarity.ok && Math.abs(softClarity.offsetSemitones - -15) <= 1,
      softClarity.ok ? "offset " + softClarity.offsetSemitones : "");

console.log("\nrobustness:");
const glitched = RangeFinder.estimate(singMelody({ transpose: -12, glitchRate: 0.1 }), score);
check("10% octave glitches → same offset as clean",
      glitched.ok && glitched.offsetSemitones === octaveDown.offsetSemitones,
      glitched.ok ? "offset " + glitched.offsetSemitones : glitched.reason);
check("10% octave glitches → same voice hint",
      glitched.ok && glitched.voiceHint === octaveDown.voiceHint);

// 60 s sample: with only ~2 melody passes, a fixed 3.5 s gap clock is
// near-commensurate with the 14.4 s pass and deletes the SAME notes every
// pass, genuinely shifting the sung distribution (offset drifted 3 st).
// Longer samples spread the phase; real consonant gaps track syllables,
// not a clock, so this is the fair robustness scenario.
const gappy = RangeFinder.estimate(
  singMelody({ transpose: -7, seconds: 60, gapEveryMs: 3000, gapMs: 500 }),
  score
);
check("500 ms silences every 3 s → still ok", gappy.ok, gappy.ok ? "" : gappy.reason);
check("500 ms silences every 3 s → same offset",
      gappy.ok && gappy.offsetSemitones === fifthDown.offsetSemitones,
      gappy.ok ? "offset " + gappy.offsetSemitones : "");

console.log("\ntoo little to go on:");
const short = RangeFinder.estimate(singMelody({ transpose: 0, seconds: 3 }), score);
check("a 3 s sample is rejected", short.ok === false && short.reason === "not enough singing",
      short.ok ? "returned ok" : short.reason);
check("rejection still carries debug", !!short.debug);

const monotone = RangeFinder.estimate(
  (() => {
    const f = [];
    for (let t = 0; t < 20000; t += FRAME_MS) f.push({ t, midi: 65 + (t % 100 === 0 ? 0.2 : 0), clarity: 0.97 });
    return f;
  })(),
  score
);
check("a sample with no range is rejected",
      monotone.ok === false && monotone.reason === "not enough singing",
      monotone.ok ? "span " + (monotone.high - monotone.low) : monotone.reason);

console.log("\nnarrow sample against a wide melody:");
// Melody spanning 14 semitones; singer only covers ~8.
const wideScore = {
  version: 1,
  pages: [
    {
      index: 0,
      staves: [
        {
          index: 0,
          notes: [58, 60, 62, 64, 65, 67, 69, 70, 72].map((m, i) => ({
            index: i,
            type: "note",
            glyph: "quarter",
            midi: m,
            lyric: "la",
          })),
        },
      ],
    },
  ],
};
const narrowFrames = (() => {
  const f = [];
  const shape = [62, 64, 65, 67, 68, 67, 65, 64];
  let t = 0;
  for (let i = 0; i < 400; i++) {
    const midi = shape[i % shape.length];
    for (let u = 0; u < 500; u += FRAME_MS) f.push({ t: t + u, midi, clarity: 0.97 });
    t += 500;
  }
  return f;
})();
const narrow = RangeFinder.estimate(narrowFrames, wideScore);
check("wide melody vs narrow voice → ok", narrow.ok, narrow.ok ? "" : narrow.reason);
check("wide melody vs narrow voice → narrow-sample hint",
      narrow.ok && /\(narrow sample\)$/.test(narrow.voiceHint),
      narrow.ok ? narrow.voiceHint : "");
check("narrow sample keeps the centre fit (no nudge)",
      narrow.ok && narrow.offsetSemitones === Math.round(narrow.center - 65),
      narrow.ok ? "offset " + narrow.offsetSemitones : "");

// ——— 2. tempo ————————————————————————————————————————————————————
console.log("\ntempo:");
const bps = (() => {
  const int = RangeFinder._internals;
  let B = 0;
  let S = 0;
  for (const n of NOTES) {
    B += int.noteBeats(n);
    S += int.noteSyllables(n);
  }
  return B / S;
})();
// Expected tempo must be derived from the LOADED score's beats-per-syllable
// ratio: the inline fixture is exactly 1.0, but the real range-test.json
// (Happy Birthday) is 24/25 — hard-coding 1.0 broke the suite the moment the
// bundled piece appeared.
if (!usingReal) {
  check("inline fixture is 1 beat per syllable", Math.abs(bps - 1) < 1e-9, "Bw/Sw = " + bps);
}
function expectedBpm(spacingMs) {
  const raw = (60000 / spacingMs) * bps;
  return Math.max(50, Math.min(110, Math.round(raw / 2) * 2));
}

const t750 = RangeFinder.estimate(singSyllables({ spacingMs: 750, count: 40 }), score);
check(`onsets every 750 ms → ${expectedBpm(750)} bpm`, t750.tempoBpm === expectedBpm(750),
      "got " + t750.tempoBpm + " want " + expectedBpm(750) + " (onsets " + (t750.debug && t750.debug.onsets) + ")");

const t500 = RangeFinder.estimate(singSyllables({ spacingMs: 500, count: 50 }), score);
check(`onsets every 500 ms → clamped to ${expectedBpm(500)}`, t500.tempoBpm === expectedBpm(500),
      "got " + t500.tempoBpm);

const withBreaks = RangeFinder.estimate(
  singSyllables({ spacingMs: 750, count: 40, breakAfter: [8, 18, 28], breakMs: 3000 }),
  score
);
check("three 3 s phrase breaks → unchanged tempo",
      withBreaks.tempoBpm === t750.tempoBpm,
      "got " + withBreaks.tempoBpm + " vs " + t750.tempoBpm);

// Six long syllables: plenty of sample to judge the range, far too few
// onsets to judge a tempo.
const fewOnsets = RangeFinder.estimate(
  singSyllables({ spacingMs: 3000, dipMs: 140, count: 6 }),
  score
);
check("too few onsets → tempoBpm null", fewOnsets.tempoBpm === null,
      "got " + fewOnsets.tempoBpm);
check("…but the range result still succeeds", fewOnsets.ok === true,
      fewOnsets.ok ? "" : fewOnsets.reason);

console.log(failures ? `\n${failures} FAILURE(S)\n` : "\nall range checks passed\n");
process.exit(failures ? 1 : 0);
