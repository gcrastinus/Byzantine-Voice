/**
 * mobile.js — phone layout rearrangement.
 *
 * A phone gets a deliberately reduced app: gear (upload + settings), Match
 * Pitch, Play, page navigation. Everything else either moves inside the gear
 * sheet or is hidden and explained in Help.
 *
 * The reduction is done by moving real DOM nodes rather than duplicating
 * controls, so Transpose and Tempo keep their ids, their event wiring in
 * follow.js, and their enable/disable state. Nothing here re-implements
 * behaviour; it only changes where the controls live.
 */
(() => {
  "use strict";

  if (typeof document === "undefined") return;

  const MOUNT_ID = "mobile-tools-mount";
  /** Controls that move into the gear sheet on a phone, in display order. */
  const MOVABLE = ["transpose-controls", "tempo-controls"];

  /** Where each control lived on the desktop toolbar, so it can go back. */
  const home = new Map();

  function $(id) {
    return document.getElementById(id);
  }

  function isCompact() {
    return document.body.classList.contains("compact-toolbar");
  }

  /** Remember a node's original parent + next sibling before the first move. */
  function rememberHome(el) {
    if (home.has(el.id)) return;
    home.set(el.id, { parent: el.parentNode, next: el.nextSibling });
  }

  function moveToSheet() {
    const mount = $(MOUNT_ID);
    if (!mount) return;
    for (const id of MOVABLE) {
      const el = $(id);
      if (!el || el.parentNode === mount) continue;
      rememberHome(el);
      mount.appendChild(el);
    }
  }

  function moveToToolbar() {
    for (const id of MOVABLE) {
      const el = $(id);
      const slot = home.get(id);
      if (!el || !slot || !slot.parent) continue;
      if (el.parentNode === slot.parent) continue;
      // insertBefore with a null ref appends, which is the right fallback if
      // the original next sibling has since been removed.
      const ref = slot.next && slot.next.parentNode === slot.parent ? slot.next : null;
      slot.parent.insertBefore(el, ref);
    }
  }

  function sync() {
    if (isCompact()) moveToSheet();
    else moveToToolbar();
  }

  function install() {
    if (!document.body) {
      setTimeout(install, 50);
      return;
    }
    sync();
    // app.js toggles .compact-toolbar on resize after measuring the bar.
    const obs = new MutationObserver((records) => {
      for (const r of records) {
        if (r.attributeName === "class") {
          sync();
          return;
        }
      }
    });
    obs.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    window.addEventListener("orientationchange", () => setTimeout(sync, 120));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", install);
  } else {
    install();
  }
})();
