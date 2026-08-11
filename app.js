/**
 * Chant Sight-Singing Trainer — shell UI + PDF viewer + overlay hooks.
 * Pitch detection is in pitch.js (ES module); it calls trainer.onPitch.
 *
 * score.json schema (frozen):
 * {
 *   "version": 1,
 *   "source": "Sunday_T1_DL.pdf",
 *   "pages": [{
 *     "index": 0,                    // 0-based page index
 *     "width": 612.0, "height": 792.0,
 *     "staves": [{
 *       "index": 0,
 *       "xStart": 54.0, "xEnd": 558.0,
 *       "lineYs": [256.86, 261.18, 265.5, 269.82, 274.14],
 *       "spacing": 4.32,
 *       "clef": "treble",
 *       "keySig": { "fifths": 1 },
 *       "label": "Troparion of the Resurrection - Tone 1",
 *       "notes": [{
 *         "index": 0,
 *         "type": "note",            // e.g. "note" | "rest"
 *         "glyph": "quarter",
 *         "x": 88.2, "y": 267.7,     // PDF points, 72dpi, origin top-left
 *         "step": 3,                 // relative scale degree
 *         "midi": 67,                // absolute pitch (A4 = 69)
 *         "accidental": null,
 *         "lyric": "The"
 *       }]
 *     }]
 *   }]
 * }
 */

