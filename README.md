# TALLY — two-player Guess Who, television edition

A 6×3 board of 18 characters from one of ten shows. Both players get a secret
character; you take alternating turns crossing off suspects until someone locks
in a guess. Correct guess wins outright, wrong guess hands over the turn.

Plain ES modules — no build step, no npm. Firebase Realtime Database for state,
GitHub Pages for hosting.

```
index.html          markup
styles.css          the whole visual system
app.js              game logic + Firebase   ← paste your config here
characters.js       10 shows × 18 characters ← edit names here
assets/<show>/      your character images
IMAGE-MANIFEST.txt  the 180 exact filenames the code looks for
```

---

## 1. Firebase setup

**Create the database.** Firebase Console → Build → Realtime Database → Create
Database → start in **test mode**. You'll replace the rules in step 3.

**Turn on anonymous sign-in.** Authentication → Sign-in method → Anonymous →
Enable. This is required — the app refuses to start without it, because the
rules use `auth.uid` to stop players reading each other's secret character.

**Copy your config** from Project Settings → Your apps → Web app, and paste it
into the `FIREBASE_CONFIG` block at the top of `app.js`:

```js
const FIREBASE_CONFIG = {
  apiKey:            "AIza…",
  authDomain:        "your-project.firebaseapp.com",
  databaseURL:       "https://your-project-default-rtdb.firebaseio.com",
  projectId:         "your-project",
  storageBucket:     "your-project.appspot.com",
  messagingSenderId: "1234567890",
  appId:             "1:1234:web:abcd"
};
```

`databaseURL` only appears once the Realtime Database actually exists — if it's
missing from the snippet, you skipped the first step. And yes, these keys are
meant to be public in a client app; the rules below are what protect the data.

## 2. Authorise your domain

Authentication → Settings → Authorized domains → Add domain →
`yourusername.github.io`. Anonymous sign-in fails silently on an unlisted
domain, which looks exactly like a broken app.

## 3. Database rules

Realtime Database → Rules. Paste this over the test-mode default:

```json
{
  "rules": {
    "lobby": {
      ".read": "auth != null",
      ".write": "auth != null",
      ".indexOn": ["joinedAt"]
    },
    "games": {
      "$gid": {
        "meta":         { ".read": "auth != null", ".write": "auth != null && data.parent().child('players').child(auth.uid).exists()" },
        "players":      { ".read": "auth != null", ".write": "auth != null" },
        "presence":     { ".read": "auth != null", "$uid": { ".write": "auth.uid === $uid" } },
        "pendingGuess": { ".read": "auth != null", ".write": "auth != null && data.parent().child('players').child(auth.uid).exists()" },
        "log":          { ".read": "auth != null", ".write": "auth != null && data.parent().child('players').child(auth.uid).exists()" },
        "reveal":       { ".read": "auth != null", "$uid": { ".write": "auth.uid === $uid" } },
        "identities": {
          "$uid": {
            ".read":  "auth.uid === $uid || data.parent().parent().child('meta/status').val() === 'finished'",
            ".write": "auth != null && data.parent().parent().child('meta/status').val() === 'choosing'"
          }
        }
      }
    }
  }
}
```

The important line is `identities/$uid`: only you can read your own character
until the game ends. The whole app is built around that restriction — that's
why it listens to each branch of a game separately instead of the game node as
a whole. Realtime Database grants read access downward, so a single listener on
`games/$gid` would have handed both secrets to both players.

## 4. Deploy

```bash
git init
git add .
git commit -m "TALLY"
git remote add origin https://github.com/brgrkng/<repo>.git
git push -u origin main
```

Settings → Pages → Source: `main`, folder `/ (root)`. Every path in the code is
relative, so it works at `brgrkng.github.io/<repo>/` without any base-path
configuration.

## 5. Testing it alone

Anonymous auth issues **one identity per browser profile**, so two tabs in the
same window are the same player and will never pair. Use two different browsers,
or one normal window and one private/incognito window.

---

## Adding character images

Cards look for `assets/<show-id>/<character-slug>.jpg`. Any file that isn't
there falls back to a test-card placeholder — initials over colour bars in that
show's hue — so the game is fully playable right now with zero images.

