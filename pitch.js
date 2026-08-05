/**
 * Pitch detection module — dual classical detectors (no network / no ES modules).
 *
 *  - McLeod Pitch Method (MPM) via FFT-accelerated NSDF (as in pitchy)
 *  - YIN (de Cheveigné & Kawahara) — often more stable on sung vowels
 * Live path picks the clearer estimate each frame after a light DC/highpass.
 *
 * Owns the mic button, shared AudioContext, and pushes smoothed MIDI to
 * window.trainer.onPitch(midiFloat, clarity).
 */
(() => {
  "use strict";

  // =====================================================================
  // MPM detector (pure — exposed as MPM.findPitch for headless testing)
  // =====================================================================

  /** Iterative radix-2 complex FFT, in place. */
  function fftInPlace(re, im, invert) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = ((2 * Math.PI) / len) * (invert ? 1 : -1);
      const wR = Math.cos(ang), wI = Math.sin(ang);
      const half = len >> 1;
      for (let i = 0; i < n; i += len) {
        let curR = 1, curI = 0;
        for (let k = 0; k < half; k++) {
          const aR = re[i + k], aI = im[i + k];
          const bR = re[i + k + half] * curR - im[i + k + half] * curI;
          const bI = re[i + k + half] * curI + im[i + k + half] * curR;
          re[i + k] = aR + bR; im[i + k] = aI + bI;
          re[i + k + half] = aR - bR; im[i + k + half] = aI - bI;
          const nR = curR * wR - curI * wI;
          curI = curR * wI + curI * wR;
          curR = nR;
        }
      }
    }
    if (invert) {
      for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
    }
  }

  /**
   * Normalized Square Difference Function via FFT autocorrelation.
   * nsdf(τ) = 2·r(τ) / m(τ), m(τ) updated incrementally (McLeod §3).
   */
  function computeNSDF(buf) {
    const n = buf.length;              // power of two (analyser fftSize)
    const size = 2 * n;                // zero-padded for linear autocorrelation
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    for (let i = 0; i < n; i++) re[i] = buf[i];
    fftInPlace(re, im, false);
    for (let i = 0; i < size; i++) {
      re[i] = re[i] * re[i] + im[i] * im[i];
      im[i] = 0;
    }
    fftInPlace(re, im, true);          // re[τ] is now the autocorrelation r(τ)

    const maxTau = n >> 1;
    const nsdf = new Float64Array(maxTau);
    let m = 2 * re[0];                 // m(0) = 2·Σx²  = 2·r(0)
    nsdf[0] = 1;
    for (let tau = 1; tau < maxTau; tau++) {
      m -= buf[tau - 1] * buf[tau - 1] + buf[n - tau] * buf[n - tau];
      nsdf[tau] = m > 1e-12 ? (2 * re[tau]) / m : 0;
    }
    return nsdf;
  }

  /**
   * McLeod: [frequencyHz, clarity 0..1]. Returns [0, 0] when no pitch found.
   */
  function findPitchMcLeod(buf, sampleRate) {
    const nsdf = computeNSDF(buf);
    const len = nsdf.length;

    // Skip the initial positive lobe around τ=0.
    let pos = 1;
    while (pos < len && nsdf[pos] > 0) pos++;

    // Key maxima between positive-going zero crossings.
    const maxima = [];
    while (pos < len - 1) {
      while (pos < len - 1 && !(nsdf[pos] <= 0 && nsdf[pos + 1] > 0)) pos++;
      if (pos >= len - 1) break;
      pos++;
      let maxIdx = -1, maxVal = -Infinity;
      while (pos < len && nsdf[pos] > 0) {
        if (nsdf[pos] > maxVal) { maxVal = nsdf[pos]; maxIdx = pos; }
        pos++;
      }
      if (maxIdx > 0) maxima.push(maxIdx);
    }
    if (!maxima.length) return [0, 0];

    let highest = -Infinity;
    for (const i of maxima) if (nsdf[i] > highest) highest = nsdf[i];
    const K = 0.9; // first key maximum within 90% of the global one
    let chosen = maxima[0];
    for (const i of maxima) {
      if (nsdf[i] >= K * highest) { chosen = i; break; }
    }

    // Parabolic interpolation around the chosen lag.
    const a = nsdf[chosen - 1];
    const b = nsdf[chosen];
    const c = chosen + 1 < len ? nsdf[chosen + 1] : b;
    const denom = a - 2 * b + c;
    const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
    const tau = chosen + shift;
    const clarity = Math.max(0, Math.min(1, b - 0.25 * (a - c) * shift));
    if (tau <= 0) return [0, 0];
    return [sampleRate / tau, clarity];
  }

  /**
   * YIN pitch estimate (de Cheveigné & Kawahara 2002).
   * threshold: absolute CMND threshold (lower = more sensitive; 0.12–0.2 typical).
   */
  function findPitchYin(buf, sampleRate, threshold) {
    const thr = threshold == null ? 0.14 : threshold;
    const n = buf.length;
    const half = n >> 1;
    if (half < 4) return [0, 0];

    // Difference function d(τ)
    const yinBuf = new Float64Array(half);
    for (let tau = 1; tau < half; tau++) {
      let sum = 0;
      for (let i = 0; i < half; i++) {
        const d = buf[i] - buf[i + tau];
        sum += d * d;
      }
      yinBuf[tau] = sum;
    }

    // Cumulative mean normalized difference
    yinBuf[0] = 1;
    let runningSum = 0;
    for (let tau = 1; tau < half; tau++) {
      runningSum += yinBuf[tau];
      yinBuf[tau] = runningSum > 0 ? (yinBuf[tau] * tau) / runningSum : 1;
    }

    // Absolute threshold: first τ below thr, then local min
    let tauEstimate = -1;
    for (let tau = 2; tau < half; tau++) {
      if (yinBuf[tau] < thr) {
        while (tau + 1 < half && yinBuf[tau + 1] < yinBuf[tau]) tau++;
        tauEstimate = tau;
        break;
      }
    }
    if (tauEstimate < 0) return [0, 0];

    // Parabolic interpolation
    const x0 = Math.max(1, tauEstimate - 1);
    const x2 = Math.min(half - 1, tauEstimate + 1);
    let better = tauEstimate;
    if (x0 !== tauEstimate && x2 !== tauEstimate) {
      const s0 = yinBuf[x0];
      const s1 = yinBuf[tauEstimate];
      const s2 = yinBuf[x2];
      const denom = 2 * s1 - s2 - s0;
      if (Math.abs(denom) > 1e-12) {
        better = tauEstimate + (s2 - s0) / (2 * denom);
      }
    }
    if (!(better > 0)) return [0, 0];
    const freq = sampleRate / better;
    // Clarity: 1 - CMND at discrete τ (higher = better)
    const clarity = Math.max(0, Math.min(1, 1 - yinBuf[tauEstimate]));
    return [freq, clarity];
  }

  /** Remove DC and apply a gentle one-pole highpass (vocal band emphasis). */
  function preprocess(buf) {
    const n = buf.length;
    let mean = 0;
    for (let i = 0; i < n; i++) mean += buf[i];
    mean /= n || 1;
    const out = new Float32Array(n);
    // Simple highpass ~ y[i] = x[i]-x[i-1] + 0.97*y[i-1] (cheap, stable)
    let y = 0;
    let prev = 0;
    for (let i = 0; i < n; i++) {
      const x = buf[i] - mean;
      y = x - prev + 0.97 * y;
      prev = x;
      out[i] = y;
    }
    // Soft RMS normalize so quiet singing still has structure
    let energy = 0;
    for (let i = 0; i < n; i++) energy += out[i] * out[i];
    const rms = Math.sqrt(energy / (n || 1));
    if (rms > 1e-6 && rms < 0.08) {
      const g = 0.08 / rms;
      for (let i = 0; i < n; i++) out[i] *= Math.min(g, 6);
    }
    return out;
  }

  /**
   * Dual detector: McLeod + YIN on preprocessed buffer; pick best valid clarity.
   * Prefer agreement when both are good (average freqs if within a semitone).
   */
  function findPitch(buf, sampleRate) {
    if (!buf || !buf.length || !sampleRate) return [0, 0];
    const cleaned = preprocess(buf);
    const m = findPitchMcLeod(cleaned, sampleRate);
    const y = findPitchYin(cleaned, sampleRate, 0.14);

    const mOk = m[0] >= 55 && m[0] <= 1400 && m[1] > 0.35;
    const yOk = y[0] >= 55 && y[0] <= 1400 && y[1] > 0.35;

    if (mOk && yOk) {
      const cents = Math.abs(1200 * Math.log2(m[0] / y[0]));
      if (cents < 100) {
        // Agree: blend frequency, take max clarity
        const f = Math.sqrt(m[0] * y[0]); // geometric mean
        return [f, Math.max(m[1], y[1])];
      }
      // Disagree: trust higher clarity
      return m[1] >= y[1] ? m : y;
    }
    if (mOk) return m;
    if (yOk) return y;
    // Neither strong — return the less-bad of the two
    if (m[1] >= y[1]) return m;
    return y;
  }

  const MPM = {
    findPitch,
    findPitchMcLeod,
    findPitchYin,
    computeNSDF,
    preprocess,
  };
  if (typeof window !== "undefined") window.MPM = MPM;
  else if (typeof globalThis !== "undefined") globalThis.MPM = MPM;

  // Headless (node) — expose the detector only.
  if (typeof document === "undefined") return;

  // =====================================================================
  // Mic + UI (unchanged behavior)
  // =====================================================================

  /**
   * 4096 samples (~93 ms at 44.1 kHz). A male cantor reads the treble staff an
   * octave down, so bottom-staff notes arrive at 145–165 Hz — only ~6 cycles in
   * a 2048-sample window, where the detector gets unreliable and biases the
   * estimate upward. Poll rate is unchanged.
   */
  const FFT_SIZE = 4096;
  /**
   * Dual detector + preprocess is more reliable; 0.72 keeps chant vowels without
   * accepting pure noise. (Assess alignment is more forgiving than this gate.)
   */
  const CLARITY_MIN = 0.72;
  const FREQ_MIN = 55;
  const FREQ_MAX = 1400;
  const MEDIAN_N = 5;
  /** Call onPitch(null, 0) after this long without a confident frame. */
  const LOST_MS = 450;
  /** ~50 Hz poll budget via rAF throttle. */
  const POLL_MS = 1000 / 50;

  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

  const els = {
    micBtn: document.getElementById("mic-btn"),
    micSwitch: document.getElementById("mic-switch"),
    micSwitchState: document.getElementById("mic-switch-state"),
    soundMicMenu: document.getElementById("sound-mic-menu"),
    // Optional legacy readout (removed from UI; keep null-safe)
    pitchReadout: document.getElementById("pitch-readout"),
    pitchNote: document.getElementById("pitch-note"),
    pitchBar: document.getElementById("pitch-bar"),
    pitchNeedle: document.getElementById("pitch-needle"),
    micError: document.getElementById("mic-error"),
  };

  /** @type {AudioContext | null} */
  let audioCtx = null;
  /** @type {MediaStream | null} */
  let mediaStream = null;
  /** @type {MediaStreamAudioSourceNode | null} */
  let sourceNode = null;
  /** @type {AnalyserNode | null} */
  let analyser = null;
  /** @type {Float32Array | null} */
  let timeBuf = null;

  let running = false;
  let rafId = 0;
  let lastPollTs = 0;
  /** Last wall time we accepted a confident pitch frame. */
  let lastGoodTs = 0;
  /** Whether we already sent the null “lost pitch” event for this silence. */
  let lostSent = true;
  /** Recent accepted floating-MIDI samples for median filter. */
  const midiHistory = [];

  function setMicUi(on) {
    // Hidden compat button (diagnose.js / older code)
    if (els.micBtn) {
      els.micBtn.setAttribute("aria-pressed", String(on));
      els.micBtn.classList.toggle("is-on", on);
      els.micBtn.textContent = on ? "Mic On" : "Mic Off";
    }
    // Visible switch in Sound & Mic menu
    if (els.micSwitch) {
      els.micSwitch.checked = !!on;
      els.micSwitch.setAttribute("aria-checked", String(!!on));
    }
    if (els.micSwitchState) {
      els.micSwitchState.textContent = on ? "On" : "Off";
      els.micSwitchState.classList.toggle("is-on", !!on);
    }
    if (els.soundMicMenu) {
      els.soundMicMenu.classList.toggle("is-mic-on", !!on);
    }
    window.dispatchEvent(new CustomEvent("trainer:mic", { detail: { on: !!on } }));
  }

  function showMicError(msg) {
    if (!els.micError) return;
    if (msg) {
      els.micError.hidden = false;
      els.micError.textContent = msg;
    } else {
      els.micError.hidden = true;
      els.micError.textContent = "";
    }
  }

  function midiToName(midi) {
    const m = Math.round(midi);
    const name = NOTE_NAMES[((m % 12) + 12) % 12];
    const oct = Math.floor(m / 12) - 1;
    return `${name}${oct}`;
  }

  /** Floating MIDI → nearest note name + cents offset (signed). */
  function midiToNoteAndCents(midiFloat) {
    const nearest = Math.round(midiFloat);
    const cents = Math.round((midiFloat - nearest) * 100);
    return { name: midiToName(nearest), cents, nearest };
  }

  function median(arr) {
    if (!arr.length) return null;
    const s = arr.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  function freqToMidi(freqHz) {
    return 69 + 12 * Math.log2(freqHz / 440);
  }

  function notifyTrainer(midiFloat, clarity) {
    const t = window.trainer;
    if (t && typeof t.onPitch === "function") {
      t.onPitch(midiFloat, clarity);
    }
  }

  function updateDebug(midiFloat, clarity) {
    // Readout UI removed; keep this no-op safe if elements are absent
    if (!els.pitchNote && !els.pitchNeedle) return;

    if (midiFloat == null || clarity < CLARITY_MIN) {
      if (els.pitchNote) els.pitchNote.textContent = "—";
      if (els.pitchNeedle) els.pitchNeedle.style.left = "50%";
      els.pitchReadout?.classList.remove("has-pitch");
      return;
    }

    const { cents } = midiToNoteAndCents(midiFloat);
    if (els.pitchNote) {
      if (Math.abs(cents) <= 12) els.pitchNote.textContent = "on";
      else if (cents > 0) els.pitchNote.textContent = "high";
      else els.pitchNote.textContent = "low";
    }
    els.pitchReadout?.classList.add("has-pitch");
    if (els.pitchNeedle) {
      const pct = 50 + Math.max(-50, Math.min(50, cents));
      els.pitchNeedle.style.left = `${pct}%`;
    }
  }

  function clearDebug() {
    updateDebug(null, 0);
  }

  async function ensureGraph() {
    if (audioCtx && mediaStream && analyser) {
      if (audioCtx.state === "suspended") await audioCtx.resume();
      return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(
        new Error(
          "Microphone API unavailable. If you opened this app as a local file, " +
            "Safari may hide the mic — use the served/hosted URL instead."
        ),
        { name: "NotSupportedError" }
      );
    }

    // Unlock/share the same AudioContext used for note playback (audio.js).
    // A second context + closing it on mic-off was a major cause of silence.
    if (window.AppAudio) window.AppAudio.unlock();

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    let ctx = null;
    if (window.AppAudio) {
      ctx = window.AppAudio.ensure();
      if (ctx && ctx.state === "suspended") {
        try {
          await ctx.resume();
        } catch (_) {
          /* ignore */
        }
      }
    }
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      ctx = new Ctx();
      if (ctx.state === "suspended") await ctx.resume();
    }

    // sampleRate is whatever the device/context provides
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = FFT_SIZE;
    an.smoothingTimeConstant = 0;
    src.connect(an);
    // Do not connect to destination — silent monitoring only

    const buf = new Float32Array(an.fftSize);

    mediaStream = stream;
    audioCtx = ctx;
    sourceNode = src;
    analyser = an;
    timeBuf = buf;
  }

  function tearDownGraph() {
    if (sourceNode) {
      try {
        sourceNode.disconnect();
      } catch (_) {
        /* ignore */
      }
      sourceNode = null;
    }
    analyser = null;
    timeBuf = null;

    if (mediaStream) {
      for (const t of mediaStream.getTracks()) t.stop();
      mediaStream = null;
    }

    // NEVER close the shared AppAudio context — that kills note playback.
    // Only drop our reference; tones keep using the same context.
    audioCtx = null;
  }

  function stopPolling() {
    running = false;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    lastPollTs = 0;
    midiHistory.length = 0;
    lastGoodTs = 0;
    lostSent = true;
    clearDebug();
    notifyTrainer(null, 0);
  }

  function pollFrame(now) {
    if (!running) return;
    rafId = requestAnimationFrame(pollFrame);

    if (now - lastPollTs < POLL_MS) return;
    lastPollTs = now;

    if (!analyser || !timeBuf || !audioCtx) return;
    if (audioCtx.state !== "running") return;

    analyser.getFloatTimeDomainData(timeBuf);
    const [freqHz, clarity] = findPitch(timeBuf, audioCtx.sampleRate);

    const ok =
      clarity >= CLARITY_MIN &&
      freqHz >= FREQ_MIN &&
      freqHz <= FREQ_MAX &&
      Number.isFinite(freqHz);

    if (ok) {
      const midi = freqToMidi(freqHz);
      midiHistory.push(midi);
      if (midiHistory.length > MEDIAN_N) midiHistory.shift();

      const smoothed = median(midiHistory);
      lastGoodTs = now;
      lostSent = false;

      notifyTrainer(smoothed, clarity);
      updateDebug(smoothed, clarity);
    } else {
      // No confident pitch this frame — maybe emit loss after LOST_MS
      if (!lostSent && lastGoodTs && now - lastGoodTs > LOST_MS) {
        lostSent = true;
        midiHistory.length = 0;
        notifyTrainer(null, 0);
        clearDebug();
      } else if (!lostSent && midiHistory.length) {
        // Keep showing last median briefly while within grace window
        const smoothed = median(midiHistory);
        updateDebug(smoothed, clarity);
      }
    }
  }

  async function startMic() {
    showMicError(null);

    try {
      await ensureGraph(); // getUserMedia on first start; resume AudioContext after
    } catch (err) {
      console.error("getUserMedia failed", err);
      const denied =
        err && (err.name === "NotAllowedError" || err.name === "PermissionDeniedError");
      showMicError(
        denied
          ? "Microphone permission denied. Allow mic access in the browser and try again."
          : `Could not open microphone: ${err.message || err.name || err}`
      );
      tearDownGraph();
      setMicUi(false);
      return;
    }

    if (audioCtx && audioCtx.state === "suspended") {
      try {
        await audioCtx.resume();
      } catch (err) {
        console.error("AudioContext.resume failed", err);
        showMicError("Could not resume audio. Click Mic again.");
        setMicUi(false);
        return;
      }
    }

    running = true;
    setMicUi(true);
    lastPollTs = 0;
    lastGoodTs = 0;
    lostSent = true;
    midiHistory.length = 0;
    rafId = requestAnimationFrame(pollFrame);
  }

  async function stopMic() {
    stopPolling();
    // Fully release the microphone. Suspending the AudioContext is NOT enough:
    // Safari keeps the MediaStream tracks live (mic indicator stays on) until
    // every track is stopped and the context is closed. ensureGraph() rebuilds
    // the whole graph on the next Mic On click (a user gesture, as Safari needs).
    tearDownGraph();
    setMicUi(false);
  }

  async function toggleMic() {
    if (running) {
      await stopMic();
    } else {
      await startMic();
    }
  }

  function init() {
    if (!els.micSwitch && !els.micBtn) {
      // Headless tests / no UI — detectors still available on window.MPM
      return;
    }

    // Primary control: on/off switch in Sound & Mic menu
    if (els.micSwitch) {
      els.micSwitch.addEventListener("change", () => {
        const wantOn = !!els.micSwitch.checked;
        // Align UI optimistically; start/stop will re-sync if permission fails
        if (wantOn && !running) {
          startMic().catch((e) => {
            console.error(e);
            setMicUi(false);
          });
        } else if (!wantOn && running) {
          stopMic().catch((e) => console.error(e));
        } else {
          setMicUi(running);
        }
      });
    }

    // Compat: hidden #mic-btn click (diagnose ensureMic)
    if (els.micBtn) {
      els.micBtn.addEventListener("click", () => {
        toggleMic().catch((e) => console.error(e));
      });
    }

    setMicUi(false);
    clearDebug();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Optional handle for debugging from the console
  window.pitchModule = { startMic, stopMic, toggleMic };
})();
