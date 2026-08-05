# Prompt for Opus 5 — Play / Begin / Finder modes, octave-fold fix, in-tune feedback

Copy everything below the line into Claude Code (Opus 5), run from the project folder. (Grok could do the visual bits, but the mode state machine and audio gating touch the playback engine — Opus is the right tool.)

---

Rework the practice modes of this chant sight-singing app and fix two field-reported bugs. All files are in the current folder and working. The pitch detector is now self-contained in pitch.js (no ESM, no CDN — do not reintroduce either). Core math is `window.followCore`; playback engine is in follow.js; `node test-timeline.js` and the follow-core smoke test must still pass when you're done.

## Bug fixes (do these first)

1. **Octave folding — ball sits too low and flip-flops.** Current `fixOctave` only corrects by exactly ±12 when |sung−target| > 8, so a male voice singing chant an octave (or more) below written pitch lands in zones where the fold is wrong or alternates frame-to-frame (reported: "ball much lower than expected, jumps back and forth"). Replace with:
   - `fold = Math.round((sung - target) / 12)`; `folded = sung - 12 * fold` (nearest octave multiple, handles any octave distance).
   - **Hysteresis:** keep the previous fold value unless a different fold has been implied continuously for > 200 ms of voiced frames; reset the memory on note change and on pitch loss > 400 ms.
2. **Ball vertical jitter.** Smooth the displayed y with an exponential moving average, time constant ≈ 70 ms (smoothing on the display only — scoring uses the raw cents).
3. **Ball default position.** When no pitch is coming in (before singing, and during silences), the ball rests on the BOTTOM LINE of the current staff (`lineYs[4]`) at the current x — not on the melody trace. It rises/falls from there when the voice arrives.
4. **The app scores its own guide tones** (green rings appear when the computer plays through speakers). Fix globally: whenever the app is synthesizing any tone, and for 150 ms after the last one ends, ignore `onPitch` completely — no ball movement from it, no scoring, no anchor updates. One flag set by the tone scheduler, checked at the top of the onPitch handler.

## Mode rework — three cleanly separated modes

Replace the Guide button ("First 6 → All → Off") and the "Headphones recommended" hint with:

**Play ▶ / Stop** (listen mode)
- Plays the notes at the tempo slider from the current ball position, using the existing timeline and synth voice. Runs to the end unless stopped; the button toggles to Stop.
- Mic input fully ignored throughout (rule 4 covers it); nothing is scored, no rings appear, the ball rides the written melody line, pages turn as in playback.
- Purpose: hear the piece (or any stretch of it) before singing. Combined with click-to-seek this replaces "first 6 notes" entirely.

**Begin** (sing mode — existing tempo playback, minus tones)
- Unchanged: countdown at beat speed, bold ball at go, tempo-driven ball, scoring, summary. But the computer now NEVER plays tones during Begin. Simpler mental model: Play = computer sings, Begin = you sing.

**Finder** (new mode — a Mode toggle button: "Tempo | Finder")
- No timeline. The ball parks on the current note (bottom-line default until voice arrives). The app advances to the next note ONLY when the singer holds the target within the tolerance slider for the hold time — accumulate voiced in-tune time additively; consonant gaps must not reset progress (the accumulator pattern already used for scoring).
- **Hear note** button: every press plays the current target note (~700 ms, existing synth voice, mic ignored while sounding + 150 ms). Press it as many times as you like.
- Advancing marks the note green as usual; page turns and staff scrolling work; click-to-seek works; Start over resets.
- Begin/Play buttons are disabled in Finder mode (and Hear note is hidden in Tempo mode).

## In-tune feedback (new, both sing modes)

- **Live halo:** while the sung pitch is within tolerance of the current target, draw 2–3 concentric expanding rings around the green ball (subtle, ~60% opacity, re-emitting every ~400 ms — a gentle pulse, not a strobe). Vanishes the instant you drift out of tolerance. This gives moment-to-moment "you're on it" feedback even while the tempo moves.
- **Scored burst:** when a note is scored (added to `trainer.completed`), draw a one-shot expanding ring animation (~300 ms) centered on that notehead, then the existing static green ring remains.

## Constraints

- Vanilla JS, no build step, no new dependencies, no ES modules (file:// must keep working).
- All synthesis goes through one shared AudioContext created/resumed only inside user-gesture handlers (Safari).
- Keep `window.followCore` exports intact but UPDATE `fixOctave` there to the nearest-multiple version (signature `fixOctave(sung, target)` stays; hysteresis lives in the caller since it's stateful).
- Minimal diffs; don't restructure the timeline engine.

## Verify (must actually run, not just claim)

- `node test-timeline.js` passes.
- Node smoke: `node -e "global.window=undefined; eval(require('fs').readFileSync('follow.js','utf8')); const c=globalThis.followCore; const f=c.fixOctave; if(f(53,65)!==65||f(41,65)!==65||f(63,65)!==63||f(77,65)!==65) throw 'fixOctave wrong'; console.log('core OK')"` — note the two-octave case (41 → 65).
- `?selftest=2` (simulated Begin run) still passes.
- New `?selftest=3`: Finder-mode simulation — virtual singer holds each of the first 8 notes' pitches (with 80 ms silent gaps every 250 ms to imitate consonants); assert the cursor advances through all 8 and each got a green ring; then simulate 2 s of wrong pitch (a 4th off) and assert NO advance happened. PASS/FAIL banner.
- List every file changed and why.