`IMAGE-MANIFEST.txt` lists all 180 paths exactly as the code expects them.
Show ids are `got`, `myl`, `ted`, `sev`, `plu`, `boj`, `tgp`, `ysh`, `adv`,
`b99`. Slugs are lowercase with hyphens: `assets/got/tyrion-lannister.jpg`,
`assets/adv/lumpy-space-princess.jpg`.

Square, around 300×300, under ~40KB each. 180 images at phone-camera sizes will
make the repo miserable to clone, so run them through something like Squoosh
first. You can drop them in a few at a time — every image is independent, and
missing ones just stay as placeholders.

**Changing the characters themselves:** edit `characters.js`. Keep exactly 18
per show or the board won't fill. If you rename a character, update its `img`
path and `ini` (the placeholder initials) to match.

**Console 404s:** while images are missing you'll see 404s in DevTools. That's
the fallback working, not an error. If it bothers you, comment out the `img.src`
line in `buildBoard()` until you have real images.

---

## How the game state works

```
/lobby/{uid}              name, emoji, ready, gameId, seat, joinedAt
/games/{gid}/meta         status, show, turn, turnStartedAt, winner
/games/{gid}/players      name, emoji, seat per player
/games/{gid}/identities   secret character per player — read-locked
/games/{gid}/pendingGuess a guess awaiting a verdict
/games/{gid}/log          guess history, drives the feed
/games/{gid}/presence     drives the "opponent dropped out" banner
/games/{gid}/reveal       both characters, published only at the end
```

**Pairing.** Everyone shares one lobby. A transaction on `/lobby` takes the two
earliest players who are ready and not already in a game and stamps both with
the same `gameId`. Because it's a transaction, two clients racing to pair the
same people can't both win — the loser sees the `gameId` already set and backs
off.

**Seats.** Seat 2 picks the show. Seat 1 then deals the two secret characters
and takes the first turn. Splitting those two jobs is deliberate (see the
caveat below).

**Guessing.** Neither client can read the other's secret, so the guesser writes
their guess to `pendingGuess` and the *player being guessed* checks it against
their own character and writes the verdict. Single writer, no race.

**Cross-offs** never touch the database at all. They're in `localStorage`, keyed
by game and player, so they're private by construction and survive a refresh.

**The timer** counts up from `turnStartedAt`, corrected by Firebase's
`.info/serverTimeOffset` so both players see the same number regardless of
clock drift. It never forces a turn to end.

---

## The one honest caveat

Seat 1's browser generates *both* secret characters, which means a determined
seat-1 player could open DevTools and read the opponent's character before it's
written. Splitting show-choice and dealing between the two seats limits it, but
doesn't eliminate it — client-side code can't keep a secret from the person
running it.

For a friendly game this is fine. If you ever want it airtight, move the deal to
a Cloud Function so no browser ever holds both answers:

```js
// functions/index.js — requires the Blaze plan
exports.deal = functions.database
  .ref("/games/{gid}/meta/show")
  .onCreate(async (snap, ctx) => {
    const gid = ctx.params.gid;
    const players = (await snap.ref.parent.parent.child("players").get()).val();
    const uids = Object.keys(players);
    const n = 18;
    let a = Math.floor(Math.random() * n), b;
    do { b = Math.floor(Math.random() * n); } while (b === a);
    return snap.ref.parent.parent.update({
      [`identities/${uids[0]}`]: a,   // store the index; map to id client-side
      [`identities/${uids[1]}`]: b,
      "meta/turn": uids.find(u => players[u].seat === 1),
      "meta/turnStartedAt": admin.database.ServerValue.TIMESTAMP,
      "meta/status": "playing"
    });
  });
```

Then delete `maybeDeal()` from `app.js` and tighten the `identities` write rule
to `false`.

---

## Ideas if you keep building

- **Rematch in place** — currently both players go back to the lobby and re-pair.
  A rematch button that resets `meta` and re-deals in the same game node would be
  a small change.
- **A guess budget** — three wrong guesses and you lose, which makes crossing off
  matter more than it currently does.
- **Round history** — the `log` node already has everything needed for a
  scoreboard across games.
