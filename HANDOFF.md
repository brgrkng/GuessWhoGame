# TALLY — handoff

Two-player Guess Who played across ten TV shows. Vanilla ES modules, Firebase
Realtime Database, hosted on GitHub Pages. No build step, no npm, no framework.

**Read this before changing anything:** the project is *not* fully verified. It
gets as far as the show-selection screen and then stalls. See
[Current state](#current-state) and [The open bug](#the-open-bug).

---

## Original brief

From the person who owns this repo, verbatim in intent:

- Two players enter names, pick an emoji icon, and ready up in a lobby. Game
  starts when both are ready.
- A grid of characters from **one** TV show per round — Game of Thrones one
  round, BoJack Horseman the next.
- Each card shows a border, the character's name, and a picture. Placeholders
  are acceptable where images aren't available, with instructions for replacing
  them.
- **Player 2 chooses the show** before the game starts.
- Each player is randomly assigned a character from that show for the opponent
  to guess. **The two must never be the same character.**
- Alternating turns, with a timer tracking the current turn and an end-turn
  button.
- On a turn a player can *cross off* characters (a purely visual mark on that
  card) or *lock in a guess*. Tapping a card offers a cross and a check. The
  cross toggles on/off. The check submits, with a confirmation prompt first.
- A correct guess always wins. An incorrect guess passes the turn.
- Shows: Game of Thrones, Mind Your Language, Ted Lasso, Severance, Pluribus,
  BoJack Horseman, The Good Place, Young Sheldon, Adventure Time, Brooklyn 99.
  Avoid niche characters except where needed to fill the grid.

Decisions made during the build, all confirmed by the owner:

- **6×3 grid = 18 characters per show**, not 5×5. Pluribus has a tiny cast and
  25 recognisable characters wasn't achievable; Mind Your Language and Severance
  were borderline too.
- **One shared global lobby.** Not room codes, not random matchmaking.
- **Turn timer counts up with no limit.** It never forces a turn to end.

---

## Current state

Working and verified:

- Firebase project connected, anonymous auth working
- Lobby: sign-on, emoji picker with taken-emoji locking, presence roster
- Ready-up and pairing — two players get matched and land in the same game
- `players` node written correctly with `seat: 1` and `seat: 2` (confirmed in
  the Firebase console)
- Seat 2 reaches the show-picker and can click a show; `meta/show` is written

Not verified — **no one has played a full round yet**:

- Dealing the secret characters
- The board, cross-off, guessing, adjudication
- Win/lose screen and the reveal
- Return to lobby / rematch

Everything from `renderPlaying()` onward is written but has never executed
against a real game.

---

## The open bug

Both clients sit on the show-selection screen showing "Shuffling the deck…"
and never advance to `status: "playing"`.

What's been ruled out:

- Not a permissions failure — no `permission_denied` warning appears
- Not missing seat data — `players/<uid>/seat` is 1 and 2 in the database
- Not a stale-lobby-pointer problem — that was a real bug (a refresh orphaned
  the game because the only pointer lived in the lobby entry, which
  `onDisconnect` deletes) and it's fixed via `tryResume()`

The most recent change addresses the reason it was *undiagnosable*: the boot
watchdog in `index.html` was catching `unhandledrejection` and writing the
message into `#boot-status`, an element on the hidden boot screen, without ever
logging to console. Every async failure after startup was being swallowed.
`maybeDeal()` is called without `await` or `.catch()`, and its risky lines sat
outside its own `try` — so anything thrown there vanished completely.

**First thing to do:** hard-refresh both browsers, run a fresh game, and read
the console. Errors are prefixed `[tally]`. Also run `tally()` in the console of
both browsers — it dumps uid, gameId, seat, the `assigning` / `dealFallback`
flags, and the full `meta` and `players` objects.

There is now a fallback: if seat 1 hasn't dealt within 6 seconds of the show
being picked, seat 2 deals instead (`armDealFallback()`). So the game may now
start anyway after a delay — **that is a symptom, not a fix**. If it starts only
via the fallback, seat 1's `maybeDeal()` is still failing and the root cause is
still unfound. Don't declare victory on that.

---

## Files

```
index.html          markup + a boot watchdog (plain script, runs before the module)
styles.css          the entire visual system
app.js              all logic — 768 lines, single module
characters.js       10 shows × 18 characters, pure data
assets/<show>/      character images, currently empty
IMAGE-MANIFEST.txt  the 180 exact paths the code looks for
README.md           setup, Firebase rules, deployment, image instructions
```

`README.md` has the Firebase rules and the reasoning behind them. Read that
before touching security rules — the read/write asymmetry is deliberate and
easy to break.

---

## Architecture

### Database shape

```
/lobby/{uid}                 name, emoji, ready, gameId, seat, joinedAt
/games/{gid}/meta            status, show, turn, turnStartedAt, winner, createdAt
/games/{gid}/players/{uid}   name, emoji, seat
/games/{gid}/identities/{uid}  secret character id — READ-LOCKED to that uid
/games/{gid}/pendingGuess    { by, target, at } — a guess awaiting a verdict
/games/{gid}/log/{key}       { by, byName, target, targetName, correct, at }
/games/{gid}/presence/{uid}  bool, maintained via onDisconnect
/games/{gid}/reveal/{uid}    published by each player once the game finishes
```

`meta.status` is `"choosing"` → `"playing"` → `"finished"`.

### The constraint that shapes everything

`identities/{uid}` is readable only by its owner until the game ends. Realtime
Database grants reads *downward*, so there is deliberately **no `.read` rule at
`games/$gid`** — a single listener on the game node would hand both secrets to
both players. This is why `enterGame()` opens **seven separate listeners**, one
per branch, instead of one.

Two consequences worth internalising:

1. **No client can validate a guess.** The guesser writes to `pendingGuess`; the
   *player being guessed* compares it to their own identity and writes the
   verdict. Single writer, no race. That's `adjudicate()`.
2. **Cross-offs never touch the database.** They live in `localStorage` keyed
   `tally:{gid}:{uid}`, which makes them private by construction and survives a
   refresh.

### Module state (app.js, lines 76–92)

| Variable | Purpose |
|---|---|
| `db`, `auth`, `uid` | Firebase handles; `uid` is the anonymous auth uid, used as player id everywhere |
| `me` | `{ name, emoji }` for this browser |
| `lobbySnapshot` | Mirror of `/lobby`, refreshed by the lobby listener |
| `pendingGameId` | Push key generated *before* the pairing transaction, reused across retries |
| `gameId` | Current game, or null |
| `G` | All live game data: `meta`, `players`, `log`, `pending`, `presence`, `identity`, `revealData` |
| `show` | The resolved object from `SHOWS`, set in `renderPlaying()` |
| `crossed` | `Set` of crossed-off character ids, local only |
| `unsubs` | Listener teardown functions; `dropListeners()` runs them all |
| `serverOffset` | From `.info/serverTimeOffset`, so both players' clocks agree |
| `adjudicating`, `assigning`, `dealFallback` | Re-entrancy guards; every listener calls `render()`, so guards matter |

### Key functions

| Line | Function | Notes |
|---|---|---|
| 119 | `boot()` | Init, anonymous sign-in, then `tryResume()` or `startLobby()` |
| 142 | `explainAuthError()` | Maps Firebase auth codes to human messages |
| 171 | `startLobby()` | Prefills from `localStorage`, subscribes to `/lobby` |
| 194 | `tryResume()` | Rejoins an in-progress game after a reload |
| 237 | `renderRoster()` | Roster, emoji locking, and calls `tryMatch()` when ready |
| 306 | `tryMatch()` | **Transaction on `/lobby`.** Takes the two earliest ready players, stamps both with the same `gameId` and seats 1/2. The transaction is what stops two clients pairing the same people twice |
| 340 | `createGame()` | Called only by the client whose transaction committed |
| 353 | `enterGame()` | Tears down listeners, opens the seven per-branch ones, sets presence |
| 383 | `render()` | Single dispatcher, called by every listener; branches on `meta.status` |
| 393 | `renderChoosing()` | Show picker for seat 2, waiting state for seat 1 |
| 444 | `armDealFallback()` | 6-second safety net described above |
| 458 | `maybeDeal()` | **Where it's currently stalling.** Seat 1 writes both identities, turn, and `status: "playing"` |
| 493 | `window.tally()` | Console diagnostic helper |
| 499 | `renderPlaying()` | The board screen |
| 546 | `buildBoard()` | Cards; skips rebuild via a `dataset.sig` cache key |
| 639 | `adjudicate()` | Verdict on a pending guess. Only the guessed player runs this |
| 671 | `onLog()` | Auto-crosses a wrong guess on the guesser's own board |
| 696 | `renderFinished()` | Result + reveal; each client publishes its own identity |
| 730 | `backToLobby()` | Shared by all three leave/again buttons |

### Seat roles

Seat 2 picks the show. Seat 1 deals the characters. That split is deliberate:
it stops one client from both choosing the show and knowing both answers. It is
**not** airtight — seat 1's browser does generate both identities, and DevTools
beats it. The README has a Cloud Function that closes this properly, along with
the rule changes it needs. Treat the current arrangement as a friendly-game
mitigation, not security.

---

## Images

Cards request `assets/<show-id>/<character-slug>.jpg`. Missing files trigger
`img.onerror`, which adds `.noimg` to the card and reveals a CSS test-card
placeholder — colour bars in the show's hue with the character's initials. The
game is fully playable with zero images.

Show ids: `got`, `myl`, `ted`, `sev`, `plu`, `boj`, `tgp`, `ysh`, `adv`, `b99`.
All 180 paths are listed in `IMAGE-MANIFEST.txt`. Square, ~300×300, under ~40KB.

404s in the console while images are missing are expected, not a fault.

To change characters, edit `characters.js` only. Exactly 18 per show or the
board won't fill. If you rename someone, update their `img` slug and `ini`.

---

## Intended next work

In priority order:

1. **Find the real cause of the deal stall.** Everything else is blocked on it.
2. **Play a full round end to end.** Nothing after `renderPlaying()` has ever
   run — expect bugs in the board, adjudication, and the reveal.
3. **Rematch in place.** Currently both players return to the lobby and re-pair.
   Resetting `meta` and re-dealing within the same game node would be better.
4. **A guess budget** — the owner's idea to consider: three wrong guesses loses,
   which would make crossing off matter strategically. Currently crossing off is
   purely a memory aid with no mechanical weight.
5. **Round history / scoreboard.** The `log` node already holds what's needed.
6. **Images.** Owner will supply; no code changes required.

Not planned but worth flagging if it comes up: the turn timer deliberately has
no limit, so nothing prevents a stalling opponent. The owner accepted this. A
soft nudge at 90 seconds would be a couple of lines in `startClock()`.

---

## Gotchas

- **Anonymous auth gives one identity per browser profile.** Two tabs in the
  same window are the same player and will never pair. Test with two different
  browsers, or one normal and one incognito window.
- **Every listener calls `render()`**, which is why the re-entrancy guards
  exist. Adding a listener without thinking about repeat renders will cause
  duplicate writes.
- **`buildBoard()` caches on `el.board.dataset.sig`.** If you change what a card
  displays, add it to the signature or your change won't appear.
- **Hard-refresh after every deploy.** GitHub Pages caches aggressively and it
  has already cost hours here.
- **Clear `games` and `lobby` in the Firebase console between test runs.**
  Half-built games satisfy the resume check and pull you back into broken state.
- The owner edits directly on GitHub sometimes. Pull before working locally.
