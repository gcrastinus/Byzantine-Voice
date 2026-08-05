/**
 * audio.js — single shared AudioContext + HTML5 unlock for Safari.
 *
 * Safari often reports AudioContext.state === "running" while still producing
 * no sound. Fix:
 *  - Turn Sound On uses a real user click
 *  - Plays an HTML5 <audio> beep (most reliable Safari unlock)
 *  - Then resumes Web Audio and plays a loud BufferSource beep
 *  - "Confirmed" only after that button path — not merely context "running"
 */
(() => {
  "use strict";

  let ctx = null;
  let primed = false;
  let lastError = "";
  let keepAliveNodes = null;
  /** True only after Turn Sound On successfully scheduled a beep. */
  let userConfirmed = false;
  let recreateCount = 0;
  let htmlAudio = null;
  let silentAudio = null;
  let beepUrl = null;
  let silentUrl = null;
  const listeners = new Set();

  function AC() {
    return window.AudioContext || window.webkitAudioContext || null;
  }

  function notify() {
    const st = getStatus();
    for (const fn of listeners) {
      try {
        fn(st);
      } catch (_) {
        /* ignore */
      }
    }
  }

  function getStatus() {
    const state = ctx ? ctx.state : "none";
    return {
      state,
      ok: !!(ctx && state === "running"),
      /** Only true after Turn Sound On played a beep on a real click */
      enabledOk: userConfirmed && !!(ctx && state === "running"),
      userConfirmed,
      error: lastError,
    };
  }

  // —— Build a real WAV beep (no external files) ——

  function buildBeepWavUrl(freq, durationSec, sampleRate, peak) {
    const n = Math.floor(sampleRate * durationSec);
    const dataBytes = n * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buf);
    const wstr = (offset, s) => {
      for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    };
    wstr(0, "RIFF");
    view.setUint32(4, 36 + dataBytes, true);
    wstr(8, "WAVE");
    wstr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    wstr(36, "data");
    view.setUint32(40, dataBytes, true);
    let o = 44;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      // Attack / decay so it isn't a click
      const env =
        Math.min(1, i / (sampleRate * 0.02)) *
        Math.min(1, (n - i) / (sampleRate * 0.06));
      // Slightly bright tone (fund + octave) so laptop speakers hear it
      const s =
        Math.sin(2 * Math.PI * freq * t) * 0.7 +
        Math.sin(2 * Math.PI * freq * 2 * t) * 0.3;
      const sample = Math.max(-1, Math.min(1, s * env * peak));
      view.setInt16(o, (sample * 32767) | 0, true);
      o += 2;
    }
    const blob = new Blob([buf], { type: "audio/wav" });
    return URL.createObjectURL(blob);
  }

  function attachHiddenAudio(el) {
    if (typeof document === "undefined" || !document.body) return;
    try {
      if (el.style) {
        el.style.position = "fixed";
        el.style.width = "0";
        el.style.height = "0";
        el.style.opacity = "0";
        el.style.pointerEvents = "none";
      }
      if (!el.parentNode) document.body.appendChild(el);
    } catch (e) {
      console.warn("AppAudio: could not attach HTML audio", e);
    }
  }

  function makeAudioEl(url) {
    const a = new Audio();
    a.preload = "auto";
    a.setAttribute("playsinline", "true");
    a.setAttribute("webkit-playsinline", "true");
    a.controls = false;
    a.src = url;
    attachHiddenAudio(a);
    return a;
  }

  function ensureHtmlAudio() {
    if (beepUrl && htmlAudio) return htmlAudio;
    if (beepUrl) {
      try {
        URL.revokeObjectURL(beepUrl);
      } catch (_) {
        /* ignore */
      }
    }
    // ~880 Hz, 0.45 s, loud — only for Turn Sound On
    beepUrl = buildBeepWavUrl(880, 0.45, 22050, 0.95);
    htmlAudio = makeAudioEl(beepUrl);
    htmlAudio.volume = 1;
    return htmlAudio;
  }

  /** Truly silent WAV for Begin/Play unlock (no audible test tone). */
  function ensureSilentAudio() {
    if (silentUrl && silentAudio) return silentAudio;
    if (silentUrl) {
      try {
        URL.revokeObjectURL(silentUrl);
      } catch (_) {
        /* ignore */
      }
    }
    // peak 0 → all zeros; still a valid play() for Safari policy
    silentUrl = buildBeepWavUrl(440, 0.05, 22050, 0);
    silentAudio = makeAudioEl(silentUrl);
    silentAudio.volume = 0;
    return silentAudio;
  }

  function playAudioEl(a, volume) {
    try {
      a.pause();
      a.currentTime = 0;
      a.volume = Math.max(0, Math.min(1, volume));
      const p = a.play();
      if (p && typeof p.then === "function") {
        return p
          .then(() => true)
          .catch((e) => {
            lastError = "HTML audio blocked: " + (e && e.message ? e.message : e);
            console.warn("AppAudio: HTML audio failed", e);
            return false;
          });
      }
      return Promise.resolve(true);
    } catch (e) {
      lastError = "HTML audio error: " + (e && e.message ? e.message : e);
      console.warn("AppAudio: HTML audio error", e);
      return Promise.resolve(false);
    }
  }

  /**
   * Audible HTML5 beep — only for Turn Sound On.
   * Returns Promise&lt;boolean&gt;.
   */
  function playHtmlBeep(opts) {
    const vol = opts && opts.volume != null ? opts.volume : 1;
    return playAudioEl(ensureHtmlAudio(), vol);
  }

  /** Silent HTML unlock for Begin/Play (must not be heard). */
  function playHtmlSilentUnlock() {
    return playAudioEl(ensureSilentAudio(), 0);
  }

  /** Zero-sample Web Audio tick — proves the graph works, produces no tone. */
  function scheduleSilentTick(c) {
    if (!c || c.state !== "running") return false;
    try {
      const sr = c.sampleRate || 44100;
      const n = Math.max(8, (sr * 0.03) | 0);
      const buf = c.createBuffer(1, n, sr);
      // leave channel data as zeros
      const src = c.createBufferSource();
      src.buffer = buf;
      const g = c.createGain();
      g.gain.value = 0;
      src.connect(g);
      g.connect(c.destination);
      src.start();
      primed = true;
      return true;
    } catch (e) {
      console.warn("AppAudio: silent tick failed", e);
      return false;
    }
  }

  function wireState(c) {
    if (!c || c.__appAudioWired) return;
    c.__appAudioWired = true;
    c.addEventListener("statechange", () => {
      if (!ctx || ctx !== c) return;
      if (c.state === "running") {
        if (!keepAliveNodes) startKeepAlive(c);
        notify();
      } else if (c.state === "interrupted" || c.state === "suspended") {
        userConfirmed = false;
        keepAliveNodes = null;
        notify();
      } else if (c.state === "closed") {
        userConfirmed = false;
        keepAliveNodes = null;
        if (ctx === c) ctx = null;
        primed = false;
        notify();
      }
    });
  }

  function ensure() {
    const Ctor = AC();
    if (!Ctor) {
      lastError = "Web Audio API not available in this browser.";
      return null;
    }
    if (ctx && ctx.state === "closed") {
      ctx = null;
      primed = false;
      keepAliveNodes = null;
    }
    if (!ctx) {
      try {
        ctx = new Ctor();
        wireState(ctx);
      } catch (e) {
        lastError = String(e && e.message ? e.message : e);
        console.warn("AppAudio: create failed", e);
        return null;
      }
    }
    return ctx;
  }

  function recreate() {
    stopKeepAlive();
    const old = ctx;
    ctx = null;
    primed = false;
    if (old) {
      try {
        old.close();
      } catch (_) {
        /* ignore */
      }
    }
    recreateCount += 1;
    return ensure();
  }

  function primeOutput(c) {
    if (!c || c.state !== "running") return;
    try {
      // Silent buffer source (Safari output path openers prefer this)
      const n = Math.max(1, (c.sampleRate * 0.05) | 0);
      const buf = c.createBuffer(1, n, c.sampleRate);
      const src = c.createBufferSource();
      src.buffer = buf;
      const g = c.createGain();
      g.gain.value = 0.0001;
      src.connect(g);
      g.connect(c.destination);
      src.start();
      primed = true;
    } catch (e) {
      console.warn("AppAudio: prime failed", e);
    }
  }

  function startKeepAlive(c) {
    if (!c || c.state !== "running") return;
    stopKeepAlive();
    try {
      const n = Math.max(1, (c.sampleRate * 0.25) | 0);
      const buf = c.createBuffer(1, n, c.sampleRate);
      // Tiny non-zero so some engines don't optimize out the graph
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (i & 1) * 0.00001;
      const src = c.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const g = c.createGain();
      g.gain.value = 0.00005;
      src.connect(g);
      g.connect(c.destination);
      src.start();
      keepAliveNodes = { src, g };
    } catch (e) {
      console.warn("AppAudio: keep-alive failed", e);
    }
  }

  function stopKeepAlive() {
    if (!keepAliveNodes) return;
    try {
      keepAliveNodes.src.stop();
    } catch (_) {
      /* ignore */
    }
    try {
      keepAliveNodes.src.disconnect();
      keepAliveNodes.g.disconnect();
    } catch (_) {
      /* ignore */
    }
    keepAliveNodes = null;
  }

  /** Loud Web Audio beep via AudioBuffer (more reliable than Oscillator on some Safari builds). */
  function playWebBeep(c) {
    if (!c || c.state !== "running") return false;
    try {
      const sr = c.sampleRate || 44100;
      const dur = 0.45;
      const n = Math.floor(sr * dur);
      const buf = c.createBuffer(1, n, sr);
      const data = buf.getChannelData(0);
      const freq = 880;
      for (let i = 0; i < n; i++) {
        const t = i / sr;
        const env =
          Math.min(1, i / (sr * 0.02)) * Math.min(1, (n - i) / (sr * 0.08));
        const s =
          Math.sin(2 * Math.PI * freq * t) * 0.65 +
          Math.sin(2 * Math.PI * freq * 2 * t) * 0.35;
        data[i] = s * env * 0.85;
      }
      const src = c.createBufferSource();
      src.buffer = buf;
      const g = c.createGain();
      g.gain.value = 0.9;
      src.connect(g);
      g.connect(c.destination);
      src.start();
      primed = true;
      return true;
    } catch (e) {
      console.warn("AppAudio: web beep failed", e);
      lastError = "Web beep failed: " + (e && e.message ? e.message : e);
      return false;
    }
  }

  function resumePromise(c) {
    if (!c) return Promise.reject(new Error("no context"));
    if (c.state === "running") return Promise.resolve(c);
    return c.resume().then(() => c);
  }

  /**
   * Soft unlock on any gesture — does NOT claim “sound works”.
   */
  function unlock() {
    let c = ensure();
    if (!c) return null;
    if (c.state === "closed") c = recreate();
    if (!c) return null;

    if (c.state !== "running") {
      c.resume()
        .then(() => {
          if (c.state === "running") {
            primeOutput(c);
            startKeepAlive(c);
            notify();
          }
        })
        .catch((e) => {
          lastError = "Audio unlock failed: " + (e && e.message ? e.message : e);
          console.warn("AppAudio: resume failed", e);
          notify();
        });
    } else {
      if (!keepAliveNodes) startKeepAlive(c);
      if (!primed) primeOutput(c);
      notify();
    }
    return c;
  }

  function wake() {
    lastError = "";
    let c = ensure();
    if (!c) return Promise.resolve(false);

    const afterRunning = (running) => {
      if (!running || running.state !== "running") return false;
      primeOutput(running);
      startKeepAlive(running);
      notify();
      return true;
    };

    return resumePromise(c)
      .then((running) => {
        if (afterRunning(running)) return true;
        c = recreate();
        if (!c) return false;
        return resumePromise(c).then((r2) => afterRunning(r2));
      })
      .catch(() => {
        c = recreate();
        if (!c) return false;
        return resumePromise(c)
          .then((r2) => afterRunning(r2))
          .catch((e2) => {
            lastError = "Audio wake failed: " + (e2 && e2.message ? e2.message : e2);
            notify();
            return false;
          });
      });
  }

  /**
   * Call from Begin / Play / note click (real user gesture).
   * Re-wakes Safari/Chrome audio every time:
   *  1) near-silent HTML5 play() (unlocks media policy)
   *  2) resume or recreate AudioContext
   *  3) prime + keep-alive + silent Web Audio tick
   * Returns Promise&lt;{ ok, ctx, html, web, state }&gt;
   */
  function ensureLive() {
    lastError = "";
    // Kick both paths immediately on the click stack (before awaits settle)
    const htmlP = playHtmlSilentUnlock();
    let c = ensure();
    if (c && c.state === "closed") c = recreate();
    const resumeP = c
      ? c.state === "running"
        ? Promise.resolve(c)
        : c.resume().then(() => c).catch(() => null)
      : Promise.resolve(null);

    return Promise.all([htmlP, resumeP])
      .then(([htmlOk, running]) => {
        let use = running && running.state === "running" ? running : null;
        if (!use) {
          use = recreate();
          if (!use) {
            return { ok: false, ctx: null, html: htmlOk, web: false, state: "none" };
          }
          return use
            .resume()
            .then(() => finishLive(use, htmlOk))
            .catch(() => finishLive(use, htmlOk));
        }
        return finishLive(use, htmlOk);
      })
      .catch((e) => {
        lastError = String(e && e.message ? e.message : e);
        notify();
        return {
          ok: false,
          ctx: null,
          html: false,
          web: false,
          state: getState(),
        };
      });
  }

  function finishLive(use, htmlOk) {
    if (!use || use.state !== "running") {
      if (!lastError) lastError = "Audio context not running after wake.";
      notify();
      return {
        ok: false,
        ctx: null,
        html: !!htmlOk,
        web: false,
        state: use ? use.state : "none",
      };
    }
    primeOutput(use);
    startKeepAlive(use);
    const webOk = scheduleSilentTick(use);
    // Soft-confirm so later notes can schedule; Turn Sound On still does a loud test
    if (htmlOk || webOk) userConfirmed = true;
    notify();
    return {
      ok: true,
      ctx: use,
      html: !!htmlOk,
      web: !!webOk,
      state: use.state,
    };
  }

  /**
   * HARD user button — call only from click handler.
   * ensureLive + loud HTML/Web beeps so the singer can hear confirmation.
   */
  function forceEnable() {
    lastError = "";
    // Loud HTML beep on the gesture first
    const htmlP = playHtmlBeep({ volume: 1 });
    let c = ensure();
    if (c && c.state === "closed") c = recreate();
    const resumeP = c
      ? c.state === "running"
        ? Promise.resolve(c)
        : c.resume().then(() => c).catch(() => null)
      : Promise.resolve(null);

    return Promise.all([htmlP, resumeP])
      .then(([htmlOk, running]) => {
        return ensureLive().then((live) => {
          const use = (live && live.ctx) || running || ensure();
          let webOk = false;
          if (use && use.state === "running") {
            webOk = playWebBeep(use);
            primeOutput(use);
            startKeepAlive(use);
          }
          // Also count loud HTML beep
          userConfirmed = !!(htmlOk || webOk || (live && live.ok));
          if (!userConfirmed && !lastError) {
            lastError =
              "No beep scheduled. Check that this tab is not muted (speaker icon on the tab).";
          }
          notify();
          return {
            ok: userConfirmed,
            html: htmlOk,
            web: webOk,
            state: use ? use.state : "none",
          };
        });
      })
      .catch((e) => {
        lastError = String(e && e.message ? e.message : e);
        userConfirmed = false;
        notify();
        return { ok: false, html: false, web: false, state: getState() };
      });
  }

  function whenRunning(fn) {
    // Fast path: already live (e.g. mid Play-notes sequence)
    const c = ensure();
    if (c && c.state === "running") {
      if (!primed) primeOutput(c);
      if (!keepAliveNodes) startKeepAlive(c);
      fn(c);
      return;
    }
    // Slow path: re-arm Safari/Chrome (tab return, first note after sleep)
    ensureLive()
      .then((r) => {
        if (r && r.ok && r.ctx && r.ctx.state === "running") fn(r.ctx);
        else fn(null);
      })
      .catch(() => fn(null));
  }

  function getState() {
    return ctx ? ctx.state : "none";
  }

  function getLastError() {
    return lastError;
  }

  function onStatus(fn) {
    if (typeof fn === "function") listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function markUnconfirmed() {
    userConfirmed = false;
    notify();
  }

  // —— Global gesture unlock + tab return ——
  if (typeof document !== "undefined" && document.addEventListener) {
    // Soft unlock only — do NOT auto-confirm sound
    const kick = () => unlock();
    document.addEventListener("pointerdown", kick, { capture: true });
    document.addEventListener("touchstart", kick, { capture: true });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        userConfirmed = false;
        keepAliveNodes = null;
        notify();
      } else {
        userConfirmed = false;
        notify();
        const c = ctx;
        if (c && c.state !== "running" && c.state !== "closed") {
          c.resume()
            .then(() => {
              if (c.state === "running") startKeepAlive(c);
              notify();
            })
            .catch(() => {});
        }
      }
    });

    window.addEventListener("pageshow", () => {
      userConfirmed = false;
      notify();
    });
  }

  window.AppAudio = {
    ensure,
    unlock,
    wake,
    ensureLive,
    forceEnable,
    recreate,
    whenRunning,
    primeOutput,
    startKeepAlive,
    playHtmlBeep,
    getState,
    getLastError,
    getStatus,
    onStatus,
    markUnconfirmed,
    get context() {
      return ctx;
    },
    get recreateCount() {
      return recreateCount;
    },
  };
})();
