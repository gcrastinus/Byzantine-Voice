/**
 * follow.js — plainchant practice: free-time singing + optional tempo playback.
 *
 * Begin  — free chant follow: hear the start note → countdown → sing.
 *          Ball sits on the current note; hold green to advance.
 *
 * Play   — computer sings the melody at a fixed demo tempo so you can learn it.
 *          Mic ignored; ball rides the written line.
 *
 * Click a notehead anytime to seek there and hear that pitch.
 *
 * Consumes window.trainer (app.js) and the onPitch stream (pitch.js).
 * Pure math is exported as followCore for headless tests.
 */
(() => {
  "use strict";

  // ===================================================================
  // Pure math core (no DOM) — testable in node via global.followCore
  // ===================================================================
  const MAJOR = [0, 2, 4, 5, 7, 9, 11];

  function keyInfo(fifths) {
    const tonicPc = (((fifths * 7) % 12) + 12) % 12;
    const tonicLetter = (((fifths * 4) % 7) + 7) % 7;
    return { tonicPc, tonicLetter };
  }

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

  function midiToAbsStepFloat(midiFloat, fifths) {
    const tones = getScale(fifths);
    let lo = tones[0],
      hi = tones[tones.length - 1];
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

  function ballStep(sungMidi, target, fifths, offset) {
    const t = midiToAbsStepFloat(target.midi + offset, fifths);
    const s = midiToAbsStepFloat(sungMidi, fifths);
    const rel = (target.step != null ? target.step : 0) + (s - t);
    return Math.max(-10, Math.min(16, rel));
  }

  function stepToY(step, lineYs, spacing) {
    const bottom = lineYs && lineYs.length === 5 ? lineYs[4] : null;
    if (bottom == null) return null;
    return bottom - step * (spacing / 2);
  }

  /**
   * Prefer written register; allow ±1–2 octaves when clearly near that pitch.
   * Slightly wider so male cantors an octave down still lock; still avoids
   * unlimited nearest-octave fold (which made climbing wrap to green).
   */
  function bestOctaveFold(sungMidi, targetMidi) {
    const raw = Math.abs(sungMidi - targetMidi);
    if (raw <= 7.5) return 0;
    let bestF = 0;
    let bestErr = raw;
    for (const f of [-2, -1, 1, 2]) {
      const err = Math.abs(sungMidi - (targetMidi + 12 * f));
      if (err + 0.01 < bestErr) {
        bestErr = err;
        bestF = f;
      }
    }
    // Accept fold if within ~a minor third of the folded target
    return bestF !== 0 && bestErr <= 4.0 ? bestF : 0;
  }

  function fixOctave(sungMidi, targetMidi) {
    return sungMidi - 12 * bestOctaveFold(sungMidi, targetMidi);
  }

  const core = {
    keyInfo,
    scaleTable,
    midiToAbsStepFloat,
    ballStep,
    stepToY,
    fixOctave,
    bestOctaveFold,
  };
  if (typeof window !== "undefined") window.followCore = core;
  else if (typeof globalThis !== "undefined") globalThis.followCore = core;

  // ===================================================================
  // DOM / trainer integration
  // ===================================================================
  if (typeof document === "undefined") return;

  const GLYPH_BEATS = {
    whole: 4,
    half: 2,
    quarter: 1,
    eighth: 0.5,
    sixteenth: 0.25,
    dottedhalf: 3,
    dottedquarter: 1.5,
    dottedeighth: 0.75,
  };
  /**
   * Reciting tones (same pitch over many syllables): each syllable is a written
   * quarter note → exactly 1 beat at the current Play tempo. Duration SCALES
   * with the tempo slider (beats, not fixed ms), so the whole line stays even.
   */
  /** Below this a beat is too short to re-articulate; sustain instead. */
  const MIN_PULSE_BEAT_SEC = 0.14;
  /** Span of a recit with nothing after it and no known staff edge, in points. */
  const RECIT_FALLBACK_SPAN_PT = 120;
  const RECIT_BEATS_PER_SYLLABLE = 1;
  const RECIT_MIN_BEATS = 1;
  const RECIT_FALLBACK_SYLLABLES = 6;

  /**
   * Singer-calibrated holds (no global tempo for singing):
   *  - First note: observe how long the singer holds (release ends the note),
   *    then unitMs = greenHoldMs / noteUnits(note).
   *  - Later notes need unitMs * noteUnits(n) of green pitch to advance.
   *  - Written “double” notes (half vs quarter) use ~1.5× a quarter (50% longer),
   *    not a metronome 2× — so relative lengths stay related, set by the singer.
   *  - If the piece starts on a double, unitMs is inferred from that hold and
   *    quarters need about 2/3 of that time (≈ half-ish of the double).
   * Computer Play uses the Play Notes tempo slider only for the demo timeline.
   */
  const HOLD_MIN_MS = 320;
  const HOLD_MAX_MS = 8000;
  /**
   * Until the singer finishes the first note, use this ms-per-quarter as the hold
   * target so the first note advances on duration (not “hold forever until silence”).
   * After that note, unitMs is calibrated from how long they actually held green.
   */
  const BOOTSTRAP_UNIT_MS = 500;
  /** Soften rare re-calibration if we ever sample again. */
  const UNIT_EMA = 0.45;
  /**
   * Computer “Play Notes” tempo only (not used for Begin holds).
   * Slow end for sorrowful chant; fast end ~25% above the old 150 BPM cap
   * for more joyful pieces.
   */
  const PLAY_TEMPO_DEFAULT = 80;
  const PLAY_TEMPO_MIN = 40;
  const PLAY_TEMPO_MAX = 190;
  /** Countdown tick length when beginning to sing (not tempo-linked). */
  const COUNTDOWN_TICK_MS = 700;
  /** Brief pause on a completed note before jumping to the next. */
  const ADVANCE_PAUSE_MS = 220;
  /** Match Pitch: solid green hold ≈ one quarter-note beat at a moderate pace. */
  const MATCH_PITCH_HOLD_MS = 600;
  const PITCH_FRESH_MS = 200;
  const MAX_FRAME_MS = 120;
  /** Hit radius for clicking notes (PDF CSS px). Larger so recits / dense notes are easy to hit. */
  const SEEK_RADIUS_PX = 48;
  const OCTAVE_SWITCH_MS = 200;
  const OCTAVE_RESET_MS = 400;
  const BALL_TAU_MS = 55;
  const TONE_TAIL_MS = 200;
  const HEAR_NOTE_MS = 700;
  /**
   * Cents ≤ sensitivity → green.
   * Cents ≤ max(sens * YELLOW_MULT, YELLOW_MIN_CENTS) → yellow (near-miss).
   * Else red. Wider yellow so “almost green” is not painted red.
   */
  const YELLOW_MULT = 4.5;
  const YELLOW_MIN_CENTS = 180;

  const follow = {
    offset: 0,
    anchored: false,
    anchorFrames: [],
  };

  const play = {
    active: false,
    /** Free-time sing mode (Begin) — no tempo cursor. */
    freeFollow: false,
    /** Computer plays the melody (Play). */
    listen: false,
    startIndex: 0,
    timeline: [],
    seg: -1,
    runStartMs: 0,
    rafId: 0,
    /** Only for computer Play timeline (not for Begin hold lengths). */
    tempo: PLAY_TEMPO_DEFAULT,
    /**
     * User pitch transpose in half steps (−12 … +6): one octave down to
     * half an octave up. Default 0 = written pitch (slider ~2/3 from left).
     */
    transposeSemis: 0,
    voicedMs: 0,
    /** Green-hold accumulator for the current note (ms). */
    inTuneMs: 0,
    lastFrameMs: 0,
    pitchY: null,
    lastVoicedMs: 0,
    ballX: null,
    countdownTimer: 0,
    cancelCountdown: null,
    emphasisTimer: 0,
    /** Bumped on stop so async Begin can abandon after first-note wait. */
    runId: 0,
    /** How much green time the current note needs before advance. */
    needHoldMs: 0,
    /** True while celebrating a completed note before jumping ahead. */
    advancing: false,
    /**
     * Calibrated ms per “quarter unit” from the singer’s green holds.
     * null until the first note of a Begin run is completed.
     */
    unitMs: null,
    /** performance.now() when silence began (legacy; advance is hold-based). */
    releaseSince: 0,
    /** True from Begin click through cue/countdown until free-follow is live. */
    preparingBegin: false,
    /**
     * Match Pitch mode: click any note to hear it and match with voice.
     * Hold green for MATCH_PITCH_HOLD_MS → success chime + freeze until re-click.
     */
    matchPitch: false,
    /** Green-hold ms for the current Match Pitch target. */
    matchHoldMs: 0,
    /** True after a successful match on the current note (until that note is re-clicked). */
    matchWon: false,
    matchLastFrameMs: 0,
  };

  const octave = {
    fold: 0,
    candidate: null,
    candidateSinceMs: 0,
    lastVoicedMs: 0,
    noteKey: null,
  };

  const ballY = { value: null, lastMs: 0 };

  function resetOctave() {
    octave.fold = 0;
    octave.candidate = null;
    octave.candidateSinceMs = 0;
    octave.lastVoicedMs = 0;
    octave.noteKey = null;
  }

  function resetBallSmoothing() {
    ballY.value = null;
    ballY.lastMs = 0;
  }

  function resetFreeAccum() {
    play.voicedMs = 0;
    play.inTuneMs = 0;
    play.lastFrameMs = 0;
    play.needHoldMs = 0;
    play.advancing = false;
    play.releaseSince = 0;
  }

  function resetCalibration() {
    play.unitMs = null;
    play.releaseSince = 0;
  }

  /** Still learning pace from the singer’s first hold(s). */
  function needsCalibration() {
    return play.unitMs == null;
  }

  /**
   * Relative length of a written note for hold math.
   * Quarter = 1. A written double (half) ≈ 1.5 (50% longer than a quarter).
   * Whole ≈ 2.25. Recits scale with syllable count.
   */
  function noteUnits(n) {
    if (!n) return 1;
    // Free-follow: one notehead = one advance unit (recits are one glyph on the staff).
    // Computer Play still expands recits by syllable count in beatsFor().
    if (n.type === "recit" || n.glyph === "recit") {
      return 1;
    }
    const g = String(n.glyph || "quarter").toLowerCase().replace(/\s+/g, "");
    let raw = GLYPH_BEATS[g];
    if (raw == null) raw = 1;
    if (n.dotted && !g.startsWith("dotted")) raw *= 1.5;
    return compressUnits(raw);
  }

  /** Map written 1,2,4… toward 1, 1.5, 2.5… so doubles are ~50% longer, not 100%. */
  function compressUnits(raw) {
    if (raw <= 1) return Math.max(0.55, raw);
    return 1 + (raw - 1) * 0.5;
  }

  /**
   * Green time required for note n.
   * First note uses bootstrap unit; later notes use singer-calibrated unitMs.
   * Advance is always hold-duration (no “pause to finish” on the first note).
   */
  function requiredHoldMs(n) {
    const u = noteUnits(n);
    const unit = play.unitMs != null ? play.unitMs : BOOTSTRAP_UNIT_MS;
    return Math.max(HOLD_MIN_MS, Math.min(HOLD_MAX_MS, unit * u));
  }

  /** After a note is held green, fold that duration into unitMs. */
  function calibrateFromHold(n, heldMs) {
    if (!n || !(heldMs > 80)) return;
    const u = noteUnits(n);
    if (u < 0.4) return;
    const sample = heldMs / u;
    if (!(sample > 80) || sample > HOLD_MAX_MS) return;
    if (play.unitMs == null) {
      play.unitMs = sample;
    } else {
      play.unitMs = play.unitMs * (1 - UNIT_EMA) + sample * UNIT_EMA;
    }
  }

  function stableFold(sungMidi, targetMidi, now, noteKey) {
    const implied = bestOctaveFold(sungMidi, targetMidi);
    const stale = octave.lastVoicedMs && now - octave.lastVoicedMs > OCTAVE_RESET_MS;

    if (noteKey !== octave.noteKey || stale) {
      octave.noteKey = noteKey;
      octave.fold = implied;
      octave.candidate = null;
      octave.candidateSinceMs = 0;
    } else if (implied === octave.fold) {
      octave.candidate = null;
      octave.candidateSinceMs = 0;
    } else if (implied !== octave.candidate) {
      octave.candidate = implied;
      octave.candidateSinceMs = now;
    } else if (now - octave.candidateSinceMs > OCTAVE_SWITCH_MS) {
      octave.fold = implied;
      octave.candidate = null;
      octave.candidateSinceMs = 0;
    }

    octave.lastVoicedMs = now;
    return octave.fold;
  }

  function smoothBallY(target, now) {
    if (target == null) return null;
    if (ballY.value == null || !ballY.lastMs) {
      ballY.value = target;
    } else {
      const dt = Math.max(0, now - ballY.lastMs);
      ballY.value += (target - ballY.value) * (1 - Math.exp(-dt / BALL_TAU_MS));
    }
    ballY.lastMs = now;
    return ballY.value;
  }

  function bottomLineY(n) {
    return stepToY(0, n.staffLineYs, n.staffSpacing || 4.32);
  }

  const els = {};
  function el(id) {
    if (!(id in els)) els[id] = document.getElementById(id);
    return els[id];
  }

  function resetAnchor() {
    follow.offset = 0;
    follow.anchored = false;
    follow.anchorFrames = [];
  }

  function trainer() {
    return window.trainer;
  }

  function noteAt(i) {
    const t = trainer();
    if (!t || !t.notes || i == null || i < 0 || i >= t.notes.length) return null;
    return t.notes[i];
  }

  function currentNote() {
    const t = trainer();
    return t ? noteAt(t.currentNoteIndex) : null;
  }

  function sameStaff(a, b) {
    return !!a && !!b && a.pageIndex === b.pageIndex && a.staffIndex === b.staffIndex;
  }

  function scrollToNote(n) {
    const stage = el("stage");
    if (!stage || !n || n.y == null) return;
    const scale = window.pdfScale || 1;
    const cssY = n.y * scale;
    const view = stage.clientHeight;
    const top = stage.scrollTop;
    if (cssY < top + view * 0.15 || cssY > top + view * 0.75) {
      stage.scrollTo({ top: Math.max(0, cssY - view * 0.35), behavior: "smooth" });
    }
  }

  // —— Durations (used by Play timeline + first-note reference on Begin) ——

  function syllableCount(n) {
    if (!n || !n.lyric) return RECIT_FALLBACK_SYLLABLES;
    const parts = String(n.lyric)
      .split(/[\s\-‐‑–—]+/)
      .filter(Boolean);
    return parts.length || RECIT_FALLBACK_SYLLABLES;
  }

  function beatsFor(n, tempo) {
    if (!n) return 1;
    if (n.type === "recit" || n.glyph === "recit") {
      const syl = Math.max(1, syllableCount(n));
      return Math.max(RECIT_MIN_BEATS, syl * RECIT_BEATS_PER_SYLLABLE);
    }
    const g = String(n.glyph || "quarter")
      .toLowerCase()
      .replace(/\s+/g, "");
    let beats = GLYPH_BEATS[g];
    if (beats == null) beats = 1; // unknown → quarter (filled heads without flags)
    if (n.dotted && !g.startsWith("dotted")) beats *= 1.5;
    return beats;
  }

  function durationMs(n, tempo) {
    return beatsFor(n, tempo) * (60000 / tempo);
  }

  /**
   * Build the Play timeline. Reciting tones expand into one segment per
   * quarter-note beat (one syllable ≈ one beat) so the computer re-articulates
   * a clear series of quarters instead of one long sustain.
   */
  function buildTimeline(startIndex, tempo, endIndex) {
    const t = trainer();
    const notes = (t && t.notes) || [];
    const out = [];
    let clock = 0;
    const last =
      endIndex == null || endIndex < 0
        ? notes.length - 1
        : Math.min(endIndex, notes.length - 1);
    const start = Math.max(0, Math.min(startIndex, last));
    const bpm = Math.max(1, Number(tempo) || PLAY_TEMPO_DEFAULT);
    const beatMs = 60000 / bpm;

    for (let i = start; i <= last; i++) {
      const n = notes[i];
      if (isRecitNote(n)) {
        const beats = Math.max(
          RECIT_MIN_BEATS,
          Math.round(beatsFor(n, bpm)) || 1
        );
        // Ball steps evenly across the recit word span
        let x0 = n.x != null ? n.x : 0;
        let x1 = x0 + RECIT_FALLBACK_SPAN_PT;
        // Prefer next note on the full score for span (not only in play range)
        const after = notes[i + 1];
        if (after && after.x != null && sameStaff(n, after) && after.x > x0 + 4) {
          x1 = x0 + (after.x - x0) * 0.94;
        } else {
          const sp = n.staffSpacing || 4.32;
          const syl = Math.max(2, syllableCount(n));
          x1 = x0 + sp * Math.min(18, 2 + syl * 1.35);
        }
        for (let b = 0; b < beats; b++) {
          // Jump to the start of each beat slot across the span
          const ballX =
            beats <= 1 ? x0 : x0 + ((x1 - x0) * b) / beats;
          out.push({
            i,
            n,
            t0: clock,
            t1: clock + beatMs,
            durMs: beatMs,
            recitBeat: b,
            recitBeats: beats,
            ballX,
            isRecitPulse: true,
            glideX0: x0,
            glideX1: x1,
          });
          clock += beatMs;
        }
      } else {
        const durMs = Math.max(60, durationMs(n, bpm));
        out.push({ i, n, t0: clock, t1: clock + durMs, durMs });
        clock += durMs;
      }
    }
    return out;
  }

  // —— Synth (uses window.AppAudio — see audio.js for why Safari goes silent) ——

  let toneNodes = [];
  let toneBlankUntilMs = 0;

  function unlockAudio() {
    if (window.AppAudio) {
      // Prefer wake when available — recovers Safari after tab background
      if (typeof window.AppAudio.wake === "function") {
        window.AppAudio.wake();
      }
      return window.AppAudio.unlock();
    }
    // Fallback if audio.js failed to load
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    if (!window.__legacyAudioCtx || window.__legacyAudioCtx.state === "closed") {
      window.__legacyAudioCtx = new Ctor();
    }
    const c = window.__legacyAudioCtx;
    if (c.state !== "running") c.resume().catch(() => {});
    return c;
  }

  /**
   * Every Begin / Play (and note click via whenAudioRunning) re-arms Safari/Chrome
   * audio on that user gesture. May take ~50–200ms; better than silent notes.
   * @returns {Promise<{ok:boolean,ctx:AudioContext|null}>}
   */
  function ensureAudioLive() {
    if (window.AppAudio && typeof window.AppAudio.ensureLive === "function") {
      // Kick unlock synchronously on the click stack first
      unlockAudio();
      return window.AppAudio.ensureLive().then((r) => ({
        ok: !!(r && r.ok),
        ctx: (r && r.ctx) || null,
        detail: r,
      }));
    }
    unlockAudio();
    return new Promise((resolve) => {
      whenAudioRunning((ctx) => resolve({ ok: !!ctx, ctx, detail: null }));
    });
  }

  function whenAudioRunning(fn) {
    if (window.AppAudio && typeof window.AppAudio.whenRunning === "function") {
      window.AppAudio.whenRunning(fn);
      return;
    }
    const c = unlockAudio();
    if (!c) {
      fn(null);
      return;
    }
    if (c.state === "running") fn(c);
    else c.resume().then(() => fn(c)).catch(() => fn(null));
  }

  function setSoundMicMenuOpen(open) {
    // Sound & Mic lives inside Upload & Settings now
    const panel = el("upload-save-panel");
    const toggle = el("upload-save-toggle");
    if (!panel || !toggle) return;
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.classList.toggle("is-open", open);
  }

  function showAudioBlocked() {
    const msg =
      "No sound yet. Open Settings → Turn Sound On (you should hear a beep), then try again.";
    console.warn(msg, window.AppAudio && window.AppAudio.getState());
    const b = document.getElementById("mic-error");
    if (b) {
      b.hidden = false;
      b.textContent = msg;
      setTimeout(() => {
        if (b.textContent === msg) {
          b.hidden = true;
          b.textContent = "";
        }
      }, 8000);
    }
    updateSoundUi(false, msg);
    // Open the menu and highlight Turn Sound On
    setSoundMicMenuOpen(true);
    const btn = el("enable-sound-btn");
    if (btn) {
      btn.classList.add("is-fail");
      btn.focus();
    }
  }

  function setSoundStatusOpen(open) {
    const panel = el("sound-status-panel");
    if (!panel) return;
    panel.hidden = !open;
  }

  /**
   * Floating box under Sound & Mic (not a full-width banner).
   * ok === false → red alert; true → green brief note; null + detail → neutral/info.
   * ok === null and no detail → hide.
   */
  function updateSoundUi(ok, detail) {
    const btn = el("enable-sound-btn");
    const st = el("sound-status");
    const panel = el("sound-status-panel");
    const state = window.AppAudio && window.AppAudio.getState ? window.AppAudio.getState() : "none";
    const err = window.AppAudio && window.AppAudio.getLastError ? window.AppAudio.getLastError() : "";

    if (btn) {
      btn.disabled = false;
      btn.classList.toggle("is-ok", ok === true);
      btn.classList.toggle("is-fail", ok === false);
      if (ok === true) btn.textContent = "Sound On — click to re-test";
      else if (ok === false) btn.textContent = "Turn Sound On (retry)";
      else btn.textContent = "Turn Sound On";
    }

    if (!st || !panel) return;

    // No message requested — keep panel closed (don't force a permanent banner)
    if (ok == null && detail == null && !err) {
      setSoundStatusOpen(false);
      return;
    }

    let html = "";
    if (ok === true) {
      html =
        detail ||
        "Beep played. If you heard it, notes and Play should work. If not: unmute the Safari tab and Mac volume, then try again.";
    } else if (ok === false) {
      html =
        detail ||
        err ||
        "Sound was paused. Open Sound & Mic → Turn Sound On (you should hear a beep).";
    } else {
      html = detail || err || "";
    }
    if (!html) {
      setSoundStatusOpen(false);
      return;
    }

    st.innerHTML = html;
    panel.classList.toggle("is-ok", ok === true);
    panel.classList.toggle("is-neutral", ok == null);
    // fail = default red styles (no extra class)
    if (ok === false) {
      panel.classList.remove("is-ok", "is-neutral");
    }
    setSoundStatusOpen(true);
  }

  function enableSoundClick(ev) {
    if (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    }
    const btn = el("enable-sound-btn");
    if (btn) {
      btn.textContent = "Playing beep…";
      btn.classList.remove("is-ok", "is-fail");
    }
    updateSoundUi(null, "Unlocking sound and playing a test beep…");

    if (!window.AppAudio || typeof window.AppAudio.forceEnable !== "function") {
      updateSoundUi(false, "Audio module failed to load. Hard-refresh the page (⌘⇧R).");
      return;
    }

    // forceEnable must run on this click — HTML5 audio.play() + Web Audio beep
    window.AppAudio.forceEnable().then((result) => {
      const ok = !!(result && result.ok);
      const html = result && result.html;
      const web = result && result.web;
      const state = (result && result.state) || window.AppAudio.getState();
      if (ok) {
        updateSoundUi(
          true,
          "Test beep sent (HTML: " +
            (html ? "yes" : "no") +
            ", WebAudio: " +
            (web ? "yes" : "no") +
            ", state: " +
            state +
            "). If you still heard silence: check Mac volume and that the Safari tab is not muted."
        );
        const b = document.getElementById("mic-error");
        if (b) {
          b.hidden = true;
          b.textContent = "";
        }
      } else {
        const err =
          (window.AppAudio.getLastError && window.AppAudio.getLastError()) ||
          "Could not unlock sound.";
        updateSoundUi(
          false,
          err +
            " Tip: click the speaker icon on the Safari tab to unmute, raise Mac volume, then press Turn Sound On again."
        );
      }
    });
  }

  function midiToFreq(midi) {
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  function tonesActive() {
    return performance.now() < toneBlankUntilMs;
  }

  function blankMicFor(ms) {
    toneBlankUntilMs = Math.max(toneBlankUntilMs, performance.now() + ms);
  }

  function blankThrough(ctx, endSec) {
    const leadMs = (endSec - ctx.currentTime) * 1000;
    const endsAtPerf = performance.now() + Math.max(0, leadMs);
    toneBlankUntilMs = Math.max(toneBlankUntilMs, endsAtPerf + TONE_TAIL_MS);
  }

  /**
   * Schedule a speaker tone. ONLY call when ctx.state === "running".
   * Applies user Transpose (play.transposeSemis) but never relative-mode
   * follow.offset (that was wrongly shifting Play when someone sang low).
   * Linear gain only; simple sine — most reliable across Safari/Chrome.
   */
  function scheduleTone(ctx, midi, startSec, endSec) {
    if (!ctx || ctx.state !== "running") return false;
    if (midi == null || !Number.isFinite(midi)) return false;
    if (!(endSec > startSec + 0.05)) return false;
    const transposed = Number(midi) + (play.transposeSemis || 0);
    const freq = midiToFreq(transposed);
    if (!Number.isFinite(freq) || freq < 40 || freq > 3500) return false;

    const now = ctx.currentTime;
    let t0 = startSec;
    let t1 = endSec;
    if (t0 < now + 0.005) {
      const dur = Math.max(0.08, endSec - startSec);
      t0 = now + 0.02;
      t1 = t0 + dur;
    }

    const dur = t1 - t0;
    const attack = Math.min(0.025, dur * 0.12);
    const release = Math.min(0.07, dur * 0.22);
    const peak = 0.55; // loud enough for laptop speakers after Safari unlock

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.setValueAtTime(peak, Math.max(t0 + attack, t1 - release));
    gain.gain.linearRampToValueAtTime(0.0001, t1);
    gain.connect(ctx.destination);
    toneNodes.push(gain);

    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, t0);
    osc.connect(gain);
    osc.start(t0);
    osc.stop(t1 + 0.03);
    toneNodes.push(osc);

    const osc2 = ctx.createOscillator();
    const g2 = ctx.createGain();
    osc2.type = "triangle";
    osc2.frequency.setValueAtTime(freq, t0);
    g2.gain.value = 0.32;
    osc2.connect(g2).connect(gain);
    osc2.start(t0);
    osc2.stop(t1 + 0.03);
    toneNodes.push(osc2, g2);

    blankThrough(ctx, t1);
    return true;
  }

  function stopTones() {
    for (const node of toneNodes) {
      try {
        if (typeof node.stop === "function") node.stop();
      } catch (_) {
        /* already stopped */
      }
      try {
        node.disconnect();
      } catch (_) {
        /* ignore */
      }
    }
    toneNodes = [];
    if (performance.now() < toneBlankUntilMs) {
      toneBlankUntilMs = Math.min(toneBlankUntilMs, performance.now() + TONE_TAIL_MS);
    }
  }

  function pulseCountForNote(n) {
    if (!n) return 1;
    if (n.type === "recit" || n.glyph === "recit") {
      return Math.max(1, syllableCount(n));
    }
    return 1;
  }

  /**
   * Schedule note tones for Play / click.
   *
   * A reciting tone is not one long note: it is one quarter note per syllable
   * at the current tempo, on the same pitch. The ball glides across the words
   * while the voice re-articulates each beat.
   *
   * Onsets are derived as `i * beatSec` rather than accumulated as
   * `each + gap`. Accumulating makes every pulse land fractionally early and
   * the error compounds across a long recitation, which is what made the
   * tempo sound wrong; deriving each onset from the grid cannot drift.
   */
  function scheduleMidiPulses(ctx, midi, totalDurMs, pulses) {
    if (!ctx || ctx.state !== "running") return false;
    const p = Math.max(1, pulses | 0);
    const totalSec = Math.max(0.15, (totalDurMs || HEAR_NOTE_MS) / 1000);
    const tStart = ctx.currentTime + 0.015;

    if (p === 1) {
      return scheduleTone(ctx, Number(midi), tStart, tStart + totalSec);
    }

    // totalSec is p beats by construction, so this is exactly one beat.
    const beatSec = totalSec / p;
    // Only sustain if the beat is too short to articulate at all.
    if (beatSec < MIN_PULSE_BEAT_SEC) {
      return scheduleTone(ctx, Number(midi), tStart, tStart + totalSec);
    }

    const gap = Math.min(0.06, beatSec * 0.18); // silence between syllables
    let ok = false;
    for (let i = 0; i < p; i++) {
      const t0 = tStart + i * beatSec;
      if (scheduleTone(ctx, Number(midi), t0, t0 + (beatSec - gap))) ok = true;
    }
    return ok;
  }

  /** Guard against accidental double-cue (Assess start + seek, etc.). */
  let lastToneKey = "";
  let lastToneAtMs = 0;

  /**
   * Play one score note (click or short cue).
   * @param {number|object} midiOrNote
   * @param {number} [durMs]
   * @param {{ pulses?: number, forceSingle?: boolean }} [opts]
   *   forceSingle: one clean pitch (Assess cues — never syllable re-attacks)
   */
  function playSingleTone(midiOrNote, durMs, opts) {
    let midi = midiOrNote;
    let pulses = 1;
    let totalMs = durMs || HEAR_NOTE_MS;
    const forceSingle = !!(opts && opts.forceSingle);
    if (midiOrNote && typeof midiOrNote === "object") {
      midi = midiOrNote.midi;
      if (forceSingle) {
        pulses = 1;
      } else if (opts && opts.pulses != null) {
        pulses = Math.max(1, opts.pulses | 0);
      } else {
        // Click-to-hear: a recit re-articulates once per syllable, at the same
        // tempo Play uses, so clicking it sounds like what you'll sing.
        pulses = pulseCountForNote(midiOrNote);
        if (durMs == null && pulses > 1) {
          totalMs = durationMs(midiOrNote, clampPlayTempo(play.tempo));
        }
      }
    } else if (opts && opts.pulses != null && !forceSingle) {
      pulses = Math.max(1, opts.pulses | 0);
    }
    if (midi == null || !Number.isFinite(Number(midi))) {
      console.warn("playSingleTone: no midi", midi);
      return false;
    }

    // Drop near-duplicate cues (same pitch within 120ms) — fixes double-play on Assess
    const now = performance.now();
    const key = `${Math.round(Number(midi))}:${Math.round(totalMs / 50)}`;
    if (key === lastToneKey && now - lastToneAtMs < 120) {
      return false;
    }
    lastToneKey = key;
    lastToneAtMs = now;

    // Sync with user gesture (required on Safari)
    unlockAudio();
    stopTones();

    whenAudioRunning((ctx) => {
      if (!ctx) {
        showAudioBlocked();
        return;
      }
      const ok = scheduleMidiPulses(ctx, Number(midi), totalMs, pulses);
      if (!ok) {
        console.warn("playSingleTone: schedule failed", midi, ctx.state);
        showAudioBlocked();
      }
    });
    return true;
  }

  /**
   * Play the current Play-mode segment.
   * Recit beats are already expanded to one segment per quarter: play a single
   * slightly-short quarter so the re-attack into the next beat is audible.
   */
  function playSegmentTone(seg) {
    if (!seg || !seg.n || seg.n.midi == null) return;
    unlockAudio();
    const n = seg.n;
    // One segment = one re-attack. Recit pulses are never multi-scheduled here.
    const pulses = 1;
    // Leave a short silence at the end of each recit quarter so they read as
    // separate notes rather than one continuous hold.
    const durMs = seg.isRecitPulse
      ? Math.max(90, (seg.durMs || HEAR_NOTE_MS) * 0.78)
      : seg.durMs || HEAR_NOTE_MS;
    whenAudioRunning((ctx) => {
      if (!ctx || ctx.state !== "running") {
        // Mid-run silence after tab return: try one hard wake then reschedule
        if (window.AppAudio && typeof window.AppAudio.wake === "function") {
          window.AppAudio.wake().then((ok) => {
            const c2 = window.AppAudio.ensure && window.AppAudio.ensure();
            if (!ok || !c2 || c2.state !== "running") {
              showAudioBlocked();
              return;
            }
            stopTones();
            if (!scheduleMidiPulses(c2, n.midi, durMs, pulses)) showAudioBlocked();
          });
          return;
        }
        showAudioBlocked();
        return;
      }
      stopTones();
      if (!scheduleMidiPulses(ctx, n.midi, durMs, pulses)) {
        showAudioBlocked();
      }
    });
  }

  // —— Countdown ——

  function showCount(text) {
    const c = el("countdown");
    if (!c) return;
    if (text == null) {
      c.hidden = true;
      c.textContent = "";
      return;
    }
    c.hidden = false;
    c.textContent = text;
    c.classList.remove("is-tick");
    void c.offsetWidth;
    c.classList.add("is-tick");
  }

  function countdown(beatMs) {
    return new Promise((resolve) => {
      const step = Math.max(500, beatMs);
      let n = 3;
      showCount(String(n));
      play.cancelCountdown = () => {
        clearInterval(play.countdownTimer);
        play.countdownTimer = 0;
        play.cancelCountdown = null;
        showCount(null);
        resolve(false);
      };
      play.countdownTimer = setInterval(() => {
        n -= 1;
        if (n <= 0) {
          clearInterval(play.countdownTimer);
          play.countdownTimer = 0;
          play.cancelCountdown = null;
          showCount(null);
          resolve(true);
          return;
        }
        showCount(String(n));
      }, step);
    });
  }

  // —— UI ——

  function scoreReady() {
    const t = trainer();
    return !!(t && t.notes && t.notes.length);
  }

  /** True when a note is selected as a play start (clicked note, not cleared). */
  function hasPlayStartSelection() {
    return (play.startIndex | 0) > 0;
  }

  function setRunUi() {
    const uploadBtn = el("upload-pdf-btn");
    const uploadSaveToggle = el("upload-save-toggle");
    const toolsToggle = el("tools-toggle");
    const toolsMenu = el("tools-menu");
    const matchBtn = el("match-pitch-btn");
    const playBtn = el("play-btn");
    const playControls = el("play-controls");
    const diagBtn = el("diag-btn");
    const ready = scoreReady();
    const listening = !!(play.active && play.listen);
    const matching = !!play.matchPitch;
    const freeBusy = !!(play.active && play.freeFollow);

    // First load: Upload/Settings blue. After score: Match Pitch blue.
    if (uploadSaveToggle) {
      uploadSaveToggle.classList.toggle("btn-primary", !ready);
      uploadSaveToggle.title = ready
        ? "Upload & Settings: sound & mic, save or load a score, upload another PDF"
        : "Upload a PDF first — then sound, mic, and other options unlock";
    }
    if (uploadBtn && uploadBtn.classList && typeof uploadBtn.classList.toggle === "function") {
      uploadBtn.classList.toggle("btn-primary", !ready);
    }

    // Phone Tools ▾ — grayed/disabled until a score is ready
    if (toolsToggle) {
      toolsToggle.classList.toggle("is-awaiting-score", !ready);
      toolsToggle.disabled = !ready;
      toolsToggle.title = ready
        ? "Practice tools: Match Pitch, Transpose, Tempo, Assess, Play"
        : "Upload a PDF first to use practice tools";
      if (!ready && toolsMenu) {
        toolsMenu.classList.remove("is-open");
        toolsToggle.classList.remove("is-open");
        toolsToggle.setAttribute("aria-expanded", "false");
      }
    }

    if (
      typeof document !== "undefined" &&
      document.body &&
      document.body.classList &&
      typeof document.body.classList.toggle === "function"
    ) {
      document.body.classList.toggle("score-ready", ready);
    }

    const tempoControls = el("tempo-controls");
    const transposeControls = el("transpose-controls");
    const tempoSlider = el("tempo-slider");
    const transposeSlider = el("transpose-slider");
    const infoEye = transposeControls && transposeControls.querySelector(".info-eye");

    // Always visible: grayed/disabled until a score is loaded
    if (playControls) playControls.hidden = false;
    if (tempoControls) {
      tempoControls.hidden = false;
      tempoControls.classList.toggle("is-awaiting-score", !ready);
      tempoControls.setAttribute("aria-disabled", ready ? "false" : "true");
      tempoControls.title = ready
        ? "Playback speed for Play All and drag-select"
        : "Upload a PDF first to set Tempo";
    }
    if (transposeControls) {
      transposeControls.hidden = false;
      transposeControls.classList.toggle("is-awaiting-score", !ready);
      transposeControls.setAttribute("aria-disabled", ready ? "false" : "true");
      transposeControls.title = ready
        ? "Shift all played and matched pitches by half steps"
        : "Upload a PDF first to use Transpose";
    }
    if (tempoSlider) tempoSlider.disabled = !ready;
    if (transposeSlider) transposeSlider.disabled = !ready;
    if (infoEye) {
      // Always allow keyboard focus so the help tip stays available
      infoEye.tabIndex = 0;
      infoEye.setAttribute("aria-disabled", "false");
    }
    // Parent title must not cover the circled-i tip while hovering it
    if (transposeControls && !transposeControls.__tipTitleWired) {
      transposeControls.__tipTitleWired = true;
      const eye = transposeControls.querySelector(".info-eye");
      if (eye) {
        const clearTitle = () => {
          transposeControls.dataset._savedTitle = transposeControls.title || "";
          transposeControls.removeAttribute("title");
          const lab = transposeControls.querySelector("label");
          if (lab) {
            lab.dataset._savedTitle = lab.title || "";
            lab.removeAttribute("title");
          }
        };
        const restoreTitle = () => {
          const t =
            transposeControls.dataset._savedTitle ||
            (scoreReady()
              ? transposeControls.dataset.titleReady ||
                "Shift all played and matched pitches by half steps"
              : transposeControls.dataset.titleIdle ||
                "Upload a PDF first to use Transpose");
          // Prefer data-title-* attributes set in HTML
          const ready = scoreReady();
          const pref = ready
            ? transposeControls.getAttribute("data-title-ready")
            : transposeControls.getAttribute("data-title-idle");
          transposeControls.title = pref || t || "";
        };
        eye.addEventListener("mouseenter", clearTitle);
        eye.addEventListener("focus", clearTitle);
        eye.addEventListener("mouseleave", restoreTitle);
        eye.addEventListener("blur", restoreTitle);
      }
    }
    if (transposeControls) {
      const readyTitle = transposeControls.getAttribute("data-title-ready");
      const idleTitle = transposeControls.getAttribute("data-title-idle");
      if (!transposeControls.querySelector(".info-eye:hover")) {
        transposeControls.title = ready
          ? readyTitle || "Shift all played and matched pitches by half steps"
          : idleTitle || "Upload a PDF first to use Transpose";
      }
    }

    if (matchBtn) {
      matchBtn.hidden = false;
      matchBtn.classList.toggle("is-awaiting-score", !ready);
      // Active → "Stop" so it is obvious you can click to turn Match Pitch off
      matchBtn.textContent = matching ? "Stop" : "Match Pitch";
      matchBtn.classList.toggle("is-playing", matching && ready);
      // Blue primary when score is ready and Match Pitch is idle
      matchBtn.classList.toggle("btn-primary", ready && !matching);
      matchBtn.setAttribute("aria-pressed", matching ? "true" : "false");
      matchBtn.setAttribute(
        "aria-label",
        matching ? "Stop Match Pitch" : "Match Pitch"
      );
      // Disabled until score; when ready, allow off anytime / block on while Play runs
      matchBtn.disabled = !ready || (!matching && (listening || freeBusy));
      matchBtn.title = !ready
        ? "Upload a PDF first to use Match Pitch"
        : matching
          ? "Stop Match Pitch"
          : "Click to turn on, then click a note to hear it and match with your voice";
    }

    if (playBtn) {
      playBtn.hidden = false;
      playBtn.classList.toggle("is-awaiting-score", !ready);
      let html;
      let label;
      let title;
      if (!ready) {
        html = 'Play All <span class="play-icon" aria-hidden="true">▶</span>';
        label = "Play all (upload a PDF first)";
        title = "Upload a PDF first to play the score";
        playBtn.classList.remove("is-playing");
        playBtn.disabled = true;
      } else if (listening) {
        html = 'Pause <span class="pause-icon" aria-hidden="true">⏸</span>';
        label = "Pause";
        title = "Pause playback";
        playBtn.classList.add("is-playing");
        playBtn.disabled = false;
      } else if (hasPlayStartSelection()) {
        html =
          'Play Starting Here <span class="play-icon" aria-hidden="true">▶</span>';
        label = "Play starting from the selected note";
        title = "Play from the selected note to the end at the Tempo setting";
        playBtn.classList.remove("is-playing");
        playBtn.disabled = false;
      } else {
        html = 'Play All <span class="play-icon" aria-hidden="true">▶</span>';
        label = "Play all from the beginning";
        title = "Play the whole piece from the beginning at the Tempo setting";
        playBtn.classList.remove("is-playing");
        playBtn.disabled = false;
      }
      // Only rewrite DOM when label changes — rewriting on pointerdown was
      // cancelling the subsequent click (Play did nothing).
      if (playBtn.innerHTML !== html) playBtn.innerHTML = html;
      playBtn.setAttribute("aria-label", label);
      playBtn.title = title;
    }

    if (diagBtn) {
      diagBtn.hidden = false;
      diagBtn.classList.toggle("is-awaiting-score", !ready);
      diagBtn.disabled = !ready;
      // Light yellow outline once a score is ready (tool cue, not a warning)
      diagBtn.classList.toggle("btn-assess-ready", ready);
      diagBtn.title = ready
        ? "Assess a section: pick start and end notes, sing freely, get a pitch report (no audio is saved)"
        : "Upload a PDF first to use Assess Singing";
    }
  }

  /**
   * Clear the orange “clicked note” box.
   * Always allowed in every mode — highlight is only for the note you are on;
   * moving away (empty click / leave mode) removes it.
   */
  function clearSeekHighlight() {
    const t = trainer();
    if (!t) return;
    if (typeof t.clearNoteHighlight === "function") t.clearNoteHighlight();
    else if (typeof t.highlightNote === "function") {
      t.highlightNote(-1);
      if (typeof t.drawBall === "function") t.drawBall(null, null);
    }
    // No note selected → Play All (from the beginning)
    play.startIndex = 0;
    setRunUi();
  }

  /** Turn mic on (same user gesture when possible). */
  function ensureMicOnForPractice() {
    if (window.pitchModule && typeof window.pitchModule.startMic === "function") {
      const sw = el("mic-switch");
      if (sw && sw.checked) return;
      window.pitchModule.startMic().catch((e) => console.warn("mic on", e));
      return;
    }
    const sw = el("mic-switch");
    if (sw && !sw.checked) {
      sw.checked = true;
      sw.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  /** Turn mic off (Begin Stop / leave Match Pitch). */
  function ensureMicOff() {
    if (window.pitchModule && typeof window.pitchModule.stopMic === "function") {
      window.pitchModule.stopMic().catch((e) => console.warn("mic off", e));
      return;
    }
    const sw = el("mic-switch");
    if (sw && sw.checked) {
      sw.checked = false;
      sw.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function setBallColorFromCents(cents, sens) {
    const t = trainer();
    if (!t || !t.setBallColor) return;
    if (cents == null) {
      t.setBallColor("neutral");
      return;
    }
    const s = sens || 40;
    const yellowTop = Math.max(s * YELLOW_MULT, YELLOW_MIN_CENTS);
    if (cents <= s) t.setBallColor("green");
    else if (cents <= yellowTop) t.setBallColor("yellow");
    else t.setBallColor("red");
  }

  // —— Play mode (tempo timeline) ——

  function clampPlayTempo(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return PLAY_TEMPO_DEFAULT;
    return Math.max(PLAY_TEMPO_MIN, Math.min(PLAY_TEMPO_MAX, Math.round(n)));
  }

  /** BPM from the Play Notes tempo slider (computer playback only). */
  function readPlayTempo() {
    const slider = el("tempo-slider");
    if (slider) return clampPlayTempo(slider.value);
    return clampPlayTempo(play.tempo);
  }

  function syncTempoUi(bpm) {
    const t = clampPlayTempo(bpm);
    play.tempo = t;
    const slider = el("tempo-slider");
    const val = el("tempo-val");
    if (slider) {
      slider.value = String(t);
      slider.setAttribute("aria-valuenow", String(t));
    }
    if (val) val.textContent = String(t);
  }

  /** Transpose: −12 … +6 half steps (semitones). Default 0. */
  function clampTranspose(semis) {
    const n = Math.round(Number(semis));
    if (!Number.isFinite(n)) return 0;
    return Math.max(-12, Math.min(6, n));
  }

  /** Display: −1 / 0 for exact octaves; otherwise signed half-step count. */
  function transposeLabel(semis) {
    const t = semis | 0;
    if (t === 0) return "0";
    if (t === -12) return "−1";
    if (t === 6) return "+½";
    return t > 0 ? `+${t}` : String(t);
  }

  function syncTransposeUi(semis) {
    const t = clampTranspose(semis);
    play.transposeSemis = t;
    const slider = el("transpose-slider");
    if (slider) {
      slider.value = String(t);
      slider.setAttribute("aria-valuenow", String(t));
      // No on-screen number; expose value on the control for hover / a11y
      let tip;
      if (t === 0) tip = "Written pitch (0)";
      else if (t === -12) tip = "1 octave down (−12)";
      else if (t === 6) tip = "Half an octave up (+6)";
      else {
        const abs = Math.abs(t);
        tip =
          (t < 0 ? `${abs} half step${abs === 1 ? "" : "s"} down` : `${abs} half step${abs === 1 ? "" : "s"} up`) +
          ` (${transposeLabel(t)})`;
      }
      slider.title = tip;
      slider.setAttribute("aria-valuetext", tip);
    }
  }

  /**
   * After the user releases the transpose slider, play the first three score
   * notes at the new pitch so they can hear the register.
   */
  function previewTranspose() {
    const t = trainer();
    if (!t || !t.notes || !t.notes.length) return;
    // Don't interrupt a full Play run
    if (play.active && play.listen) return;
    unlockAudio();
    const count = Math.min(3, t.notes.length);
    const beat = 520;
    for (let i = 0; i < count; i++) {
      const n = t.notes[i];
      if (!n || n.midi == null) continue;
      const delay = i * beat;
      setTimeout(() => {
        if (play.active && play.listen) return;
        playSingleTone(n, 420, { forceSingle: true });
      }, delay);
    }
  }



  function isRecitNote(n) {
    return !!(n && (n.type === "recit" || n.glyph === "recit"));
  }

  /**
   * End X for a recit glide: span the written words up to the next same-staff note.
   * Prefer a wide visual path so the ball clearly travels the recitation line.
   */
  function recitGlideEndX(segIndex) {
    const seg = play.timeline[segIndex];
    if (!seg || !seg.n || seg.n.x == null) return null;
    if (seg.glideX1 != null && Number.isFinite(seg.glideX1)) return seg.glideX1;
    const n = seg.n;
    const nextSeg = play.timeline[segIndex + 1];
    if (nextSeg && nextSeg.n && nextSeg.n.x != null && sameStaff(n, nextSeg.n)) {
      const span = nextSeg.n.x - n.x;
      // Cover almost all the way to the next notehead (leave a small gap)
      if (span > 4) return n.x + span * 0.94;
    }
    // Fallback: slide right by spacing × syllables (visual proxy for text width)
    const sp = n.staffSpacing || 4.32;
    const syl = Math.max(2, syllableCount(n));
    return n.x + sp * Math.min(18, 2 + syl * 1.35);
  }

  /** No-op kept for call sites; recit ball X is set per-beat in buildTimeline. */
  function attachRecitGlides(timeline) {
    return timeline || [];
  }

  function beginSegment(k) {
    const seg = play.timeline[k];
    if (!seg) return;
    const t = trainer();
    const prev = k > 0 ? play.timeline[k - 1].n : null;

    resetOctave();
    if (t.setHalo) t.setHalo(false);
    if (t.setBallColor) t.setBallColor("neutral");
    resetBallSmoothing();

    // Only re-focus / scroll when the score note changes (not every recit beat)
    const noteChanged = !prev || prev !== seg.n;
    if (noteChanged) {
      t.focusNote(seg.i);
      if (!sameStaff(prev, seg.n)) scrollToNote(seg.n);
    }

    // Recit beat: jump ball to this beat’s x. Normal notes: notehead.
    if (seg.n.y != null) {
      const x =
        seg.isRecitPulse && seg.ballX != null
          ? seg.ballX
          : seg.n.x != null
            ? seg.n.x
            : null;
      if (x != null) {
        play.ballX = x;
        t.drawBall(x, seg.n.y);
      }
    }
    // Each recit beat is its own quarter-note attack
    playSegmentTone(seg);
  }

  function tickListen() {
    if (!play.active || !play.listen) return;
    play.rafId = requestAnimationFrame(tickListen);

    const now = performance.now();
    const elapsed = now - play.runStartMs;

    while (play.seg < play.timeline.length && elapsed >= play.timeline[play.seg].t1) {
      play.seg += 1;
      if (play.seg < play.timeline.length) beginSegment(play.seg);
    }

    if (play.seg >= play.timeline.length) {
      stopPlayback();
      return;
    }

    const seg = play.timeline[play.seg];
    const n = seg.n;
    const t = trainer();
    // Still allow ball updates if page is mid-turn (focusNote may be loading)
    if (!n || n.y == null) return;
    if (t.pageNum != null && n.pdfPage != null && t.pageNum !== n.pdfPage) return;
    if (t.setBallColor) t.setBallColor("neutral");

    // Recit quarter-beats: park on this beat’s x (jumps when the segment advances)
    if (seg.isRecitPulse && seg.ballX != null) {
      play.ballX = seg.ballX;
      t.drawBall(seg.ballX, n.y);
      return;
    }

    // Normal notes: ball stays on the current notehead
    if (n.x == null) return;
    play.ballX = n.x;
    t.drawBall(n.x, n.y);
  }

  /**
   * Computer sings at tempo (Play ▶), or a drag-selected range.
   * Start note = last clicked note (play.startIndex), or an explicit range.
   * When a run finishes/pauses, startIndex resets to 0 so the next Play goes
   * from the beginning unless the user clicks a note (or drags) first.
   * @param {{ startIndex?: number, endIndex?: number }} opts
   */
  async function startListenRun(opts) {
    const t = trainer();
    if (!t || !t.notes || !t.notes.length) {
      alert("No score yet — wait until notes are ready, then try Play again.");
      return;
    }
    // Snapshot start immediately (opts win); don't let later UI clear it
    const requestedStart =
      opts && opts.startIndex != null ? opts.startIndex : play.startIndex || 0;
    const requestedEnd = opts && opts.endIndex != null ? opts.endIndex : null;

    // Tear down free-follow / leftover state so the early-return guard can't stick
    if (play.active && !play.listen) {
      play.active = false;
      play.freeFollow = false;
    }
    if (play.active || play.countdownTimer) return;

    if (play.matchPitch) stopPitchMatch();
    play.freeFollow = false;
    // Relative-mode singer offset must not color computer Play pitch
    resetAnchor();
    resetOctave();

    const live = await ensureAudioLive();
    if (!live.ok || !live.ctx || live.ctx.state !== "running") {
      showAudioBlocked();
      return;
    }
    // Re-check after await — free-follow mic handler may have re-armed
    if (play.active && play.listen) return;
    play.active = false;
    play.freeFollow = false;
    await new Promise((r) => setTimeout(r, 40));

    const tempo = readPlayTempo();
    play.tempo = tempo;
    const startIndex = Math.max(
      0,
      Math.min(requestedStart, t.notes.length - 1)
    );
    const endIndex =
      requestedEnd != null
        ? Math.max(startIndex, Math.min(requestedEnd, t.notes.length - 1))
        : null;
    play.startIndex = startIndex;

    play.listen = true;
    play.freeFollow = false;
    play.timeline = attachRecitGlides(buildTimeline(startIndex, tempo, endIndex));
    if (!play.timeline.length) {
      play.listen = false;
      return;
    }

    if (endIndex != null && t.setStaffHighlightFromNoteRange) {
      t.setStaffHighlightFromNoteRange(startIndex, endIndex);
    }

    t.focusNote(startIndex);
    scrollToNote(t.notes[startIndex]);

    play.active = true;
    play.seg = 0;
    play.runStartMs = performance.now();
    play.ballX = null;
    resetBallSmoothing();
    beginSegment(0);
    setRunUi();
    play.rafId = requestAnimationFrame(tickListen);

    window.dispatchEvent(
      new CustomEvent("trainer:playback", { detail: { playing: true, listen: true } })
    );
  }

  // —— Begin: free-time chant follow ——

  /** Written notehead y — rest / target position when not voicing. */
  function noteHeadY(n) {
    if (!n) return null;
    if (n.y != null) return n.y;
    return bottomLineY(n);
  }

  /**
   * Draw the ball for free-follow.
   * x is always the current notehead; y follows pitch when singing, else notehead.
   * No horizontal glide between notes — ever.
   */
  function freeFollowPaint(n, y, now) {
    const t = trainer();
    if (!n || n.x == null) return;
    if (t.pageNum != null && n.pdfPage !== t.pageNum) return;
    const targetY = y != null ? y : noteHeadY(n);
    const painted = smoothBallY(targetY, now);
    if (painted != null) {
      play.ballX = n.x;
      t.drawBall(n.x, painted);
    }
  }

  /** Celebrate a successful note, then jump the ball to the next (no glide). */
  function completeAndAdvance() {
    if (play.advancing) return;
    const t = trainer();
    if (!t || !play.active || !play.freeFollow) return;

    const i = t.currentNoteIndex;
    const prev = t.notes[i];
    play.advancing = true;

    // Singer’s green hold sets/updates the pace unit for later notes
    calibrateFromHold(prev, play.inTuneMs);

    // Success feedback: ring + green pulse
    t.completed.add(i);
    if (t.burstAt) t.burstAt(i);
    if (t.setBallColor) t.setBallColor("green");
    if (t.setHalo) t.setHalo(true);
    if (t.setBallScale) t.setBallScale(1.55);
    freeFollowPaint(prev, noteHeadY(prev), performance.now());

    const runId = play.runId;
    setTimeout(() => {
      if (runId !== play.runId) return;
      if (t.setBallScale) t.setBallScale(1);
      if (t.setHalo) t.setHalo(false);

      const next = i + 1;
      resetFreeAccum();
      resetOctave();
      resetBallSmoothing();

      if (next >= t.notes.length) {
        stopPlayback();
        return;
      }

      t.focusNote(next);
      play.needHoldMs = requiredHoldMs(t.notes[next]);
      if (!sameStaff(prev, t.notes[next])) scrollToNote(t.notes[next]);
      if (t.setBallColor) t.setBallColor("neutral");
      // Jump: appear on the next notehead
      freeFollowPaint(t.notes[next], noteHeadY(t.notes[next]), performance.now());
      play.advancing = false;
    }, ADVANCE_PAUSE_MS);
  }

  /**
   * Begin: hear the starting note → countdown → sing immediately (no second play).
   * Order: prepare by ear, then 3-2-1, then free pitch follow.
   */
  async function startSingRun() {
    const t = trainer();
    if (!t || !t.notes || !t.notes.length) return;
    if (play.active || play.countdownTimer) return;

    // Every Begin press: leave pitch-match, re-arm audio, turn mic on
    if (play.matchPitch) play.matchPitch = false;
    play.preparingBegin = true;
    setRunUi();
    ensureMicOnForPractice();
    const live = await ensureAudioLive();
    if (!live.ok || !live.ctx || live.ctx.state !== "running") {
      play.preparingBegin = false;
      setRunUi();
      showAudioBlocked();
      return;
    }
    await new Promise((r) => setTimeout(r, 80));

    const startIndex = Math.max(0, Math.min(play.startIndex, t.notes.length - 1));
    const first = t.notes[startIndex];

    play.listen = false;
    play.freeFollow = false;
    play.timeline = [];
    play.runId += 1;
    const runId = play.runId;
    resetCalibration(); // new Begin run: learn pace from this singer
    if (typeof t.clearCompleted === "function") t.clearCompleted();
    else if (t.completed) t.completed.clear();
    setRunUi();

    t.focusNote(startIndex);
    scrollToNote(first);
    if (t.setBallColor) t.setBallColor("neutral");
    freeFollowPaint(first, noteHeadY(first), performance.now());

    // 1) Hear the target note first (fixed short preview — not a tempo/hold cue)
    const firstDur = Math.max(500, Math.min(900, 550 * noteUnits(first)));
    if (first.midi != null) {
      playSingleTone(first, firstDur);
    }
    await new Promise((r) => setTimeout(r, firstDur + TONE_TAIL_MS + 40));
    if (runId !== play.runId) {
      play.preparingBegin = false;
      setRunUi();
      return;
    }

    // 2) Countdown to prepare (fixed ticks — not a tempo slider)
    const counted = await countdown(COUNTDOWN_TICK_MS);
    if (!counted || runId !== play.runId) {
      play.preparingBegin = false;
      setRunUi();
      return;
    }

    // Re-arm audio after the wait (Safari can suspend during countdown)
    if (window.AppAudio && typeof window.AppAudio.wake === "function") {
      await window.AppAudio.wake();
    }

    // 3) Start singing immediately — do not play the note again
    play.active = true;
    play.freeFollow = true;
    play.listen = false;
    play.preparingBegin = false;
    play.seg = -1;
    resetFreeAccum();
    resetOctave();
    resetBallSmoothing();
    play.needHoldMs = requiredHoldMs(currentNote() || first);
    setRunUi();

    if (t.setBallScale) {
      t.setBallScale(1.35);
      clearTimeout(play.emphasisTimer);
      play.emphasisTimer = setTimeout(() => t.setBallScale(1), 900);
    }

    freeFollowPaint(currentNote() || first, noteHeadY(first), performance.now());

    window.dispatchEvent(
      new CustomEvent("trainer:playback", { detail: { playing: true, listen: false } })
    );
  }

  function stopPlayback() {
    const wasActive = play.active || !!play.countdownTimer;
    const wasFree = play.freeFollow;
    const wasListen = play.listen;
    play.runId += 1; // cancel any async Begin wait
    play.active = false;
    play.freeFollow = false;
    play.listen = false;
    play.preparingBegin = false;
    if (play.rafId) cancelAnimationFrame(play.rafId);
    play.rafId = 0;
    if (play.cancelCountdown) play.cancelCountdown();
    if (play.countdownTimer) {
      clearInterval(play.countdownTimer);
      play.countdownTimer = 0;
    }
    play.countdownTimer = 0;
    play.cancelCountdown = null;
    clearTimeout(play.emphasisTimer);
    showCount(null);
    stopTones();
    play.timeline = [];
    play.seg = -1;
    resetFreeAccum();
    // After a Play / drag-select run ends (or is paused), the next Play without a
    // new note click starts from the beginning of the piece. Click a note first
    // (or drag a range) to start elsewhere.
    if (wasListen) {
      play.startIndex = 0;
    }
    const t = trainer();
    if (t && t.setBallScale) t.setBallScale(1);
    if (t && t.setHalo) t.setHalo(false);
    if (t && t.setBallColor) t.setBallColor("neutral");
    if (wasFree && t && typeof t.clearCompleted === "function") t.clearCompleted();
    else if (wasFree && t && t.completed) {
      t.completed.clear();
    }
    // Clear drag-select staff highlight when computer play ends
    if (wasListen && t && typeof t.clearStaffHighlight === "function") {
      t.clearStaffHighlight();
    }
    setRunUi();
    // Leave the orange click-highlight whenever playback ends
    clearSeekHighlight();
    if (wasActive) {
      window.dispatchEvent(new CustomEvent("trainer:playback", { detail: { playing: false } }));
    }
    // After computer Play (or drag-select), resume free-follow if mic is on
    if (wasListen && micIsOn() && scoreReady()) {
      armFreeFollowFromCurrent();
    }
  }

  function micIsOn() {
    const sw = el("mic-switch");
    if (sw) return !!sw.checked;
    const mic = el("mic-btn");
    return !!(mic && mic.getAttribute("aria-pressed") === "true");
  }

  /** Start free-follow practice from the current note (no countdown). */
  function armFreeFollowFromCurrent() {
    const t = trainer();
    if (!t || !t.notes || !t.notes.length) return;
    if (play.listen || play.countdownTimer) return;
    if (window.diagnose && window.diagnose.isOn && window.diagnose.isOn()) {
      // Assess handles its own listening
      return;
    }
    play.matchPitch = false;
    play.active = true;
    play.freeFollow = true;
    play.listen = false;
    play.preparingBegin = false;
    resetFreeAccum();
    resetOctave();
    const n = currentNote() || t.notes[0];
    play.needHoldMs = requiredHoldMs(n);
    if (n) freeFollowPaint(n, noteHeadY(n), performance.now());
    setRunUi();
    window.dispatchEvent(
      new CustomEvent("trainer:playback", { detail: { playing: true, listen: false } })
    );
  }

  // —— Match Pitch mode ——

  function resetMatchHold() {
    play.matchHoldMs = 0;
    play.matchWon = false;
    play.matchLastFrameMs = 0;
  }

  /** Short ascending chime so success is obvious. */
  function playSuccessChime() {
    unlockAudio();
    whenAudioRunning((ctx) => {
      if (!ctx || ctx.state !== "running") return;
      stopTones();
      const t0 = ctx.currentTime + 0.02;
      // C5 → E5 → G5, cheerful and brief
      scheduleTone(ctx, 72, t0, t0 + 0.11);
      scheduleTone(ctx, 76, t0 + 0.1, t0 + 0.22);
      scheduleTone(ctx, 79, t0 + 0.2, t0 + 0.38);
    });
  }

  function celebrateMatchSuccess(n) {
    const t = trainer();
    if (!t || !n) return;
    play.matchWon = true;
    play.matchHoldMs = MATCH_PITCH_HOLD_MS;
    if (t.burstAt && t.currentNoteIndex != null) t.burstAt(t.currentNoteIndex);
    if (t.setBallColor) t.setBallColor("green");
    if (t.setHalo) t.setHalo(true);
    if (t.setBallScale) t.setBallScale(1.65);
    freeFollowPaint(n, noteHeadY(n), performance.now());
    playSuccessChime();
    // Hold the “you got it” pose, then settle still green/won
    clearTimeout(play.emphasisTimer);
    play.emphasisTimer = setTimeout(() => {
      if (!play.matchPitch || !play.matchWon) return;
      if (t.setBallScale) t.setBallScale(1);
      if (t.setHalo) t.setHalo(false);
      freeFollowPaint(n, noteHeadY(n), performance.now());
    }, 700);
  }

  function stopPitchMatch() {
    if (!play.matchPitch) return;
    play.matchPitch = false;
    resetMatchHold();
    ensureMicOff();
    const t = trainer();
    if (t && t.setHalo) t.setHalo(false);
    if (t && t.setBallColor) t.setBallColor("neutral");
    if (t && t.setBallScale) t.setBallScale(1);
    clearSeekHighlight();
    setRunUi();
  }

  function startPitchMatch() {
    // Leave Begin / Play if needed; keep match mode exclusive
    if (play.active || play.countdownTimer || play.preparingBegin) {
      stopPlayback();
    }
    play.matchPitch = true;
    resetMatchHold();
    resetAnchor(); // Match Pitch uses written pitch only
    resetOctave();
    setRunUi();
  }

  /** Click Match Pitch to turn on; click again (or Escape) to turn off. */
  function togglePitchMatch() {
    if (play.matchPitch) stopPitchMatch();
    else startPitchMatch();
  }

  /**
   * In Match Pitch: jump to a note, play it, keep mic on for pitch matching.
   * Re-clicking the same note after a win lets you try again.
   */
  function pitchMatchSelect(i) {
    const t = trainer();
    if (!t || i < 0 || !t.notes[i]) return;
    const n = t.notes[i];
    play.startIndex = i;
    t.focusNote(i);
    scrollToNote(n);
    resetOctave();
    // Don't carry a relative-mode transposition into Match Pitch or the cue tone
    resetAnchor();
    resetBallSmoothing();
    resetMatchHold(); // new attempt (or new note)
    if (t.setBallColor) t.setBallColor("neutral");
    if (t.setHalo) t.setHalo(false);
    if (t.setBallScale) t.setBallScale(1);
    freeFollowPaint(n, noteHeadY(n), performance.now());
    unlockAudio();
    playSingleTone(n);
    ensureMicOnForPractice();
    setRunUi();
  }

  function toggleListen() {
    if (play.active && play.listen) {
      stopPlayback();
      return;
    }
    // Capture start before any other cleanup (selection must survive the click)
    const start = hasPlayStartSelection() ? play.startIndex | 0 : 0;
    // Always force a clean listen start (free-follow may leave active true)
    if (play.active || play.freeFollow || play.countdownTimer || play.preparingBegin) {
      play.active = false;
      play.freeFollow = false;
      play.listen = false;
      play.preparingBegin = false;
      if (play.rafId) {
        cancelAnimationFrame(play.rafId);
        play.rafId = 0;
      }
      if (play.cancelCountdown) play.cancelCountdown();
      if (play.countdownTimer) {
        clearInterval(play.countdownTimer);
        play.countdownTimer = 0;
      }
    }
    if (play.matchPitch) stopPitchMatch();
    // Play All from 0, or Play Starting Here from the last clicked note
    startListenRun({ startIndex: start }).catch((e) => console.error("Play", e));
  }

  /** Alias for ?selftest=2 — free-follow Begin. */
  function beginPlayback() {
    return startSingRun();
  }

  // —— Pitch stream ——

  function updateAnchor(midiFloat, now, target) {
    const fr = follow.anchorFrames;
    fr.push({ t: now, m: midiFloat });
    while (fr.length && now - fr[0].t > 700) fr.shift();
    if (!fr.length || now - fr[0].t < 500) return false;
    const ms = fr.map((f) => f.m);
    const span = Math.max(...ms) - Math.min(...ms);
    if (span > 1.0) {
      follow.anchorFrames = fr.slice(-3);
      return false;
    }
    const mid = ms.slice().sort((a, b) => a - b)[Math.floor(ms.length / 2)];
    follow.offset = Math.round(mid - target.midi);
    follow.anchored = true;
    return true;
  }

  function centsToTarget(sung, targetMidi) {
    return Math.abs((sung - targetMidi) * 100);
  }

  /**
   * Green only when close to the *current* target AND closer to it than to the
   * previous note’s pitch. Prevents “I nudged slightly toward the next step
   * and it counted as that note” when notes are a half/whole step apart
   * (with ~50¢ tolerance, halfway to a half-step already looks “in tune”).
   */
  function isClearlyOnTarget(sungMidi, targetMidi, prevMidi, sensCents) {
    const cents = Math.abs(sungMidi - targetMidi) * 100;
    if (cents > sensCents) return false;
    if (prevMidi != null && Number.isFinite(prevMidi)) {
      const step = Math.abs(targetMidi - prevMidi);
      // Only apply when previous note is a nearby different pitch
      if (step >= 0.4 && step <= 5) {
        const dTarget = Math.abs(sungMidi - targetMidi);
        const dPrev = Math.abs(sungMidi - prevMidi);
        // Must be clearly nearer target than previous (margin ~8¢)
        if (dTarget + 0.08 >= dPrev) return false;
      }
    }
    return true;
  }

  function onPitch(midiFloat, clarity) {
    const t = trainer();
    if (!t) return;

    // Never score/react to our own speaker tones
    if (tonesActive()) return;

    t.lastPitch = { midi: midiFloat, clarity, t: performance.now() };

    // Play mode ignores mic entirely
    if (play.active && play.listen) return;
    // Freeze pitch handling while we celebrate a completed note
    if (play.advancing) return;

    const n = currentNote();
    if (!n) return;

    const now = performance.now();

    // Match Pitch: already won this note — park on success until they re-click
    if (play.matchPitch && play.matchWon) {
      if (t.setBallColor) t.setBallColor("green");
      freeFollowPaint(n, noteHeadY(n), now);
      return;
    }

    if (midiFloat == null) {
      play.pitchY = null;
      play.lastFrameMs = 0;
      play.matchLastFrameMs = 0;
      // Consonants: stop accumulating, but do NOT erase green progress already earned
      if (t.setHalo) t.setHalo(false);
      if (t.setBallColor) t.setBallColor("neutral");
      freeFollowPaint(n, noteHeadY(n), now);
      return;
    }

    // Match Pitch / free-follow use written pitch + user Transpose.
    // Relative-mode anchor is only for free practice — never for Match Pitch.
    const relativeMode = t.mode === "relative" && !play.matchPitch;
    if (relativeMode && !follow.anchored) updateAnchor(midiFloat, now, n);
    const relOffset = relativeMode && follow.anchored ? follow.offset : 0;
    const transpose = play.transposeSemis || 0;
    const offset = relOffset + transpose;

    const targetMidi = n.midi + offset;
    const noteKey = n.globalIndex != null ? n.globalIndex : n.x;
    const fold = stableFold(midiFloat, targetMidi, now, noteKey);
    const sung = midiFloat - 12 * fold;

    const fifths = (n.keySig && n.keySig.fifths) || 0;
    // Ball staff position uses score degrees only (transpose is register, not staff step)
    const step = ballStep(sung, n, fifths, relOffset);
    const y = stepToY(step, n.staffLineYs, n.staffSpacing || 4.32);
    play.pitchY = y;
    play.lastVoicedMs = now;

    // Slightly tighter default than half a step (50¢) so adjacent notes don't bleed
    const sens = Math.min(t.sensitivityCents || 40, 42);
    const cents = centsToTarget(sung, targetMidi);
    // Previous note pitch (for "closer to target than previous" gate)
    // In Match Pitch there is no “previous score note” gate — only hit this pitch.
    let prevMidi = null;
    if (!play.matchPitch && t.currentNoteIndex > 0 && t.notes[t.currentNoteIndex - 1]) {
      const pn = t.notes[t.currentNoteIndex - 1];
      if (pn.midi != null) prevMidi = pn.midi + offset;
    }
    const inTune = isClearlyOnTarget(sung, targetMidi, prevMidi, sens);
    // Ball color still shows raw distance; green only when clearly on target
    if (inTune) setBallColorFromCents(0, sens);
    else setBallColorFromCents(cents, sens);
    if (t.setHalo) t.setHalo(inTune);

    // Ball stays over this note's x; y shows how high/low you are
    freeFollowPaint(n, y, now);

    // Click a note (mic off) = pitch match only (ball feedback, no advance)
    // Mic on + freeFollow = practice advance
    if (play.matchPitch) {
      const dt = play.matchLastFrameMs
        ? Math.min(now - play.matchLastFrameMs, MAX_FRAME_MS)
        : 0;
      play.matchLastFrameMs = now;
      if (dt > 0 && inTune) {
        play.matchHoldMs += dt;
        if (play.matchHoldMs >= MATCH_PITCH_HOLD_MS) {
          celebrateMatchSuccess(n);
        }
      }
      return;
    }

    if (!play.active || !play.freeFollow) return;

    const dt = play.lastFrameMs ? Math.min(now - play.lastFrameMs, MAX_FRAME_MS) : 0;
    play.lastFrameMs = now;
    if (dt <= 0) return;

    play.voicedMs += dt;
    if (inTune) {
      play.inTuneMs += dt;
    }
    // Off pitch: freeze the green accumulator (don't decay to zero on every wobble)

    if (!play.needHoldMs) play.needHoldMs = requiredHoldMs(n);

    // Held green for this note’s relative length → advance (first note calibrates pace)
    if (play.inTuneMs >= play.needHoldMs) {
      completeAndAdvance();
    }
  }

  // —— Click-to-seek: always plays the note ——

  function isRecit(n) {
    return !!n && (n.type === "recit" || n.glyph === "recit");
  }

  /**
   * Horizontal extent of a note in PDF points, as [x0, x1].
   *
   * An ordinary notehead is a point. A reciting tone is not: one glyph carries
   * a whole clause, so it occupies the staff from its own x up to the next
   * note on that staff (or the staff's right edge if it is the last). Treating
   * it as a point is why the pointer "fell through" the blank stretch and
   * neither click nor drag could catch it.
   */
  function noteSpanX(i) {
    const t = trainer();
    const n = t.notes[i];
    if (!n || n.x == null) return null;
    if (!isRecit(n)) return [n.x, n.x];

    // Stop just short of the next notehead so that note keeps ownership of its
    // own position — otherwise clicking it would select the recitation instead.
    const margin = (n.staffSpacing || 4.32) * 1.5;
    for (let k = i + 1; k < t.notes.length; k++) {
      const m = t.notes[k];
      if (m.pageIndex !== n.pageIndex || m.staffIndex !== n.staffIndex) break;
      if (m.x != null && m.x > n.x) return [n.x, Math.max(n.x, m.x - margin)];
    }
    const end = n.staffXEnd != null ? n.staffXEnd : n.x + RECIT_FALLBACK_SPAN_PT;
    return [n.x, Math.max(end, n.x)];
  }

  /** Distance in css px from `cssX` to a note's horizontal span (0 if inside). */
  function distToSpanX(i, cssX, scale) {
    const span = noteSpanX(i);
    if (!span) return Infinity;
    const x0 = span[0] * scale;
    const x1 = span[1] * scale;
    if (cssX < x0) return x0 - cssX;
    if (cssX > x1) return cssX - x1;
    return 0;
  }

  /** Vertical band a staff occupies, including the lyric line beneath it. */
  function staffBandCss(n, scale) {
    const sp = n.staffSpacing || 4.32;
    const ys = n.staffLineYs;
    if (!ys || ys.length !== 5) return null;
    return [(ys[0] - sp * 2) * scale, (ys[4] + sp * 5) * scale];
  }

  function nearestNoteToPoint(cssX, cssY) {
    const t = trainer();
    if (!t || !t.notes || !t.notes.length) return -1;
    const scale = window.pdfScale || 1;
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < t.notes.length; i++) {
      const n = t.notes[i];
      if (n.pdfPage !== t.pageNum || n.x == null || n.y == null) continue;
      // Measure x against the note's span, so anywhere over a recitation's
      // stretch of words counts as being on that note.
      const dx = distToSpanX(i, cssX, scale);
      const dy = n.y * scale - cssY;
      const d = Math.hypot(dx, dy * 0.85);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    let radius = SEEK_RADIUS_PX;
    if (best >= 0 && isRecit(t.notes[best])) radius = SEEK_RADIUS_PX * 1.6;
    return bestDist <= radius ? best : -1;
  }

  /**
   * Looser hit test used while dragging a selection.
   *
   * Sweeping the pointer across a staff should keep extending the selection
   * even over blank stretches and along the lyric line, so staff proximity
   * dominates and the nearest note by x wins within it. Without this a drag
   * across a recitation simply stopped extending.
   */
  function dragNoteAt(cssX, cssY) {
    const t = trainer();
    if (!t || !t.notes || !t.notes.length) return -1;
    const scale = window.pdfScale || 1;
    let best = -1;
    let bestScore = Infinity;
    for (let i = 0; i < t.notes.length; i++) {
      const n = t.notes[i];
      if (n.pdfPage !== t.pageNum || n.x == null) continue;
      const band = staffBandCss(n, scale);
      let dy;
      if (band) dy = cssY < band[0] ? band[0] - cssY : cssY > band[1] ? cssY - band[1] : 0;
      else dy = n.y != null ? Math.abs(n.y * scale - cssY) : 0;
      const dx = distToSpanX(i, cssX, scale);
      // Staff proximity dominates so the drag doesn't jump between systems.
      const score = dy * 4 + dx;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
    return best;
  }

  function seekTo(i) {
    const t = trainer();
    if (!t || i < 0 || !t.notes[i]) return;

    // Match Pitch mode: dedicated select + hold-to-success
    if (play.matchPitch) {
      pitchMatchSelect(i);
      return;
    }

    // Stop computer playback if running
    if (play.listen) stopPlayback();

    const n = t.notes[i];
    play.startIndex = i;
    t.focusNote(i);
    scrollToNote(n);
    if (t.setBallColor) t.setBallColor("neutral");
    resetBallSmoothing();
    resetOctave();
    resetFreeAccum();
    freeFollowPaint(n, noteHeadY(n), performance.now());

    unlockAudio();
    playSingleTone(n);
    setRunUi(); // Play All → Play Starting Here

    // If mic is on, free-follow continues from this note after the cue tone
    if (micIsOn() && scoreReady()) {
      const resume = () => {
        if (play.listen || play.matchPitch) return;
        armFreeFollowFromCurrent();
      };
      setTimeout(resume, HEAR_NOTE_MS + TONE_TAIL_MS + 30);
    }
  }

  // —— Drag-select notes → yellow staff + play at tempo ——
  const dragSel = {
    active: false,
    startI: -1,
    endI: -1,
    moved: false,
    pointerId: null,
  };

  function updateDragHighlight() {
    const t = trainer();
    if (!t || !t.setStaffHighlightFromNoteRange) return;
    if (dragSel.startI < 0 || dragSel.endI < 0) {
      t.clearStaffHighlight && t.clearStaffHighlight();
      return;
    }
    t.setStaffHighlightFromNoteRange(dragSel.startI, dragSel.endI);
  }

  function onStagePointerDown(e) {
    const wrap = el("canvas-wrap");
    if (!wrap || wrap.hidden) return;
    if (e.button != null && e.button !== 0) return;
    const rect = wrap.getBoundingClientRect();
    let i = nearestNoteToPoint(e.clientX - rect.left, e.clientY - rect.top);

    // Page shown before notes extracted: kick extraction and retry once
    if (i < 0 && window.trainer) {
      const page = window.trainer.pageNum;
      const notes = window.trainer.notes || [];
      const hasPageNotes = notes.some((n) => n && n.pdfPage === page);
      if (!hasPageNotes && typeof window.trainer.ensurePageNotes === "function") {
        window.trainer.ensurePageNotes(page).then(() => {
          const j = nearestNoteToPoint(e.clientX - rect.left, e.clientY - rect.top);
          if (j >= 0) {
            // Re-dispatch as a synthetic seek on the note that just appeared
            if (
              window.diagnose &&
              window.diagnose.isOn &&
              window.diagnose.isOn() &&
              typeof window.diagnose.handleNoteClick === "function"
            ) {
              window.diagnose.handleNoteClick(j);
            } else {
              seekTo(j);
            }
          }
        });
        return;
      }
    }

    // Assess mode may consume the click
    if (
      window.diagnose &&
      typeof window.diagnose.handleNoteClick === "function" &&
      window.diagnose.isOn &&
      window.diagnose.isOn()
    ) {
      if (i >= 0) {
        const consumed = window.diagnose.handleNoteClick(i);
        if (consumed) return;
        // still allow seek for note preview when assess doesn't consume
        seekTo(i);
      }
      return;
    }

    // Click empty score area → clear orange note highlight
    if (i < 0) {
      clearSeekHighlight();
      return;
    }
    dragSel.active = true;
    dragSel.startI = i;
    dragSel.endI = i;
    dragSel.moved = false;
    dragSel.pointerId = e.pointerId;
    try {
      wrap.setPointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    updateDragHighlight();
    e.preventDefault();
  }

  function onStagePointerMove(e) {
    if (!dragSel.active) return;
    const wrap = el("canvas-wrap");
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    // Looser than the click test: a drag should keep extending across blank
    // stretches (recitations) and along the lyric line.
    const j = dragNoteAt(e.clientX - rect.left, e.clientY - rect.top);
    if (j < 0) return;
    if (j !== dragSel.endI) {
      dragSel.endI = j;
      if (j !== dragSel.startI) dragSel.moved = true;
      updateDragHighlight();
    }
  }

  function onStagePointerUp(e) {
    if (!dragSel.active) return;
    const wrap = el("canvas-wrap");
    if (wrap && dragSel.pointerId != null) {
      try {
        wrap.releasePointerCapture(dragSel.pointerId);
      } catch (_) {
        /* ignore */
      }
    }
    const a = Math.min(dragSel.startI, dragSel.endI);
    const b = Math.max(dragSel.startI, dragSel.endI);
    const moved = dragSel.moved && a !== b;
    dragSel.active = false;
    dragSel.pointerId = null;

    if (moved && a >= 0 && b >= 0) {
      // Drag-select: play this stretch at the Play Notes tempo
      unlockAudio();
      if (play.active || play.countdownTimer) stopPlayback();
      play.startIndex = a;
      startListenRun({ startIndex: a, endIndex: b }).catch((err) =>
        console.error("drag play", err)
      );
    } else if (a >= 0) {
      // Single click: hear note + free-follow if mic on
      if (trainer() && trainer().clearStaffHighlight) trainer().clearStaffHighlight();
      seekTo(a);
    }
    dragSel.startI = -1;
    dragSel.endI = -1;
    dragSel.moved = false;
  }

  function install() {
    if (!window.trainer) {
      setTimeout(install, 50);
      return;
    }
    window.trainer.onPitch = onPitch;

    // Close Sound & Mic / Score dropdowns when clicking outside; clear note highlight on empty click
    if (typeof document.addEventListener === "function") {
      document.addEventListener("pointerdown", (e) => {
        const uploadSaveMenu = el("upload-save-menu");
        const uploadSavePanel = el("upload-save-panel");
        if (
          uploadSaveMenu &&
          uploadSavePanel &&
          !uploadSavePanel.hidden &&
          e.target &&
          uploadSaveMenu.contains &&
          !uploadSaveMenu.contains(e.target)
        ) {
          uploadSavePanel.hidden = true;
          const st = el("upload-save-toggle");
          if (st) {
            st.setAttribute("aria-expanded", "false");
            st.classList.remove("is-open");
          }
        }
        const toolsMenu = el("tools-menu");
        if (
          toolsMenu &&
          toolsMenu.classList.contains("is-open") &&
          e.target &&
          toolsMenu.contains &&
          !toolsMenu.contains(e.target)
        ) {
          // Assess panels can sit slightly outside the menu box
          const inDiag =
            typeof e.target.closest === "function" &&
            e.target.closest(".diag-ui, .diag-panel, .diag-action-dock, .diag-report-panel");
          if (!inDiag) {
            toolsMenu.classList.remove("is-open");
            const tt = el("tools-toggle");
            if (tt) {
              tt.classList.remove("is-open");
              tt.setAttribute("aria-expanded", "false");
            }
          }
        }
        // Clear note highlight only for empty background — never when pressing
        // toolbar controls (Play / Match Pitch / menus). Clearing on Play’s
        // pointerdown was rewriting the button and cancelling the click.
        const wrap = el("canvas-wrap");
        const onScore = wrap && !wrap.hidden && e.target && wrap.contains(e.target);
        const onToolbar =
          e.target &&
          typeof e.target.closest === "function" &&
          e.target.closest(
            ".toolbar, .page-bar, .diag-ui, .play-menu-panel, .tools-panel, .tools-menu, .sound-status-panel, .help-modal, .lit-cal-modal"
          );
        if (!onScore && !onToolbar) {
          clearSeekHighlight();
        }
      });
    }

    const playBtn = el("play-btn");
    if (playBtn) {
      playBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        unlockAudio();
        toggleListen();
      });
    }

    const matchBtn = el("match-pitch-btn");
    if (matchBtn) {
      matchBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        unlockAudio();
        togglePitchMatch();
      });
    }

    // Escape always exits Match Pitch
    if (typeof document.addEventListener === "function") {
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && play.matchPitch) {
          e.preventDefault();
          stopPitchMatch();
        }
      });
    }

    // Mic on → free-follow practice; mic off → stop free-follow
    window.addEventListener("trainer:mic", (e) => {
      const on = !!(e.detail && e.detail.on);
      if (on && scoreReady() && !play.listen) {
        armFreeFollowFromCurrent();
      } else if (!on && play.freeFollow) {
        play.active = false;
        play.freeFollow = false;
        setRunUi();
      }
    });

    const soundStatusCollapse = el("sound-status-collapse");
    if (soundStatusCollapse) {
      soundStatusCollapse.addEventListener("click", (e) => {
        e.stopPropagation();
        setSoundStatusOpen(false);
      });
    }

    const enableSoundBtn = el("enable-sound-btn");
    if (enableSoundBtn) {
      // Use click only (not pointerdown) so we don't double-fire; this is the real unlock gesture
      enableSoundBtn.addEventListener("click", enableSoundClick);
    }
    if (window.AppAudio && typeof window.AppAudio.onStatus === "function") {
      window.AppAudio.onStatus((st) => {
        // Never auto-claim “Sound On” just because the context is running —
        // Safari often says running while still silent. Only forceEnable confirms.
        if (st && st.userConfirmed) return;
        if (st && st.state && st.state !== "running" && st.state !== "none") {
          updateSoundUi(
            false,
            "Sound was paused (tab was in the background or idle). Open <strong>Settings</strong> and press <strong>Turn Sound On</strong>."
          );
        }
      });
    }
    // No permanent banner on load — only show the floating box when needed
    setSoundStatusOpen(false);

    // Tempo slider (computer Play only)
    const tempoSlider = el("tempo-slider");
    if (tempoSlider) {
      syncTempoUi(tempoSlider.value);
      tempoSlider.addEventListener("input", () => {
        syncTempoUi(tempoSlider.value);
      });
    } else {
      syncTempoUi(PLAY_TEMPO_DEFAULT);
    }

    // Transpose on the main bar; release plays first three notes at new pitch
    const transposeSlider = el("transpose-slider");
    if (transposeSlider) {
      syncTransposeUi(transposeSlider.value);
      transposeSlider.addEventListener("input", () => {
        syncTransposeUi(transposeSlider.value);
      });
      transposeSlider.addEventListener("change", () => {
        syncTransposeUi(transposeSlider.value);
        previewTranspose();
      });
    } else {
      syncTransposeUi(0);
    }

    const wrap = el("canvas-wrap");
    if (wrap) {
      wrap.addEventListener("pointerdown", onStagePointerDown);
      wrap.addEventListener("pointermove", onStagePointerMove);
      wrap.addEventListener("pointerup", onStagePointerUp);
      wrap.addEventListener("pointercancel", onStagePointerUp);
    }

    window.addEventListener("trainer:mode", resetAnchor);
    window.addEventListener("trainer:mic", resetAnchor);
    window.addEventListener("trainer:score", (e) => {
      // Progressive extract merges more pages without interrupting a run
      if (e.detail && e.detail.partial) {
        setRunUi(); // may reveal Play Notes once first notes exist
        return;
      }
      play.startIndex = 0;
      stopPlayback();
      resetOctave();
      resetBallSmoothing();
      resetFreeAccum();
      resetCalibration();
      setRunUi();
    });

    setRunUi();
  }
  install();

  window.followPlayback = {
    play,
    beginPlayback,
    startRun: (listen) => (listen ? startListenRun() : startSingRun()),
    stopPlayback,
    seekTo,
    onPitch,
    buildTimeline,
    durationMs,
    syllableCount,
    noteUnits,
    requiredHoldMs,
    calibrateFromHold,
    hearNote: () => {
      const n = currentNote();
      if (n && n.midi != null) playSingleTone(n);
    },
    /** Play a specific score note as a short pitch cue (Assess “Sing section”). */
    playNoteCue: (note, durMs) => {
      if (!note || note.midi == null) return false;
      // Always one clean pitch — never syllable pulses (was causing double/triple cues)
      return playSingleTone(Number(note.midi), durMs || 700, { forceSingle: true });
    },
    pulseCountForNote,
    scheduleMidiPulses,
    noteSpanX,
    nearestNoteToPoint,
    dragNoteAt,
    tonesActive,
    blankMicFor,
    resetBallSmoothing,
    stableFold,
    smoothBallY,
    resetOctave,
    resetFinder: resetFreeAccum,
    resetCalibration,
    bottomLineY,
    setPracticeMode: () => {
      /* removed */
    },
    /** Kept for tests: sets computer-Play timeline speed only. */
    setTempo: (v) => {
      syncTempoUi(v);
    },
  };

  // ===================================================================
  // Self-tests
  // ===================================================================
  const selftest =
    (typeof location !== "undefined" && /[?&]selftest=(\d)/.exec(location.search)) || null;
  if (selftest) {
    const mode = Number(selftest[1]);
    const banner = document.createElement("div");
    banner.className = "selftest-banner";
    banner.textContent = "Self-test: waiting for score…";
    document.body.appendChild(banner);

    const pass = (msg) => {
      banner.textContent = "PASS — " + msg;
      banner.style.background = "#1c4430";
    };
    const fail = (msg) => {
      banner.textContent = "FAIL — " + msg;
      banner.style.background = "#5a1c1c";
    };

    const waitScore = setInterval(() => {
      const t = window.trainer;
      if (!t || !t.notes || !t.notes.length) return;
      clearInterval(waitScore);
      const run =
        mode === 3 ? runFreeFollowTest : mode === 2 ? runPlayTest : runFollowTest;
      run(t, banner, pass, fail).catch((e) =>
        fail("error: " + (e && e.message ? e.message : e))
      );
    }, 200);
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runFollowTest(t, banner, pass, fail) {
    const first = t.notes[0];
    const line = t.notes.filter((n) => sameStaff(n, first));
    banner.textContent = `Self-test 1: tracking ${line.length} notes of the first staff…`;

    for (const n of line) {
      t.focusNote(n.globalIndex);
      resetBallSmoothing();
      for (let k = 0; k < 15; k++) {
        onPitch(n.midi + (Math.random() - 0.5) * 0.4, 0.97);
        await sleep(20);
      }
      const ball = t.ball;
      const want = stepToY(n.step, n.staffLineYs, n.staffSpacing || 4.32);
      if (!ball || want == null || Math.abs(ball.y - want) > (n.staffSpacing || 4.32) * 0.5) {
        fail(
          `ball off target at note ${n.globalIndex}: ` +
            `y=${ball ? ball.y.toFixed(2) : "none"} want≈${want == null ? "?" : want.toFixed(2)}`
        );
        return;
      }
      onPitch(null, 0);
      await sleep(20);
    }
    pass(`ball tracked all ${line.length} notes of the first staff.`);
  }

  /** ?selftest=2 — Play mode timeline (computer sings at tempo). */
  async function runPlayTest(t, banner, pass, fail) {
    window.followPlayback.setTempo(120);
    play.startIndex = 0;
    t.completed.clear();

    const monotonic = { ok: true, detail: "" };
    let lastKey = null;
    let lastX = -Infinity;
    let sawPage2 = false;
    let notesPlayed = 0;
    let stop = false;

    const watch = setInterval(() => {
      if (!play.active) return;
      const seg = play.timeline[play.seg];
      if (!seg) return;
      const key = seg.n.pageIndex + ":" + seg.n.staffIndex;
      if (key !== lastKey) {
        lastKey = key;
        lastX = -Infinity;
      }
      const x = play.ballX;
      if (x != null) {
        if (x < lastX - 0.01) {
          monotonic.ok = false;
          monotonic.detail = `x went ${lastX.toFixed(2)} → ${x.toFixed(2)} on staff ${key}`;
        }
        lastX = Math.max(lastX, x);
      }
      notesPlayed = play.seg + 1;
      if (t.pageNum === 2) {
        if (!sawPage2) sawPage2 = true;
        if (seg.n.pdfPage === 2 && play.seg > 0 && notesPlayed > 3) {
          const idxOnPage2 = play.timeline
            .slice(0, play.seg + 1)
            .filter((s) => s.n.pdfPage === 2).length;
          if (idxOnPage2 >= 3) stop = true;
        }
      }
    }, 16);

    banner.textContent = "Self-test 2: Play mode at 120 bpm through page turn…";
    await startListenRun();

    const t0 = performance.now();
    while (!stop && play.active && performance.now() - t0 < 240000) {
      await sleep(100);
    }

    clearInterval(watch);
    const played = Math.max(1, notesPlayed);
    stopPlayback();

    const problems = [];
    if (!monotonic.ok) problems.push("ball x moved backwards (" + monotonic.detail + ")");
    if (!sawPage2) problems.push("page never turned to 2");

    if (problems.length) fail(problems.join("; "));
    else
      pass(
        `Play mode: ${played} notes, page turned 1→2, ball x monotonic within every staff.`
      );
  }

  /**
   * ?selftest=3 — hold-to-duration Begin: hold each of first 8 pitches in tune
   * for requiredHoldMs (with consonant gaps); then wrong pitch must not advance.
   */
  async function runFreeFollowTest(t, banner, pass, fail) {
    const N = 8;
    if (t.notes.length < N + 1) {
      fail(`score has only ${t.notes.length} notes; need at least ${N + 1}`);
      return;
    }

    play.startIndex = 0;
    t.completed.clear();
    t.focusNote(0);

    play.active = true;
    play.freeFollow = true;
    play.listen = false;
    resetFreeAccum();
    resetCalibration();
    // Fixed unit for a fast automated test
    play.unitMs = 200;
    play.needHoldMs = requiredHoldMs(t.notes[0]);
    resetOctave();
    setRunUi();

    const startIndex = t.currentNoteIndex;
    let voicedSince = performance.now();
    let silentUntil = 0;

    banner.textContent = `Self-test 3: hold-duration free-follow ${N} notes…`;

    const singer = setInterval(() => {
      if (play.advancing) return;
      const now = performance.now();
      const n = t.notes[t.currentNoteIndex];
      if (!n || n.midi == null) return;
      if (now < silentUntil) {
        onPitch(null, 0);
        return;
      }
      if (now - voicedSince > 250) {
        silentUntil = now + 60;
        voicedSince = now + 60;
        onPitch(null, 0);
        return;
      }
      onPitch(n.midi + (Math.random() - 0.5) * 0.25, 0.97);
    }, 20);

    const deadline = performance.now() + 90000;
    while (t.currentNoteIndex < startIndex + N && performance.now() < deadline) {
      await sleep(100);
      banner.textContent =
        `Self-test 3: note ${t.currentNoteIndex - startIndex + 1}/${N}, ` +
        `hold ${Math.round(play.inTuneMs)}/${Math.round(play.needHoldMs)}ms…`;
    }
    clearInterval(singer);

    const advanced = t.currentNoteIndex - startIndex;
    if (advanced < N) {
      fail(`only advanced ${advanced}/${N} notes (hold model)`);
      stopPlayback();
      return;
    }

    banner.textContent = "Self-test 3: 2 s wrong pitch…";
    const held = t.currentNoteIndex;
    const before = t.completed.size;
    const wrong = setInterval(() => {
      const n = t.notes[t.currentNoteIndex];
      if (!n || n.midi == null) return;
      onPitch(n.midi + 5 + (Math.random() - 0.5) * 0.3, 0.97);
    }, 20);
    await sleep(2000);
    clearInterval(wrong);
    onPitch(null, 0);
    stopPlayback();

    if (t.currentNoteIndex !== held) {
      fail(`wrong pitch advanced (${held} → ${t.currentNoteIndex})`);
      return;
    }
    if (t.completed.size !== before) {
      fail(`wrong pitch scored a ring (${before} → ${t.completed.size})`);
      return;
    }

    pass(
      `Hold-duration advance through ${N} notes with rings; wrong pitch advanced nothing.`
    );
  }
})();
