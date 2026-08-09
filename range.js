/**
 * range.js — singer range / tempo estimation (RangeFinder).
 *
 * UI (range-ui.js) calls window.RangeFinder.estimate(frames, scoreJson).
 *
 * Signature (frozen):
 *   estimate(frames, scoreJson) →
 *     { ok: false, reason: string }
 *     | { ok: true, low, high, center, offsetSemitones, voiceHint, tempoBpm, debug? }
 *
 * frames: [{ t (ms), midi (float), clarity }, ...] voiced only
 * scoreJson: app score schema { pages: [{ staves: [{ notes: [{ midi, glyph, type, lyric }] }] }] }
 *
 * Headless: globalThis.RangeFinder (same pattern as followCore).
 */
(function (root) {
  "use strict";

  // —— Tunables (fixed by spec) ——————————————————————————————————————
  /**
   * Match pitch.js CLARITY_MIN (0.72). Was 0.9, which discarded most real
   * low-register frames the detector already accepted → “not enough singing”
   * after an honest Happy Birthday sing-through.
   */
  const CLARITY_MIN = 0.72;
  /** A silence longer than this is a breath/phrase break. */
  const GAP_MS = 250;
  /** Voice slides into pitch after a break; ignore the scoop. */
  const SCOOP_MS = 300;
  /** No single frame may dominate: cap its weight at one frame period. */
  const MAX_FRAME_WEIGHT_MS = 40;
  /** Beyond this from the mode, a sample is probably an octave glitch. */
  const FOLD_WINDOW = 9;
  const LOW_PCT = 0.07;
  const HIGH_PCT = 0.93;
  const MIN_SPAN_SEMITONES = 3;
  const MIN_TOTAL_WEIGHT_MS = 6000;
  const MAX_NUDGE = 3;
  const NUDGE_TRIGGER = 2;
  const NARROW_SLACK = 4;

  // Tempo
  const ONSET_GAP_MS = 120;
  const ONSET_WINDOW_MS = 150;
  const ONSET_STEP_SEMITONES = 0.8;
  const IOI_MAX_MS = 2000;
  const IOI_MEDIAN_FACTOR = 3;
  const MIN_IOIS = 10;
  const BPM_MIN = 50;
  const BPM_MAX = 110;

  /** Beats per glyph. */
  const GLYPH_BEATS = {
    quarter: 1,
    eighth: 0.5,
    dottedquarter: 1.5,
    half: 2,
    whole: 4,
  };
  const RECIT_EMPTY_SYLLABLES = 8;

  // —— Small helpers ————————————————————————————————————————————————

  function syllableCount(lyric) {
    if (lyric == null) return 0;
    const parts = String(lyric)
      .split(/[\s\-‐‑–—]+/)
      .filter(Boolean);
    return parts.length;
  }

  function isRecit(note) {
    return !!note && (note.type === "recit" || note.glyph === "recit");
  }

  /** Duration of a written note in beats. */
  function noteBeats(note) {
    if (!note) return 1;
    if (isRecit(note)) {
      const syl = syllableCount(note.lyric) || RECIT_EMPTY_SYLLABLES;
      return Math.max(1, syl / 2);
    }
    const g = String(note.glyph || "quarter").toLowerCase();
    let beats = GLYPH_BEATS[g];
    if (beats == null) beats = 1;
    if (note.dotted && g.indexOf("dotted") !== 0) beats *= 1.5;
    return beats;
  }

  /** Syllables a written note carries (for beats-per-syllable). */
  function noteSyllables(note) {
    const n = syllableCount(note && note.lyric);
    if (n > 0) return n;
    return isRecit(note) ? RECIT_EMPTY_SYLLABLES : 1;
  }

  function allNotes(scoreJson) {
    const out = [];
    if (!scoreJson || !Array.isArray(scoreJson.pages)) return out;
    for (const page of scoreJson.pages) {
      for (const staff of page.staves || []) {
        for (const note of staff.notes || []) {
          if (note && note.midi != null && Number.isFinite(Number(note.midi))) out.push(note);
        }
      }
    }
    return out;
  }

  /**
   * Weighted quantile over [{ v, w }]. Sorts by value, walks the cumulative
   * weight, returns the value where it crosses q of the total.
   */
  function weightedQuantile(samples, q) {
    if (!samples.length) return null;
    const sorted = samples.slice().sort((a, b) => a.v - b.v);
    let total = 0;
    for (const s of sorted) total += s.w;
    if (total <= 0) return null;
    const target = q * total;
    let acc = 0;
    for (const s of sorted) {
      acc += s.w;
      if (acc >= target) return s.v;
    }
    return sorted[sorted.length - 1].v;
  }

  function median(list) {
    if (!list.length) return null;
    const s = list.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /** Weighted histogram over integer semitones → { hist: Map, mode }. */
  function histogram(samples) {
    const hist = new Map();
    for (const s of samples) {
      const k = Math.round(s.v);
      hist.set(k, (hist.get(k) || 0) + s.w);
    }
    let mode = null;
    let best = -Infinity;
    for (const [k, w] of hist) {
      if (w > best) {
        best = w;
        mode = k;
      }
    }
    return { hist, mode };
  }

  function histToObject(hist) {
    const out = {};
    for (const [k, w] of hist) out[k] = Math.round(w);
    return out;
  }

  // —— Step 1: clean the frame stream ————————————————————————————————

  /**
   * Clarity filter, then drop the scoop after every break, then weight each
   * surviving frame by how long it was held (capped so one long frame can't
   * outvote a phrase).
   */
  function cleanFrames(frames) {
    if (!Array.isArray(frames)) return [];
    const voiced = frames
      .filter(
        (f) =>
          f &&
          Number.isFinite(Number(f.t)) &&
          Number.isFinite(Number(f.midi)) &&
          Number(f.clarity) >= CLARITY_MIN
      )
      .map((f) => ({ t: Number(f.t), midi: Number(f.midi) }))
      .sort((a, b) => a.t - b.t);

    // Drop the first SCOOP_MS after each gap — the voice is still sliding in.
    const kept = [];
    let scoopUntil = -Infinity;
    for (let i = 0; i < voiced.length; i++) {
      if (i > 0 && voiced[i].t - voiced[i - 1].t > GAP_MS) {
        scoopUntil = voiced[i].t + SCOOP_MS;
      }
      if (voiced[i].t < scoopUntil) continue;
      kept.push(voiced[i]);
    }
    return kept;
  }

  /** Weight each cleaned frame by its hold time, capped. */
  function weighFrames(kept) {
    const out = [];
    for (let i = 0; i < kept.length; i++) {
      const next = kept[i + 1];
      const gap = next ? next.t - kept[i].t : MAX_FRAME_WEIGHT_MS;
      out.push({ v: kept[i].midi, w: Math.max(0, Math.min(gap, MAX_FRAME_WEIGHT_MS)), t: kept[i].t });
    }
    return out;
  }

  // —— Step 3: octave-glitch fold ————————————————————————————————————

  /** Fold stray samples one octave toward the mode; single fold only. */
  function foldOctaves(samples, mode) {
    if (mode == null) return samples;
    return samples.map((s) => {
      const d = Math.abs(s.v - mode);
      if (d <= FOLD_WINDOW) return s;
      const down = Math.abs(s.v - 12 - mode);
      const up = Math.abs(s.v + 12 - mode);
      if (down <= FOLD_WINDOW && down <= up) return { v: s.v - 12, w: s.w, t: s.t };
      if (up <= FOLD_WINDOW) return { v: s.v + 12, w: s.w, t: s.t };
      return s;
    });
  }

  // —— Steps 9–10: onsets and inter-onset intervals ——————————————————

  /**
   * Weighted mean midi over a window either side of frame `i`, walking outward
   * only while the singing stays continuous.
   *
   * Stopping at a break matters: without it, the pitch step across a silence
   * is seen from the frame *before* the silence and registers a second onset
   * there, on top of the re-entry onset rule (a) already gives — every syllable
   * counted twice and the tempo came out double.
   */
  /**
   * MEDIAN pitch of the window before/after frame i — not the mean.
   * A single octave-glitch frame inside a 150 ms window shifts the mean by
   * ~1.6 semitones (12 × 20/150), which reads as a legitimate syllable step
   * and doubled the onset count at realistic glitch rates. The median is
   * unmoved by isolated glitch frames, so only real pitch steps register.
   */
  function meanAround(samples, i, dir, windowMs) {
    const origin = samples[i].t;
    const vals = [];
    for (let k = i + dir; k >= 0 && k < samples.length; k += dir) {
      const prev = samples[k - dir];
      if (Math.abs(samples[k].t - prev.t) >= ONSET_GAP_MS) break; // a break: stop
      if (Math.abs(samples[k].t - origin) > windowMs) break;
      vals.push(samples[k].v);
    }
    // Include the frame itself on the trailing side so a lone frame still counts.
    if (dir < 0) vals.push(samples[i].v);
    // A median of 2–3 frames is still glitch-dominated (windows shrink near
    // note tails); type-b needs a populated window — type-a covers the edges.
    if (vals.length < 4) return null;
    vals.sort((a, b) => a - b);
    const m = vals.length >> 1;
    return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
  }

  /**
   * Onsets are either a re-entry after a break, or a step to a new pitch.
   * A registered onset of either kind suppresses step detection for
   * ONSET_WINDOW_MS, so a pitch change at a re-entry isn't counted twice.
   */
  function detectOnsets(samples) {
    const onsets = [];
    if (!samples.length) return onsets;
    let suppressUntil = -Infinity;

    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];

      // (a) first voiced frame of the stream, or after a break
      const prev = samples[i - 1];
      if (!prev || s.t - prev.t >= ONSET_GAP_MS) {
        onsets.push(s.t);
        suppressUntil = s.t + ONSET_WINDOW_MS;
        continue;
      }

      // (b) pitch step across this frame, within continuous singing
      if (s.t < suppressUntil) continue;
      const next = samples[i + 1];
      if (!next || next.t - s.t >= ONSET_GAP_MS) continue; // a break — rule (a) owns it
      const before = meanAround(samples, i, -1, ONSET_WINDOW_MS);
      const after = meanAround(samples, i, +1, ONSET_WINDOW_MS);
      if (before == null || after == null) continue;
      const step = Math.abs(after - before);
      // Steps of ~an octave or more inside continuous voicing are detector
      // octave glitches, not sung syllables (real octave leaps get a type-a
      // onset from the consonant gap). Without this guard, 8–10% glitch rates
      // doubled the onset count and the tempo estimate with it.
      if (step >= ONSET_STEP_SEMITONES && step < 10) {
        onsets.push(s.t);
        suppressUntil = s.t + ONSET_WINDOW_MS;
      }
    }
    return onsets;
  }

  /** Successive onset deltas, minus phrase breaks and outliers. */
  function interOnsetIntervals(onsets) {
    const kept = [];
    for (let i = 1; i < onsets.length; i++) {
      const d = onsets[i] - onsets[i - 1];
      if (!(d > 0)) continue;
      if (d > IOI_MAX_MS) continue;
      if (kept.length >= 3) {
        const run = median(kept);
        if (run != null && d > IOI_MEDIAN_FACTOR * run) continue;
      }
      kept.push(d);
    }
    return kept;
  }

  // —— Main ————————————————————————————————————————————————————————

  /**
   * @param {Array<{t:number, midi:number, clarity:number}>} frames
   * @param {object} scoreJson
   * @returns {{ok:false, reason:string, debug?:object}|{ok:true, low:number, high:number, center:number, offsetSemitones:number, voiceHint:string, tempoBpm:number|null, debug:object}}
   */
  function estimate(frames, scoreJson) {
    const kept = cleanFrames(frames);
    const weighted = weighFrames(kept);

    const first = histogram(weighted);
    const M = first.mode;

    const folded = foldOctaves(weighted, M);
    const second = histogram(folded);

    let totalWeight = 0;
    for (const s of folded) totalWeight += s.w;

    const C = weightedQuantile(folded, 0.5);
    const low = weightedQuantile(folded, LOW_PCT);
    const high = weightedQuantile(folded, HIGH_PCT);
    // Extremes for the FIT CHECK only. The display range (7th/93rd)
    // deliberately trims brief extremes — but a melody's peak is usually
    // brief (Happy Birthday's top note is 1 beat of 24), so comparing it
    // against ANY trimmed ceiling makes the nudge fire on honest full
    // sing-throughs and biases the offset flat (found in end-to-end tests).
    // The sample IS the singer performing this melody, so the honest test
    // is the actual folded extremes: octave glitches are already folded out.
    let fitLow = Infinity;
    let fitHigh = -Infinity;
    for (const s of folded) {
      if (s.v < fitLow) fitLow = s.v;
      if (s.v > fitHigh) fitHigh = s.v;
    }

    // Tempo is independent of the range verdict; compute it either way so the
    // debug payload is useful even when the sample is too short.
    const onsets = detectOnsets(weighted);
    const iois = interOnsetIntervals(onsets);
    const medianIOI = iois.length >= MIN_IOIS ? median(iois) : null;

    const notes = allNotes(scoreJson);
    let Bw = 0;
    let Sw = 0;
    const durSamples = [];
    for (const n of notes) {
      const beats = noteBeats(n);
      Bw += beats;
      Sw += noteSyllables(n);
      durSamples.push({ v: Number(n.midi), w: beats });
    }

    let tempoBpm = null;
    if (medianIOI != null && medianIOI > 0 && Sw > 0) {
      const beatsPerSyllable = Bw / Sw;
      const raw = (60 * beatsPerSyllable) / (medianIOI / 1000);
      tempoBpm = Math.max(BPM_MIN, Math.min(BPM_MAX, Math.round(raw / 2) * 2));
    }

    const debug = {
      samples: histToObject(second.hist),
      M,
      W: null,
      onsets: onsets.length,
      medianIOI,
      Bw,
      Sw,
    };

    if (
      C == null ||
      low == null ||
      high == null ||
      high - low < MIN_SPAN_SEMITONES ||
      totalWeight < MIN_TOTAL_WEIGHT_MS
    ) {
      return { ok: false, reason: "not enough singing", debug };
    }

    // —— Step 5: what the written melody actually asks for ——
    const W = weightedQuantile(durSamples, 0.5);
    debug.W = W;
    if (W == null) {
      return { ok: false, reason: "no score notes", debug };
    }

    let melodyMin = Infinity;
    let melodyMax = -Infinity;
    for (const n of notes) {
      const m = Number(n.midi);
      if (m < melodyMin) melodyMin = m;
      if (m > melodyMax) melodyMax = m;
    }

    // —— Steps 6–7: offset, then check the melody actually fits ——
    let offset = Math.round(C - W);

    let voiceHint =
      C <= 48 ? "bass" : C <= 55 ? "baritone" : C <= 62 ? "tenor" : C <= 69 ? "alto" : "soprano";

    const melodySpan = melodyMax - melodyMin;
    const measuredSpan = high - low;

    if (melodySpan > measuredSpan + NARROW_SLACK) {
      // The voice sample is narrower than the piece. Centring is the best we
      // can do — nudging would only trade one clipped end for the other.
      voiceHint += " (narrow sample)";
    } else {
      const excessHigh = melodyMax + offset - fitHigh;
      const excessLow = fitLow - (melodyMin + offset);
      const highOver = excessHigh > NUDGE_TRIGGER;
      const lowOver = excessLow > NUDGE_TRIGGER;
      // Only when one end alone is clipped is there a direction to move in.
      if (highOver && !lowOver) {
        offset -= Math.min(Math.round(excessHigh), MAX_NUDGE);
      } else if (lowOver && !highOver) {
        offset += Math.min(Math.round(excessLow), MAX_NUDGE);
      }
    }

    return {
      ok: true,
      low,
      high,
      center: C,
      offsetSemitones: offset,
      voiceHint,
      tempoBpm,
      debug,
    };
  }

  const api = {
    estimate,
    // Exposed for tests / escalation.
    _internals: {
      cleanFrames,
      weighFrames,
      foldOctaves,
      histogram,
      weightedQuantile,
      detectOnsets,
      interOnsetIntervals,
      noteBeats,
      noteSyllables,
      syllableCount,
    },
  };

  if (typeof root !== "undefined") {
    root.RangeFinder = api;
  }
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this);
