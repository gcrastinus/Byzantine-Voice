/**
 * follow.js — score following: pitch→staff-position mapping, relative mode,
 * octave-error suppression, auto-advance, and a ?selftest=1 simulation mode.
 *
 * Consumes window.trainer (app.js) and the onPitch stream (pitch.js).
 * The math core is pure and exported as followCore for headless testing.
 */
(() => {
  "use strict";

  // ===================================================================
  // Pure math core (no DOM) — testable in node via global.followCore
  // ===================================================================
  const MAJOR = [0, 2, 4, 5, 7, 9, 11];

  /** Key signature (fifths) → tonic pitch class and tonic letter index (C=0…B=6). */
  function keyInfo(fifths) {
    const tonicPc = (((fifths * 7) % 12) + 12) % 12;
    const tonicLetter = (((fifths * 4) % 7) + 7) % 7;
    return { tonicPc, tonicLetter };
  }

  /**
   * Build the scale tones of the key across the vocal range as
   * sorted [{ midi, absStep }], where absStep = octave*7 + letterIndex
   * (a diatonic "staff step" number; treble-clef bottom line E4 = 30).
   */
  function scaleTable(fifths) {
    const { tonicPc, tonicLetter } = keyInfo(fifths);
    const tones = [];
    for (let oct = 1; oct <= 7; oct++) {
      for (let d = 0; d < 7; d++) {
        const letter = (tonicLetter + d) % 7;
        const pc = (tonicPc + MAJOR[d]) % 12;
        const midi = 12 * (oct + 1) + pc;
        const absStep = oct * 7 + letter;
        tones.push({ midi, absStep });
      }
    }
    tones.sort((a, b) => a.midi - b.midi);
    return tones;
  }

  const scaleCache = new Map();
  function getScale(fifths) {
    const f = fifths | 0;
    if (!scaleCache.has(f)) scaleCache.set(f, scaleTable(f));
    return scaleCache.get(f);
  }

  /**
   * Floating MIDI → fractional absStep in the given key.
   * Chromatic pitches interpolate between the bracketing scale tones,
   * so the ball moves continuously and snaps visually onto lines/spaces
   * only when the singer is on a diatonic pitch.
   */
  function midiToAbsStepFloat(midiFloat, fifths) {
    const tones = getScale(fifths);
    let lo = tones[0], hi = tones[tones.length - 1];
    for (let i = 0; i < tones.length - 1; i++) {
      if (tones[i].midi <= midiFloat && midiFloat <= tones[i + 1].midi) {
        lo = tones[i];
        hi = tones[i + 1];
        break;
      }
    }
    if (hi.midi === lo.midi) return lo.absStep;
    const frac = (midiFloat - lo.midi) / (hi.midi - lo.midi);
    return lo.absStep + frac * (hi.absStep - lo.absStep);
  }

  /**
   * Ball staff step for a sung pitch, anchored on the current target note so
   * that singing exactly the (offset) target puts the ball dead on the ring
   * regardless of accidental spelling: relStep = target.step + Δdiatonic.
   */
  function ballStep(sungMidi, target, fifths, offset) {
    const t = midiToAbsStepFloat(target.midi + offset, fifths);
    const s = midiToAbsStepFloat(sungMidi, fifths);
    const rel = (target.step != null ? target.step : 0) + (s - t);
    return Math.max(-6, Math.min(14, rel)); // clamp to 6 ledger steps out
  }

  /** Staff step (0 = bottom line, +1 per line/space) → PDF y. */
  function stepToY(step, lineYs, spacing) {
    const bottom = lineYs && lineYs.length === 5 ? lineYs[4] : null;
    if (bottom == null) return null;
    return bottom - step * (spacing / 2);
  }

  /** Octave-error suppression: fold sung pitch toward target by 12 if that helps. */
  function fixOctave(sungMidi, targetMidi) {
    const d = sungMidi - targetMidi;
    if (Math.abs(d) > 8) {
      if (Math.abs(d - 12) <= 8) return sungMidi - 12;
      if (Math.abs(d + 12) <= 8) return sungMidi + 12;
    }
    return sungMidi;
  }

  const core = { keyInfo, scaleTable, midiToAbsStepFloat, ballStep, stepToY, fixOctave };
  if (typeof window !== "undefined") window.followCore = core;
  else if (typeof globalThis !== "undefined") globalThis.followCore = core;

  // ===================================================================
  // DOM / trainer integration
  // ===================================================================
  if (typeof document === "undefined") return; // headless (node) — core only

  const follow = {
    /** Semitone offset applied to all targets (relative mode). */
    offset: 0,
    anchored: false,
    /** Frames collected while waiting for a stable anchor pitch. */
    anchorFrames: [],
    /** Timestamp when the current in-tolerance streak began, or null. */
    matchStart: null,
    finished: false,
  };

  function resetAnchor() {
    follow.offset = 0;
    follow.anchored = false;
    follow.anchorFrames = [];
    follow.matchStart = null;
    follow.finished = false;
  }

  function resetRun() {
    resetAnchor();
    if (window.trainer) window.trainer.completed.clear();
  }

  /** Scroll the stage so the current note's staff sits in the upper third. */
  function scrollToNote(n) {
    const stage = document.getElementById("stage");
    if (!stage || n.y == null) return;
    const scale = window.pdfScale || 1;
    const cssY = n.y * scale;
    const view = stage.clientHeight;
    const top = stage.scrollTop;
    if (cssY < top + view * 0.15 || cssY > top + view * 0.75) {
      stage.scrollTo({ top: Math.max(0, cssY - view * 0.35), behavior: "smooth" });
    }
  }

  function currentNote() {
    const t = window.trainer;
    if (!t || !t.notes || !t.notes.length) return null;
    const i = t.currentNoteIndex;
    return i >= 0 && i < t.notes.length ? t.notes[i] : null;
  }

  function advance() {
    const t = window.trainer;
    const i = t.currentNoteIndex;
    t.completed.add(i);
    follow.matchStart = null;
    if (i + 1 < t.notes.length) {
      t.focusNote(i + 1); // handles page turns; then scroll to staff
      scrollToNote(t.notes[i + 1]);
    } else {
      follow.finished = true;
      t.drawBall(null); // done — leave the green trail
    }
  }

  /** Try to establish the relative-mode anchor; returns true when anchored. */
  function updateAnchor(midiFloat, now, target) {
    const fr = follow.anchorFrames;
    fr.push({ t: now, m: midiFloat });
    // Drop frames older than 700 ms
    while (fr.length && now - fr[0].t > 700) fr.shift();
    if (!fr.length || now - fr[0].t < 500) return false;
    const ms = fr.map((f) => f.m);
    const span = Math.max(...ms) - Math.min(...ms);
    if (span > 1.0) {
      // unstable — keep only recent frames and keep waiting
      follow.anchorFrames = fr.slice(-3);
      return false;
    }
    const mid = ms.slice().sort((a, b) => a - b)[Math.floor(ms.length / 2)];
    follow.offset = Math.round(mid - target.midi);
    follow.anchored = true;
    return true;
  }

  function onPitch(midiFloat, clarity) {
    const t = window.trainer;
    if (!t) return;
    t.lastPitch = { midi: midiFloat, clarity, t: performance.now() };

    const n = currentNote();
    if (!n || follow.finished) return;

    if (midiFloat == null) {
      follow.matchStart = null;
      t.drawBall(null);
      return;
    }

    const now = performance.now();
    const relativeMode = t.mode === "relative";

    if (relativeMode && !follow.anchored) {
      updateAnchor(midiFloat, now, n);
      // Until anchored, show the ball with no offset so the singer sees something.
    }
    const offset = relativeMode && follow.anchored ? follow.offset : 0;

    const targetMidi = n.midi + offset;
    const sung = fixOctave(midiFloat, targetMidi);

    // Ball position
    const fifths = (n.keySig && n.keySig.fifths) || 0;
    const step = ballStep(sung, n, fifths, offset);
    const y = stepToY(step, n.staffLineYs, n.staffSpacing || 4.32);
    if (y != null && n.x != null) t.drawBall(n.x, y);

    // Auto-advance
    const cents = Math.abs((sung - targetMidi) * 100);
    const tol = t.sensitivityCents || 50;
    const need = (n.type === "recit" ? 2 : 1) * (t.advanceHoldMs || 300);
    if (cents <= tol) {
      if (follow.matchStart == null) follow.matchStart = now;
      if (now - follow.matchStart >= need) advance();
    } else {
      follow.matchStart = null;
    }
  }

  // Install: replace the app.js stub, preserving its lastPitch bookkeeping.
  function install() {
    if (!window.trainer) {
      setTimeout(install, 50);
      return;
    }
    window.trainer.onPitch = onPitch;

    const startOverBtn = document.getElementById("start-over-btn");
    if (startOverBtn) startOverBtn.addEventListener("click", resetRun);
    window.addEventListener("trainer:mode", resetAnchor);
    window.addEventListener("trainer:mic", resetAnchor);
  }
  install();

  // ===================================================================
  // Self-test: ?selftest=1 replays the melody with small errors, no mic.
  // ===================================================================
  if (typeof location !== "undefined" && /[?&]selftest=1/.test(location.search)) {
    const banner = document.createElement("div");
    banner.style.cssText =
      "position:fixed;bottom:0;left:0;right:0;z-index:99;padding:10px 16px;" +
      "font:600 16px system-ui;background:#1c2a44;color:#cfe0ff;";
    banner.textContent = "Self-test: waiting for score.json…";
    document.body.appendChild(banner);

    const waitScore = setInterval(() => {
      const t = window.trainer;
      if (!t || !t.notes || !t.notes.length) return;
      clearInterval(waitScore);
      runSelfTest(t, banner).catch((e) => {
        banner.textContent = "Self-test error: " + e.message;
        banner.style.background = "#5a1c1c";
      });
    }, 200);
  }

  async function runSelfTest(t, banner) {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    // Sing through the entire first staff (the "first line").
    const first = t.notes[0];
    const lineNotes = t.notes.filter(
      (n) => n.pageIndex === first.pageIndex && n.staffIndex === first.staffIndex
    );
    banner.textContent = `Self-test: singing ${lineNotes.length} notes of the first line…`;

    const holdMs = t.advanceHoldMs || 300;
    for (const n of lineNotes) {
      const startIdx = t.currentNoteIndex;
      const need = (n.type === "recit" ? 2 : 1) * holdMs + 400;
      const t0 = performance.now();
      while (t.currentNoteIndex === startIdx && performance.now() - t0 < need + 1500) {
        // ±20¢ wobble around the true pitch
        const wobble = (Math.random() - 0.5) * 0.4;
        onPitch(n.midi + wobble, 0.97);
        await sleep(20);
      }
      onPitch(null, 0); // brief consonant gap between syllables
      await sleep(60);
      if (t.currentNoteIndex === startIdx) {
        banner.textContent = `Self-test FAILED at note ${startIdx} (${n.lyric || ""} midi ${n.midi}) — no advance.`;
        banner.style.background = "#5a1c1c";
        return;
      }
    }
    banner.textContent = `Self-test PASSED: cursor advanced through all ${lineNotes.length} first-line notes. Green rings mark them.`;
    banner.style.background = "#1c4430";
  }
})();
