/**
 * range-ui.js — "Find your range" session UI + wiring.
 * Does not implement estimation (see range.js / RangeFinder.estimate).
 * Does not modify Assess selection (diagnose.js) code path.
 */
(() => {
  "use strict";

  if (typeof document === "undefined" || typeof document.getElementById !== "function") {
    return;
  }

  const STORAGE_KEY = "byz.range.v1";
  /** Preferred PDF names (first that fetch() succeeds wins). */
  const RANGE_PDF_CANDIDATES = [
    "range-test.pdf",
    "Happy_Birthday_To_You.pdf",
    "Happy Birthday.pdf",
    "Happy_Birthday.pdf",
  ];
  /** Preferred score JSON names. */
  const RANGE_JSON_CANDIDATES = [
    "range-test.json",
    "Happy_Birthday_To_You.json",
    "Happy Birthday.json",
    "Happy_Birthday.json",
  ];
  const MAX_SESSION_MS = 90000;
  const SILENCE_END_MS = 4000;
  const MIN_VOICED_BEFORE_SILENCE_MS = 8000;
  const MIN_VOICED_TOTAL_MS = 6000;

  function $(id) {
    return document.getElementById(id);
  }

  function midiToName(midi) {
    if (typeof window.midiToName === "function") {
      return window.midiToName(midi);
    }
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const m = Math.round(Number(midi));
    if (!Number.isFinite(m)) return "?";
    return names[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  }

  // —— session state ——
  const session = {
    active: false,
    recording: false,
    starting: false, // true during mic + 3-2-1 (prevents double-start)
    frames: [],
    scoreJson: null,
    t0: 0,
    lastVoicedAt: 0,
    voicedMs: 0,
    lastFrameT: 0,
    silenceRunStart: 0,
    tickTimer: 0,
    prevOnPitch: null,
  };

  function setAssessMenuOpen(open) {
    const panel = $("assess-menu-panel");
    const toggle = $("assess-menu-toggle");
    if (!panel || !toggle) return;
    panel.hidden = !open;
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    toggle.classList.toggle("is-open", open);
  }

  function stopPracticeModes() {
    try {
      if (window.diagnose && typeof window.diagnose.exitMode === "function") {
        if (window.diagnose.isOn && window.diagnose.isOn()) window.diagnose.exitMode();
      }
    } catch (_) {
      /* ignore */
    }
    try {
      if (window.followPlayback) {
        if (typeof window.followPlayback.stopPitchMatch === "function") {
          window.followPlayback.stopPitchMatch();
        } else if (window.followPlayback.play) {
          window.followPlayback.play.matchPitch = false;
        }
        if (typeof window.followPlayback.stopPlayback === "function") {
          window.followPlayback.stopPlayback();
        }
      }
    } catch (_) {
      /* ignore */
    }
  }

  /**
   * Session UI modes share one large Happy Birthday card (#range-session-stage).
   * Dialog cards (retry / results / pending) hide that stage.
   */
  function setSessionMode(mode) {
    // mode: "intro" | "countdown" | "listen" | null
    const prompt = $("range-sheet-prompt");
    const listenBar = $("range-sheet-listen-bar");
    const sheet = $("range-piece-sheet");
    if (prompt) {
      if (mode === "intro") {
        prompt.hidden = false;
        prompt.textContent =
          "Click this card to begin — then sing the way that feels comfortable. Don’t worry about being exact.";
      } else if (mode === "countdown") {
        prompt.hidden = false;
        prompt.textContent = "Get ready…";
      } else if (mode === "listen") {
        prompt.hidden = true;
      }
    }
    if (listenBar) listenBar.hidden = mode !== "listen";
    if (sheet) {
      sheet.classList.toggle("is-clickable", mode === "intro");
      sheet.classList.toggle("is-listening", mode === "listen");
      sheet.classList.toggle("is-countdown", mode === "countdown");
    }
  }

  function showOverlay(which) {
    const root = $("range-overlay");
    if (!root) return;
    root.hidden = false;
    const stage = $("range-session-stage");
    const isSession =
      which === "range-overlay-intro" || which === "range-overlay-listen";

    root.classList.toggle("is-intro", which === "range-overlay-intro");
    root.classList.toggle("is-listen", which === "range-overlay-listen");
    root.classList.toggle("is-dialog", !isSession);

    if (stage) stage.hidden = !isSession;

    if (which === "range-overlay-intro") {
      setSessionMode("intro");
      showCount(null);
    } else if (which === "range-overlay-listen") {
      setSessionMode("listen");
      showCount(null);
    } else {
      setSessionMode(null);
      showCount(null);
    }

    ["range-overlay-retry", "range-overlay-results", "range-overlay-pending"].forEach((id) => {
      const el = $(id);
      if (el) el.hidden = id !== which;
    });
  }

  function hideOverlay() {
    const root = $("range-overlay");
    if (root) {
      root.hidden = true;
      root.classList.remove("is-intro", "is-listen", "is-dialog");
    }
    const stage = $("range-session-stage");
    if (stage) stage.hidden = true;
    setSessionMode(null);
    showCount(null);
    ["range-overlay-retry", "range-overlay-results", "range-overlay-pending"].forEach((id) => {
      const el = $(id);
      if (el) el.hidden = true;
    });
  }

  /**
   * Build lyric lines from score JSON (one line per staff) so singers see
   * “dear friend” instead of inventing a name.
   */
  function scoreToLyricLines(scoreJson) {
    const lines = [];
    if (!scoreJson || !Array.isArray(scoreJson.pages)) return lines;
    for (const page of scoreJson.pages) {
      for (const st of page.staves || []) {
        const parts = [];
        for (const n of st.notes || []) {
          const ly = n.lyric != null ? String(n.lyric).trim() : "";
          if (ly) parts.push(ly);
        }
        if (parts.length) lines.push(parts.join(" "));
      }
    }
    return lines;
  }

  function fillHappyBirthdayLyrics(scoreJson) {
    let lines = scoreToLyricLines(scoreJson);
    if (!lines.length) {
      // Fallback if score has no lyrics
      lines = [
        "Hap- py birth- day to you,",
        "Hap- py birth- day to you,",
        "Hap- py birth- day dear friend,",
        "Hap- py birth- day to you!",
      ];
    }
    const html = lines
      .map((line) => {
        // Emphasize “friend” so users don’t insert a personal name
        const safe = line
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        const withFriend = safe.replace(
          /\bfriend\b/gi,
          '<span class="range-friend">friend</span>'
        );
        return '<p class="range-piece-line">' + withFriend + "</p>";
      })
      .join("");
    const a = $("range-piece-lyrics");
    if (a) a.innerHTML = html;
  }

  /** Ensure stage shows the score page (not the empty upload drop-hint). */
  function showScoreStage() {
    const drop = $("drop-hint");
    const wrap = $("canvas-wrap");
    if (drop) drop.hidden = true;
    if (wrap) wrap.hidden = false;
    if (window.trainer && typeof window.trainer.focusNote === "function") {
      try {
        // Page 1, first note — scroll sheet into view without free-follow
        if (window.trainer.notes && window.trainer.notes.length) {
          window.trainer.focusNote(0);
        }
      } catch (_) {
        /* ignore */
      }
    }
    const stage = $("stage");
    if (stage) stage.scrollTop = 0;
  }

  /** Bold 3-2-1 drawn over the Happy Birthday card (not the faint global #countdown). */
  function showCount(text) {
    const c = $("range-sheet-countdown");
    // Also hide the global stage countdown so it never peeks through faintly
    const globalC = $("countdown");
    if (globalC) {
      globalC.hidden = true;
      globalC.textContent = "";
    }
    if (!c) return;
    if (text == null) {
      c.hidden = true;
      c.textContent = "";
      c.setAttribute("aria-hidden", "true");
      c.classList.remove("is-tick");
      return;
    }
    c.hidden = false;
    c.setAttribute("aria-hidden", "false");
    c.textContent = text;
    c.classList.remove("is-tick");
    void c.offsetWidth;
    c.classList.add("is-tick");
  }

  function runCountdown() {
    return new Promise((resolve) => {
      let n = 3;
      setSessionMode("countdown");
      showCount(String(n));
      const id = setInterval(() => {
        n -= 1;
        if (n <= 0) {
          clearInterval(id);
          showCount(null);
          resolve(true);
          return;
        }
        showCount(String(n));
      }, 700);
    });
  }

  async function ensureMicOn() {
    if (window.pitchModule && typeof window.pitchModule.startMic === "function") {
      try {
        await window.pitchModule.startMic();
      } catch (e) {
        console.warn("range mic", e);
        return false;
      }
    } else {
      const sw = $("mic-switch");
      if (sw && !sw.checked) {
        sw.checked = true;
        sw.dispatchEvent(new Event("change", { bubbles: true }));
      }
      const mic = $("mic-btn");
      if (mic && mic.getAttribute("aria-pressed") !== "true") {
        mic.click();
      }
    }
    // Brief wait for permission UI
    await new Promise((r) => setTimeout(r, 80));
    const sw = $("mic-switch");
    if (sw && !sw.checked) return false;
    const mic = $("mic-btn");
    if (mic && mic.getAttribute("aria-pressed") !== "true") {
      // may still be starting
      await new Promise((r) => setTimeout(r, 200));
    }
    const err = $("mic-error");
    if (err && !err.hidden && err.textContent) return false;
    return true;
  }

  function installPitchTap() {
    if (!window.trainer) return;
    if (session.prevOnPitch) return; // already installed
    session.prevOnPitch = window.trainer.onPitch;
    window.trainer.onPitch = function (midi, clarity) {
      if (session.recording) {
        if (midi != null && Number.isFinite(Number(midi))) {
          const t = performance.now();
          session.frames.push({
            t,
            midi: Number(midi),
            clarity: clarity != null ? Number(clarity) : 0,
          });
          if (session.lastVoicedAt > 0) {
            session.voicedMs += Math.min(40, Math.max(0, t - session.lastFrameT));
          }
          session.lastVoicedAt = t;
          session.lastFrameT = t;
          session.silenceRunStart = 0;
        } else {
          const t = performance.now();
          session.lastFrameT = t;
          if (session.silenceRunStart <= 0) session.silenceRunStart = t;
        }
        return; // no free-follow / tones / rings during range mode
      }
      if (typeof session.prevOnPitch === "function") {
        return session.prevOnPitch(midi, clarity);
      }
    };
  }

  function clearSessionTimers() {
    if (session.tickTimer) {
      clearInterval(session.tickTimer);
      session.tickTimer = 0;
    }
  }

  function endRecording(reason) {
    if (!session.recording && !session.active) return;
    session.recording = false;
    clearSessionTimers();
    showCount(null);

    const frames = session.frames.slice();
    const voicedMs = session.voicedMs;
    const scoreJson = session.scoreJson;

    if (voicedMs < MIN_VOICED_TOTAL_MS) {
      showOverlay("range-overlay-retry");
      return;
    }

    showOverlay("range-overlay-pending");
    let result;
    try {
      if (!window.RangeFinder || typeof window.RangeFinder.estimate !== "function") {
        result = { ok: false, reason: "engine pending" };
      } else {
        result = window.RangeFinder.estimate(frames, scoreJson);
      }
    } catch (e) {
      console.warn("RangeFinder.estimate", e);
      result = { ok: false, reason: (e && e.message) || "estimate failed" };
    }

    if (!result || !result.ok) {
      const reason = (result && result.reason) || "engine pending";
      if (reason === "engine pending") {
        const pending = $("range-pending-msg");
        if (pending) {
          pending.textContent =
            "Range analysis engine is not installed yet (stub). Your sample was recorded; try again after the engine is added.";
        }
        showOverlay("range-overlay-pending");
        return;
      }
      if (/not enough|enough singing/i.test(String(reason))) {
        showOverlay("range-overlay-retry");
        return;
      }
      const pending = $("range-pending-msg");
      if (pending) pending.textContent = "Could not estimate range: " + reason;
      showOverlay("range-overlay-pending");
      return;
    }

    showResults(result);
  }

  function showResults(result) {
    const card = $("range-results-body");
    if (!card) return;
    const lowN = midiToName(result.low);
    const highN = midiToName(result.high);
    const hint = result.voiceHint ? String(result.voiceHint) : "";
    const off = Number(result.offsetSemitones) || 0;
    const offAbs = Math.abs(off);
    const offDir =
      off === 0
        ? "at written pitch"
        : off < 0
          ? offAbs + " semitone" + (offAbs === 1 ? "" : "s") + " lower"
          : offAbs + " semitone" + (offAbs === 1 ? "" : "s") + " higher";

    let html =
      "<p><strong>Your comfortable range:</strong> " +
      lowN +
      " – " +
      highN +
      (hint ? " (" + hint + ")" : "") +
      ".</p>";
    if (result.tempoBpm != null && Number.isFinite(Number(result.tempoBpm))) {
      html +=
        "<p><strong>Your natural pace:</strong> ♩ = " +
        Math.round(Number(result.tempoBpm)) +
        ".</p>";
    }
    html +=
      "<p>Pieces will now start " +
      offDir +
      (result.tempoBpm != null && Number.isFinite(Number(result.tempoBpm))
        ? " at that tempo"
        : "") +
      ".</p>";
    card.innerHTML = html;
    card.dataset.result = JSON.stringify({
      low: result.low,
      high: result.high,
      center: result.center,
      offsetSemitones: off,
      tempoBpm: result.tempoBpm != null ? Number(result.tempoBpm) : null,
      voiceHint: hint || "",
    });
    showOverlay("range-overlay-results");
  }

  /** Match slider / follow.js: −18 … +6 (1½ octaves down to +½ octave). */
  function clampTranspose(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return 0;
    return Math.max(-18, Math.min(6, v));
  }

  function clampTempo(n) {
    const v = Math.round(Number(n));
    if (!Number.isFinite(v)) return null;
    return Math.max(40, Math.min(190, v));
  }

  function applyTransposeDefault(semis) {
    const t = clampTranspose(semis);
    const slider = $("transpose-slider");
    if (slider) {
      slider.value = String(t);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      // Avoid preview beep on load: only fire change when user-initiated elsewhere
      if (window.followPlayback && window.followPlayback.play) {
        window.followPlayback.play.transposeSemis = t;
      }
    }
  }

  function applyTempoDefault(bpm) {
    const t = clampTempo(bpm);
    if (t == null) return;
    const slider = $("tempo-slider");
    if (slider) {
      // snap to step=5
      const snapped = Math.round(t / 5) * 5;
      const v = Math.max(40, Math.min(190, snapped));
      slider.value = String(v);
      slider.dispatchEvent(new Event("input", { bubbles: true }));
      if (window.followPlayback && window.followPlayback.play) {
        window.followPlayback.play.tempo = v;
      }
      const val = $("tempo-val");
      if (val) val.textContent = String(v);
    }
  }

  function readStoredRange() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  /**
   * Show measured range inside the Transpose ▾ menu panel
   * (Re-measure / Clear + summary).
   */
  function updateRangeChip() {
    const tip = $("range-in-tip");
    const summary = $("range-in-tip-summary");
    const toggle = $("transpose-menu-toggle");
    const data = readStoredRange();
    if (!tip) return;
    if (!data || data.low == null || data.high == null) {
      tip.hidden = true;
      if (toggle) toggle.classList.remove("has-range");
      return;
    }
    const lowN = midiToName(data.low);
    const highN = midiToName(data.high);
    let text = lowN + " – " + highN;
    if (data.voiceHint) text += " (" + String(data.voiceHint) + ")";
    if (data.tempoBpm != null && Number.isFinite(Number(data.tempoBpm))) {
      text += " · ♩ = " + Math.round(Number(data.tempoBpm));
    }
    if (data.offsetSemitones != null && Number(data.offsetSemitones) !== 0) {
      const off = Number(data.offsetSemitones);
      text +=
        " · transpose " +
        (off > 0 ? "+" : "") +
        off;
    }
    if (summary) summary.textContent = text;
    tip.hidden = false;
    if (toggle) toggle.classList.add("has-range");
  }

  function applyStoredDefaults(opts) {
    const data = readStoredRange();
    if (!data) {
      updateRangeChip();
      return;
    }
    if (data.offsetSemitones != null) applyTransposeDefault(data.offsetSemitones);
    if (data.tempoBpm != null) applyTempoDefault(data.tempoBpm);
    updateRangeChip();
    if (opts && opts.previewTranspose && window.followPlayback && typeof window.followPlayback.previewTranspose === "function") {
      /* optional */
    }
  }

  function persistAndApply(result) {
    const payload = {
      low: result.low,
      high: result.high,
      center: result.center,
      offsetSemitones: clampTranspose(result.offsetSemitones),
      tempoBpm: result.tempoBpm != null ? clampTempo(result.tempoBpm) : null,
      voiceHint: result.voiceHint || "",
      ts: Date.now(),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn("range save failed", e);
    }
    applyTransposeDefault(payload.offsetSemitones);
    if (payload.tempoBpm != null) applyTempoDefault(payload.tempoBpm);
    // Preview pitch after user confirms
    const slider = $("transpose-slider");
    if (slider) slider.dispatchEvent(new Event("change", { bubbles: true }));
    updateRangeChip();
    finishSession();
  }

  function clearStoredRange() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (_) {
      /* ignore */
    }
    applyTransposeDefault(0);
    // leave tempo as-is when clearing range (user may have set it)
    updateRangeChip();
  }

  function finishSession() {
    session.active = false;
    session.recording = false;
    session.starting = false;
    session.frames = [];
    session.scoreJson = null;
    clearSessionTimers();
    hideOverlay();
    showCount(null);
    // The session turned the mic on; turn it back off. Leaving it running
    // kept the ambient pitch-ball bouncing after the user returned to the
    // app (reported as a stray ball at the screen edge post-measurement).
    try {
      if (window.pitchModule && typeof window.pitchModule.stopMic === "function") {
        window.pitchModule.stopMic();
      }
    } catch (_) {
      /* ignore */
    }
    try {
      if (window.trainer && typeof window.trainer.drawBall === "function") {
        window.trainer.drawBall(null);
      }
    } catch (_) {
      /* ignore */
    }
    // Leave Happy Birthday / range-test score; restore upload + calendar home
    restoreWelcomeScreen();
  }

  /** Clear the range-test piece and show the main drop-hint (upload + calendar). */
  function restoreWelcomeScreen() {
    try {
      if (window.followPlayback && typeof window.followPlayback.stopPlayback === "function") {
        window.followPlayback.stopPlayback();
      }
    } catch (_) {
      /* ignore */
    }
    try {
      if (window.trainer && typeof window.trainer.clearDocument === "function") {
        window.trainer.clearDocument();
      } else {
        const drop = $("drop-hint");
        const wrap = $("canvas-wrap");
        if (drop) drop.hidden = false;
        if (wrap) wrap.hidden = true;
      }
    } catch (e) {
      console.warn("range restore welcome", e);
    }
  }

  function resolveUrl(name) {
    try {
      return new URL(name, location.href).href;
    } catch (_) {
      return name;
    }
  }

  async function fetchFirstOk(names) {
    const list =
      (Array.isArray(names) && names.length && names) ||
      [];
    for (const name of list) {
      const url = resolveUrl(name);
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res && res.ok) return { name, res };
      } catch (e) {
        console.warn("range fetch failed", name, e);
      }
    }
    return null;
  }

  function isUsableScore(json) {
    if (!json || !Array.isArray(json.pages) || !json.pages.length) return false;
    let n = 0;
    for (const p of json.pages) {
      for (const st of p.staves || []) {
        n += (st.notes || []).length;
      }
    }
    return n >= 8;
  }

  /**
   * Load the Happy Birthday / range-test piece for Find your range.
   * Order:
   *  1) fetch JSON candidates (range-test.json, Happy_Birthday*.json, …)
   *  2) embedded window.RANGE_TEST_SCORE (range-test-data.js — works on file://)
   *  3) score already loaded in the app (Upload & Settings → Load custom score)
   * PDF: try fetch candidates for display; if PDF fetch fails but score is ok, keep going.
   */
  async function loadRangePiece() {
    if (!window.trainer) {
      alert("App load path not ready — try again in a moment.");
      return false;
    }

    const pdfNames =
      (window.RANGE_TEST_PDF_CANDIDATES && window.RANGE_TEST_PDF_CANDIDATES.length
        ? window.RANGE_TEST_PDF_CANDIDATES
        : null) || RANGE_PDF_CANDIDATES;
    const jsonNames =
      (window.RANGE_TEST_JSON_CANDIDATES && window.RANGE_TEST_JSON_CANDIDATES.length
        ? window.RANGE_TEST_JSON_CANDIDATES
        : null) || RANGE_JSON_CANDIDATES;

    // —— Score JSON ——
    let json = null;
    let jsonName = null;
    const jsonHit = await fetchFirstOk(jsonNames);
    if (jsonHit) {
      try {
        json = await jsonHit.res.json();
        jsonName = jsonHit.name;
      } catch (e) {
        console.warn("range json parse", e);
        json = null;
      }
    }
    if (!isUsableScore(json) && window.RANGE_TEST_SCORE && isUsableScore(window.RANGE_TEST_SCORE)) {
      json = window.RANGE_TEST_SCORE;
      jsonName = "RANGE_TEST_SCORE (embedded)";
    }
    if (!isUsableScore(json) && window.trainer.score && isUsableScore(window.trainer.score)) {
      // Already loaded via Upload & Settings (e.g. Happy Birthday score)
      json = window.trainer.score;
      jsonName = "currently loaded score";
    }
    if (!isUsableScore(json)) {
      alert(
        "Range test piece not installed.\n\n" +
          "Add range-test.json (or Happy_Birthday_To_You.json) next to index.html,\n" +
          "or load that score first via Upload & Settings → Load custom score,\n" +
          "then try Find your range again."
      );
      return false;
    }

    // —— PDF for display (best-effort) ——
    let pdfLoaded = false;
    const pdfHit = await fetchFirstOk(pdfNames);
    if (pdfHit && typeof window.trainer.loadPdfData === "function") {
      try {
        const buf = new Uint8Array(await pdfHit.res.arrayBuffer());
        await window.trainer.loadPdfData(buf, pdfHit.name, {
          fileSize: buf.byteLength,
          skipCache: true,
        });
        pdfLoaded = true;
      } catch (e) {
        console.warn("range pdf load", e);
      }
    }

    // Apply score (override extract if PDF was loaded)
    if (typeof window.trainer.setScore === "function") {
      window.trainer.setScore(json, { override: true });
    }
    session.scoreJson = json;
    fillHappyBirthdayLyrics(json);
    showScoreStage();
    // Second tick: ensure drop-hint stays hidden after any async extract UI
    setTimeout(showScoreStage, 50);
    setTimeout(showScoreStage, 250);
    console.info(
      "[Byzantine Voice] Find your range loaded score from",
      jsonName,
      pdfLoaded ? "+ PDF" : "(no PDF fetched; score only)"
    );
    return true;
  }

  async function startFindRange() {
    setAssessMenuOpen(false);
    stopPracticeModes();
    installPitchTap();

    const ok = await loadRangePiece();
    if (!ok) return;

    session.active = true;
    session.recording = false;
    session.starting = false;
    session.frames = [];
    session.voicedMs = 0;
    session.lastVoicedAt = 0;
    session.lastFrameT = 0;
    session.silenceRunStart = 0;
    // Large Happy Birthday card stays centered for intro → 3-2-1 → listen
    showOverlay("range-overlay-intro");
  }

  async function beginListening() {
    if (!session.active || session.recording || session.starting) return;
    session.starting = true;
    // Leave large card on screen; only drop is-clickable while we prepare
    const sheet = $("range-piece-sheet");
    if (sheet) sheet.classList.remove("is-clickable");

    try {
      const micOk = await ensureMicOn();
      if (!micOk) {
        // existing mic-error UI should already show
        finishSession();
        return;
      }
      if (!session.active) return;

      // Keep stage + large card; flash 3-2-1 on the card itself
      await runCountdown();
      if (!session.active) return;

      session.recording = true;
      session.t0 = performance.now();
      session.frames = [];
      session.voicedMs = 0;
      session.lastVoicedAt = 0;
      session.lastFrameT = session.t0;
      session.silenceRunStart = 0;
      showOverlay("range-overlay-listen");

      session.tickTimer = setInterval(() => {
        if (!session.recording) return;
        const now = performance.now();
        const elapsed = now - session.t0;
        if (elapsed >= MAX_SESSION_MS) {
          endRecording("cap");
          return;
        }
        if (
          session.voicedMs >= MIN_VOICED_BEFORE_SILENCE_MS &&
          session.silenceRunStart > 0 &&
          now - session.silenceRunStart >= SILENCE_END_MS
        ) {
          endRecording("silence");
        }
      }, 200);
    } finally {
      session.starting = false;
    }
  }

  function wireUi() {
    const menu = $("assess-menu");
    const toggle = $("assess-menu-toggle");
    const panel = $("assess-menu-panel");
    const findBtn = $("find-range-btn");
    const diagBtn = $("diag-btn");

    if (toggle && panel) {
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        setAssessMenuOpen(!!panel.hidden);
      });
      document.addEventListener("pointerdown", (e) => {
        if (!panel.hidden && menu && e.target && !menu.contains(e.target)) {
          setAssessMenuOpen(false);
        }
      });
    }

    // Assess selection: leave #diag-btn for diagnose.js — close menu first
    if (diagBtn) {
      diagBtn.addEventListener(
        "click",
        () => {
          setAssessMenuOpen(false);
        },
        true
      );
    }

    if (findBtn) {
      findBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        startFindRange().catch((err) => console.error(err));
      });
    }

    // Large Happy Birthday card stays put; click it during intro to start 3-2-1
    const sheet = $("range-piece-sheet");
    if (sheet) {
      sheet.addEventListener("click", (e) => {
        if (e.target && e.target.closest && e.target.closest("#range-stop-btn")) return;
        if (!session.active || session.recording) return;
        if (!sheet.classList.contains("is-clickable")) return;
        beginListening().catch((err) => console.error(err));
      });
    }

    const stopBtn = $("range-stop-btn");
    if (stopBtn) {
      stopBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        endRecording("stop");
      });
    }

    const retryBtn = $("range-retry-btn");
    if (retryBtn) {
      retryBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        session.frames = [];
        session.voicedMs = 0;
        showOverlay("range-overlay-intro");
      });
    }

    const cancelBtn = $("range-cancel-btn");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        finishSession();
      });
    }

    const useBtn = $("range-use-btn");
    if (useBtn) {
      useBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const body = $("range-results-body");
        if (!body || !body.dataset.result) {
          finishSession();
          return;
        }
        try {
          const result = JSON.parse(body.dataset.result);
          persistAndApply(result);
        } catch (_) {
          finishSession();
        }
      });
    }

    const discardBtn = $("range-discard-btn");
    if (discardBtn) {
      discardBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        finishSession();
      });
    }

    const pendingOk = $("range-pending-ok");
    if (pendingOk) {
      pendingOk.addEventListener("click", (e) => {
        e.stopPropagation();
        finishSession();
      });
    }

    // Range actions live inside Transpose circled-i tip
    const remeasure = $("range-chip-remeasure");
    if (remeasure) {
      remeasure.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        startFindRange().catch((err) => console.error(err));
      });
    }
    const clearBtn = $("range-chip-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        clearStoredRange();
      });
    }
  }

  function install() {
    if (!$("assess-menu-toggle") && !$("find-range-btn")) {
      // HTML not yet updated in some hosts
      return;
    }
    // Wait for trainer + pitch
    if (!window.trainer) {
      setTimeout(install, 50);
      return;
    }
    wireUi();
    installPitchTap();
    // Apply stored defaults after follow.js has wired sliders
    setTimeout(() => applyStoredDefaults(), 100);
    setTimeout(() => applyStoredDefaults(), 400);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
})();
