# Prompt for Opus 5 — Tempo-driven playback mode

Copy everything below the line into Claude Code (Opus 5), run from the project folder.

---

Rebuild the practice flow of this chant sight-singing web app from "advance when the singer holds the right pitch" to **tempo-driven playback**. All files are in the current folder and working: index.html, app.js (PDF viewer + overlay + `window.trainer` API), pitch.js (mic → `trainer.onPitch(midiFloat, clarity)` at ~50 Hz), follow.js (old pitch-hold auto-advance + a pure math core exported as `window.followCore`), style.css, plus a test pair: 08-16-26_Sunday_Vespers.pdf and its extracted 08-16-26_Sunday_Vespers.json.

Reuse, do not rewrite: `followCore.midiToAbsStepFloat / ballStep / stepToY / fixOctave` (diatonic pitch→staff-step mapping, verified by tests), the flattened `trainer.notes` (each note has `x, y, step, midi, type ("note"|"recit"), glyph, lyric, staffLineYs, staffSpacing, keySig, pdfPage, staffIndex`), `trainer.drawBall / focusNote / completed`, and the coordinate rule cssPx = pdfPt × `window.pdfScale`.

## New behavior

1. **Ball on load.** As soon as a score.json is loaded, park a GREEN ball (replace the blue fill; keep the glow) on the first note. Remove the grey target ring. Instead draw a thin grey polyline tracing the written melody of the currently visible staff (segments connecting each note's engraved (x, y)); ball-on-line = in tune.

2. **New controls** (match the existing large-button style in style.css):
   - **Begin/Stop** button.
   - **Tempo** slider, 40–140, default 80 = quarter notes per minute (half = 2 beats, whole = 4, eighth = 0.5, dottedQuarter = 1.5).
   - **Guide** button cycling `First 6 → All → Off` (default First 6).
   - A banner when a PDF is loaded without a score: "Load the matching score.json (Score button)" — this was a real usability failure.

3. **Click-to-seek.** Clicking/tapping the sheet selects the nearest note within 25 css px (overlay has pointer-events none — attach the handler to the canvas wrapper). Ball parks there; Begin starts from it.

4. **Begin sequence.** On Begin: 3-2-1 countdown, one count per quarter-note duration (min 500 ms each), drawn as large translucent numerals centered over the sheet. At "go" the ball becomes ~1.6× radius with a stronger glow for the first second, then normal.

5. **Playback timeline.** Note duration in beats from glyph as in (2). Reciting notes (`type "recit"`): seconds = max(1, syllableCount/2) at 2 syllables/sec, converted to beats at the current tempo; syllableCount = count of hyphen-or-space-separated segments in `lyric`, fallback 8 syllables if lyric is empty. Ball x glides linearly from the current note's x to the next note's x across the duration. At a staff break: NO x interpolation across the gap — ball jumps to the next staff's first note at the boundary (drops to the next line). At a page break: turn the page at the note boundary (call `trainer.focusNote`, which already renders the new page) and continue on the next beat without extra pause. Auto-scroll the stage so the active staff stays in the upper third.

6. **Ball y while playing.** When the mic reports a pitch: `y = stepToY(ballStep(fixOctave(sung, target), currentNote, keySig.fifths, offset), staffLineYs, spacing)` — exactly the existing math, target = the note the ball is currently inside. When no pitch: ball rides the written melody trace (interpolate target y). Relative mode: keep follow.js's anchor logic (first stable pitch ≥500 ms sets a semitone offset).

7. **Guide tones.** WebAudio oscillator (triangle), gain ≈ 0.15 with 20 ms attack / 60 ms release, scheduled against `AudioContext.currentTime` at the exact note boundaries, frequency = 440·2^((midi+offset−69)/12). "First 6": only the first 6 notes from the start position. "All": every note. Mic keeps running during guide tones (if the detector picks up the guide, it reads the correct target pitch — acceptable; add a small "headphones recommended" hint near the Guide button).

8. **Scoring.** During playback mark a note in `trainer.completed` (green ring, already rendered by app.js) if the singer was within the tolerance slider's cents for ≥40% of the note's *voiced* duration. CRITICAL, from field testing: consonants between syllables interrupt pitch detection many times per note, especially on long reciting notes. Accumulate in-tune time additively across those gaps — never reset an accumulator because `onPitch(null)` arrived. Silence simply doesn't accumulate; it must not erase progress. The green rings are the singer's score trail: they persist until Start over, which clears them.

9. **Old mode.** The pitch-hold auto-advance is superseded; remove its advance logic but keep `followCore` exports and the anchor code. Start-over resets position to note 0 (or the seek position), clears `completed`, stops playback.

## Fixes from field testing (do these too)

- **pitch.js:** raise `FFT_SIZE` from 2048 to 4096. A male cantor sings the treble staff an octave down; bottom-staff notes land at 145–165 Hz, where a 2048-sample window (~6 cycles) makes the McLeod detector unreliable and biases estimates upward — the reported symptom was "the ball can't reach notes on or below the bottom line." Keep the poll rate as is.
- **follow.js:** widen the ball's step clamp in `ballStep` from [-6, 14] to [-10, 16] so the ball can travel well below the staff (first ledger lines are real targets in this repertoire).
- Written notes on/below the bottom line must be reachable: after the two fixes above, verify in the selftest that a simulated E4 (midi 64, bottom line) and D4 (midi 62, below the line) place the ball at `stepToY(0)` and `stepToY(-1)` respectively.

## Constraints

- Vanilla JS, no build step, no new dependencies. Implement in follow.js (rename internals as needed); minimal diffs to app.js/index.html/style.css.
- Keep `window.followCore` exports and the headless-node guard (`typeof document === "undefined"` → return after exporting core) intact — node tests eval follow.js.
- Safari (M1 Mac) is the primary browser: create/resume AudioContext only inside the Begin click handler; the mic module (pitch.js) already handles its own context — use a separate context or reuse pitch.js's only via a clean accessor, don't reach into its internals.

## Verify (must run, not just claim)

- `?selftest=2`: simulated playback — virtual singer emits the correct melody (±20¢ wobble) into `trainer.onPitch` while playback runs at 120 bpm from note 0 with Guide Off; assert ball x is monotonically non-decreasing within each staff, the page turns when the timeline crosses page 1→2, and the summary reports ≥90% in tune. Show a PASS/FAIL banner like the existing `?selftest=1`.
- Node smoke test: `node -e "global.window=undefined; eval(require('fs').readFileSync('follow.js','utf8')); const c=globalThis.followCore; if(c.ballStep(69,{midi:67,step:2},1,0)!==3) throw 'math regressed'; console.log('core OK')"`.
- List every file you changed and why, at the end.