(() => {
  "use strict";

  // Build stamp: visible on the how-to card and in the console so a phone
  // running a stale cached build can be identified at a glance.
  const APP_BUILD = "2026-08-10";
  try {
    console.log("Byzantine Voice — build", APP_BUILD);
    document.documentElement.setAttribute("data-build", APP_BUILD);
    const bl = document.getElementById("howto-build");
    if (bl) bl.textContent = "build " + APP_BUILD;
  } catch (_) {
    /* ignore */
  }

  // —— pdf.js setup ——
  const pdfjsLib = window["pdfjs-dist/build/pdf"] || window.pdfjsLib;
  if (!pdfjsLib) {
    console.error("pdf.js failed to load from CDN");
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  // —— DOM ——
  /** Halo pulse period and scored-burst lifetime, ms. */
  const HALO_PERIOD_MS = 400;
  const BURST_MS = 300;

  const $ = (id) => document.getElementById(id);
  const els = {
    stage: $("stage"),
    dropHint: $("drop-hint"),
    canvasWrap: $("canvas-wrap"),
    pageCanvas: $("page"),
    overlayCanvas: $("overlay"),
    pdfInput: $("pdf-input"),
    scoreInput: $("score-input"),
    saveScoreBtn: $("save-score-btn"),
    fileStatus: $("file-status"),
    micBtn: $("mic-btn"),
    modeBtn: $("mode-btn"), // optional / removed from toolbar
    sensitivity: $("sensitivity"),
    sensitivityVal: $("sensitivity-val"),
    advanceHold: $("advance-hold"),
    advanceHoldVal: $("advance-hold-val"),
    currentNote: $("current-note"), // optional — lyric readout removed from UI

    scoreBanner: $("score-banner"),
    extractBanner: $("extract-banner"),
    extractBannerText: $("extract-banner-text"),
    extractDiagCopy: $("extract-diag-copy"),
    notationDiagBtn: $("notation-diag-btn"),
    scoreReadyBox: $("score-ready-box"),
    extractTestBanner: $("extract-test-banner"),
    prevPage: $("prev-page"),
    nextPage: $("next-page"),
    pageLabel: $("page-label"),
    pageAdvanceHint: $("page-advance-hint"),
    harmonyHint: $("harmony-hint"),
    uploadSaveToggle: $("upload-save-toggle"),
  };

  /** How close to the foot of the sheet counts as "at the bottom", in css px. */
  const PAGE_HINT_SLACK_PX = 90;

  const queryParams = new URLSearchParams(location.search);
  const DEBUG_EXTRACT = queryParams.get("debug") === "1";
  const EXTRACT_TEST = queryParams.get("extracttest") === "1";

  const pageCtx = els.pageCanvas.getContext("2d", { alpha: false });
  const overlayCtx = els.overlayCanvas.getContext("2d", { alpha: true });

  // —— App state ——
  const state = {
    pdfDoc: null,
    pdfName: null,
    /** 1-based pdf.js page number */
    pageNum: 1,
    pageCount: 0,
    /** CSS-pixel scale: PDF points → CSS pixels (fit-to-width). */
    scale: 1,
    dpr: 1,
    cssW: 0,
    cssH: 0,
    /** Raw score.json object */
    score: null,
    /**
     * Sequential notes flattened from pages→staves→notes.
     * Each entry keeps pageIndex (0-based), staff meta, and note fields.
     */
    notes: [],
    /** Ball position in PDF points, or null */
    ball: null,
    /** Ball radius multiplier (follow.js may emphasize at start). */
    ballScale: 1,
    /**
     * Pitch accuracy color while singing:
     * green = on the note, yellow = close, red = far, neutral = no pitch.
     */
    ballColor: "neutral",
    /** In-tolerance halo around the ball (follow.js drives it). */
    halo: false,
    haloStartMs: 0,
    /** One-shot expanding rings: [{ index, t0 }] */
    bursts: [],
    animRaf: 0,
    /** Global sequential index into state.notes, or -1 */
    highlightIndex: -1,
    micOn: false,
    /** Relative = match the key *you* start in (best for a cappella chant). */
    mode: "relative", // "absolute" | "relative"
    /**
     * How close to “green” (¢). Hidden in UI.
     * ~40¢: must land nearer the written pitch than a half-step “halfway there.”
     */
    sensitivityCents: 40,
    advanceHoldMs: 400,
    rendering: false,
    /** Latest requested page while a render is in flight */
    pendingPage: null,
    /** True when score came from a hand-loaded score.json override */
    scoreOverride: false,
    /** Last cache key for IndexedDB (fileName + fileSize) */
    cacheKey: null,
    /** Draw every extracted notehead when ?debug=1 */
    debugExtract: DEBUG_EXTRACT,
    /** Progressive extract job (cancel when a new PDF loads). */
    extractJob: null,
    /** PDF pages fully extracted so far (0-based count of pages done). */
    extractPagesDone: 0,
    extractPagesTotal: 0,
    extractComplete: false,
    /**
     * Diagnostic overlay:
     *   range: { start, end } inclusive note indices
     *   marks: [{ index, category: 'ok'|'near'|'wrong'|'missing' }]
     */
    diag: { range: null, marks: null },
    /**
     * Drag-select / range play: yellow bands covering only the selected notes
     * (first click → release), not the whole staff.
     * Array of { pdfPage, x0, y0, x1, y1 } in PDF points, or null.
     */
    staffHighlightBands: null,
  };

  // —— IndexedDB cache for extracted scores ——
  // Bump SCORE_CACHE_VER whenever extractor output changes in a way that
  // old cached scores must not be reused (e.g. eighth-flag support).
  // Cache keys include this version so stale entries are simply ignored.
  // ex13 = geometric top-voice filter (column stacks → highest pitch only)
  const SCORE_CACHE_VER = "ex13";
  const IDB_NAME = "byzantine-voice-scores";
  const IDB_STORE = "scores";
  const IDB_VERSION = 1;

  function openScoreDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function cacheGet(key) {
    try {
      const db = await openScoreDb();
      if (!db) return null;
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn("score cache get failed", e);
      return null;
    }
  }

  async function cachePut(key, score) {
    try {
      const db = await openScoreDb();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).put(score, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn("score cache put failed", e);
    }
  }

  /**
   * Status routing:
   *  - kind "ok" (fully ready) → green box inside Upload & Save menu; hide bottom bar
   *  - processing / error / warn → yellow (or red) banner at the bottom of the screen
   *  - opts.showDiagCopy: show “Copy diagnostic report” on the banner
   *  - opts.mixedCase: do not force uppercase (notation messages)
   */
  function setExtractBanner(msg, kind, opts) {
    const options = opts || {};
    const b = els.extractBanner;
    const textEl = els.extractBannerText;
    const copyBtn = els.extractDiagCopy;
    const ready = els.scoreReadyBox;
    if (!msg) {
      if (b) {
        b.hidden = true;
        b.classList.remove("is-error", "is-ok", "is-warn", "is-mixed-case");
      }
      if (textEl) textEl.textContent = "";
      else if (b) b.textContent = "";
      if (copyBtn) {
        copyBtn.hidden = true;
        copyBtn.textContent = "Copy diagnostic report";
      }
      if (ready) {
        ready.hidden = true;
        ready.textContent = "";
      }
      return;
    }

    if (kind === "ok") {
      // Ready state lives in the Upload & Save menu, not the bottom bar
      if (ready) {
        ready.hidden = false;
        ready.textContent = msg;
      }
      if (b) {
        b.hidden = true;
        b.classList.remove("is-error", "is-ok", "is-warn", "is-mixed-case");
      }
      if (textEl) textEl.textContent = "";
      if (copyBtn) copyBtn.hidden = true;
      return;
    }

    // Extracting / errors stay on the bottom bar (yellow while working)
    if (ready) {
      ready.hidden = true;
      ready.textContent = "";
    }
    if (!b) return;
    b.hidden = false;
    if (textEl) textEl.textContent = msg;
    else b.textContent = msg;
    b.classList.toggle("is-error", kind === "error");
    b.classList.toggle("is-warn", kind === "warn");
    b.classList.toggle("is-mixed-case", !!options.mixedCase);
    b.classList.remove("is-ok");
    if (copyBtn) {
      copyBtn.hidden = !options.showDiagCopy;
      if (options.showDiagCopy) copyBtn.textContent = "Copy diagnostic report";
    }
  }

  /** Clipboard helper: navigator.clipboard with textarea fallback (file:// / Safari). */
  async function copyTextToClipboard(text) {
    const s = text == null ? "" : String(text);
    if (typeof navigator !== "undefined" && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(s);
        return true;
      } catch (_) {
        /* fall through */
      }
    }
    try {
      const ta = document.createElement("textarea");
      ta.value = s;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      ta.style.top = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return !!ok;
    } catch (e) {
      console.warn("copy failed", e);
      return false;
    }
  }

  function notationDiagnosticText() {
    if (window.ScoreExtractor && typeof window.ScoreExtractor.formatDiagnosticReport === "function") {
      return window.ScoreExtractor.formatDiagnosticReport();
    }
    return "Byzantine Voice notation diagnostic — (no diagnostic available yet)\n";
  }

  async function copyNotationDiagnostic(btn) {
    const ok = await copyTextToClipboard(notationDiagnosticText());
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = ok ? "Copied ✓" : "Copy failed";
      setTimeout(() => {
        if (btn) btn.textContent = prev || "Copy diagnostic report";
      }, 1600);
    }
    return ok;
  }

  /**
   * After extraction completes: special banners when staves/notes look unsupported.
   * Returns true if a notation-specific banner was shown.
   */
  function maybeShowNotationDiagnosticBanner(st) {
    const d =
      window.ScoreExtractor && window.ScoreExtractor.lastDiagnostic
        ? window.ScoreExtractor.lastDiagnostic
        : null;
    if (!d) return false;
    const totalStaves = d.totalStaves | 0;
    const totalNotes =
      d.totalNotes != null ? d.totalNotes | 0 : st && st.totalNotes != null ? st.totalNotes | 0 : 0;
    let msg = null;
    let kind = "error";
    if (totalStaves > 0 && totalNotes === 0) {
      msg =
        "Found " +
        totalStaves +
        " staves but no readable notes. This PDF may use a newer notation format (Finale was retired in 2024).";
      kind = "error";
    } else if (totalNotes > 0 && totalNotes < totalStaves * 2) {
      msg =
        "Very few notes were read (" +
        totalNotes +
        " from " +
        totalStaves +
        " staves) — the notation may be partially unsupported.";
      kind = "warn";
    } else {
      return false;
    }
    if (d.smuflSuspected) {
      msg +=
        " SMuFL-style glyphs detected (Dorico/MuseScore family) — the report below is exactly what’s needed to add support.";
    }
    setExtractBanner(msg, kind, { showDiagCopy: true, mixedCase: true });
    return true;
  }

  function updateSaveScoreBtn() {
    if (!els.saveScoreBtn) return;
    // Still require a score; also stays disabled while the whole after-PDF block is locked
    els.saveScoreBtn.disabled = !state.score || !state.notes.length;
  }

  /** Diagnostic is available once a PDF is loaded (even if notes are 0). */
  function updateNotationDiagBtn() {
    const btn = els.notationDiagBtn;
    if (!btn) return;
    const hasPdf = !!state.pdfDoc;
    btn.disabled = !hasPdf;
    btn.classList.toggle("is-awaiting-pdf", !hasPdf);
    btn.title = hasPdf
      ? "Copy a notation diagnostic report (fonts/glyphs the extractor saw)"
      : "Upload a PDF first to copy a notation diagnostic";
  }

  /**
   * Inside Upload & Settings: only Upload PDF is active until a PDF is loaded.
   * Sound, mic, save, and load custom stay grayed so users do not think they
   * must configure audio before opening a score.
   */
  function updateUploadMenuAfterPdf() {
    const hasPdf = !!state.pdfDoc;
    if (document.body && document.body.classList) {
      document.body.classList.toggle("has-pdf", hasPdf);
    }
    const after = $("upload-save-after-pdf");
    if (after) {
      after.classList.toggle("is-awaiting-pdf", !hasPdf);
      after.setAttribute("aria-disabled", hasPdf ? "false" : "true");
    }
    const micSwitch = $("mic-switch");
    if (micSwitch) {
      micSwitch.disabled = !hasPdf;
      if (!hasPdf) {
        micSwitch.checked = false;
        micSwitch.setAttribute("aria-checked", "false");
      }
    }
    const soundBtn = $("enable-sound-btn");
    if (soundBtn) {
      soundBtn.disabled = !hasPdf;
      soundBtn.title = hasPdf
        ? "Unlock browser sound and play a test beep"
        : "Upload a PDF first — then unlock browser sound";
    }
    const scoreInput = $("score-input");
    if (scoreInput) {
      scoreInput.disabled = !hasPdf;
      const loadLabel = scoreInput.closest("label");
      if (loadLabel) {
        loadLabel.classList.toggle("is-awaiting-pdf", !hasPdf);
        loadLabel.title = hasPdf
          ? "Replace the auto score with your own score.json (advanced)"
          : "Upload a PDF first (optional: replace auto score with your own score.json)";
      }
    }
    const firstHint = $("upload-first-hint");
    if (firstHint) firstHint.hidden = hasPdf;
    updateSaveScoreBtn();
    updateNotationDiagBtn();
    // Compact Tools unlocks with PDF (items inside stay gray until notes ready)
    const toolsToggle = $("tools-toggle");
    if (toolsToggle) {
      toolsToggle.disabled = !hasPdf;
      toolsToggle.classList.toggle("is-awaiting-score", !hasPdf);
      toolsToggle.title = hasPdf
        ? "Practice tools: Match Pitch, Transpose, Tempo, Assess, Play"
        : "Upload a PDF first to use practice tools";
      if (!hasPdf) {
        const tm = $("tools-menu");
        if (tm) tm.classList.remove("is-open");
        toolsToggle.classList.remove("is-open");
        toolsToggle.setAttribute("aria-expanded", "false");
      }
    }
    // Compact label is Upload → Settings based on has-pdf; remeasure bar
    if (typeof window.updateCompactToolbar === "function") {
      window.updateCompactToolbar();
    } else {
      setTimeout(() => {
        if (typeof window.updateCompactToolbar === "function") {
          window.updateCompactToolbar();
        }
      }, 0);
    }
  }

  /**
   * Shorten a filename so it fits at the top of Upload & Settings (display only).
   * Keeps the extension when possible.
   */
  function shortFileName(name, maxLen) {
    const max = maxLen != null ? maxLen : 28;
    const s = String(name || "").trim();
    if (!s) return "No PDF loaded";
    if (s.length <= max) return s;
    const dot = s.lastIndexOf(".");
    const ext = dot > 0 && s.length - dot <= 6 ? s.slice(dot) : "";
    const base = ext ? s.slice(0, s.length - ext.length) : s;
    const keep = Math.max(4, max - ext.length - 1);
    return base.slice(0, keep) + "…" + ext;
  }

  function setFileStatusDisplay(name) {
    if (!els.fileStatus) return;
    const full = name || "No PDF loaded";
    els.fileStatus.textContent = shortFileName(full, 26);
    els.fileStatus.title = full === "No PDF loaded" ? "" : full;
  }

  // =====================================================================
  // Coordinate math
  //
  // score.json uses PDF points (1/72") with origin at the TOP-LEFT of the
  // page, y increasing downward (not the PDF native bottom-left origin).
  // pdf.js getViewport({ scale }) produces a top-left CSS box of size
  //   (pageWidthPt * scale) × (pageHeightPt * scale).
  // One uniform factor therefore maps JSON → CSS pixels:
  //   cssX = xPt * scale,  cssY = yPt * scale
  // Backing-store bitmaps are larger by devicePixelRatio; overlay drawing
  // uses setTransform(dpr) so we still paint in CSS-pixel units.
  // =====================================================================

  /** PDF points (top-left origin) → CSS pixels on the canvases. */
  function pdfToCanvas(x, y) {
    return { x: x * state.scale, y: y * state.scale };
  }

  window.pdfToCanvas = pdfToCanvas;
  Object.defineProperty(window, "pdfScale", {
    get: () => state.scale,
    configurable: true,
  });

  // —— Score helpers ——

  /** Console histogram of note.glyph values (debug=1 or force). */
  function logGlyphHistogram(notes, label) {
    const hist = Object.create(null);
    for (const n of notes || []) {
      const g = (n && n.glyph) || "(null)";
      hist[g] = (hist[g] || 0) + 1;
    }
    const sample = (notes || [])
      .slice(0, 12)
      .map((n) => (n && n.glyph) || "?")
      .join(" ");
    console.info(
      `[Byzantine Voice] glyphs (${label || "score"}):`,
      hist,
      "first12:",
      sample
    );
  }

  function isValidScore(json) {
    return json && typeof json === "object" && Array.isArray(json.pages);
  }

  /**
   * Geometric top-voice filter (runs on the flattened note list every setScore).
   *
   * If several noteheads sit in one vertical column (close in x, spread in y
   * within about one staff height), keep ONLY the top musical pitch — never
   * arpeggiate SATB chords. Relies on geometry + midi, not staffIndex, so a
   * bad staff split cannot leave three voices as sequential notes.
   *
   * Monophonic music (no vertical stacks) is unchanged.
   */
  function ensureTopVoiceOnly(notes) {
    if (!notes || !notes.length) return notes || [];

    // Work per PDF page so systems on other pages never interact
    const byPage = new Map();
    for (const n of notes) {
      const p = n.pdfPage != null ? n.pdfPage : 1;
      if (!byPage.has(p)) byPage.set(p, []);
      byPage.get(p).push(n);
    }

    const out = [];
    let stacks = 0;
    let removed = 0;

    for (const list of byPage.values()) {
      const sp =
        (list[0] && list[0].staffSpacing) ||
        4.32;
      const xTol = Math.max(5, sp * 1.2); // ~5pt — Finale chord stagger
      const yStackMin = sp * 0.35; // distinct pitches in a column
      const ySameSystem = sp * 5.5; // don't merge two systems at same x

      const sorted = list.slice().sort((a, b) => {
        const ax = a.x != null ? a.x : 0;
        const bx = b.x != null ? b.x : 0;
        if (ax !== bx) return ax - bx;
        const ay = a.y != null ? a.y : 0;
        const by = b.y != null ? b.y : 0;
        return ay - by;
      });

      const used = new Array(sorted.length).fill(false);

      for (let i = 0; i < sorted.length; i++) {
        if (used[i]) continue;
        const a = sorted[i];
        const ax = a.x != null ? Number(a.x) : 0;
        const ay = a.y != null ? Number(a.y) : 0;
        if (!Number.isFinite(ax) || !Number.isFinite(ay)) {
          out.push(a);
          used[i] = true;
          continue;
        }

        // Gather geometrically stacked notes (same column, same system)
        const cluster = [a];
        const idxs = [i];
        used[i] = true;
        for (let j = i + 1; j < sorted.length; j++) {
          if (used[j]) continue;
          const b = sorted[j];
          const bx = b.x != null ? Number(b.x) : NaN;
          const by = b.y != null ? Number(b.y) : NaN;
          if (!Number.isFinite(bx) || !Number.isFinite(by)) continue;
          if (bx - ax > xTol) break; // sorted by x
          if (Math.abs(bx - ax) <= xTol && Math.abs(by - ay) <= ySameSystem) {
            cluster.push(b);
            idxs.push(j);
            used[j] = true;
          }
        }

        if (cluster.length === 1) {
          out.push(cluster[0]);
          continue;
        }

        let yMin = Infinity;
        let yMax = -Infinity;
        for (const n of cluster) {
          const y = Number(n.y);
          if (y < yMin) yMin = y;
          if (y > yMax) yMax = y;
        }
        const ySpan = yMax - yMin;

        if (ySpan > yStackMin) {
          // Multi-voice column: keep highest pitch (prefer midi; else top of page)
          stacks += 1;
          removed += cluster.length - 1;
          let best = cluster[0];
          for (let k = 1; k < cluster.length; k++) {
            const n = cluster[k];
            const bm = best.midi;
            const nm = n.midi;
            if (
              bm != null &&
              nm != null &&
              Number.isFinite(bm) &&
              Number.isFinite(nm)
            ) {
              if (nm > bm) best = n;
              else if (nm === bm && Number(n.y) < Number(best.y)) best = n;
            } else if (Number(n.y) < Number(best.y)) {
              // top-left: smaller y = higher on page
              best = n;
            }
          }
          out.push(best);
        } else {
          // Same height (duplicates / jitter): keep left-to-right all, or one if x-identical
          cluster.sort((p, q) => Number(p.x) - Number(q.x) || Number(p.y) - Number(q.y));
          const x0 = Number(cluster[0].x);
          const x1 = Number(cluster[cluster.length - 1].x);
          if (x1 - x0 < 1.25) {
            out.push(cluster[0]);
            removed += cluster.length - 1;
          } else {
            for (const n of cluster) out.push(n);
          }
        }
      }
    }

    out.sort((a, b) => {
      const ap = a.pdfPage != null ? a.pdfPage : 0;
      const bp = b.pdfPage != null ? b.pdfPage : 0;
      if (ap !== bp) return ap - bp;
      const as = a.staffIndex != null ? a.staffIndex : 0;
      const bs = b.staffIndex != null ? b.staffIndex : 0;
      if (as !== bs) return as - bs;
      return (a.x || 0) - (b.x || 0) || (a.y || 0) - (b.y || 0);
    });
    for (let i = 0; i < out.length; i++) {
      out[i].globalIndex = i;
    }
    if (stacks > 0 || removed > 0) {
      console.info(
        "[Byzantine Voice] top-voice geometric filter:",
        "stacks=" + stacks,
        "removed=" + removed,
        notes.length + "→" + out.length
      );
    }
    // Do NOT "stabilize" middle pitches toward neighbors — that could rewrite
    // real contours (e.g. A–B–A). Only geometric multi-voice collapse remains.
    return out;
  }

  /**
   * Flatten pages → staves → notes into a sequential list for the trainer.
   * Adds pageIndex (0-based), pdfPage (1-based for pdf.js), staffSpacing, etc.
   */
  function flattenNotes(score) {
    const out = [];
    if (!score || !Array.isArray(score.pages)) return out;

    for (const page of score.pages) {
      const pageIndex = page.index != null ? page.index : 0;
      const pdfPage = pageIndex + 1; // pdf.js is 1-based
      const staves = page.staves || [];

      for (const staff of staves) {
        const spacing = staff.spacing != null ? staff.spacing : 4.32;
        const staffIndex = staff.index != null ? staff.index : 0;
        const notes = staff.notes || [];

        for (const note of notes) {
          out.push({
            // sequential index assigned after flatten
            globalIndex: out.length,
            pageIndex,
            pdfPage,
            staffIndex,
            staffSpacing: spacing,
            staffLineYs: staff.lineYs || null,
            // Right edge of the staff — a reciting tone on the last position of
            // a staff has no following note to bound its span.
            staffXEnd: staff.xEnd != null ? staff.xEnd : null,
            staffLabel: staff.label || null,
            clef: staff.clef || null,
            keySig: staff.keySig || null,
            // original note fields
            index: note.index,
            type: note.type || "note",
            glyph: note.glyph || null,
            x: note.x,
            y: note.y,
            step: note.step,
            midi: note.midi,
            accidental: note.accidental,
            dotted: !!note.dotted,
            lyric: note.lyric != null ? note.lyric : null,
          });
        }
      }
    }
    return out;
  }

  function midiToName(midi) {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const m = Math.round(midi);
    const name = names[((m % 12) + 12) % 12];
    const oct = Math.floor(m / 12) - 1;
    return `${name}${oct}`;
  }
  // Exposed for range-ui / other shells (file:// safe, no modules)
  window.midiToName = midiToName;

  /**
   * What to show in the big readout: the syllable/words for this note.
   * (Not “G4” — plainchant users don’t need piano pitch names.)
   */
  function noteDisplayLabel(n) {
    if (!n) return "—";
    if (n.type === "rest") return "—";
    const lyric = n.lyric != null ? String(n.lyric).trim() : "";
    if (lyric) {
      // Keep the toolbar compact
      return lyric.length > 22 ? lyric.slice(0, 20) + "…" : lyric;
    }
    return "·"; // note with no lyric under it
  }

  // —— Overlay drawing ——

  function clearOverlay() {
    overlayCtx.save();
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
    overlayCtx.restore();
  }

  /** Soft yellow/orange rounded rect behind sequential note index (state.notes). */
  function highlightNote(index) {
    state.highlightIndex = index;
    redrawOverlay();
  }

  /**
   * Remove click-to-hear orange box (and parked ball).
   * Always safe — call when the user leaves the note in any mode.
   */
  function clearNoteHighlight() {
    if (state.highlightIndex < 0 && !state.ball) return;
    state.highlightIndex = -1;
    state.ball = null;
    redrawOverlay();
  }

  /** Diagnostic range + mistake marks (set by diagnose.js). */
  function setDiagVisual(vis) {
    const v = vis || {};
    state.diag.range = v.range || null;
    state.diag.marks = v.marks || null;
    redrawOverlay();
  }

  /**
   * Look up staff geometry from the loaded score (xStart/xEnd/lineYs).
   */
  function getStaffGeom(pdfPage, staffIndex) {
    if (!state.score || !state.score.pages) return null;
    const page = state.score.pages.find(
      (p) => (p.index != null ? p.index + 1 : 0) === pdfPage || p.index === pdfPage - 1
    );
    if (!page) return null;
    const staves = page.staves || [];
    const staff =
      staves.find((s) => (s.index != null ? s.index : 0) === staffIndex) ||
      staves[staffIndex] ||
      null;
    if (!staff) return null;
    return {
      xStart: staff.xStart,
      xEnd: staff.xEnd,
      lineYs: staff.lineYs,
      spacing: staff.spacing != null ? staff.spacing : 4.32,
    };
  }

  /**
   * Highlight only the selected note range [start..end] as yellow bands.
   * Horizontal span = first selected note → last selected note on each staff
   * (not the whole staff). Full staff height so the strip is easy to see.
   * Used while dragging and while that stretch is playing; cleared when done.
   */
  function setStaffHighlightFromNoteRange(start, end) {
    if (start == null || end == null || !state.notes.length) {
      state.staffHighlightBands = null;
      redrawOverlay();
      return;
    }
    const a = Math.min(start, end);
    const b = Math.max(start, end);

    // Group selected notes by staff; x span comes only from those notes
    const staffMap = new Map(); // key -> { pdfPage, staffIndex, sample, minX, maxX }
    for (let i = a; i <= b; i++) {
      const n = state.notes[i];
      if (!n || n.x == null) continue;
      const staff = n.staffIndex != null ? n.staffIndex : n.staff;
      const key = `${n.pdfPage}|${staff}`;
      let g = staffMap.get(key);
      if (!g) {
        g = {
          pdfPage: n.pdfPage,
          staffIndex: staff,
          sample: n,
          minX: n.x,
          maxX: n.x,
        };
        staffMap.set(key, g);
      } else {
        g.minX = Math.min(g.minX, n.x);
        g.maxX = Math.max(g.maxX, n.x);
      }
    }

    const bands = [];
    for (const { pdfPage, staffIndex, sample, minX, maxX } of staffMap.values()) {
      const geom = getStaffGeom(pdfPage, staffIndex);
      const spacing =
        (geom && geom.spacing) || sample.staffSpacing || 4.32;
      let lineYs = (geom && geom.lineYs) || sample.staffLineYs || null;

      // Staff height from geometry; fallback from selected note y
      if (!lineYs || !lineYs.length) {
        let minY = Infinity,
          maxY = -Infinity;
        for (const n of state.notes) {
          if (n.pdfPage !== pdfPage) continue;
          const si = n.staffIndex != null ? n.staffIndex : n.staff;
          if (si !== staffIndex) continue;
          if (n.y != null) {
            minY = Math.min(minY, n.y);
            maxY = Math.max(maxY, n.y);
          }
          if (n.staffLineYs && n.staffLineYs.length) {
            lineYs = n.staffLineYs;
            break;
          }
        }
        if ((!lineYs || !lineYs.length) && Number.isFinite(minY)) {
          lineYs = [minY - spacing * 2, maxY + spacing * 2];
        }
      }

      if (!lineYs || !lineYs.length) continue;

      // Horizontal: pad slightly around the first and last selected noteheads
      const pad = spacing * 1.4;
      const x0 = minX - pad;
      const x1 = maxX + pad;
      const top = Math.min(...lineYs) - spacing * 1.35;
      const bot = Math.max(...lineYs) + spacing * 1.35;
      bands.push({ pdfPage, x0, y0: top, x1, y1: bot });
    }

    state.staffHighlightBands = bands.length ? bands : null;
    redrawOverlay();
  }

  function clearStaffHighlight() {
    if (!state.staffHighlightBands) return;
    state.staffHighlightBands = null;
    redrawOverlay();
  }

  /** Yellow band for the selected note span on each staff (click → release). */
  function drawStaffHighlight() {
    const bands = state.staffHighlightBands;
    if (!bands || !bands.length) return;
    for (const b of bands) {
      if (b.pdfPage !== state.pageNum) continue;
      const c0 = pdfToCanvas(b.x0, b.y0);
      const c1 = pdfToCanvas(b.x1, b.y1);
      const w = Math.max(4, c1.x - c0.x);
      const h = Math.max(4, c1.y - c0.y);
      const rx = Math.max(4, 6 * state.scale);
      roundRect(overlayCtx, c0.x, c0.y, w, h, rx);
      overlayCtx.fillStyle = "rgba(255, 220, 70, 0.28)";
      overlayCtx.fill();
      overlayCtx.strokeStyle = "rgba(230, 190, 40, 0.45)";
      overlayCtx.lineWidth = Math.max(1, 1.25 * state.scale);
      overlayCtx.stroke();
    }
  }

  /**
   * Staff y for a sung MIDI relative to a written note (same math as the live ball).
   * Returns PDF-point y, or null.
   */
  function sungPitchY(n, sungMidi) {
    if (!n || sungMidi == null || !Number.isFinite(sungMidi)) return null;
    // Diagnose folds sungMidi toward the TRANSPOSED expectation (written +
    // transpose). The trail must be anchored the same way, or every mark for
    // a transposed singer draws ~an octave off the written note (the reported
    // "first note green, the rest proportionally spaced but far too low").
    let transpose = 0;
    try {
      const p = window.followPlayback && window.followPlayback.play;
      transpose = (p && p.transposeSemis) || 0;
    } catch (_) {
      /* ignore */
    }
    const core = window.followCore;
    if (!core || typeof core.ballStep !== "function" || typeof core.stepToY !== "function") {
      // Fallback: shift written y by ~1 staff step per 100¢ vs expectation
      if (n.y == null) return null;
      const sp = n.staffSpacing || 4.32;
      const cents = (sungMidi - (n.midi + transpose)) * 100;
      return n.y - (cents / 100) * (sp / 2);
    }
    const fifths = (n.keySig && n.keySig.fifths) || 0;
    const step = core.ballStep(sungMidi, n, fifths, transpose);
    return core.stepToY(step, n.staffLineYs, n.staffSpacing || 4.32);
  }

  function drawDiagOverlay(notes) {
    const range = state.diag.range;
    const marks = state.diag.marks;
    if (!range && (!marks || !marks.length)) return;

    // Range band while selecting (before results): soft amber on the section
    if (range && range.start != null && range.end != null && !(marks && marks.length)) {
      const a = Math.min(range.start, range.end);
      const b = Math.max(range.start, range.end);
      for (let i = a; i <= b; i++) {
        const n = notes[i];
        if (!n || n.pdfPage !== state.pageNum || n.x == null || n.y == null) continue;
        const sp = n.staffSpacing || 4.32;
        const c = pdfToCanvas(n.x, n.y);
        const w = sp * 2.4 * state.scale;
        const h = sp * 2.2 * state.scale;
        roundRect(overlayCtx, c.x - w / 2, c.y - h / 2, w, h, 3 * state.scale);
        if (i === a) overlayCtx.fillStyle = "rgba(80, 200, 120, 0.4)";
        else if (i === b) overlayCtx.fillStyle = "rgba(80, 140, 255, 0.4)";
        else overlayCtx.fillStyle = "rgba(230, 180, 60, 0.22)";
        overlayCtx.fill();
      }
    }

    // After analysis:
    //  - ok  → green highlight on the written note (same green as the ball)
    //  - near/wrong → yellow/red ball at the *sung* staff height (not on the notehead)
    //  - missing → faint gray ring on the written note
    if (marks && marks.length) {
      const ballR = BALL_R_PT * state.scale;
      for (const m of marks) {
        const n = notes[m.index];
        if (!n || n.pdfPage !== state.pageNum || n.x == null || n.y == null) continue;
        const sp = n.staffSpacing || 4.32;
        const written = pdfToCanvas(n.x, n.y);

        if (m.category === "ok") {
          const w = sp * 2.6 * state.scale;
          const h = sp * 2.4 * state.scale;
          roundRect(
            overlayCtx,
            written.x - w / 2,
            written.y - h / 2,
            w,
            h,
            3 * state.scale
          );
          overlayCtx.fillStyle = "rgba(61, 184, 122, 0.4)";
          overlayCtx.fill();
          overlayCtx.lineWidth = Math.max(1.5, 1.8 * state.scale);
          overlayCtx.strokeStyle = "rgba(61, 184, 122, 0.95)";
          overlayCtx.stroke();
          continue;
        }

        if (m.category === "missing") {
          overlayCtx.beginPath();
          overlayCtx.arc(written.x, written.y, ballR * 1.15, 0, Math.PI * 2);
          overlayCtx.strokeStyle = "rgba(160, 160, 170, 0.85)";
          overlayCtx.lineWidth = Math.max(1.5, 1.8 * state.scale);
          overlayCtx.stroke();
          continue;
        }

        // near or wrong: ball at sung pitch on this note's column
        const sungY = sungPitchY(n, m.sungMidi);
        if (sungY == null) continue;
        const sung = pdfToCanvas(n.x, sungY);
        const col =
          m.category === "wrong"
            ? {
                fill: "rgba(220, 70, 70, 0.78)",
                stroke: "rgba(240, 90, 90, 0.95)",
                glow: "rgba(220, 70, 70, 0.75)",
              }
            : {
                fill: "rgba(230, 180, 50, 0.78)",
                stroke: "rgba(240, 200, 60, 0.95)",
                glow: "rgba(230, 180, 50, 0.75)",
              };

        // Guide line from written note to where they sang
        overlayCtx.beginPath();
        overlayCtx.moveTo(written.x, written.y);
        overlayCtx.lineTo(sung.x, sung.y);
        overlayCtx.strokeStyle =
          m.category === "wrong"
            ? "rgba(240, 90, 90, 0.45)"
            : "rgba(230, 180, 50, 0.45)";
        overlayCtx.lineWidth = Math.max(1, 1.2 * state.scale);
        overlayCtx.setLineDash([3 * state.scale, 3 * state.scale]);
        overlayCtx.stroke();
        overlayCtx.setLineDash([]);

        // Outer ring + filled ball (same style as the live ball)
        overlayCtx.beginPath();
        overlayCtx.arc(sung.x, sung.y, ballR * 1.85, 0, Math.PI * 2);
        overlayCtx.lineWidth = Math.max(1.25, 1.5 * state.scale);
        overlayCtx.strokeStyle = col.stroke;
        overlayCtx.stroke();

        overlayCtx.beginPath();
        overlayCtx.arc(sung.x, sung.y, ballR, 0, Math.PI * 2);
        overlayCtx.fillStyle = col.fill;
        overlayCtx.shadowColor = col.glow;
        overlayCtx.shadowBlur = 7 * state.scale;
        overlayCtx.fill();
        overlayCtx.shadowBlur = 0;
      }
    }
  }

  /** Base ball radius in PDF points (~25% smaller than the old 6 pt). */
  const BALL_R_PT = 4.5;

  /**
   * Ball at PDF-point (x, y). Pass null / omit y to clear.
   * Color comes from trainer.setBallColor (green / yellow / red / neutral).
   */
  function drawBall(x, y) {
    if (x == null || y == null) {
      state.ball = null;
    } else {
      state.ball = { x, y };
    }
    redrawOverlay();
  }

  function ballFillStroke(color) {
    switch (color) {
      case "green":
        return {
          fill: "rgba(61, 184, 122, 0.78)",
          stroke: "rgba(61, 184, 122, 0.95)",
          glow: "rgba(61, 184, 122, 0.85)",
        };
      case "yellow":
        return {
          fill: "rgba(230, 180, 50, 0.78)",
          stroke: "rgba(240, 200, 60, 0.95)",
          glow: "rgba(230, 180, 50, 0.75)",
        };
      case "red":
        return {
          fill: "rgba(220, 70, 70, 0.78)",
          stroke: "rgba(240, 90, 90, 0.95)",
          glow: "rgba(220, 70, 70, 0.75)",
        };
      default:
        return {
          fill: "rgba(150, 155, 170, 0.65)",
          stroke: "rgba(200, 205, 220, 0.85)",
          glow: "rgba(150, 155, 170, 0.5)",
        };
    }
  }

  function redrawOverlay() {
    clearOverlay();
    // Draw in CSS-pixel space (dpr scales into the backing store).
    overlayCtx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    const notes = state.notes;
    const hi = state.highlightIndex;

    drawMelodyTrace(notes, hi);
    drawStaffHighlight();
    drawDiagOverlay(notes);

    // Highlight under the ball — only if that note is on the visible PDF page
    if (hi >= 0 && hi < notes.length) {
      const n = notes[hi];
      if (n.pdfPage === state.pageNum && n.x != null && n.y != null) {
        // Box size from staff spacing (notehead ≈ one interline gap)
        const sp = n.staffSpacing || 4.32;
        const wPt = sp * 2.6;
        const hPt = sp * 2.4;
        const w = wPt * state.scale;
        const h = hPt * state.scale;
        const c = pdfToCanvas(n.x, n.y);
        const pad = sp * 0.35 * state.scale;
        const rx = Math.max(2, sp * 0.5 * state.scale);

        roundRect(
          overlayCtx,
          c.x - w / 2 - pad,
          c.y - h / 2 - pad,
          w + pad * 2,
          h + pad * 2,
          rx
        );
        overlayCtx.fillStyle = "rgba(255, 220, 60, 0.35)";
        overlayCtx.fill();
      }
    }

    // Completed notes: small green rings (follow.js fills trainer.completed)
    const completed = window.trainer && window.trainer.completed;
    if (completed && completed.size) {
      overlayCtx.lineWidth = 2;
      overlayCtx.strokeStyle = "rgba(61, 184, 122, 0.8)";
      for (const i of completed) {
        const n = notes[i];
        if (!n || n.pdfPage !== state.pageNum || n.x == null || n.y == null) continue;
        const r = (n.staffSpacing || 4.32) * 1.1 * state.scale;
        overlayCtx.beginPath();
        overlayCtx.arc(n.x * state.scale, n.y * state.scale, r, 0, Math.PI * 2);
        overlayCtx.stroke();
      }
    }

    drawScoredBursts(notes);

    // Soft pulsing halo only while on pitch (green) — extra "you're there" cue.
    if (state.halo && state.ball) {
      const c = pdfToCanvas(state.ball.x, state.ball.y);
      const base = BALL_R_PT * state.scale * (state.ballScale || 1);
      const now = performance.now();
      const period = HALO_PERIOD_MS;
      for (let ring = 0; ring < 2; ring++) {
        const phase = (((now - state.haloStartMs) / period + ring / 2) % 1 + 1) % 1;
        const r = base * (1.9 + phase * 1.2);
        const alpha = 0.45 * (1 - phase);
        if (alpha <= 0.01) continue;
        overlayCtx.beginPath();
        overlayCtx.arc(c.x, c.y, r, 0, Math.PI * 2);
        overlayCtx.lineWidth = Math.max(1, 1.2 * state.scale);
        overlayCtx.strokeStyle = `rgba(61, 184, 122, ${alpha.toFixed(3)})`;
        overlayCtx.stroke();
      }
    }

    // Ball: filled disc (~25% smaller than before) + always-on circumference
    // ring so the eye can find it on the staff. Color = pitch accuracy.
    if (state.ball) {
      const c = pdfToCanvas(state.ball.x, state.ball.y);
      const r = BALL_R_PT * state.scale * (state.ballScale || 1);
      const col = ballFillStroke(state.ballColor);

      // Outer attention ring (stroke only — not a filled halo)
      overlayCtx.beginPath();
      overlayCtx.arc(c.x, c.y, r * 1.85, 0, Math.PI * 2);
      overlayCtx.lineWidth = Math.max(1.25, 1.5 * state.scale);
      overlayCtx.strokeStyle = col.stroke;
      overlayCtx.globalAlpha = 0.9;
      overlayCtx.stroke();
      overlayCtx.globalAlpha = 1;

      // Filled ball
      overlayCtx.beginPath();
      overlayCtx.arc(c.x, c.y, r, 0, Math.PI * 2);
      overlayCtx.fillStyle = col.fill;
      overlayCtx.shadowColor = col.glow;
      overlayCtx.shadowBlur = (state.ballScale > 1 ? 14 : 7) * state.scale;
      overlayCtx.fill();
      overlayCtx.shadowBlur = 0;
    }

    if (state.debugExtract) drawExtractDebug(notes);
  }

  /** One-shot ring that expands out of a note the instant it is scored. */
  function drawScoredBursts(notes) {
    if (!state.bursts.length) return;
    const now = performance.now();
    for (const b of state.bursts) {
      const n = notes[b.index];
      if (!n || n.pdfPage !== state.pageNum || n.x == null || n.y == null) continue;
      const p = Math.min(1, (now - b.t0) / BURST_MS);
      const r0 = (n.staffSpacing || 4.32) * 1.1 * state.scale;
      const c = pdfToCanvas(n.x, n.y);
      overlayCtx.beginPath();
      overlayCtx.arc(c.x, c.y, r0 * (1 + p * 1.8), 0, Math.PI * 2);
      overlayCtx.lineWidth = Math.max(1, 2.4 * (1 - p) * state.scale);
      overlayCtx.strokeStyle = `rgba(61, 184, 122, ${(0.85 * (1 - p)).toFixed(3)})`;
      overlayCtx.stroke();
    }
  }

  /**
   * The halo pulses and the scored bursts animate on their own clock, so the
   * overlay needs a frame loop that runs even when nothing else is redrawing
   * (Finder mode has no playback rAF).
   */
  function overlayAnimFrame() {
    state.animRaf = 0;
    const now = performance.now();
    if (state.bursts.length) {
      state.bursts = state.bursts.filter((b) => now - b.t0 < BURST_MS);
    }
    redrawOverlay();
    if (state.halo || state.bursts.length) scheduleOverlayAnim();
  }

  function scheduleOverlayAnim() {
    if (!state.animRaf) state.animRaf = requestAnimationFrame(overlayAnimFrame);
  }

  /** ?debug=1 — red dots + pitch names on every extracted notehead. */
  function drawExtractDebug(notes) {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    overlayCtx.font = `${Math.max(8, 9 * state.scale)}px system-ui, sans-serif`;
    overlayCtx.textAlign = "center";
    overlayCtx.textBaseline = "bottom";
    for (const n of notes) {
      if (n.pdfPage !== state.pageNum || n.x == null || n.y == null) continue;
      const c = pdfToCanvas(n.x, n.y);
      const r = 2.2 * state.scale;
      overlayCtx.beginPath();
      overlayCtx.arc(c.x, c.y, r, 0, Math.PI * 2);
      overlayCtx.strokeStyle = "rgba(40, 80, 255, 0.95)";
      overlayCtx.lineWidth = 1.2;
      overlayCtx.stroke();
      const nm =
        n.midi != null
          ? names[((n.midi % 12) + 12) % 12] + String(Math.floor(n.midi / 12) - 1)
          : "?";
      overlayCtx.fillStyle = "rgba(220, 40, 40, 0.92)";
      overlayCtx.fillText(nm, c.x, c.y - (n.staffSpacing || 4) * 1.6 * state.scale);
    }
  }

  /**
   * Thin grey polyline through the engraved (x, y) of every note on the
   * visible page, one segment run per staff. This is the written melody: the
   * singer keeps the ball on the line.
   */
  function drawMelodyTrace(notes, hi) {
    if (!notes.length) return;
    const activeStaff =
      hi >= 0 && hi < notes.length ? `${notes[hi].pageIndex}:${notes[hi].staffIndex}` : null;

    const byStaff = new Map();
    for (const n of notes) {
      if (n.pdfPage !== state.pageNum || n.x == null || n.y == null) continue;
      const key = `${n.pageIndex}:${n.staffIndex}`;
      if (!byStaff.has(key)) byStaff.set(key, []);
      byStaff.get(key).push(n);
    }

    overlayCtx.lineJoin = "round";
    overlayCtx.lineCap = "round";
    for (const [key, list] of byStaff) {
      if (list.length < 2) continue;
      const active = key === activeStaff;
      overlayCtx.beginPath();
      list.forEach((n, i) => {
        const c = pdfToCanvas(n.x, n.y);
        if (i === 0) overlayCtx.moveTo(c.x, c.y);
        else overlayCtx.lineTo(c.x, c.y);
      });
      overlayCtx.lineWidth = active ? 1.6 : 1.1;
      overlayCtx.strokeStyle = active
        ? "rgba(150, 152, 162, 0.65)"
        : "rgba(150, 152, 162, 0.3)";
      overlayCtx.stroke();
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  // —— PDF render ——

  function fitScaleFor(page) {
    // Fit-to-width; stage scrolls vertically for tall pages.
    const unscaled = page.getViewport({ scale: 1 });
    const avail = Math.max(1, els.stage.clientWidth);
    state.lastFitW = avail; // resize handler re-renders only when this changes
    return avail / unscaled.width;
  }

  async function renderPage(num) {
    if (!state.pdfDoc) return;
    if (state.rendering) {
      state.pendingPage = num;
      return;
    }
    state.rendering = true;
    state.pendingPage = null;
    state.pageNum = num;

    try {
      const page = await state.pdfDoc.getPage(num);
      if (state.pendingPage != null) return;

      const scale = fitScaleFor(page);
      const viewport = page.getViewport({ scale });
      const dpr = window.devicePixelRatio || 1;

      state.scale = scale;
      state.dpr = dpr;
      state.cssW = viewport.width;
      state.cssH = viewport.height;

      for (const canvas of [els.pageCanvas, els.overlayCanvas]) {
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
      }
      els.canvasWrap.style.width = `${viewport.width}px`;

      // White fill in device pixels; pdf.js HiDPI via transform
      pageCtx.setTransform(1, 0, 0, 1, 0, 0);
      pageCtx.fillStyle = "#ffffff";
      pageCtx.fillRect(0, 0, els.pageCanvas.width, els.pageCanvas.height);

      const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
      await page.render({
        canvasContext: pageCtx,
        viewport,
        transform,
      }).promise;

      if (state.pendingPage != null) return;

      updatePageChrome();
      redrawOverlay();
      // Stay ahead of the singer: extract the next batch while they read this page
      ensureExtractAhead(num);
    } catch (err) {
      console.error("renderPage failed", err);
      setFileStatusDisplay("Render error");
    } finally {
      state.rendering = false;
      if (state.pendingPage != null) {
        const next = state.pendingPage;
        state.pendingPage = null;
        renderPage(next);
      }
    }
  }

  function updatePageChrome() {
    const n = state.pageCount;
    const p = state.pageNum;
    // "Page 3 of 12" — the two numerals carry the bright text color (style.css)
    els.pageLabel.replaceChildren(
      document.createTextNode("Page "),
      Object.assign(document.createElement("span"), {
        className: "page-label-num",
        textContent: n ? String(p) : "—",
      }),
      document.createTextNode(" of "),
      Object.assign(document.createElement("span"), {
        className: "page-label-num",
        textContent: n ? String(n) : "—",
      })
    );
    els.prevPage.disabled = !n || p <= 1;
    els.nextPage.disabled = !n || p >= n;
    updatePageAdvanceHint();
    updateHarmonyHint();
  }

  /**
   * Show a floating cue once the singer scrolls into the white space at the
   * foot of the sheet, so it's clear the next page arrives on its own rather
   * than the music having run out.
   */
  function updatePageAdvanceHint() {
    const hint = els.pageAdvanceHint;
    const stage = els.stage;
    if (!hint || !stage) return;

    const hasNext = !!state.pdfDoc && state.pageNum < state.pageCount;
    const maxScroll = Math.max(0, stage.scrollHeight - stage.clientHeight);
    // Purely a function of where the view is — not of whether anything is
    // playing. Someone just reading around the score should learn what happens
    // at the foot of a page without having to start a run to find out.
    // Short pages (maxScroll ≈ 0): still show the cue so multi-page is obvious.
    const nearBottom =
      maxScroll <= 8 || maxScroll - stage.scrollTop < PAGE_HINT_SLACK_PX;

    if (!hasNext || !nearBottom || !state.pdfDoc) {
      // Leave it in the DOM so it fades out; pointer-events:none keeps it inert.
      hint.classList.remove("is-visible");
      // Keep element present but inert when hidden via class only
      if (!hasNext || !state.pdfDoc) hint.hidden = true;
      return;
    }

    hint.textContent = `Continues on page ${state.pageNum + 1} of ${state.pageCount} — turns automatically`;
    // Pin to the stage's own box so the cue clears the page bar no matter how
    // tall it is (the extract banner grows it while a score is processing).
    const r = stage.getBoundingClientRect();
    hint.style.left = `${r.left + r.width / 2}px`;
    hint.style.bottom = `${Math.max(12, window.innerHeight - r.bottom + 16)}px`;
    hint.hidden = false;
    if (!hint.classList.contains("is-visible")) {
      requestAnimationFrame(() => hint.classList.add("is-visible"));
    }
  }

  /**
   * When the viewed page has stacked multi-voice noteheads (same x, several
   * pitches), show a small notice near Play All. The trainer keeps the top voice.
   */
  function updateHarmonyHint() {
    const hint = els.harmonyHint;
    if (!hint) return;
    if (!state.score || !state.pdfDoc || !Array.isArray(state.score.pages)) {
      hint.hidden = true;
      return;
    }
    const pageIndex0 = (state.pageNum | 0) - 1;
    let page = null;
    for (const p of state.score.pages) {
      const idx = p.index != null ? p.index : 0;
      if (idx === pageIndex0) {
        page = p;
        break;
      }
    }
    const show = !!(page && page.hasHarmonyStacks);
    hint.hidden = !show;
  }

  /** Scroll the stage to the top of the current PDF page. */
  function scrollStageToTop() {
    if (els.stage) els.stage.scrollTop = 0;
  }

  /**
   * Navigate to a PDF page (1-based).
   * Always scrolls to the top so manual Next/Prev doesn’t leave you stuck at
   * the previous page’s bottom. Note-following can scroll again via scrollToNote.
   */
  async function goToPage(num) {
    if (!state.pdfDoc) return;
    const clamped = Math.max(1, Math.min(state.pageCount, num));
    const pageChanged = clamped !== state.pageNum;
    // Wait for note extraction on this page so clicks/highlights work immediately
    await ensureExtractThroughPage(clamped);
    await renderPage(clamped);
    // If this page has no notes yet (title page, or still catching up), keep going
    if (
      state.extractJob &&
      !state.extractJob.complete &&
      !pageHasNotes(clamped)
    ) {
      setExtractBanner(
        `EXTRACTING NOTES FOR PAGE ${clamped}…`,
        null
      );
      await ensureExtractThroughPage(clamped);
      // Merge may have finished via onBatch; refresh overlay hit targets
      redrawOverlay();
      if (state.extractComplete || pageHasNotes(clamped)) {
        // Restore ready banner into menu when fully done; otherwise clear bottom
        if (state.extractComplete && state.notes.length) {
          setExtractBanner(readyToPlayMessage(state.notes.length), "ok");
        } else if (pageHasNotes(clamped) && !state.extractComplete) {
          // Processing continues in background — only show bottom while still busy overall
          const job = state.extractJob;
          const st = job && job.status ? job.status() : null;
          if (st) bannerForExtractStatus(st);
        }
      }
    }
    // Manual paging (and any page change): start at the top of the new page.
    // Auto-play will call scrollToNote afterward if it needs a lower staff.
    if (pageChanged) scrollStageToTop();
  }

  // —— Score / trainer ——

  function focusNote(index) {
    const notes = state.notes;
    if (!notes.length || index < 0 || index >= notes.length) {
      // index < 0: clear highlight only (keep currentNoteIndex for Play start)
      if (index < 0) {
        state.highlightIndex = -1;
        state.ball = null;
        redrawOverlay();
        return;
      }
      window.trainer.currentNoteIndex = 0;
      state.highlightIndex = -1;
      state.ball = null;
      updateCurrentNoteDisplay();
      redrawOverlay();
      return;
    }

    window.trainer.currentNoteIndex = index;
    const n = notes[index];
    updateCurrentNoteDisplay();

    const apply = () => {
      highlightNote(index);
      // Do NOT park a ball here. The ball belongs to the live paint loops
      // (Play / Match Pitch / free-follow repaint it ~50×/s); drawing one on
      // focus left a stray gray circle sitting on the sheet right after a
      // PDF loaded, before any mode was active.
    };

    if (state.pdfDoc && n.pdfPage !== state.pageNum) {
      goToPage(n.pdfPage).then(apply);
    } else {
      apply();
    }
  }

  function setScore(scoreJson, opts) {
    const options = opts || {};
    if (!isValidScore(scoreJson)) {
      console.warn("setScore: expected { version, pages: [{ staves: [{ notes }] }] }");
      state.score = null;
      state.notes = [];
      window.trainer.currentNoteIndex = 0;
      state.highlightIndex = -1;
      state.ball = null;
      updateCurrentNoteDisplay();
      updateScoreBanner();
      updateSaveScoreBtn();
      redrawOverlay();
      return;
    }

    const prevIndex = window.trainer.currentNoteIndex;
    const prevCompleted = window.trainer.completed
      ? new Set(window.trainer.completed)
      : new Set();

    state.score = scoreJson;
    state.notes = ensureTopVoiceOnly(flattenNotes(scoreJson));
    if (options.override) {
      state.scoreOverride = true;
      state.extractComplete = true;
    }
    // Always log once on full score apply so eighth detection is easy to verify
    // without ?debug=1 (Play uses note.glyph; if all "quarter", flags never attached).
    if (!options.partial && state.notes.length) {
      logGlyphHistogram(state.notes, options.override ? "override" : "extract");
    }

    updateScoreBanner();
    updateSaveScoreBtn();
    updateHarmonyHint();
    updatePageAdvanceHint();

    // Full replace (first batch, cache, override): reset practice cursor
    if (!options.partial) {
      window.trainer.currentNoteIndex = 0;
      window.trainer.completed.clear();
      state.ball = null;
      window.dispatchEvent(
        new CustomEvent("trainer:score", {
          detail: { notes: state.notes.length, partial: false },
        })
      );
      if (state.notes.length) focusNote(0);
      else {
        state.highlightIndex = -1;
        updateCurrentNoteDisplay();
        redrawOverlay();
      }
      return;
    }

    // Progressive merge: keep cursor & completed rings; only extend the note list
    window.trainer.completed = new Set(
      [...prevCompleted].filter((i) => i >= 0 && i < state.notes.length)
    );
    const clamped = Math.max(
      0,
      Math.min(prevIndex, Math.max(0, state.notes.length - 1))
    );
    window.trainer.currentNoteIndex = clamped;
    state.highlightIndex = state.notes.length ? clamped : -1;
    updateCurrentNoteDisplay();
    redrawOverlay();
    window.dispatchEvent(
      new CustomEvent("trainer:score", {
        detail: {
          notes: state.notes.length,
          partial: true,
          pagesDone: options.pagesDone,
          pagesTotal: options.pagesTotal,
          complete: !!options.complete,
        },
      })
    );
  }

  /**
   * Banner when PDF is open but no notes (extraction failed / empty).
   * Success messaging goes to extract-banner instead.
   */
  function updateScoreBanner() {
    const b = els.scoreBanner;
    if (!b) return;
    const needsScore = !!state.pdfDoc && !state.notes.length && !state.scoreOverride;
    // extract-banner handles extract errors; keep legacy banner quiet when we already showed one
    const extractVisible = els.extractBanner && !els.extractBanner.hidden;
    b.hidden = !needsScore || extractVisible;
    b.textContent = needsScore
      ? "No notes found — try Score override with a hand-edited score.json, or a different MCI PDF."
      : "";
  }

  function downloadScoreJson() {
    if (!state.score) return;
    const name = (state.pdfName || "score").replace(/\.pdf$/i, "") + ".json";
    const blob = new Blob([JSON.stringify(state.score, null, 1)], {
      type: "application/json",
    });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 500);
  }

  function cancelExtractJob() {
    if (state.extractJob && typeof state.extractJob.cancel === "function") {
      state.extractJob.cancel();
    }
    state.extractJob = null;
  }

  /** Large bottom status: READY TO PLAY — N NOTES (all caps). */
  function readyToPlayMessage(noteCount) {
    const n = noteCount | 0;
    return `READY TO PLAY — ${n} NOTE${n === 1 ? "" : "S"}`;
  }

  function bannerForExtractStatus(st) {
    if (!st) return;
    if (st.complete) {
      // Notation diagnostic takes priority over generic empty/success banners
      if (maybeShowNotationDiagnosticBanner(st)) return;
      if (!st.totalNotes) {
        setExtractBanner("NO NOTES FOUND", "error");
        return;
      }
      // Fully done → green box in Upload & Save menu
      setExtractBanner(readyToPlayMessage(st.totalNotes), "ok");
      return;
    }
    // Still processing → bottom yellow banner (even if some notes already usable)
    if (st.totalNotes) {
      setExtractBanner(
        `EXTRACTING… PAGE ${st.pagesDone}/${st.pagesTotal}  ·  ${st.totalNotes} NOTES SO FAR`,
        null
      );
    } else {
      setExtractBanner(`EXTRACTING… PAGE ${st.pagesDone || 1}/${st.pagesTotal}`, null);
    }
  }

  /**
   * Keep extraction at least `lookahead` PDF pages ahead of the page the user
   * is viewing (1-based pageNum). Background batches of 3 pages.
   */
  function ensureExtractAhead(pageNum1Based) {
    const job = state.extractJob;
    if (!job || job.complete || job.cancelled) return;
    const idx0 = Math.max(0, (pageNum1Based | 0) - 1);
    // Prefer having the next full batch ready (≈2–3 pages ahead)
    job.ensureAhead(idx0, job.batchSize).catch((e) => console.warn("ensureAhead", e));
  }

  /**
   * Block until notes for this PDF page are extracted (0-based index = pageNum-1).
   * Without this, Next Page shows the PDF image before note positions exist, so
   * clicks miss and do nothing.
   */
  async function ensureExtractThroughPage(pageNum1Based) {
    const job = state.extractJob;
    if (!job || job.complete || job.cancelled) return null;
    const idx0 = Math.max(0, (pageNum1Based | 0) - 1);
    try {
      // Show brief status while we catch up
      if (!job.complete && job.status && job.status().pagesDone <= idx0) {
        setExtractBanner(
          `EXTRACTING… PAGE ${Math.min(idx0 + 1, state.pageCount)}/${state.pageCount}`,
          null
        );
      }
      const st = await job.ensureThrough(idx0);
      // Also pull a little ahead so Next Page is snappy
      job.ensureAhead(idx0, 1).catch((e) => console.warn("ensureAhead", e));
      return st;
    } catch (e) {
      console.warn("ensureExtractThroughPage", e);
      return null;
    }
  }

  /** True if any extracted note belongs to this 1-based PDF page. */
  function pageHasNotes(pageNum1Based) {
    const p = pageNum1Based | 0;
    for (const n of state.notes) {
      if (n && n.pdfPage === p) return true;
    }
    return false;
  }

  /**
   * Progressive extract (or load from IndexedDB cache).
   * First batch applies immediately so singing can start; later pages arrive
   * in the background and merge without resetting the cursor.
   */
  async function extractAndApplyScore(pdfDoc, name, fileSize, opts) {
    const options = opts || {};
    if (state.scoreOverride && !options.force) return;
    if (!window.ScoreExtractor || typeof window.ScoreExtractor.createProgressive !== "function") {
      setExtractBanner("Extractor not loaded (extractor.js).", "error");
      return;
    }

    cancelExtractJob();
    state.extractPagesDone = 0;
    state.extractPagesTotal = pdfDoc.numPages;
    state.extractComplete = false;

    // Key must change when extractor semantics change (SCORE_CACHE_VER),
    // otherwise an older run without eighth flags is reused forever.
    const cacheKey =
      name && fileSize != null
        ? `${SCORE_CACHE_VER}::${name}::${fileSize}`
        : name
          ? `${SCORE_CACHE_VER}::${name}::unknown`
          : null;
    state.cacheKey = cacheKey;

    if (cacheKey && !options.skipCache) {
      const cached = await cacheGet(cacheKey);
      if (cached && isValidScore(cached)) {
        setScore(cached);
        const n = state.notes.length;
        state.extractComplete = true;
        state.extractPagesDone = pdfDoc.numPages;
        if (n) {
          if (state.debugExtract) logGlyphHistogram(state.notes, "cache");
          setExtractBanner(readyToPlayMessage(n) + "  ·  CACHED", "ok");
          return;
        }
        setExtractBanner("CACHED SCORE EMPTY — RE-EXTRACTING…", "error");
      }
    }

    setExtractBanner("EXTRACTING… FIRST PAGES", null);

    const batchSize =
      (window.ScoreExtractor && window.ScoreExtractor.DEFAULT_BATCH_SIZE) || 3;

    const job = window.ScoreExtractor.createProgressive(pdfDoc, name || "document.pdf", {
      batchSize,
      fileSize: fileSize != null ? fileSize : null,
      onProgress: (p, n) => {
        // Lightweight live progress while a batch is scanning
        if (!state.extractComplete) {
          setExtractBanner(`EXTRACTING… PAGE ${p}/${n}`, null);
        }
      },
      onBatch: (st) => {
        if (job.cancelled) return;
        state.extractPagesDone = st.pagesDone;
        state.extractPagesTotal = st.pagesTotal;
        state.extractComplete = st.complete;
        // First time we have any notes (or empty initial score): full replace.
        // Later batches merge without resetting the practice cursor.
        const firstContent = !state.notes.length;
        setScore(st.score, {
          partial: !firstContent && st.totalNotes > 0,
          pagesDone: st.pagesDone,
          pagesTotal: st.pagesTotal,
          complete: st.complete,
        });
        bannerForExtractStatus(st);
        updateNotationDiagBtn();
        if (st.complete && cacheKey && st.totalNotes) {
          cachePut(cacheKey, st.score).catch(() => {});
        }
      },
    });
    state.extractJob = job;

    try {
      // First batch: wait so the user has notes before they try to sing
      await job.extractNextBatch();
      if (job.cancelled) return;

      // Cover / title pages: keep going until we find notes or finish
      while (!job.cancelled && !job.status().totalNotes && !job.complete) {
        await job.extractNextBatch();
      }
      if (job.cancelled) return;

      const st0 = job.status();
      if (!st0.totalNotes) {
        // Prefer detailed notation banner (detected staves / SMuFL) when available
        if (!maybeShowNotationDiagnosticBanner(st0)) {
          const d =
            window.ScoreExtractor && window.ScoreExtractor.lastDiagnostic
              ? window.ScoreExtractor.lastDiagnostic
              : null;
          const detected = d ? d.totalStaves | 0 : st0.totalStaves | 0;
          setExtractBanner(
            detected === 0
              ? "NO STAVES FOUND — NOT AN MCI FINALE PDF?"
              : "NO NOTES FOUND",
            "error",
            detected > 0 ? { showDiagCopy: true } : null
          );
        }
        updateScoreBanner();
        updateNotationDiagBtn();
        return;
      }

      // Background: fill remaining batches; page turns also call ensureExtractAhead
      (async () => {
        while (!job.cancelled && !job.complete) {
          await job.extractNextBatch();
          // Yield between batches so singing / paint stay responsive
          await new Promise((r) => setTimeout(r, 40));
        }
      })().catch((e) => console.warn("background extract", e));
    } catch (err) {
      console.error("extract failed", err);
      setExtractBanner(`Extraction failed: ${err.message || err}`, "error");
      updateScoreBanner();
    }
  }

  function updateCurrentNoteDisplay() {
    // Lyric readout was removed from the toolbar (too small / unused).
    if (!els.currentNote) return;
    const i = window.trainer.currentNoteIndex;
    const n = state.notes[i];
    els.currentNote.textContent = noteDisplayLabel(n);
  }

  // —— Trainer API (pitch.js calls onPitch; score advance comes later) ——

  window.trainer = {
    /**
     * Continuous pitch estimate from pitch.js.
     * midiFloat is median-smoothed floating MIDI, or null when pitch is lost.
     * Stub for now — score integration will consume this later.
     */
    onPitch(midiFloat, clarity) {
      // Keep last reading available for debugging / future advance logic.
      window.trainer.lastPitch = { midi: midiFloat, clarity, t: performance.now() };
    },
    lastPitch: { midi: null, clarity: 0, t: 0 },
    /** Sequential indices of correctly-sung notes (drawn as green rings during Begin). */
    completed: new Set(),
    /** Clear Begin completion rings from the staff. */
    clearCompleted() {
      window.trainer.completed.clear();
      redrawOverlay();
    },
    setScore,
    currentNoteIndex: 0,
    drawBall,
    highlightNote,
    clearNoteHighlight,
    /** Jump to sequential note (updates page, highlight, ball, display). */
    focusNote,
    /** Ball radius multiplier — follow.js pops it at the downbeat. */
    setBallScale(k) {
      state.ballScale = k || 1;
      redrawOverlay();
    },
    setDiagVisual,
    setStaffHighlightFromNoteRange,
    clearStaffHighlight,
    get diag() {
      return state.diag;
    },
    get pdfName() {
      return state.pdfName;
    },
    get cacheKey() {
      return state.cacheKey;
    },
    /**
     * green | yellow | red | neutral — pitch accuracy while singing.
     * The ball sits at the sung staff height; the color says how close it is.
     */
    setBallColor(color) {
      const next = color || "neutral";
      if (state.ballColor === next) return;
      state.ballColor = next;
      redrawOverlay();
    },
    get ballColor() {
      return state.ballColor;
    },
    /** Pulsing halo while the sung pitch sits inside tolerance. */
    setHalo(on) {
      const next = !!on;
      if (next === state.halo) return;
      state.halo = next;
      if (next) {
        state.haloStartMs = performance.now();
        scheduleOverlayAnim();
      } else {
        redrawOverlay();
      }
    },
    /** One-shot expanding ring on a note the moment it scores. */
    burstAt(index) {
      if (index == null || index < 0 || index >= state.notes.length) return;
      state.bursts.push({ index, t0: performance.now() });
      scheduleOverlayAnim();
    },
    /** Current ball position in PDF points, or null (read by the self-tests). */
    get ball() {
      return state.ball;
    },
    /** 1-based page currently rendered. */
    get pageNum() {
      return state.pageNum;
    },
    /**
     * Ensure notes for a 1-based PDF page are extracted (for click-before-ready).
     * @returns {Promise<void>}
     */
    async ensurePageNotes(pageNum1Based) {
      await ensureExtractThroughPage(pageNum1Based);
      redrawOverlay();
    },
    get mode() {
      return state.mode;
    },
    get sensitivityCents() {
      return state.sensitivityCents;
    },
    get advanceHoldMs() {
      return state.advanceHoldMs;
    },
    get micOn() {
      return state.micOn;
    },
    /** Raw score.json */
    get score() {
      return state.score;
    },
    /** Flattened sequential notes for the audio module */
    get notes() {
      return state.notes;
    },
    /**
     * Load a PDF from bytes (normal path: render + extract).
     * Used by Find your range for the bundled range-test piece.
     */
    async loadPdfData(u8, name, meta) {
      await loadPdfFromData(u8, name || "document.pdf", meta || {});
    },
    /**
     * Clear PDF/score and restore the welcome screen (upload directions + calendar).
     * Used when Find your range ends so Happy Birthday doesn’t linger.
     */
    clearDocument() {
      resetToWelcomeScreen();
    },
  };

  /** Full reset to empty home stage (drop-hint with upload + MCI calendar). */
  function resetToWelcomeScreen() {
    cancelExtractJob();
    state.pdfDoc = null;
    state.pdfName = "";
    state.pageCount = 0;
    state.pageNum = 1;
    state.ball = null;
    state.scoreOverride = false;
    state.score = null;
    state.notes = [];
    state.extractComplete = false;
    state.extractPagesDone = 0;
    state.extractPagesTotal = 0;
    state.highlightIndex = -1;
    state.bursts = [];
    state.scale = 1;
    if (window.trainer) {
      window.trainer.currentNoteIndex = 0;
      if (window.trainer.completed && typeof window.trainer.completed.clear === "function") {
        window.trainer.completed.clear();
      }
    }
    if (els.dropHint) els.dropHint.hidden = false;
    if (els.canvasWrap) els.canvasWrap.hidden = true;
    if (els.pageCanvas) {
      try {
        const ctx = els.pageCanvas.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, els.pageCanvas.width || 0, els.pageCanvas.height || 0);
      } catch (_) {
        /* ignore */
      }
    }
    if (els.overlayCanvas) {
      try {
        const ctx = els.overlayCanvas.getContext("2d");
        if (ctx) ctx.clearRect(0, 0, els.overlayCanvas.width || 0, els.overlayCanvas.height || 0);
      } catch (_) {
        /* ignore */
      }
    }
    setFileStatusDisplay("No PDF loaded");
    setExtractBanner("");
    updateScoreBanner();
    updateUploadMenuAfterPdf();
    updatePageChrome();
    updateSaveScoreBtn();
    if (els.pageAdvanceHint) els.pageAdvanceHint.classList.remove("is-visible");
    if (els.harmonyHint) els.harmonyHint.hidden = true;
    if (els.stage) els.stage.scrollTop = 0;
    window.dispatchEvent(
      new CustomEvent("trainer:score", {
        detail: { notes: 0, partial: false, cleared: true },
      })
    );
  }

  // —— File loading ——

  async function loadPdfFromData(data, name, meta) {
    const info = meta || {};
    cancelExtractJob();
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdf = await loadingTask.promise;
    state.pdfDoc = pdf;
    state.pdfName = name || "document.pdf";
    state.pageCount = pdf.numPages;
    state.pageNum = 1;
    state.ball = null;
    state.scoreOverride = false;
    // Clear previous score so extraction replaces it (unless override loads later)
    state.score = null;
    state.notes = [];
    state.extractComplete = false;
    state.extractPagesDone = 0;
    state.extractPagesTotal = pdf.numPages;
    els.dropHint.hidden = true;
    els.canvasWrap.hidden = false;
    setFileStatusDisplay(state.pdfName);
    updateScoreBanner();
    updateUploadMenuAfterPdf();
    await renderPage(1);

    // In-browser extraction (cache by fileName + fileSize)
    const size =
      info.fileSize != null
        ? info.fileSize
        : data && data.byteLength != null
          ? data.byteLength
          : null;
    await extractAndApplyScore(pdf, state.pdfName, size, {
      skipCache: !!info.skipCache,
    });
  }

  async function loadPdfFile(file) {
    const buf = await file.arrayBuffer();
    await loadPdfFromData(new Uint8Array(buf), file.name, { fileSize: file.size });
  }

  async function loadScoreFile(file) {
    const text = await file.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      alert("Invalid JSON in score file.");
      return;
    }
    if (!isValidScore(json)) {
      alert("score.json must have a pages[] array (see schema in app.js).");
      return;
    }
    // Hand-edited override takes precedence over auto-extraction
    setScore(json, { override: true });
    setExtractBanner(
      readyToPlayMessage(state.notes.length) + "  ·  OVERRIDE",
      "ok"
    );
    setFileStatusDisplay(
      state.pdfName ? `${state.pdfName} + ${file.name}` : file.name
    );
  }

  // —— UI events ——

  els.pdfInput.addEventListener("change", () => {
    const f = els.pdfInput.files && els.pdfInput.files[0];
    if (f) loadPdfFile(f).catch((e) => console.error(e));
    els.pdfInput.value = "";
  });

  els.scoreInput.addEventListener("change", () => {
    const f = els.scoreInput.files && els.scoreInput.files[0];
    if (f) loadScoreFile(f).catch((e) => console.error(e));
    els.scoreInput.value = "";
  });

  ["dragenter", "dragover"].forEach((type) => {
    els.stage.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
      els.stage.classList.add("is-dragover");
    });
  });
  ["dragleave", "drop"].forEach((type) => {
    els.stage.addEventListener(type, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (type === "dragleave" && e.target !== els.stage) return;
      els.stage.classList.remove("is-dragover");
    });
  });
  els.stage.addEventListener("drop", (e) => {
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    let pdfFile = null;
    let scoreFile = null;
    for (const f of files) {
      const n = f.name.toLowerCase();
      if (n.endsWith(".pdf") || f.type === "application/pdf") pdfFile = f;
      else if (n.endsWith(".json") || f.type === "application/json") scoreFile = f;
    }
    const chain = pdfFile ? loadPdfFile(pdfFile) : Promise.resolve();
    chain
      .then(() => (scoreFile ? loadScoreFile(scoreFile) : null))
      .catch((err) => console.error(err));
  });

  els.prevPage.addEventListener("click", () => goToPage(state.pageNum - 1));
  els.nextPage.addEventListener("click", () => goToPage(state.pageNum + 1));

  window.addEventListener("keydown", (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === "ArrowLeft" || e.key === "PageUp") {
      e.preventDefault();
      goToPage(state.pageNum - 1);
    } else if (e.key === "ArrowRight" || e.key === "PageDown") {
      e.preventDefault();
      goToPage(state.pageNum + 1);
    }
  });

  // Mic button is owned by pitch.js; mirror state for trainer.micOn
  window.addEventListener("trainer:mic", (e) => {
    state.micOn = !!(e.detail && e.detail.on);
  });

  // Mode + Sens are hidden; keep wiring so they still work if shown later / tests
  if (els.modeBtn) {
    els.modeBtn.dataset.mode = state.mode;
    els.modeBtn.textContent = "Relative";
    els.modeBtn.addEventListener("click", () => {
      state.mode = state.mode === "absolute" ? "relative" : "absolute";
      els.modeBtn.dataset.mode = state.mode;
      els.modeBtn.textContent = state.mode === "absolute" ? "Absolute" : "Relative";
      updateCurrentNoteDisplay();
      window.dispatchEvent(
        new CustomEvent("trainer:mode", { detail: { mode: state.mode } })
      );
    });
  }

  if (els.sensitivity) {
    els.sensitivity.value = String(state.sensitivityCents);
    els.sensitivity.addEventListener("input", () => {
      state.sensitivityCents = Number(els.sensitivity.value);
      if (els.sensitivityVal) {
        els.sensitivityVal.textContent = `${state.sensitivityCents}¢`;
      }
    });
  }

  // The Hold slider belonged to the old pitch-hold advance and is gone from the
  // toolbar; keep the wiring optional so nothing breaks if it is reinstated.
  if (els.advanceHold) {
    els.advanceHold.addEventListener("input", () => {
      state.advanceHoldMs = Number(els.advanceHold.value);
      if (els.advanceHoldVal) els.advanceHoldVal.textContent = `${state.advanceHoldMs}ms`;
    });
  }

  if (els.saveScoreBtn) {
    els.saveScoreBtn.addEventListener("click", downloadScoreJson);
  }
  if (els.notationDiagBtn) {
    els.notationDiagBtn.addEventListener("click", (e) => {
      e.preventDefault();
      copyNotationDiagnostic(els.notationDiagBtn).catch((err) => console.warn(err));
    });
  }
  if (els.extractDiagCopy) {
    els.extractDiagCopy.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyNotationDiagnostic(els.extractDiagCopy).catch((err) => console.warn(err));
    });
  }

  // Settings / Upload ▾ menu (upload PDF / save score / load custom / ready status)
  const uploadSaveMenu = $("upload-save-menu");
  const uploadSaveToggle = $("upload-save-toggle");
  const uploadSavePanel = $("upload-save-panel");
  function setUploadSaveMenuOpen(open) {
    if (!uploadSavePanel || !uploadSaveToggle) return;
    uploadSavePanel.hidden = !open;
    uploadSaveToggle.setAttribute("aria-expanded", open ? "true" : "false");
    uploadSaveToggle.classList.toggle("is-open", open);
    if (open) setToolsMenuOpen(false);
  }
  // Alias for any older callers
  function setScoreMenuOpen(open) {
    setUploadSaveMenuOpen(open);
  }

  // Phone Tools ▾ (Match Pitch / Transpose / Tempo / Assess / Play)
  const toolsMenu = $("tools-menu");
  const toolsToggle = $("tools-toggle");
  function setToolsMenuOpen(open) {
    if (!toolsMenu || !toolsToggle) return;
    const on = !!open;
    toolsMenu.classList.toggle("is-open", on);
    toolsToggle.classList.toggle("is-open", on);
    toolsToggle.setAttribute("aria-expanded", on ? "true" : "false");
  }
  if (toolsToggle && toolsMenu) {
    toolsToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (toolsToggle.disabled) return;
      const willOpen = !toolsMenu.classList.contains("is-open");
      setToolsMenuOpen(willOpen);
      if (willOpen) setUploadSaveMenuOpen(false);
    });
  }

  if (uploadSaveToggle && uploadSavePanel) {
    uploadSaveToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      setUploadSaveMenuOpen(!!uploadSavePanel.hidden);
    });
    document.addEventListener("pointerdown", (e) => {
      const t = e.target;
      if (uploadSaveMenu && uploadSavePanel && !uploadSavePanel.hidden) {
        if (t && uploadSaveMenu.contains && !uploadSaveMenu.contains(t)) {
          setUploadSaveMenuOpen(false);
        }
      }
      if (toolsMenu && toolsMenu.classList.contains("is-open")) {
        if (t && toolsMenu.contains && !toolsMenu.contains(t)) {
          // Keep open when interacting with Assess floating UI that may sit outside
          if (
            t &&
            typeof t.closest === "function" &&
            t.closest(".diag-ui, .diag-panel, .diag-action-dock, .diag-report-panel")
          ) {
            return;
          }
          setToolsMenuOpen(false);
        }
      }
    });
    if (els.saveScoreBtn) {
      els.saveScoreBtn.addEventListener("click", () => setUploadSaveMenuOpen(false));
    }
    if (els.scoreInput) {
      els.scoreInput.addEventListener("change", () => setUploadSaveMenuOpen(false));
    }
    if (els.pdfInput) {
      els.pdfInput.addEventListener("change", () => setUploadSaveMenuOpen(false));
    }
  }

  /**
   * Compact toolbar (Upload|Settings + Tools ▾) ONLY when Match Pitch / Tempo /
   * Transpose / Assess / Play would need a second toolbar row.
   * Wide screens: no Tools button — those controls stay on the bar (grayed
   * until a PDF is ready).
   */
  let toolbarMeasuring = false;
  function updateCompactToolbar() {
    const toolbar = document.querySelector(".toolbar");
    if (!toolbar || !document.body) return;
    if (toolbarMeasuring) return;
    toolbarMeasuring = true;
    try {
      updateCompactToolbarInner(toolbar);
    } finally {
      toolbarMeasuring = false;
    }
  }

  function updateCompactToolbarInner(toolbar) {
    const wasCompact = document.body.classList.contains("compact-toolbar");
    // Measure full desktop layout: all tools on one row, Tools button hidden
    document.body.classList.remove("compact-toolbar");
    document.body.classList.add("toolbar-measuring");
    void toolbar.offsetWidth;

    const barW = toolbar.clientWidth;
    // Layout not ready yet — don't force compact (avoids Tools on first paint)
    if (barW < 80) {
      document.body.classList.remove("toolbar-measuring");
      return;
    }

    const filesEl = toolbar.querySelector(".toolbar-files");
    const panelEl = document.getElementById("tools-panel");
    const sampleBtn =
      toolbar.querySelector("#match-pitch-btn") ||
      toolbar.querySelector("#upload-save-toggle") ||
      toolbar.querySelector(".btn");

    const filesW = filesEl ? filesEl.getBoundingClientRect().width : 0;

    // Measure natural one-row width of tools (no wrap)
    let toolsW = 0;
    if (panelEl) {
      panelEl.classList.add("tools-panel-measure-row");
      void panelEl.offsetWidth;
      toolsW = panelEl.scrollWidth;
      panelEl.classList.remove("tools-panel-measure-row");
    }
    const gap = 12;
    const needed = filesW + toolsW + gap;
    const overflow = needed > barW - 4;

    // Also: with wrap allowed, does the bar become two rows tall?
    void toolbar.offsetHeight;
    const barH = toolbar.getBoundingClientRect().height;
    const btnH = sampleBtn ? sampleBtn.getBoundingClientRect().height : 54;
    const twoLines = barH > btnH * 1.7 + 20;

    document.body.classList.remove("toolbar-measuring");

    // Compact ONLY when the full tool strip needs a second line / won't fit
    let compact = overflow || twoLines;
    if (wasCompact) {
      // Strong hysteresis: stay compact until there is CLEARLY enough room.
      // A narrow margin here caused compact↔full oscillation on phone
      // landscape (each state changes the bar's own height, re-firing the
      // ResizeObserver) — the reported "top bar flashing and covering the
      // screen".
      compact = needed > barW - 72;
    }

    document.body.classList.toggle("compact-toolbar", compact);
    if (!compact && toolsMenu && toolsMenu.classList.contains("is-open")) {
      setToolsMenuOpen(false);
    }
  }

  // Allow other modules / PDF load to remeasure
  window.updateCompactToolbar = updateCompactToolbar;

  let resizeTimer = null;
  let compactToolbarTimer = null;
  function onViewportResize() {
    updatePageAdvanceHint();
    clearTimeout(compactToolbarTimer);
    compactToolbarTimer = setTimeout(updateCompactToolbar, 80);
    if (!state.pdfDoc) return;
    // Re-render ONLY when the usable width actually changed. iOS fires
    // resize constantly as the URL bar collapses/expands (height-only), and
    // re-rendering the canvas on each one made the sheet flicker behind the
    // how-to card and thrash the main thread during playback.
    const w = els.stage ? els.stage.clientWidth : 0;
    if (state.lastFitW != null && Math.abs(w - state.lastFitW) < 3) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderPage(state.pageNum), 120);
  }
  window.addEventListener("resize", onViewportResize);
  // Initial + after fonts/layout settle
  updateCompactToolbar();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => updateCompactToolbar());
  }
  setTimeout(updateCompactToolbar, 250);
  if (typeof ResizeObserver === "function") {
    const tb = document.querySelector(".toolbar");
    if (tb) {
      // Only remeasure when the toolbar's WIDTH changes. Its height changes
      // as a RESULT of compact/full toggling, so reacting to height put the
      // observer in a feedback loop with the measurement (visible as the top
      // bar flashing on phones, worst in landscape at the breakpoint).
      let lastToolbarW = 0;
      const ro = new ResizeObserver((entries) => {
        if (toolbarMeasuring) return;
        const w =
          entries && entries[0] && entries[0].contentRect
            ? entries[0].contentRect.width
            : tb.clientWidth;
        if (Math.abs(w - lastToolbarW) < 1.5) return;
        lastToolbarW = w;
        clearTimeout(compactToolbarTimer);
        compactToolbarTimer = setTimeout(updateCompactToolbar, 60);
      });
      ro.observe(tb);
    }
  }

  // Scroll fires at display rate; coalesce onto one frame.
  let hintRaf = 0;
  els.stage.addEventListener(
    "scroll",
    () => {
      if (hintRaf) return;
      hintRaf = requestAnimationFrame(() => {
        hintRaf = 0;
        updatePageAdvanceHint();
      });
    },
    { passive: true }
  );

  /**
   * ?pdf=Name.pdf loads that file and extracts in-browser when served over http.
   */
  function autoLoadFromQuery() {
    if (location.protocol === "file:") return;
    const want = queryParams.get("pdf");
    if (!want) return;
    const url = new URL(want, location.href).href;
    fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((buf) => {
        const u8 = new Uint8Array(buf);
        return loadPdfFromData(u8, want.split("/").pop(), {
          fileSize: u8.byteLength,
        });
      })
      .catch((e) => {
        console.warn("?pdf= auto-load failed:", e.message);
        setFileStatusDisplay("Could not load " + want);
      });
  }

  /**
   * ?extracttest=1 — extract golden PDF in-browser and compare to golden JSON.
   * Requires http(s) so both files can be fetched.
   */
  async function runExtractTest() {
    const banner = els.extractTestBanner;
    if (!banner) return;
    banner.hidden = false;
    banner.classList.remove("is-pass", "is-fail");
    banner.textContent = "extracttest: loading golden PDF + JSON…";

    if (location.protocol === "file:") {
      banner.classList.add("is-fail");
      banner.textContent =
        "FAIL: ?extracttest=1 needs http(s) (open via Netlify or a local server).";
      return;
    }

    const pdfName = "08-16-26_Sunday_Vespers.pdf";
    const jsonName = "08-16-26_Sunday_Vespers.json";

    try {
      const [pdfRes, jsonRes] = await Promise.all([
        fetch(new URL(pdfName, location.href).href),
        fetch(new URL(jsonName, location.href).href),
      ]);
      if (!pdfRes.ok) throw new Error(`PDF HTTP ${pdfRes.status}`);
      if (!jsonRes.ok) throw new Error(`JSON HTTP ${jsonRes.status}`);

      const buf = new Uint8Array(await pdfRes.arrayBuffer());
      const golden = await jsonRes.json();

      banner.textContent = "extracttest: extracting in browser…";
      const loadingTask = pdfjsLib.getDocument({ data: buf });
      const pdf = await loadingTask.promise;
      const { score, totalNotes } = await window.ScoreExtractor.extractPdf(pdf, pdfName);

      // Also load into the UI so the user can inspect
      state.pdfDoc = pdf;
      state.pdfName = pdfName;
      state.pageCount = pdf.numPages;
      state.scoreOverride = false;
      els.dropHint.hidden = true;
      els.canvasWrap.hidden = false;
      setFileStatusDisplay(pdfName);
      updateUploadMenuAfterPdf();
      setScore(score);
      setExtractBanner(
        totalNotes ? readyToPlayMessage(totalNotes) + "  ·  EXTRACTTEST" : "NO NOTES FOUND",
        totalNotes ? "ok" : "error"
      );
      await renderPage(1);

      const result = window.ScoreExtractor.compareToGolden(score, golden);
      const lines = [];
      if (result.pass) {
        lines.push(
          `PASS — notes ${result.extractedCount} (golden ${result.goldenCount}), zero (midi, step, type) mismatches`
        );
        if (result.xyMismatches.length) {
          lines.push(
            `  (info) ${result.xyMismatches.length} note(s) with |Δx| or |Δy| > 1.5 pt — allowed)`
          );
        }
        banner.classList.add("is-pass");
      } else {
        lines.push(
          `FAIL — extracted ${result.extractedCount} notes, golden ${result.goldenCount}`
        );
        const show = result.pitchMismatches.slice(0, 10);
        for (const m of show) {
          if (m.kind === "count") lines.push(`  ${m.message}`);
          else
            lines.push(
              `  #${m.index} got ${JSON.stringify(m.got)} want ${JSON.stringify(m.want)}`
            );
        }
        if (result.pitchMismatches.length > 10) {
          lines.push(`  …and ${result.pitchMismatches.length - 10} more`);
        }
        banner.classList.add("is-fail");
      }
      banner.textContent = lines.join("\n");
      console.log("extracttest result", result);
      window.__extractTestResult = result;
    } catch (err) {
      console.error(err);
      banner.classList.add("is-fail");
      banner.textContent = `FAIL: ${err.message || err}`;
    }
  }

  updatePageChrome();
  updateScoreBanner();
  updateUploadMenuAfterPdf();
  setFileStatusDisplay("No PDF loaded");
  if (els.sensitivityVal) els.sensitivityVal.textContent = `${state.sensitivityCents}¢`;
  if (els.advanceHoldVal) els.advanceHoldVal.textContent = `${state.advanceHoldMs}ms`;

  // —— Byzantine Liturgical Calendar (live from mci.archpitt.org sidebar) ——
  const MCI_HOME = "https://mci.archpitt.org/";
  /**
   * Optional true live proxy (Cloudflare Worker — see workers/mci-proxy.js).
   * Leave empty to rely on: local serve.py → GitHub snapshot → public proxies.
   * Override anytime with ?mciProxy=https://your-worker.workers.dev
   */
  const MCI_LIVE_PROXY =
    (queryParams.get("mciProxy") || "").trim() ||
    ""; // e.g. "https://byzantine-voice-mci.YOUR.workers.dev"
  const litCalModal = $("lit-cal-modal");
  const litCalBody = $("lit-cal-body");
  const litCalStatus = $("lit-cal-status");
  const litCalClose = $("lit-cal-close");
  let litCalFetchSeq = 0;

  function setLitCalOpen(open) {
    if (!litCalModal) return;
    litCalModal.hidden = !open;
    if (open) {
      // Close Upload & Settings if open
      if (typeof setUploadSaveMenuOpen === "function") setUploadSaveMenuOpen(false);
      loadLiturgicalCalendar();
    }
  }

  /** Resolve relative MCI URLs to absolute https://mci.archpitt.org/... */
  function absMciUrl(href) {
    if (!href || !String(href).trim()) return null;
    const h = String(href).trim();
    if (h === "#" || h.startsWith("javascript:")) return null;
    // Broken leftover paths on the MCI site (empty anchors)
    if (h.indexOf("/public_html/") !== -1) return null;
    try {
      return new URL(h, MCI_HOME).href;
    } catch (_) {
      return null;
    }
  }

  /**
   * Fetch MCI homepage HTML for the calendar panel.
   *
   * Browsers cannot read mci.archpitt.org directly (no CORS). Priority:
   *  1) Optional Cloudflare Worker (true live) — MCI_LIVE_PROXY / ?mciProxy=
   *  2) Local serve.py  /api/mci-home  (true live on your Mac)
   *  3) Same-origin GitHub snapshot  data/mci-home.html  (Pages-friendly;
   *     refreshed by GitHub Actions every few hours)
   *  4) Direct + public CORS proxies (best-effort)
   */
  async function fetchMciHomeHtml() {
    const candidates = [];
    const bust = "t=" + Date.now();

    if (MCI_LIVE_PROXY) {
      candidates.push({
        via: "cloud-proxy",
        url: MCI_LIVE_PROXY,
        meta: null,
      });
    }

    if (location.protocol === "http:" || location.protocol === "https:") {
      candidates.push({
        via: "local-proxy",
        url: new URL("api/mci-home", location.href).href + "?" + bust,
        meta: null,
      });
      // GitHub Pages / Netlify / any static host that ships data/
      candidates.push({
        via: "pages-snapshot",
        url: new URL("data/mci-home.html", location.href).href + "?" + bust,
        metaUrl: new URL("data/mci-meta.json", location.href).href + "?" + bust,
      });
    }

    candidates.push({ via: "direct", url: MCI_HOME, meta: null });
    candidates.push({
      via: "allorigins",
      url: "https://api.allorigins.win/raw?url=" + encodeURIComponent(MCI_HOME),
      meta: null,
    });
    candidates.push({
      via: "isomorphic-git-cors",
      url: "https://cors.isomorphic-git.org/" + MCI_HOME,
      meta: null,
    });

    let lastErr = null;
    for (const c of candidates) {
      try {
        const r = await fetch(c.url, {
          mode: "cors",
          cache: "no-store",
          credentials: "omit",
        });
        if (!r.ok) {
          lastErr = new Error(c.via + " HTTP " + r.status);
          continue;
        }
        const t = await r.text();
        if (
          t &&
          t.length > 500 &&
          (t.indexOf("sidebar2") !== -1 || /Liturgical\s+Calendar/i.test(t))
        ) {
          let fetchedAt = null;
          if (c.metaUrl) {
            try {
              const mr = await fetch(c.metaUrl, {
                mode: "cors",
                cache: "no-store",
                credentials: "omit",
              });
              if (mr.ok) {
                const meta = await mr.json();
                if (meta && meta.fetchedAt) fetchedAt = meta.fetchedAt;
              }
            } catch (_) {
              /* meta optional */
            }
          }
          return { html: t, via: c.via, fetchedAt };
        }
        lastErr = new Error(c.via + " returned unexpected content");
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("Could not reach mci.archpitt.org");
  }

  function describeLitCalSource(via, fetchedAt) {
    if (via === "cloud-proxy" || via === "local-proxy" || via === "direct") {
      return "Live from MCI home page";
    }
    if (via === "pages-snapshot") {
      const when = fetchedAt
        ? " · snapshot " + fetchedAt.replace("T", " ").replace("Z", " UTC")
        : "";
      return "From site calendar snapshot (auto-refreshed)" + when;
    }
    return "From MCI via " + via;
  }

  /**
   * Pull the two sidebar sections: Liturgical Calendar + Vigil Divine Liturgy propers.
   * Structure is .newsbox blocks under #sidebar2 with matching h1 titles.
   */
  function parseMciCalendarSections(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const sidebar = doc.querySelector("#sidebar2");
    if (!sidebar) throw new Error("MCI sidebar not found — site layout may have changed");

    const wanted = [
      { key: "calendar", match: /liturgical\s+calendar/i, title: "Liturgical Calendar" },
      {
        key: "vigil",
        match: /vigil\s+divine\s+liturgy\s+propers/i,
        title: "Vigil Divine Liturgy Propers",
      },
    ];
    const found = [];

    const boxes = sidebar.querySelectorAll(".newsbox");
    for (const box of boxes) {
      const h1 = box.querySelector("h1");
      if (!h1) continue;
      const hText = (h1.textContent || "").replace(/\s+/g, " ").trim();
      const want = wanted.find((w) => w.match.test(hText));
      if (!want) continue;
      if (found.some((f) => f.key === want.key)) continue;

      const entries = [];
      const moreLinks = [];
      for (const p of box.querySelectorAll("p")) {
        // Skip empty paragraphs
        const text = (p.textContent || "").replace(/\s+/g, " ").trim();
        if (!text) continue;
        // "complete liturgical calendar" footer link — keep as more-link
        const onlyLinks = p.querySelectorAll("a");
        const isCalendarClass = p.classList && p.classList.contains("calendar");
        if (!isCalendarClass && /complete\s+liturgical\s+calendar/i.test(text)) {
          for (const a of onlyLinks) {
            const href = absMciUrl(a.getAttribute("href"));
            const label = (a.textContent || "").replace(/\s+/g, " ").trim();
            if (href && label) moreLinks.push({ href, label });
          }
          continue;
        }
        if (!isCalendarClass && !p.querySelector("a")) continue;

        // Build a light clone with absolute links
        const parts = [];
        const walk = (node) => {
          if (node.nodeType === 3) {
            const t = node.textContent;
            if (t) parts.push({ type: "text", text: t });
            return;
          }
          if (node.nodeType !== 1) return;
          const tag = node.tagName.toLowerCase();
          if (tag === "a") {
            const href = absMciUrl(node.getAttribute("href"));
            const label = (node.textContent || "").replace(/\s+/g, " ").trim();
            if (href && label) parts.push({ type: "link", href, label });
            else if (label) parts.push({ type: "text", text: label });
            return;
          }
          if (tag === "br") {
            parts.push({ type: "text", text: " " });
            return;
          }
          for (const child of node.childNodes) walk(child);
        };
        walk(p);
        // Merge adjacent text, collapse whitespace in display
        const merged = [];
        for (const part of parts) {
          if (part.type === "text") {
            const t = part.text.replace(/\s+/g, " ");
            if (!t) continue;
            if (merged.length && merged[merged.length - 1].type === "text") {
              merged[merged.length - 1].text += t;
            } else {
              merged.push({ type: "text", text: t });
            }
          } else {
            merged.push(part);
          }
        }
        if (merged.length) entries.push(merged);
      }
      found.push({
        key: want.key,
        title: want.title,
        entries,
        moreLinks,
      });
    }

    if (!found.length) {
      throw new Error("Could not find Liturgical Calendar sections on the MCI page");
    }
    // Stable order: calendar first, then vigil
    found.sort((a, b) => {
      const ia = wanted.findIndex((w) => w.key === a.key);
      const ib = wanted.findIndex((w) => w.key === b.key);
      return ia - ib;
    });
    return found;
  }

  function renderLitCalSections(sections) {
    if (!litCalBody) return;
    litCalBody.innerHTML = "";
    for (const sec of sections) {
      const wrap = document.createElement("section");
      wrap.className = "lit-cal-section";
      const h = document.createElement("h3");
      h.className = "lit-cal-section-title";
      h.textContent = sec.title;
      wrap.appendChild(h);
      for (const entry of sec.entries) {
        const p = document.createElement("p");
        p.className = "lit-cal-entry";
        for (const part of entry) {
          if (part.type === "link") {
            const a = document.createElement("a");
            a.href = part.href;
            a.target = "_blank";
            a.rel = "noopener noreferrer";
            a.textContent = part.label;
            p.appendChild(a);
          } else {
            // Bold leading date phrases roughly like the MCI site
            const span = document.createElement("span");
            const t = part.text;
            const m = t.match(/^(\s*)([A-Za-z]+\s+\d{1,2}(?:\s*[-–]\s*)?)/);
            if (m) {
              const strong = document.createElement("strong");
              strong.textContent = m[2];
              span.appendChild(strong);
              span.appendChild(document.createTextNode(t.slice(m[0].length)));
            } else {
              span.textContent = t;
            }
            p.appendChild(span);
          }
        }
        wrap.appendChild(p);
      }
      for (const more of sec.moreLinks || []) {
        const p = document.createElement("p");
        p.className = "lit-cal-more";
        const a = document.createElement("a");
        a.href = more.href;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        a.textContent = more.label;
        p.appendChild(a);
        wrap.appendChild(p);
      }
      litCalBody.appendChild(wrap);
    }
  }

  async function loadLiturgicalCalendar() {
    if (!litCalStatus || !litCalBody) return;
    const seq = ++litCalFetchSeq;
    litCalBody.hidden = true;
    litCalBody.innerHTML = "";
    litCalStatus.hidden = false;
    litCalStatus.classList.remove("is-error");
    litCalStatus.textContent = "Loading live calendar from mci.archpitt.org…";
    try {
      const { html, via, fetchedAt } = await fetchMciHomeHtml();
      if (seq !== litCalFetchSeq) return;
      const sections = parseMciCalendarSections(html);
      renderLitCalSections(sections);
      litCalBody.hidden = false;
      litCalStatus.classList.remove("is-error");
      litCalStatus.textContent =
        describeLitCalSource(via, fetchedAt) +
        " · links open PDFs in a new tab";
    } catch (err) {
      if (seq !== litCalFetchSeq) return;
      litCalStatus.classList.add("is-error");
      litCalStatus.innerHTML =
        "Could not load the live calendar. " +
        (err && err.message ? err.message + " " : "") +
        'Open the MCI site directly: <a href="' +
        MCI_HOME +
        '" target="_blank" rel="noopener noreferrer">mci.archpitt.org</a>';
      litCalBody.hidden = true;
    }
  }

  function wireLitCalButton(btn) {
    if (!btn) return;
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setLitCalOpen(true);
    });
  }
  wireLitCalButton($("lit-cal-btn-welcome"));
  wireLitCalButton($("lit-cal-btn-menu"));

  if (litCalClose) {
    litCalClose.addEventListener("click", (e) => {
      e.stopPropagation();
      setLitCalOpen(false);
    });
  }
  if (litCalModal) {
    litCalModal.addEventListener("click", (e) => {
      if (e.target === litCalModal) setLitCalOpen(false);
    });
  }

  // “How to use” every time the app is opened (this page load only).
  // Closing it is for this visit; next open shows it again.
  const howtoModal = $("howto-modal");
  const howtoClose = $("howto-close");
  function setHowtoOpen(open) {
    if (!howtoModal) return;
    howtoModal.hidden = !open;
  }
  if (howtoClose) {
    howtoClose.addEventListener("click", (e) => {
      e.stopPropagation();
      setHowtoOpen(false);
    });
  }
  // “liturgical calendar” inside How to use → dismiss howto, open MCI calendar
  const howtoLitCal = $("howto-lit-cal-btn");
  if (howtoLitCal) {
    howtoLitCal.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setHowtoOpen(false);
      setLitCalOpen(true);
    });
  }
  if (howtoModal) {
    howtoModal.addEventListener("click", (e) => {
      if (e.target === howtoModal) setHowtoOpen(false);
    });
    // Always show after paint on each new open / reload
    setTimeout(() => setHowtoOpen(true), 80);
  }

  // Help modal (?)
  const helpBtn = $("help-btn");
  const helpModal = $("help-modal");
  const helpClose = $("help-close");
  function setHelpOpen(open) {
    if (!helpModal) return;
    helpModal.hidden = !open;
  }
  if (helpBtn) {
    helpBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setHelpOpen(true);
    });
  }
  if (helpClose) {
    helpClose.addEventListener("click", (e) => {
      e.stopPropagation();
      setHelpOpen(false);
    });
  }
  if (helpModal) {
    helpModal.addEventListener("click", (e) => {
      if (e.target === helpModal) setHelpOpen(false);
    });
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (howtoModal && !howtoModal.hidden) {
      setHowtoOpen(false);
      return;
    }
    if (litCalModal && !litCalModal.hidden) {
      setLitCalOpen(false);
      return;
    }
    if (helpModal && !helpModal.hidden) setHelpOpen(false);
  });

  // Exclude lit-cal from pointer handlers that clear UI
  // (toolbar already covered; modal is outside toolbar)

  if (EXTRACT_TEST) {
    runExtractTest();
  } else {
    autoLoadFromQuery();
  }
})();
