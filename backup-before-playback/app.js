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

  // —— pdf.js setup ——
  const pdfjsLib = window["pdfjs-dist/build/pdf"] || window.pdfjsLib;
  if (!pdfjsLib) {
    console.error("pdf.js failed to load from CDN");
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  // —— DOM ——
  const $ = (id) => document.getElementById(id);
  const els = {
    stage: $("stage"),
    dropHint: $("drop-hint"),
    canvasWrap: $("canvas-wrap"),
    pageCanvas: $("page"),
    overlayCanvas: $("overlay"),
    pdfInput: $("pdf-input"),
    scoreInput: $("score-input"),
    fileStatus: $("file-status"),
    micBtn: $("mic-btn"),
    modeBtn: $("mode-btn"),
    sensitivity: $("sensitivity"),
    sensitivityVal: $("sensitivity-val"),
    advanceHold: $("advance-hold"),
    advanceHoldVal: $("advance-hold-val"),
    currentNote: $("current-note"),
    startOverBtn: $("start-over-btn"),
    prevPage: $("prev-page"),
    nextPage: $("next-page"),
    pageLabel: $("page-label"),
  };

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
    /** Global sequential index into state.notes, or -1 */
    highlightIndex: -1,
    micOn: false,
    mode: "absolute", // "absolute" | "relative"
    sensitivityCents: 50,
    advanceHoldMs: 300,
    rendering: false,
    /** Latest requested page while a render is in flight */
    pendingPage: null,
  };

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

  function isValidScore(json) {
    return json && typeof json === "object" && Array.isArray(json.pages);
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

  function noteDisplayLabel(n) {
    if (!n) return "—";
    if (n.type === "rest") return "𝄽";
    if (state.mode === "relative") {
      return n.step != null ? String(n.step) : "—";
    }
    // Absolute: prefer midi → pitch name
    if (n.midi != null) return midiToName(n.midi);
    return "—";
  }

  // —— Overlay drawing ——

  function clearOverlay() {
    overlayCtx.save();
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, els.overlayCanvas.width, els.overlayCanvas.height);
    overlayCtx.restore();
  }

  /** Soft yellow rounded rect behind sequential note index (state.notes). */
  function highlightNote(index) {
    state.highlightIndex = index;
    redrawOverlay();
  }

  /**
   * Blue ball at PDF-point (x, y). r = 6 PDF points, 60% opacity + glow.
   * Pass null / omit y to clear the ball.
   */
  function drawBall(x, y) {
    if (x == null || y == null) {
      state.ball = null;
    } else {
      state.ball = { x, y };
    }
    redrawOverlay();
  }

  function redrawOverlay() {
    clearOverlay();
    // Draw in CSS-pixel space (dpr scales into the backing store).
    overlayCtx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);

    const notes = state.notes;
    const hi = state.highlightIndex;

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

    // Grey hollow ring at the target (engraved) position of the current note,
    // so the singer sees the gap between ball (sung) and ring (target).
    if (hi >= 0 && hi < notes.length) {
      const n = notes[hi];
      if (n.pdfPage === state.pageNum && n.x != null && n.y != null) {
        const c = pdfToCanvas(n.x, n.y);
        overlayCtx.beginPath();
        overlayCtx.arc(c.x, c.y, 6 * state.scale, 0, Math.PI * 2);
        overlayCtx.lineWidth = 2.5;
        overlayCtx.strokeStyle = "rgba(140, 140, 150, 0.9)";
        overlayCtx.stroke();
      }
    }

    // Ball (always in PDF points for the current page coordinate system)
    if (state.ball) {
      const c = pdfToCanvas(state.ball.x, state.ball.y);
      const r = 6 * state.scale; // 6 PDF points → CSS px
      overlayCtx.beginPath();
      overlayCtx.arc(c.x, c.y, r, 0, Math.PI * 2);
      overlayCtx.fillStyle = "rgba(50, 120, 255, 0.6)";
      overlayCtx.shadowColor = "rgba(50, 120, 255, 0.85)";
      overlayCtx.shadowBlur = 8 * state.scale;
      overlayCtx.fill();
      overlayCtx.shadowBlur = 0;
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
    } catch (err) {
      console.error("renderPage failed", err);
      els.fileStatus.textContent = "Render error";
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
    els.pageLabel.textContent = n ? `${p} / ${n}` : "— / —";
    els.prevPage.disabled = !n || p <= 1;
    els.nextPage.disabled = !n || p >= n;
  }

  async function goToPage(num) {
    if (!state.pdfDoc) return;
    const clamped = Math.max(1, Math.min(state.pageCount, num));
    await renderPage(clamped);
  }

  // —— Score / trainer ——

  function focusNote(index) {
    const notes = state.notes;
    if (!notes.length || index < 0 || index >= notes.length) {
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
      if (n.x != null && n.y != null) drawBall(n.x, n.y);
      else {
        state.ball = null;
        redrawOverlay();
      }
    };

    if (state.pdfDoc && n.pdfPage !== state.pageNum) {
      goToPage(n.pdfPage).then(apply);
    } else {
      apply();
    }
  }

  function setScore(scoreJson) {
    if (!isValidScore(scoreJson)) {
      console.warn("setScore: expected { version, pages: [{ staves: [{ notes }] }] }");
      state.score = null;
      state.notes = [];
      window.trainer.currentNoteIndex = 0;
      state.highlightIndex = -1;
      state.ball = null;
      updateCurrentNoteDisplay();
      redrawOverlay();
      return;
    }

    state.score = scoreJson;
    state.notes = flattenNotes(scoreJson);
    window.trainer.currentNoteIndex = 0;
    window.trainer.completed.clear();
    state.ball = null;

    if (state.notes.length) {
      focusNote(0);
    } else {
      state.highlightIndex = -1;
      updateCurrentNoteDisplay();
      redrawOverlay();
    }
  }

  function updateCurrentNoteDisplay() {
    const i = window.trainer.currentNoteIndex;
    const n = state.notes[i];
    els.currentNote.textContent = noteDisplayLabel(n);
  }

  function startOver() {
    if (state.notes.length) {
      focusNote(0);
    } else {
      window.trainer.currentNoteIndex = 0;
      state.highlightIndex = -1;
      state.ball = null;
      updateCurrentNoteDisplay();
      redrawOverlay();
    }
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
    /** Sequential indices of correctly-sung notes (drawn as green rings). */
    completed: new Set(),
    setScore,
    currentNoteIndex: 0,
    drawBall,
    highlightNote,
    /** Jump to sequential note (updates page, highlight, ball, display). */
    focusNote,
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
  };

  // —— File loading ——

  async function loadPdfFromData(data, name) {
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdf = await loadingTask.promise;
    state.pdfDoc = pdf;
    state.pdfName = name || "document.pdf";
    state.pageCount = pdf.numPages;
    state.pageNum = 1;
    state.ball = null;
    els.dropHint.hidden = true;
    els.canvasWrap.hidden = false;
    els.fileStatus.textContent = state.pdfName;
    await renderPage(1);

    // Auto-fetch sibling name.json when served over HTTP from same directory
    if (name && !state.score) {
      tryAutoLoadScore(name);
    }
  }

  async function loadPdfFile(file) {
    const buf = await file.arrayBuffer();
    await loadPdfFromData(new Uint8Array(buf), file.name);
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
    setScore(json);
    els.fileStatus.textContent = state.pdfName
      ? `${state.pdfName} + ${file.name}`
      : file.name;
  }

  function tryAutoLoadScore(pdfName) {
    // Only works when served over http(s), not file://
    if (location.protocol === "file:") return;
    const base = pdfName.replace(/\.pdf$/i, "");
    const url = new URL(`${base}.json`, location.href).href;
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        if (isValidScore(json)) {
          setScore(json);
          els.fileStatus.textContent = `${state.pdfName} + ${base}.json`;
        }
      })
      .catch(() => {
        /* no sibling score — fine */
      });
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

  els.modeBtn.addEventListener("click", () => {
    state.mode = state.mode === "absolute" ? "relative" : "absolute";
    els.modeBtn.dataset.mode = state.mode;
    els.modeBtn.textContent = state.mode === "absolute" ? "Absolute" : "Relative";
    updateCurrentNoteDisplay();
    window.dispatchEvent(
      new CustomEvent("trainer:mode", { detail: { mode: state.mode } })
    );
  });

  els.sensitivity.addEventListener("input", () => {
    state.sensitivityCents = Number(els.sensitivity.value);
    els.sensitivityVal.textContent = `${state.sensitivityCents}¢`;
  });

  els.advanceHold.addEventListener("input", () => {
    state.advanceHoldMs = Number(els.advanceHold.value);
    els.advanceHoldVal.textContent = `${state.advanceHoldMs}ms`;
  });

  els.startOverBtn.addEventListener("click", startOver);

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    if (!state.pdfDoc) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => renderPage(state.pageNum), 120);
  });

  updatePageChrome();
  els.sensitivityVal.textContent = `${state.sensitivityCents}¢`;
  els.advanceHoldVal.textContent = `${state.advanceHoldMs}ms`;
})();
