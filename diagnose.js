/**
 * diagnose.js — free-tempo section analysis (no audio recording).
 *
 * Flow:
 *  1. Toggle Diagnose on
 *  2. Click a START note, then a STOP note (range highlighted)
 *  3. Press “Sing section” (mic on) and sing through at any speed/octave
 *  4. Press “Finish” → report; wrong notes marked red on the score
 *  5. Session metadata (section + mistake categories) saved per PDF in localStorage
 *     — pitch samples only live in memory during the run; nothing is recorded.
 */
(() => {
  "use strict";

  /**
   * In-tune / near / wrong bands (¢).
   * Green: tight (vibrato room). Yellow: still “close” — almost a whole step.
   * Red: clearly far. Previously NEAR was only 140¢ so mild misses looked red.
   */
  const OK_CENTS = 55;
  const NEAR_CENTS = 230;
  const WRONG_CENTS = 420;
  /**
   * Plateau detection: chant often holds one pitch across many written notes.
   * Long holds stay one plateau; DP alignment splits them across same-pitch score notes.
   */
  /**
   * Must stay < 100¢ so adjacent scale steps (half-steps) start new plateaus.
   * Wider values merged 64→65 into one plateau and the DP left a “missing” note.
   */
  const PLATEAU_CENTS = 75;
  const PLATEAU_GAP_MS = 750;
  /** Soft floor for plateau duration (ms); very short blips still accepted with ≥2 frames. */
  const PLATEAU_MIN_MS = 30;
  /** Min ms of plateau time allotted per written note when covering a same-pitch run. */
  /** Softer so a long reciting hold covers more written quarters. */
  const MS_PER_SCORE_NOTE = 70;
  /** DP costs (lower is better). */
  const COST_SKIP_NOTE = 180; // mark expected note missing
  const COST_SKIP_PLATEAU = 35; // discard noise plateau
  const STORAGE_PREFIX = "byzantine-diag-v1:";

  const diag = {
    on: false,
    /** null | 'needStart' | 'needEnd' | 'ready' | 'listening' | 'done' */
    phase: null,
    start: null,
    end: null,
    /** { t, midi }[] while listening — discarded after analysis */
    samples: [],
    lastResult: null,
    /** Instructions panel expanded (false → small yellow tab only) */
    instructionsOpen: true,
  };

  function $(id) {
    return document.getElementById(id);
  }

  function trainer() {
    return window.trainer;
  }

  /**
   * One-time intro in the yellow top panel (shown only the first time Assess is
   * turned on in this browser). Live prompts live only in the cream dock below.
   */
  const HELP_TEXT =
    "This assessment only evaluates the pitch you sing for each note from a beginning note to an ending note.";
  const HELP_SEEN_KEY = "byzantine-assess-help-seen-v1";

  function hasSeenHelp() {
    try {
      return !!(typeof localStorage !== "undefined" && localStorage.getItem(HELP_SEEN_KEY));
    } catch (_) {
      return false;
    }
  }

  function markHelpSeen() {
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(HELP_SEEN_KEY, "1");
    } catch (_) {
      /* private mode etc. */
    }
  }

  /** Close the yellow intro panel permanently for this browser. */
  function dismissHelpPanel() {
    markHelpSeen();
    diag.instructionsOpen = false;
    setHelpPanel("");
    setInstructionsOpen(false);
  }

  function setInstructionsOpen(open) {
    // After help has been seen once, never re-open the intro panel
    if (open && hasSeenHelp()) open = false;
    diag.instructionsOpen = !!open;
    const ui = $("diag-ui");
    const panel = $("diag-panel");
    const tab = $("diag-tab");
    if (!ui) return;
    if (!diag.on) {
      ui.hidden = true;
      if (panel) panel.hidden = true;
      if (tab) tab.hidden = true;
      return;
    }
    ui.hidden = false;
    if (panel) panel.hidden = !diag.instructionsOpen;
    // No re-open tab after intro has been dismissed permanently
    if (tab) tab.hidden = true;
  }

  function setHelpPanel(text) {
    const el = $("diag-banner-text") || $("diag-banner");
    if (el) el.textContent = text || "";
  }

  /**
   * Live status in the cream action dock only (never mirrored into the yellow intro).
   */
  function setStatusLine(msg, listening) {
    const line = $("diag-status-line");
    const dock = $("diag-action-dock");
    if (line) {
      line.textContent = msg || "";
      line.hidden = !msg;
    }
    if (dock) dock.classList.toggle("is-listening", !!listening);
  }

  /**
   * Live phase status. opts.forceOpen shows the one-time yellow intro if not yet seen.
   */
  function setBanner(msg, listening, opts) {
    const b = $("diag-banner");
    const forceOpen = opts && opts.forceOpen === true;
    const ui = $("diag-ui");
    if (ui && diag.on) ui.hidden = false;

    if (forceOpen && !hasSeenHelp()) {
      setHelpPanel(HELP_TEXT);
      setInstructionsOpen(true);
      setStatusLine(msg || "Click the START note.", !!listening);
      if (b) b.classList.toggle("is-listening", !!listening);
      return;
    }

    if (forceOpen && hasSeenHelp()) {
      // Already seen intro — only short dock status
      setInstructionsOpen(false);
      setStatusLine(msg || "Click the START note.", !!listening);
      if (b) b.classList.toggle("is-listening", !!listening);
      return;
    }

    if (!msg) {
      setStatusLine("", false);
      if (b) b.classList.remove("is-listening");
      return;
    }

    // Live updates never rewrite the intro panel
    setStatusLine(msg, listening);
    if (b) b.classList.toggle("is-listening", !!listening);
  }

  function setReport(html) {
    const r = $("diag-report");
    const panel = $("diag-report-panel");
    if (!r) return;
    if (!html) {
      r.innerHTML = "";
      if (panel) panel.hidden = true;
      return;
    }
    r.innerHTML = html;
    if (panel) panel.hidden = false;
    // Keep results visible even if instructions are collapsed
    const ui = $("diag-ui");
    if (ui && diag.on) ui.hidden = false;
  }

  function setBtn(on) {
    const b = $("diag-btn");
    if (!b) return;
    b.setAttribute("aria-pressed", String(on));
    b.classList.toggle("is-on", on);
    b.textContent = on ? "Assess On" : "Assess Singing";
  }

  function range() {
    if (diag.start == null || diag.end == null) return null;
    return {
      start: Math.min(diag.start, diag.end),
      end: Math.max(diag.start, diag.end),
    };
  }

  function refreshVisual(marks) {
    const t = trainer();
    if (!t || !t.setDiagVisual) return;
    t.setDiagVisual({
      range: range(),
      marks: marks || null,
    });
  }

  /** Wipe range band + result balls/rings from the staff (leave no residual marks). */
  function clearStaffMarks() {
    const t = trainer();
    if (t && t.setDiagVisual) {
      t.setDiagVisual({ range: null, marks: null });
    }
  }

  function storageKey() {
    const t = trainer();
    const key = (t && (t.cacheKey || t.pdfName)) || "unknown.pdf";
    return STORAGE_PREFIX + key;
  }

  function loadHistory() {
    try {
      const raw = localStorage.getItem(storageKey());
      if (!raw) return [];
      const j = JSON.parse(raw);
      return Array.isArray(j.sessions) ? j.sessions : [];
    } catch (_) {
      return [];
    }
  }

  function saveSession(session) {
    try {
      const prev = loadHistory();
      prev.unshift(session);
      // keep last 40 sessions per PDF
      const sessions = prev.slice(0, 40);
      localStorage.setItem(
        storageKey(),
        JSON.stringify({ pdf: storageKey(), sessions })
      );
    } catch (e) {
      console.warn("diag save failed", e);
    }
  }

  // —— Pitch stream helpers (analysis only; not stored long-term) ——

  function segmentPlateaus(samples) {
    const voiced = samples.filter((s) => s.midi != null && Number.isFinite(s.midi));
    if (!voiced.length) return [];

    const raw = [];
    let buf = [voiced[0]];

    function flush() {
      if (!buf.length) return;
      const t0 = buf[0].t;
      const t1 = buf[buf.length - 1].t;
      // Accept brief but real syllables (1–2 voiced frames at ~50 Hz)
      if (t1 - t0 < PLATEAU_MIN_MS && buf.length < 2) {
        buf = [];
        return;
      }
      const mids = buf.map((b) => b.midi).sort((a, b) => a - b);
      // Trim outliers: use central half of samples for median stability
      const lo = Math.floor(mids.length * 0.2);
      const hi = Math.max(lo + 1, Math.ceil(mids.length * 0.8));
      const core = mids.slice(lo, hi);
      const midi = core[Math.floor(core.length / 2)];
      raw.push({ midi, t0, t1, dur: Math.max(40, t1 - t0), frames: buf.length });
      buf = [];
    }

    for (let i = 1; i < voiced.length; i++) {
      const prev = buf[buf.length - 1];
      const cur = voiced[i];
      const cents = Math.abs(cur.midi - prev.midi) * 100;
      const gap = cur.t - prev.t;
      if (cents <= PLATEAU_CENTS && gap < PLATEAU_GAP_MS) {
        buf.push(cur);
      } else {
        flush();
        buf = [cur];
      }
    }
    flush();

    // Merge consecutive plateaus that are the same pitch with a short gap
    // (consonant holes in a long reciting tone)
    if (raw.length < 2) return raw;
    const merged = [raw[0]];
    for (let i = 1; i < raw.length; i++) {
      const a = merged[merged.length - 1];
      const b = raw[i];
      const cents = Math.abs(a.midi - b.midi) * 100;
      const gap = b.t0 - a.t1;
      if (cents <= PLATEAU_CENTS && gap < PLATEAU_GAP_MS) {
        const wA = a.dur;
        const wB = b.dur;
        a.midi = (a.midi * wA + b.midi * wB) / (wA + wB);
        a.t1 = b.t1;
        a.dur = Math.max(40, a.t1 - a.t0);
        a.frames = (a.frames || 0) + (b.frames || 0);
      } else {
        merged.push(b);
      }
    }
    return merged;
  }

  /**
   * Diagnose allows any octave: fold sung pitch to nearest octave of target.
   */
  function foldTo(sung, target) {
    if (!Number.isFinite(sung) || !Number.isFinite(target)) return sung;
    const oct = Math.round((sung - target) / 12);
    return sung - 12 * oct;
  }

  /** User Transpose from Tempo & Transpose menu (semitones). */
  function userTranspose() {
    try {
      const p = window.followPlayback && window.followPlayback.play;
      return (p && p.transposeSemis) || 0;
    } catch (_) {
      return 0;
    }
  }

  function expectedMidi(n) {
    if (!n || n.midi == null) return null;
    return Number(n.midi) + userTranspose();
  }

  function categoryFromCents(cents) {
    if (cents <= OK_CENTS) return "ok";
    if (cents <= NEAR_CENTS) return "near";
    if (cents <= WRONG_CENTS) return "wrong";
    return null;
  }

  function matchCost(cents) {
    if (cents <= OK_CENTS) return cents * 0.15;
    if (cents <= NEAR_CENTS) return 40 + (cents - OK_CENTS) * 0.35;
    if (cents <= WRONG_CENTS) return 90 + (cents - NEAR_CENTS) * 0.4;
    return 1e9;
  }

  /**
   * How many consecutive expected notes ending at j-1 share ~the same pitch?
   */
  function samePitchRunLength(expected, jEnd) {
    // jEnd is exclusive index in DP space (number of notes matched)
    if (jEnd <= 0) return 0;
    const pitch = expected[jEnd - 1].midi;
    let cover = 1;
    while (jEnd - cover - 1 >= 0) {
      if (Math.abs(expected[jEnd - cover - 1].midi - pitch) > 0.9) break;
      cover += 1;
      if (cover >= 64) break;
    }
    return cover;
  }

  /**
   * DP free-tempo align: plateaus (sung) ↔ expected score notes.
   *
   * Transitions:
   *  - skip plateau (noise)
   *  - skip note (missing)
   *  - match plateau → 1..K consecutive same-pitch score notes (duration-limited)
   *
   * This replaces brittle greedy left-to-right matching and is the main fix for
   * “I sang the reciting tone but half the notes are missing.”
   */
  function alignPlateausToExpected(expected, plateaus) {
    const n = expected.length;
    const m = plateaus.length;
    const INF = 1e12;
    // dp[j][i] = best cost matching expected[0..j) with plateaus[0..i)
    const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(INF));
    const bt = Array.from({ length: n + 1 }, () => Array(m + 1).fill(null));
    dp[0][0] = 0;
    for (let i = 1; i <= m; i++) {
      dp[0][i] = dp[0][i - 1] + COST_SKIP_PLATEAU;
      bt[0][i] = { op: "skipP", j: 0, i: i - 1 };
    }
    for (let j = 1; j <= n; j++) {
      dp[j][0] = dp[j - 1][0] + COST_SKIP_NOTE;
      bt[j][0] = { op: "skipN", j: j - 1, i: 0 };
    }

    for (let j = 1; j <= n; j++) {
      const runMax = samePitchRunLength(expected, j);
      for (let i = 1; i <= m; i++) {
        // Skip plateau i-1
        let c = dp[j][i - 1] + COST_SKIP_PLATEAU;
        if (c < dp[j][i]) {
          dp[j][i] = c;
          bt[j][i] = { op: "skipP", j, i: i - 1 };
        }
        // Skip note j-1
        c = dp[j - 1][i] + COST_SKIP_NOTE;
        if (c < dp[j][i]) {
          dp[j][i] = c;
          bt[j][i] = { op: "skipN", j: j - 1, i };
        }
        // Match plateau i-1 onto cover consecutive same-pitch notes ending at j-1
        const p = plateaus[i - 1];
        const target = expected[j - 1].midi;
        const folded = foldTo(p.midi, target);
        const cents = Math.abs(folded - target) * 100;
        if (cents > WRONG_CENTS) continue;

        const maxByDur = Math.max(1, Math.floor(p.dur / MS_PER_SCORE_NOTE + 0.35));
        const maxCover = Math.min(runMax, maxByDur, j);
        for (let cover = 1; cover <= maxCover; cover++) {
          // Soft duration: allow short covers even if dur is tight
          if (cover > 1 && p.dur < cover * MS_PER_SCORE_NOTE * 0.45) continue;
          const mc = matchCost(cents) + (cover - 1) * 3;
          c = dp[j - cover][i - 1] + mc;
          if (c < dp[j][i]) {
            dp[j][i] = c;
            bt[j][i] = {
              op: "match",
              j: j - cover,
              i: i - 1,
              cover,
              folded,
              cents,
              plateau: p,
            };
          }
        }
      }
    }

    // Backtrack → assignment map expectedIndex → {category, cents, sungMidi, ...}
    const assign = new Array(n).fill(null);
    let j = n;
    let i = m;
    while (j > 0 || i > 0) {
      const b = bt[j][i];
      if (!b) break;
      if (b.op === "skipP") {
        i = b.i;
      } else if (b.op === "skipN") {
        // leave assign[j-1] null → missing
        j = b.j;
      } else if (b.op === "match") {
        const cover = b.cover || 1;
        for (let k = 0; k < cover; k++) {
          const ej = j - cover + k;
          const exp = expected[ej];
          const foldK = foldTo(b.plateau.midi, exp.midi);
          const cK = Math.abs(foldK - exp.midi) * 100;
          const cat = categoryFromCents(cK) || "wrong";
          assign[ej] = {
            category: cat,
            cents: Math.round(cK),
            signedCents: Math.round((foldK - exp.midi) * 100),
            sungMidi: foldK,
          };
        }
        j = b.j;
        i = b.i;
      } else {
        break;
      }
    }
    return assign;
  }

  /**
   * Free-tempo section analysis: plateaus + DP align to score.
   */
  function analyzeSection(notes, start, end, samples) {
    const expected = [];
    for (let i = start; i <= end; i++) {
      if (notes[i] && notes[i].midi != null) {
        expected.push({ i, n: notes[i], midi: expectedMidi(notes[i]) });
      }
    }
    const plateaus = segmentPlateaus(samples);
    const assign = alignPlateausToExpected(expected, plateaus);
    const marks = [];

    for (let e = 0; e < expected.length; e++) {
      const { i, n } = expected[e];
      const a = assign[e];
      if (!a) {
        marks.push({
          index: i,
          category: "missing",
          cents: null,
          signedCents: null,
          sungMidi: null,
          expectedMidi: expectedMidi(n),
          lyric: n.lyric || "",
        });
      } else {
        marks.push({
          index: i,
          category: a.category,
          cents: a.cents,
          signedCents: a.signedCents,
          sungMidi: a.sungMidi,
          expectedMidi: expectedMidi(n),
          lyric: n.lyric || "",
        });
      }
    }

    const summary = { ok: 0, near: 0, wrong: 0, missing: 0 };
    for (const m of marks) summary[m.category] = (summary[m.category] || 0) + 1;

    return {
      marks,
      summary,
      plateauCount: plateaus.length,
      expectedCount: expected.length,
      sampleCount: samples.filter((s) => s.midi != null).length,
      alignMethod: "dp-v2",
    };
  }

  function categoryLabel(c) {
    if (c === "ok") return "in tune";
    if (c === "near") return "close / slightly off";
    if (c === "wrong") return "wrong note (red)";
    if (c === "missing") return "not clearly sung";
    return c;
  }

  function showResult(result, start, end) {
    const t = trainer();
    const notes = (t && t.notes) || [];
    const problems = result.marks.filter((m) => m.category === "wrong" || m.category === "missing");
    const s = result.summary;
    const total = result.expectedCount || 1;
    const pct = Math.round(((s.ok + s.near * 0.5) / total) * 100);

    let html = `<h3>Section analysis (notes ${start + 1}–${end + 1})</h3>`;
    html += `<div class="diag-stats">
      <span class="stat-ok">In tune: ${s.ok}</span>
      <span class="stat-near">Close: ${s.near}</span>
      <span class="stat-wrong">Wrong: ${s.wrong}</span>
      <span class="stat-missing">Missing: ${s.missing}</span>
      <span>Score ≈ ${pct}%</span>
    </div>`;
    html += `<p style="margin:0;color:var(--muted);font-size:0.9rem">
      Free tempo / any octave. Pitch is matched with dual detectors (YIN + McLeod) and
      DP alignment (same-pitch reciting holds can cover many score notes).
      Heard <strong>${result.plateauCount || 0}</strong> plateaus from
      <strong>${result.sampleCount || 0}</strong> voiced frames
      (for ${result.expectedCount} score notes).
      ${
        (result.sampleCount || 0) < 5
          ? "<br><strong>Few voiced frames — check mic is On and sing a steady vowel.</strong>"
          : ""
      }
    </p>`;

    if (problems.length) {
      html += `<p style="margin:0.5rem 0 0.15rem;font-weight:600">Attention (wrong / missing):</p><ul>`;
      for (const m of problems.slice(0, 24)) {
        const n = notes[m.index];
        const ly = (n && n.lyric) || "·";
        let c = "";
        if (m.signedCents != null) {
          const dir = m.signedCents > 0 ? "high" : m.signedCents < 0 ? "low" : "on";
          c = ` (~${Math.abs(m.signedCents)}¢ ${dir})`;
        } else if (m.cents != null) {
          c = ` (~${m.cents}¢ off)`;
        }
        html += `<li>#${m.index + 1} “${escapeHtml(ly)}” — ${categoryLabel(m.category)}${c}</li>`;
      }
      if (problems.length > 24) html += `<li>…and ${problems.length - 24} more</li>`;
      html += `</ul>`;
    } else {
      html += `<p class="stat-ok" style="margin:0.5rem 0 0">No major wrong/missing notes in this pass.</p>`;
    }

    html += `<div class="diag-actions">
      <button type="button" class="btn" id="diag-sing-again">Sing again</button>
      <button type="button" class="btn" id="diag-clear-marks">Clear marks</button>
      <button type="button" class="btn" id="diag-new-range">New range</button>
    </div>`;

    setReport(html);
    refreshVisual(result.marks);

    const again = document.getElementById("diag-sing-again");
    if (again) again.addEventListener("click", startListening);
    const clr = document.getElementById("diag-clear-marks");
    if (clr)
      clr.addEventListener("click", () => {
        clearStaffMarks();
        // Restore range highlight only (no result balls)
        diag.lastResult = null;
        refreshVisual(null);
        refreshVisual();
        setReport("");
        diag.phase = "ready";
        setBanner(
          `Assess: notes ${start + 1}–${end + 1} selected. Press “Sing section” when ready.`,
          false,
          { forceOpen: false }
        );
        updateActionButtons();
      });
    const nr = document.getElementById("diag-new-range");
    if (nr)
      nr.addEventListener("click", () => {
        diag.start = null;
        diag.end = null;
        diag.lastResult = null;
        diag.phase = "needStart";
        clearStaffMarks();
        setReport("");
        setBanner("Assess: click the START note of the section.", false, {
          forceOpen: false,
        });
        updateActionButtons();
      });
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function updateActionButtons() {
    // Buttons live in #diag-action-dock (sibling of the collapsible panel) so they
    // stay clickable even when the user collapses the long yellow instructions.
    const dock = $("diag-action-dock");
    let bar = $("diag-action-bar");
    if (!bar && dock) {
      bar = document.createElement("div");
      bar.id = "diag-action-bar";
      bar.className = "diag-actions";
      dock.appendChild(bar);
    }
    if (!bar) return;

    if (!diag.on) {
      if (dock) dock.hidden = true;
      bar.innerHTML = "";
      return;
    }

    const needsDock =
      diag.phase === "ready" ||
      diag.phase === "listening" ||
      diag.phase === "cueing" ||
      diag.phase === "needStart" ||
      diag.phase === "needEnd";

    if (dock) {
      dock.hidden = !needsDock;
      dock.classList.toggle(
        "is-listening",
        diag.phase === "listening" || diag.phase === "cueing"
      );
    }

    if (diag.phase === "listening" || diag.phase === "cueing") {
      bar.innerHTML = `<button type="button" class="btn btn-primary" id="diag-finish-btn">Finish singing</button>
        <button type="button" class="btn" id="diag-cancel-listen">Cancel</button>`;
      const f = document.getElementById("diag-finish-btn");
      if (f) f.addEventListener("click", finishListening);
      const c = document.getElementById("diag-cancel-listen");
      if (c)
        c.addEventListener("click", () => {
          diag.samples = [];
          diag.phase = "ready";
          ensureMicOff();
          setBanner(
            `Assess: notes ${range().start + 1}–${range().end + 1} selected. Press “Sing section”.`,
            false,
            { forceOpen: false }
          );
          updateActionButtons();
        });
      return;
    }

    if (diag.phase === "ready") {
      bar.innerHTML = `<button type="button" class="btn btn-primary" id="diag-sing-btn">Sing section</button>`;
      const s = document.getElementById("diag-sing-btn");
      if (s) s.addEventListener("click", startListening);
      return;
    }

    // Selecting range: no primary action yet — dock shows status only
    bar.innerHTML = "";
  }

  function ensureMic() {
    // Real gesture path: pitchModule or the Sound & Mic switch / hidden mic-btn
    if (window.pitchModule && typeof window.pitchModule.startMic === "function") {
      if (!micIsOn()) {
        window.pitchModule.startMic().catch((e) => console.warn("diag mic", e));
      }
      return;
    }
    const sw = $("mic-switch");
    if (sw && !sw.checked) {
      sw.checked = true;
      sw.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const mic = $("mic-btn");
    if (mic && mic.getAttribute("aria-pressed") !== "true") {
      mic.click();
    }
  }

  function ensureMicOff() {
    if (window.pitchModule && typeof window.pitchModule.stopMic === "function") {
      window.pitchModule.stopMic().catch((e) => console.warn("diag mic off", e));
      return;
    }
    const sw = $("mic-switch");
    if (sw && sw.checked) {
      sw.checked = false;
      sw.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function micIsOn() {
    const sw = $("mic-switch");
    if (sw) return !!sw.checked;
    const mic = $("mic-btn");
    return !!(mic && mic.getAttribute("aria-pressed") === "true");
  }

  /**
   * Sing section: turn mic on, play the first note of the range as a pitch cue
   * (no countdown), then start capturing samples so the cue isn’t scored as singing.
   */
  async function startListening() {
    const r = range();
    if (!r) return;
    const t = trainer();
    if (!t || !t.notes || !t.notes[r.start]) return;

    if (window.followPlayback && window.followPlayback.stopPlayback) {
      window.followPlayback.stopPlayback();
    }
    // Unlock audio on this click (Safari)
    if (window.AppAudio) {
      if (typeof window.AppAudio.ensureLive === "function") {
        await window.AppAudio.ensureLive();
      } else {
        window.AppAudio.unlock();
      }
    }

    diag.samples = [];
    diag.lastResult = null;
    diag.phase = "cueing"; // not sampling yet
    setReport("");
    refreshVisual(null);
    refreshVisual(); // range only
    ensureMic();

    const first = t.notes[r.start];
    if (t.focusNote) t.focusNote(r.start);

    setBanner(
      `Hear the starting note, then sing notes ${r.start + 1}–${r.end + 1}. Press Finish when done.`,
      true,
      { forceOpen: false }
    );
    updateActionButtons();

    // Play first pitch once (single clean cue — no syllable pulses / no seekTo)
    if (first.midi != null) {
      if (window.followPlayback && typeof window.followPlayback.playNoteCue === "function") {
        window.followPlayback.playNoteCue(first, 700);
      }
    }

    // Wait for cue to finish so speaker tone isn’t treated as your singing
    const cueMs = 780;
    await new Promise((res) => setTimeout(res, cueMs));
    if (diag.phase !== "cueing") return; // cancelled

    diag.samples = [];
    diag.phase = "listening";
    setBanner(
      micIsOn()
        ? `LISTENING — sing notes ${r.start + 1}–${r.end + 1}. Press Finish when done.`
        : `Mic still starting — sing notes ${r.start + 1}–${r.end + 1}. Press Finish when done.`,
      true,
      { forceOpen: false }
    );
    updateActionButtons();

    let tries = 0;
    const waitMic = setInterval(() => {
      tries += 1;
      if (diag.phase !== "listening") {
        clearInterval(waitMic);
        return;
      }
      if (micIsOn()) {
        clearInterval(waitMic);
        setBanner(
          `LISTENING — sing notes ${r.start + 1}–${r.end + 1} at any tempo. Press Finish when done.`,
          true,
          { forceOpen: false }
        );
      } else if (tries >= 30) {
        clearInterval(waitMic);
        setBanner(
          `Mic not on — open Sound & Mic, turn mic on, then sing. Press Finish when done.`,
          true,
          { forceOpen: false }
        );
      }
    }, 120);
  }

  function finishListening() {
    const t = trainer();
    const r = range();
    if (!t || !r) return;

    // Copy samples then clear (no long-term audio or pitch dump)
    const samples = diag.samples.slice();
    diag.samples = [];
    diag.phase = "done";

    const result = analyzeSection(t.notes, r.start, r.end, samples);
    diag.lastResult = result;

    const session = {
      when: new Date().toISOString(),
      startIndex: r.start,
      endIndex: r.end,
      noteCount: result.expectedCount,
      summary: result.summary,
      // Only mistake categories + note indices — never raw audio or pitch streams
      mistakes: result.marks
        .filter((m) => m.category === "wrong" || m.category === "missing" || m.category === "near")
        .map((m) => ({
          index: m.index,
          category: m.category,
          cents: m.cents,
          lyric: m.lyric,
        })),
    };
    saveSession(session);

    ensureMicOff();
    setBanner(
      `DONE — ${result.summary.wrong} wrong, ${result.summary.missing} missing, ${result.summary.ok} in tune.`,
      false,
      { forceOpen: false }
    );
    showResult(result, r.start, r.end);
    updateActionButtons();
  }

  function onPitch(midiFloat, clarity) {
    if (!diag.on || diag.phase !== "listening") return;
    // Ignore our own speaker tones (first-note cue)
    if (window.followPlayback && typeof window.followPlayback.tonesActive === "function") {
      if (window.followPlayback.tonesActive()) return;
    }
    // Pitch numbers only, in memory for this run
    diag.samples.push({ t: performance.now(), midi: midiFloat });
    // Cap memory (~3 minutes at 50 Hz)
    if (diag.samples.length > 10000) diag.samples.shift();
  }

  /**
   * @returns {boolean} true = consume click (do not seek/play via follow)
   */
  function handleNoteClick(i) {
    if (!diag.on) return false;
    // While analyzing / cueing, ignore retarget clicks so the singer isn't interrupted
    if (diag.phase === "listening" || diag.phase === "cueing") return true;

    const t = trainer();
    if (!t || !t.notes[i]) return false;

    if (
      diag.phase === "needStart" ||
      diag.phase === "needEnd" ||
      diag.phase === "ready" ||
      diag.phase === "done"
    ) {
      if (diag.start == null || diag.phase === "needStart") {
        diag.start = i;
        diag.end = null;
        diag.phase = "needEnd";
        diag.lastResult = null;
        setReport("");
        // Intro no longer needed once the user starts selecting
        dismissHelpPanel();
        setBanner(`Start = note ${i + 1}. Now click the ENDING note.`, false, {
          forceOpen: false,
        });
        refreshVisual(null);
        refreshVisual();
        updateActionButtons();
        // Consume click — play once here only (avoid seekTo double-play)
        if (window.followPlayback && window.followPlayback.playNoteCue) {
          window.followPlayback.playNoteCue(t.notes[i], 550);
        }
        t.focusNote && t.focusNote(i);
        return true;
      }
      diag.end = i;
      if (diag.end === diag.start) {
        setBanner("Ending note is the same as start — click a different note for the end.", false, {
          forceOpen: false,
        });
        diag.phase = "needEnd";
        return true;
      }
      diag.phase = "ready";
      const r = range();
      setBanner(
        `Section: notes ${r.start + 1}–${r.end + 1} (${r.end - r.start + 1} notes). Press “Sing section”.`,
        false,
        { forceOpen: false }
      );
      refreshVisual(null);
      refreshVisual();
      updateActionButtons();
      if (window.followPlayback && window.followPlayback.playNoteCue) {
        window.followPlayback.playNoteCue(t.notes[i], 550);
      }
      t.focusNote && t.focusNote(i);
      return true; // do not seekTo (would play again)
    }
    return false;
  }

  function enterMode() {
    diag.on = true;
    diag.phase = "needStart";
    diag.start = null;
    diag.end = null;
    diag.samples = [];
    diag.lastResult = null;
    // Yellow intro only the first time ever in this browser
    diag.instructionsOpen = !hasSeenHelp();
    setBtn(true);
    setReport("");
    refreshVisual(null);
    if (window.followPlayback && window.followPlayback.stopPlayback) {
      window.followPlayback.stopPlayback();
    }
    setBanner("Click the START note.", false, { forceOpen: true });
    updateActionButtons();
  }

  function exitMode() {
    diag.on = false;
    diag.phase = null;
    diag.start = null;
    diag.end = null;
    diag.samples = [];
    diag.lastResult = null;
    diag.instructionsOpen = false;
    setBtn(false);
    setBanner(null);
    setReport("");
    // Leaving Assess always releases the mic; Begin / Match Pitch turn it on again.
    ensureMicOff();
    // Must clear start/end first, then wipe overlay — otherwise residual
    // green/red/yellow diagnosis marks stay on the staff after Assess Off.
    clearStaffMarks();
    updateActionButtons();
    const ui = $("diag-ui");
    if (ui) ui.hidden = true;
    const dock = $("diag-action-dock");
    if (dock) dock.hidden = true;
    const reportPanel = $("diag-report-panel");
    if (reportPanel) reportPanel.hidden = true;
    const bar = document.getElementById("diag-action-bar");
    if (bar) bar.innerHTML = "";
  }

  function toggle() {
    if (diag.on) exitMode();
    else enterMode();
  }

  function install() {
    // Headless / missing UI: pure analysis is on diagnoseCore — no DOM install
    if (typeof document === "undefined" || typeof document.getElementById !== "function") {
      return;
    }
    if (!document.getElementById("diag-btn")) return;
    if (!window.trainer) {
      setTimeout(install, 50);
      return;
    }

    const btn = $("diag-btn");
    if (btn) btn.addEventListener("click", toggle);

    const collapse = $("diag-collapse");
    if (collapse) {
      collapse.addEventListener("click", (e) => {
        e.stopPropagation();
        // Closing the intro counts as “seen” — don’t show it again
        dismissHelpPanel();
      });
    }
    const reportCollapse = $("diag-report-collapse");
    if (reportCollapse) {
      reportCollapse.addEventListener("click", (e) => {
        e.stopPropagation();
        const panel = $("diag-report-panel");
        if (panel) panel.hidden = true;
      });
    }
    // Intro re-open tab is intentionally unused after permanent dismiss
    const tab = $("diag-tab");
    if (tab) tab.hidden = true;

    // Chain pitch stream (follow.js installs first; we wrap its handler)
    const prev = window.trainer.onPitch;
    window.trainer.onPitch = function (midi, clarity) {
      onPitch(midi, clarity);
      // While diagnosing a section (cue or listen), don't let free-follow advance
      if (diag.on && (diag.phase === "listening" || diag.phase === "cueing")) return;
      if (typeof prev === "function") prev(midi, clarity);
    };

    window.diagnose = {
      diag,
      toggle,
      enterMode,
      exitMode,
      onPitch,
      handleNoteClick,
      isOn: () => diag.on,
      loadHistory,
      analyzeSection,
      segmentPlateaus,
      foldTo,
    };
  }

  // Headless / tests can use pure analysis without the DOM install path
  if (typeof window !== "undefined") {
    window.diagnoseCore = {
      analyzeSection,
      segmentPlateaus,
      foldTo,
      OK_CENTS,
      NEAR_CENTS,
      WRONG_CENTS,
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
})();
