/**
 * Pitch detection module (McLeod method via pitchy).
 * Owns the mic button, AudioContext, and live tuner debug readout.
 * Pushes smoothed MIDI to window.trainer.onPitch(midiFloat, clarity).
 */
import { PitchDetector } from "https://cdn.jsdelivr.net/npm/pitchy@4/+esm";

const FFT_SIZE = 2048;
const CLARITY_MIN = 0.9;
const FREQ_MIN = 60;
const FREQ_MAX = 1200;
const MEDIAN_N = 5;
/** Call onPitch(null, 0) after this long without a confident frame. */
const LOST_MS = 200;
/** ~50 Hz poll budget via rAF throttle. */
const POLL_MS = 1000 / 50;

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const els = {
  micBtn: document.getElementById("mic-btn"),
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
/** @type {PitchDetector<Float32Array> | null} */
let detector = null;
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
  if (!els.micBtn) return;
  els.micBtn.setAttribute("aria-pressed", String(on));
  els.micBtn.classList.toggle("is-on", on);
  els.micBtn.textContent = on ? "Mic On" : "Mic Off";
  window.dispatchEvent(new CustomEvent("trainer:mic", { detail: { on } }));
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
  if (!els.pitchNote || !els.pitchNeedle) return;

  if (midiFloat == null || clarity < CLARITY_MIN) {
    els.pitchNote.textContent = "—";
    els.pitchNeedle.style.left = "50%";
    els.pitchReadout?.classList.remove("has-pitch");
    return;
  }

  const { name, cents } = midiToNoteAndCents(midiFloat);
  const sign = cents > 0 ? "+" : "";
  els.pitchNote.textContent = `${name} ${sign}${cents}¢`;
  els.pitchReadout?.classList.add("has-pitch");

  // Map −50…+50¢ → 0…100% of the bar (clamp)
  const pct = 50 + Math.max(-50, Math.min(50, cents));
  els.pitchNeedle.style.left = `${pct}%`;
}

function clearDebug() {
  updateDebug(null, 0);
}

async function ensureGraph() {
  if (audioCtx && mediaStream && analyser && detector) {
    if (audioCtx.state === "suspended") await audioCtx.resume();
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  // sampleRate is whatever the device/context provides
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = FFT_SIZE;
  // Prefer time-domain only; no need for frequency smoothing defaults
  an.smoothingTimeConstant = 0;
  src.connect(an);
  // Do not connect to destination — silent monitoring

  const det = PitchDetector.forFloat32Array(an.fftSize);
  const buf = new Float32Array(an.fftSize);

  mediaStream = stream;
  audioCtx = ctx;
  sourceNode = src;
  analyser = an;
  detector = det;
  timeBuf = buf;

  if (ctx.state === "suspended") await ctx.resume();
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
  detector = null;
  timeBuf = null;

  if (mediaStream) {
    for (const t of mediaStream.getTracks()) t.stop();
    mediaStream = null;
  }

  if (audioCtx) {
    // suspend if still open; close frees the device cleanly
    const ctx = audioCtx;
    audioCtx = null;
    ctx.close().catch(() => {});
  }
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

  if (!analyser || !detector || !timeBuf || !audioCtx) return;
  if (audioCtx.state !== "running") return;

  analyser.getFloatTimeDomainData(timeBuf);
  const [freqHz, clarity] = detector.findPitch(timeBuf, audioCtx.sampleRate);

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
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showMicError("Microphone API not available in this browser.");
    setMicUi(false);
    return;
  }

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
  if (!els.micBtn) {
    console.error("pitch.js: #mic-btn not found");
    return;
  }
  els.micBtn.addEventListener("click", () => {
    toggleMic().catch((e) => console.error(e));
  });
  clearDebug();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}

// Optional handle for debugging from the console
window.pitchModule = { startMic, stopMic, toggleMic };
