# Chant Sight-Singing Trainer

Static single-page web app for singing from Metropolitan Cantor Institute (MCI) PDFs. Load a Finale/Maestro PDF; the score is extracted **in the browser** (no Python, no terminal, no separate `score.json` step). Pitch detection and tempo follow run client-side.

## Deploy without a terminal (recommended)

### Netlify Drop (easiest)

1. Open **[app.netlify.com/drop](https://app.netlify.com/drop)** in a browser (free Netlify account).
2. Drag this **whole project folder** onto the page.
3. Netlify gives you a permanent **https://…netlify.app** URL. Bookmark it on Mac or iPad.
4. To update later: open the site’s **Deploys** page and drag the folder again.

### Usage after deploy

1. Open the Netlify URL.
2. Click **PDF** and choose any MCI service PDF (or drag it onto the page).
3. Wait for **“Score extracted: N notes”**.
4. Allow the microphone once (https remembers permission). Headphones recommended so the guide tone doesn’t confuse the mic.
5. Press **Begin** and sing.

Optional:

- **Score** — load a hand-edited `score.json` override (takes precedence over auto-extract).
- **Save score** — download the extracted JSON to keep or share.
- `?debug=1` — draw a dot and pitch name on every extracted notehead.
- `?extracttest=1` — run the golden PDF/JSON self-test (needs the Vespers files in the site root).

### Alternative: GitHub Pages (also terminal-free)

1. Create a new repository on [github.com](https://github.com) (or open an existing one).
2. Use **Add file → Upload files** in the browser; drag in every file from this folder; commit.
3. **Settings → Pages → Build and deployment**: Source = **Deploy from a branch**, branch **main** (or `master`), folder **/ (root)**. Save.
4. After a minute, open `https://<user>.github.io/<repo>/`.

## Local try (optional)

Double-click `serve.command` (first time: right-click → Open, because macOS Gatekeeper blocks unsigned scripts). Then open **http://localhost:8765** — type the `http://` explicitly; Safari sometimes upgrades a bare `localhost` to https and fails to connect. Or from a terminal: `python3 -m http.server 8080` → `http://localhost:8080`. Add `?extracttest=1` to verify extraction.

Opening `index.html` by double-click (file://) also works now — the app has no ES modules and the pitch detector is built in. If Safari refuses mic permission on file://, use the served or hosted URL instead.

## Files

| File | Role |
|------|------|
| `index.html` | Shell UI |
| `app.js` | PDF view, overlay, load path, cache, extracttest |
| `extractor.js` | In-browser MCI score extraction (port of `extract_score.py`) |
| `pitch.js` | Mic + pitchy detection |
| `follow.js` | Tempo follow / playback |
| `style.css` | Layout |
| `extract_score.py` | Reference Python extractor (not needed at runtime) |
| `08-16-26_Sunday_Vespers.pdf` / `.json` | Golden pair for `?extracttest=1` |

## Requirements

Modern Safari or Chrome on desktop or tablet. **https** (or localhost) for microphone access. Vanilla JS only — no build step.
