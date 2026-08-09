# Find Your Range — plan + prompts for Grok and Opus 5

## Plan in one paragraph

The Assess singing button becomes a two-option menu: "Assess singing selection" (existing behavior, unchanged) and "Find your range" (new). Find your range loads a bundled reference chant (`range-test.pdf` + its pre-extracted `range-test.json`, committed in the app folder — YOU must drop these two files in; extract the JSON once with the app's Save score button). The user clicks anywhere to begin, gets the existing 3-2-1 countdown, and sings the familiar piece freely. The app records the pitch stream only — no note tracking, no error marking. A statistics module compares the *distribution* of sung pitches against the distribution of the written melody, derives the singer's comfortable range and a semitone transpose offset, AND estimates their natural singing tempo from the rate of sung syllable onsets. Both results are saved to localStorage and applied as the new *defaults* for the transpose control and the tempo slider — recommendations, never locks; both controls remain fully user-adjustable, and a manual change wins for that session.

## Who builds what — capability assessment

- **Grok (Prompt A):** all UI and wiring — menu, overlay screens, recording session, persistence, results display. This is squarely in its lane.
- **Opus 5 (Prompt B):** the range-estimation engine and transpose integration, implementing the exact algorithm specified below, with mandatory node tests. Do not let Grok do this part.
- **Neither model should design the estimation algorithm** — that's the part that produced subtle bugs before (octave errors, free-form singing, silence gaps). The algorithm is therefore fully specified with concrete numbers in Prompt B; Opus's job is faithful implementation + tests, not invention. If Opus's tests won't pass after two rounds, or the measured offset feels wrong by an octave in real use, bring it back to Fable with the recorded sample dump (the spec requires a debug export for exactly this case).

Run Prompt A first (it defines the UI contract with a stub), then Prompt B (fills in the engine).

---

## Prompt A — Grok (UI + recording session + wiring)

Copy below into Grok, run from the project folder.

---

Add a "Find your range" flow to this chant sight-singing app. All files are in the current folder and working. Do NOT touch extractor.js, pitch.js's detectors, follow.js's timeline/playback engine, or any scoring math. No ES modules, no new dependencies, no build step (file:// must keep working).

1. **Menu.** The existing "Assess singing" button becomes a two-option popover menu, matching current button styling: "Assess selection" (exactly the current behavior — do not change its code path) and "Find your range" (new).

2. **Bundled piece.** `range-test.pdf` and `range-test.json` sit in the app root (they may not exist yet — if missing, show "Range test piece not installed" and abort gracefully). "Find your range" loads them through the normal PDF+score load path (reuse it; don't fork it).

3. **Session flow.**
   - Full-screen translucent overlay: the piece's first page visible behind, big text "Click anywhere to begin — then sing this piece the way that feels comfortable. Don't worry about being exact."
   - On click: ensure mic is on (start it via the existing mic path; if permission denied, show the existing error and abort), then run the existing 3-2-1 countdown, then show a subtle "Listening… sing freely" indicator and a Stop button.
   - Record the pitch stream: subscribe to the existing `trainer.onPitch` values (do NOT add another mic pipeline). Buffer `{t, midi, clarity}` frames, voiced frames only (midi != null). No playback, no tones, no note highlighting, no green rings during this mode.
   - End conditions: Stop clicked, 90 s cap, or ≥4 s of continuous silence after at least 8 s of accumulated voiced time.
   - If total voiced time < 6 s: show "I didn't hear enough singing — try again?" with Retry/Cancel.

4. **Hand off + results.** Call `window.RangeFinder.estimate(frames, scoreJson)` — create a STUB in a new file `range.js` that returns `{ok:false, reason:"engine pending"}` for now (Opus implements the real one; keep the file and function signature exactly). On `{ok:true, low, high, center, offsetSemitones, voiceHint, tempoBpm}`: show a results card — "Your comfortable range: F3 – C4 (baritone). Your natural pace: ♩ = 72. Pieces will now start 5 semitones lower at that tempo." with buttons "Use this" (persist + apply) and "Discard". Note names from the existing midi→name helper. If `tempoBpm` is null, show the range result alone and omit the tempo line (range and tempo succeed/fail independently).

5. **Persistence + application.** On "Use this": save `{low, high, center, offsetSemitones, tempoBpm, ts}` to localStorage key `byz.range.v1`; apply `offsetSemitones` to the app's existing transpose control and `tempoBpm` (when non-null) to the tempo slider — both as new DEFAULTS only: the controls must show the applied values and remain fully user-adjustable, and a manual change wins for that session. On app load, if `byz.range.v1` exists, apply both stored defaults the same way and show a small "Range: F3–C4 · ♩72 ▾" chip near the transpose control with a menu: "Re-measure" / "Clear".

6. **Verify:** all four `node test-*.js` suites still pass; the Assess-selection path is byte-identical in behavior; app loads with and without `range-test.pdf` present. List every file changed and why.

---

## Prompt B — Opus 5 (estimation engine + tests)

Copy below into Claude Code (Opus 5), run from the project folder. Run AFTER Grok's UI prompt.

---

Implement `window.RangeFinder` in `range.js` (Grok left a stub with the exact call signature). This estimates a singer's comfortable range and transpose offset from a free-form singing sample. Implement the algorithm EXACTLY as specified — do not redesign it. No ES modules; keep the pure math exported for node (`globalThis.RangeFinder` when `document` is undefined, same pattern as followCore).

**Input:** `frames`: array of `{t (ms), midi (float), clarity}` voiced frames from the app's detector; `scoreJson`: the bundled piece's score (frozen schema; notes have midi, glyph, type, lyric).

**Algorithm (fixed numbers, implement faithfully):**
1. Drop frames with clarity < 0.9. Drop the first 300 ms of frames after every gap > 250 ms (onset scoops). Convert to weighted samples: each frame's weight = min(gap to next frame, 40 ms).
2. Build a weighted histogram over integer semitones. Let M = histogram mode.
3. Octave-glitch fold: for each sample s with |s − M| > 9, if |s ± 12 − M| ≤ 9, fold by ±12 (single fold only). Recompute the histogram after folding.
4. Stats (weight-aware): center C = weighted median; low = 7th weighted percentile; high = 93rd weighted percentile. If (high − low) < 3 semitones or total weight < 6 s, return `{ok:false, reason:"not enough singing"}`.
5. Written melody stats from scoreJson: per-note duration in beats — quarter 1, eighth 0.5, dottedQuarter 1.5, half 2, whole 4, recit = max(1, syllableCount(lyric)/2) where syllables = hyphen-or-space-separated segments, 8 if empty. Duration-weighted median W of note midi.
6. `offset = Math.round(C − W)`.
7. Fit check: melodyMax + offset vs high, melodyMin + offset vs low. If melody exceeds the measured range by > 2 semitones on one side only, nudge offset toward fit by the excess (max nudge 3). If the melody's span exceeds (high − low) + 4, keep the center fit and set `voiceHint += " (narrow sample)"`.
8. voiceHint from C: ≤ MIDI 48 "bass", ≤ 55 "baritone", ≤ 62 "tenor", ≤ 69 "alto", else "soprano".

**Tempo estimation (steps 9–12 — implement exactly; tempo failure must NOT fail the range result):**
9. Onset detection over the cleaned frame stream (pre-fold): an onset is (a) the first voiced frame after a gap ≥ 120 ms, or (b) a pitch change where the weighted mean of the next 150 ms differs from the weighted mean of the previous 150 ms by ≥ 0.8 semitones (register at the crossing frame; then skip 150 ms before detecting another type-b onset). Collect onset times.
10. Inter-onset intervals (IOIs): successive onset deltas, EXCLUDING any delta > 2000 ms or > 3× the running median (phrase breaks and breaths). Require ≥ 10 surviving IOIs, else `tempoBpm: null`.
11. Sung seconds-per-syllable = median(IOIs). Written beats-per-syllable = B_w / S_w where, over all notes of scoreJson: B_w = total beats (same duration table as step 5) and S_w = total syllables (syllableCount(lyric), 1 if empty for a normal note, 8 if empty for a recit).
12. `tempoBpm = clamp(round(60 × (B_w / S_w) / medianIOI_seconds / 2) × 2, 50, 110)` — i.e. rounded to the nearest even bpm, clamped to 50–110.
13. Return `{ok:true, low, high, center: C, offsetSemitones: offset, voiceHint, tempoBpm, debug: {samples: <folded histogram>, M, W, onsets: <count>, medianIOI, Bw, Sw}}`. The `debug` field must always be present — it is the escalation path if real-world results are wrong.

**Integration:** none beyond the stub contract — Grok's UI already calls it. Do not modify other files except (if needed) a one-line export touch-up.

**Tests (write `test-range.js`, must run and pass, plus keep the 4 existing suites green):**
- Synthetic singer at exactly the melody median → offset 0.
- Same singer one octave down → offset −12; a fifth down → −7.
- 10% of frames corrupted with +12 octave glitches → same answers as clean.
- Singing with 500 ms silence gaps every 3 s → still ok:true, same offset.
- 3 s sample → ok:false "not enough singing".
- Narrow-melody fit-check case: melody spanning 14 semitones vs measured span 8 → returns center fit with the narrow-sample hint.
- Tempo: synthetic singer producing onsets every 750 ms (pitch steps + brief dips) against a fixture score with 1 beat/syllable → tempoBpm 80. Same stream at 500 ms spacing → 120 → clamped to 110.
- Tempo robustness: insert three 3 s phrase-break gaps → same tempoBpm as without them.
- Tempo independence: only 6 onsets total → tempoBpm null but range result still ok:true.
- Build the synthetic melody stats from the real `range-test.json` if present, else from an inline fixture score.

List every file changed and why, and show the test output.
