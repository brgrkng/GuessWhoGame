# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TALLY — two-player Guess Who across ten TV shows. Vanilla ES modules, Firebase
Realtime Database + anonymous auth, hosted on GitHub Pages. **No build step, no
npm, no framework, no tests.** Five files: `index.html`, `styles.css`, `app.js`
(all logic, one module), `characters.js` (pure data), plus `assets/<show>/`.

`README.md` (setup, Firebase rules, images) and `HANDOFF.md` (current state,
open bug, function map) are both current and worth reading before nontrivial
work.

## Running it

```bash
python -m http.server 8000     # then open http://localhost:8000
```

ES modules will not load from `file://` — the boot watchdog in `index.html`
detects this and says so. There is nothing to build, lint, or test; "running the
tests" means playing a round in two browsers.

**Testing needs two browser profiles.** Anonymous auth issues one identity per
profile, so two tabs in the same window are the same player and will never pair.
Use two different browsers, or one normal + one incognito window.

**Between test runs, delete `games` and `lobby` in the Firebase console.**
Half-built games satisfy `tryResume()` and drag you back into broken state.

**Firebase config.** `FIREBASE_CONFIG` at the top of `app.js` currently holds
`PASTE_…` placeholders on `main`, and `boot()` refuses to start without a real
one. A working key exists in earlier commits (it's a public client key, so this
is expected for Firebase — the database rules are the protection), but don't
commit a config change without asking the owner, since HEAD is deliberately
placeholder.

## Debugging

- All runtime errors are logged with a `[tally]` prefix. The boot watchdog
  (plain `<script>` in `index.html`, runs before the module) catches `error` and
  `unhandledrejection` and both logs them and writes them into `#boot-status`.
  It has swallowed async failures before — if something fails silently, check
  that the throw actually reaches the console.
- `tally()` in DevTools dumps uid, gameId, seat, the `assigning`/`dealFallback`
  guards, and the live `meta`/`players`/`identity`.
- Hard-refresh after every deploy; GitHub Pages caches aggressively.
- The owner sometimes edits files directly on GitHub. Pull before working.

## The constraint that shapes the architecture

`games/$gid/identities/$uid` is readable only by its owner until the game ends.
Realtime Database grants reads *downward*, so there is deliberately **no `.read`
rule at `games/$gid`** — a single listener on the game node would hand both
secrets to both players. Consequences that explain most of `app.js`:

1. `enterGame()` opens **seven separate listeners**, one per branch (`meta`,
   `players`, `presence`, `pendingGuess`, `log`, `identities/$uid`, `reveal`) —
   not one on the game node. Don't "simplify" this.
2. **No client can validate a guess.** The guesser writes `pendingGuess`; the
   *player being guessed* compares it against their own identity and writes the
   verdict. Single writer, no race. That's `adjudicate()`.
3. **Cross-offs never touch the database.** They live in `localStorage` under
   `tally:{gid}:{uid}` — private by construction, and they survive a refresh.

Read the rules block in `README.md` before touching security rules; the
read/write asymmetry is easy to break.

## Database shape

```
/lobby/{uid}                    name, emoji, ready, gameId, seat, joinedAt
/games/{gid}/meta               status, show, turn, turnStartedAt, winner, createdAt
/games/{gid}/players/{uid}      name, emoji, seat
/games/{gid}/identities/{uid}   secret character id — READ-LOCKED
/games/{gid}/pendingGuess       { by, target, at }
/games/{gid}/log/{key}          { by, byName, target, targetName, correct, at }
/games/{gid}/presence/{uid}     bool, maintained via onDisconnect
/games/{gid}/reveal/{uid}       published by each client once finished
```

`meta.status`: `"choosing"` → `"playing"` → `"finished"`, and `render()` is a
single dispatcher on that field.

## Flow and seat roles

One shared global lobby (no room codes). `tryMatch()` runs a **transaction on
`/lobby`** that stamps the two earliest ready-and-unpaired players with the same
`gameId` and seats 1/2 — the transaction is what stops two clients pairing the
same people twice. The client whose transaction commits calls `createGame()`.

**Seat 2 picks the show; seat 1 deals both secret characters** (`maybeDeal()`).
The split is deliberate so no one client both chooses the show and knows the
answers — but it is a friendly-game mitigation, not security: seat 1's browser
does generate both identities and DevTools beats it. `README.md` has the Cloud
Function that closes this properly, plus the rule change it needs.

`armDealFallback()` lets seat 2 deal if seat 1 hasn't within 6 seconds. If a
game only starts via that fallback, seat 1's deal is still broken — that's a
symptom, not a fix.

## Gotchas when editing `app.js`

- **Every listener calls `render()`.** That's why `adjudicating`, `assigning`,
  `dealFallback`, and `revealPublished` exist. Any new listener or write path
  needs to be idempotent under repeat renders or it will double-write.
- **`buildBoard()` early-returns on `el.board.dataset.sig`** (show id + crossed
  ids + identity). Change what a card displays and you must extend the
  signature, or the change won't appear.
- `dropListeners()` must run before re-entering a game; `enterGame()` does it
  first thing.
- The turn timer counts up with no limit and never forces a turn to end. That's
  the owner's decision, not an oversight.

## Characters and images

Edit `characters.js` only — **exactly 18 per show** or the 6×3 board won't fill.
Each entry is `{ id, name, img, ini }`; rename a character and you must update
`img` (`assets/<show>/<slug>.jpg`, lowercase-hyphen) and `ini` (placeholder
initials) too. Show ids: `got`, `myl`, `ted`, `sev`, `plu`, `boj`, `tgp`, `ysh`,
`adv`, `b99`.

`assets/` is currently empty. Missing images fire `img.onerror`, which adds
`.noimg` and reveals a CSS test-card placeholder (colour bars in the show's hue
+ initials), so the game is fully playable with zero images. **404s in the
console are expected, not a fault.** `IMAGE-MANIFEST.txt` lists all 180 expected
paths and is gitignored.

## Styling

`styles.css` is the whole visual system, hand-written, no preprocessor. Per-show
colour comes from a single `--hue`/`--h` custom property set from JS in
`renderPlaying()` and per-element for cards and show buttons; everything else
derives from it via `hsl()`.

## Known state

Verified through pairing and the show picker. Everything from `renderPlaying()`
onward — dealing, the board, cross-off, adjudication, the reveal, back-to-lobby
— has been written but **never run in a completed game**. See "The open bug" in
`HANDOFF.md`: both clients can stall on "Shuffling the deck…" instead of
advancing to `status: "playing"`. Expect bugs downstream of that.
