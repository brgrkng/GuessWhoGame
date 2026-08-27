/* ============================================================
   TALLY — two-player Guess Who across ten television shows
   Firebase Realtime Database + anonymous auth. No build step.
   ============================================================ */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged }
  from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { getDatabase, ref, set, get, update, remove, onValue, onDisconnect,
         runTransaction, serverTimestamp, push }
  from "https://www.gstatic.com/firebasejs/10.12.5/firebase-database.js";

import { SHOWS } from "./characters.js";

/* ─────────────────────────────────────────────────────────────
   1. PASTE YOUR FIREBASE CONFIG HERE
   Firebase Console → Project settings → Your apps → Web app.
   databaseURL only appears once a Realtime Database exists.
   ───────────────────────────────────────────────────────────── */
const FIREBASE_CONFIG = {
  apiKey:            "AIzaSyDtnYxGeHJOcOapL6qzFoU_m2mcfCMcCtE",
  authDomain:        "guesswhogame-2702f.firebaseapp.com",
  databaseURL:       "https://guesswhogame-2702f-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "guesswhogame-2702f",
  storageBucket:     "guesswhogame-2702f.firebasestorage.app",
  messagingSenderId: "762175949107",
  appId:             "1:762175949107:web:d8ebbc5897b96bbb16964"
};

/* Bump on every deploy. The console line is how you prove a hard refresh
   actually took - GitHub Pages caches app.js for ten minutes. */
const BUILD = "2026-08-27b";

const EMOJIS = ["🦊","🐼","🐙","🐸","🦖","🐝","🦉","🐺",
                "🦈","🐧","🦩","🐲","👽","🤖","🎃","👻",
                "🍕","🍩","🌮","⚡","🔥","🌙","⭐","🎧"];

/* A player's only pointer to their game used to live in their lobby entry,
   which onDisconnect deletes — so a refresh orphaned the game. These keys
   let a reloaded tab find its way back in. */
const LS_ME   = "tally:me";
const LS_GAME = "tally:active";
const store = {
  get(k){ try { return JSON.parse(localStorage.getItem(k)); } catch(e){ return null; } },
  set(k,v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} },
  drop(k){ try { localStorage.removeItem(k); } catch(e){} }
};

/* ── element shorthand ──────────────────────────────────────── */
const $ = id => document.getElementById(id);
const el = {
  screens: {
    boot:   $("screen-boot"),
    lobby:  $("screen-lobby"),
    show:   $("screen-show"),
    game:   $("screen-game"),
    result: $("screen-result")
  },
  bootStatus: $("boot-status"),
  nameInput: $("name-input"), emojiGrid: $("emoji-grid"),
  btnJoin: $("btn-join"), signonHint: $("signon-hint"),
  rosterList: $("roster-list"), rosterEmpty: $("roster-empty"),
  rosterCount: $("roster-count"), readyBar: $("ready-bar"), btnReady: $("btn-ready"),
  showpick: $("showpick"), showWaiting: $("show-waiting"),
  showWaitingText: $("show-waiting-text"), showSubtitle: $("show-subtitle"),
  gameShow: $("game-show"), secretName: $("secret-name"),
  clock: $("clock"), clockLabel: $("clock-label"),
  seatMe: $("seat-me"), seatThem: $("seat-them"), btnEnd: $("btn-end"),
  turnBanner: $("turn-banner"), board: $("board"), feed: $("feed"),
  overlay: $("overlay"), sheetName: $("sheet-name"),
  actCross: $("act-cross"), actCrossLabel: $("act-cross-label"), actGuess: $("act-guess"),
  sheetConfirm: $("sheet-confirm"), confirmName: $("confirm-name"),
  confirmNo: $("confirm-no"), confirmYes: $("confirm-yes"), sheetClose: $("sheet-close"),
  resultVerdict: $("result-verdict"), resultLine: $("result-line"),
  reveal: $("reveal"), btnAgain: $("btn-again"),
  toast: $("toast")
};

/* ── state ──────────────────────────────────────────────────── */
let db, auth, uid = null;
let me = { name: "", emoji: "" };
let lobbySnapshot = {};          // whole /lobby
let pendingGameId = null;        // id we would use if we win the pairing
let gameId = null;
let G = { meta:null, players:null, log:null, pending:null, presence:null, identity:null };
let show = null;                 // resolved show object
let crossed = new Set();
let unsubs = [];                 // game listeners only
let lobbyUnsub = null;           // the lobby listener - outlives every game
let leftGames = new Set();       // games we deliberately left; never re-enter one
let joinTimer = null;
let clockTimer = null;
let serverOffset = 0;
let openCard = null;
let adjudicating = false;
let assigning = false;
let dealTimer = null;
let dealFallback = false;
let revealPublished = false;

/* ── helpers ────────────────────────────────────────────────── */
function screen(name){
  for (const [k,node] of Object.entries(el.screens)) node.hidden = (k !== name);
}
function toast(msg, ms = 2600){
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.toast.hidden = true; }, ms);
}
function now(){ return Date.now() + serverOffset; }
function mmss(ms){
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function otherUid(){
  if (!G.players) return null;
  return Object.keys(G.players).find(k => k !== uid) || null;
}
function track(unsub){ unsubs.push(unsub); }
function dropListeners(){ unsubs.forEach(f => { try { f(); } catch(e){} }); unsubs = []; }

/* Everything async in here used to fail silently. It doesn't now: every
   listener and every fire-and-forget write reports through logErr, and a
   rules rejection - the likeliest cause and the least visible - also
   surfaces on screen. */
function logErr(where, err){
  const code = String((err && err.code) || "");
  const msg  = String((err && err.message) || err || "");
  console.error("[tally] " + where + " failed:", code, msg, err);
  if (/permission[_-]denied/i.test(code + " " + msg))
    toast("Database rules blocked: " + where);
}
function fire(p, where){ return p.catch(err => logErr(where, err)); }

/* ============================================================
   BOOT
   ============================================================ */
(async function boot(){
  console.log("[tally] build", BUILD);
  if (FIREBASE_CONFIG.apiKey === "PASTE_API_KEY"){
    return fail("No Firebase config yet. Open app.js and fill in FIREBASE_CONFIG near the top.");
  }
  try {
    const app = initializeApp(FIREBASE_CONFIG);
    db   = getDatabase(app);
    auth = getAuth(app);

    onValue(ref(db, ".info/serverTimeOffset"), s => { serverOffset = s.val() || 0; });

    await signInAnonymously(auth);
    onAuthStateChanged(auth, async user => {
      if (!user) return;
      uid = user.uid;
      buildEmojiGrid();
      subscribeLobby();
      const resumed = await tryResume();
      if (!resumed) startLobby();
    });
  } catch (err){
    fail(explainAuthError(err));
  }
})();

function explainAuthError(err){
  const code = String(err && err.code || "");
  const msg  = String(err && err.message || err);
  if (code.includes("admin-restricted-operation") || code.includes("operation-not-allowed"))
    return "Anonymous sign-in is switched off for this project. Firebase Console → "
         + "Authentication → Sign-in method → Anonymous → Enable, then hard-refresh.";
  if (code.includes("configuration-not-found"))
    return "This project has no authentication set up yet. Firebase Console → "
         + "Authentication → Get started, then enable Anonymous.";
  if (code.includes("api-key-not-valid") || code.includes("invalid-api-key"))
    return "That apiKey isn't valid for this project. Re-copy the config from "
         + "Project settings → Your apps.";
  if (code.includes("requests-from-referer") || code.includes("requests-to-this-api"))
    return "The API key is restricted and this domain isn't on the list. Google Cloud "
         + "Console → APIs & Services → Credentials → your browser key → Website restrictions.";
  if (code.includes("network-request-failed"))
    return "The sign-in request never reached Firebase. Check the connection, then reload.";
  return "Sign-in failed" + (code ? ` (${code})` : "") + ". " + msg;
}

function fail(msg){
  screen("boot");
  el.bootStatus.textContent = msg;
  el.bootStatus.classList.add("bad");
}

/* ============================================================
   LOBBY
   ============================================================ */
function startLobby(){
  buildEmojiGrid();
  const saved = store.get(LS_ME);
  if (saved && !el.nameInput.value){
    el.nameInput.value = saved.name || "";
    if (saved.emoji){
      me.emoji = saved.emoji;
      [...el.emojiGrid.children].forEach(c =>
        c.setAttribute("aria-pressed", String(c.textContent === saved.emoji)));
    }
  }
  screen("lobby");
  subscribeLobby();
  renderRoster();   // buildEmojiGrid() above wiped the taken-emoji locking
}

/* Deliberately NOT tracked in `unsubs`. This listener has to outlive
   enterGame(): it is the only thing that can correct a client which entered
   the wrong game, and tearing it down on every enterGame() is what used to
   strand a player on the lobby screen with no route back. */
function subscribeLobby(){
  if (lobbyUnsub) return;
  lobbyUnsub = onValue(ref(db, "lobby"), snap => {
    lobbySnapshot = snap.val() || {};
    renderRoster();
    const mine = lobbySnapshot[uid];
    if (mine && mine.gameId && mine.gameId !== gameId && !leftGames.has(mine.gameId))
      enterGame(mine.gameId);
  }, err => logErr("lobby listener", err));
}

/* Rejoin a game this browser was already in — the lobby entry that used to
   point at it is gone after a reload, so the pointer is kept locally. */
async function tryResume(){
  const gid = store.get(LS_GAME);
  if (!gid) return false;
  try {
    const [pSnap, sSnap] = await Promise.all([
      get(ref(db, `games/${gid}/players/${uid}`)),
      get(ref(db, `games/${gid}/meta/status`))
    ]);
    if (!pSnap.exists() || !sSnap.exists() || sSnap.val() === "finished"){
      store.drop(LS_GAME);
      return false;
    }
    const p = pSnap.val() || {};
    me.name = p.name || ""; me.emoji = p.emoji || "";
    buildEmojiGrid();
    enterGame(gid);
    toast("Rejoined your game.");
    return true;
  } catch (err){
    store.drop(LS_GAME);
    return false;
  }
}

function buildEmojiGrid(){
  el.emojiGrid.innerHTML = "";
  EMOJIS.forEach(e => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = e;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => {
      me.emoji = e;
      [...el.emojiGrid.children].forEach(c =>
        c.setAttribute("aria-pressed", String(c.textContent === e)));
      if (inLobby()) fire(update(ref(db, `lobby/${uid}`), { emoji: e }), "set emoji");
    });
    el.emojiGrid.appendChild(b);
  });
}

function inLobby(){ return !!lobbySnapshot[uid]; }

function renderRoster(){
  const takenEmoji = new Set(
    Object.entries(lobbySnapshot).filter(([k]) => k !== uid).map(([,v]) => v.emoji));
  [...el.emojiGrid.children].forEach(b => { b.disabled = takenEmoji.has(b.textContent); });

  const rows = Object.entries(lobbySnapshot)
    .sort((a,b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));

  el.rosterCount.textContent = String(rows.length);
  el.rosterEmpty.hidden = rows.length > 0;
  el.rosterList.innerHTML = "";

  rows.forEach(([k,v]) => {
    const li = document.createElement("li");
    if (k === uid) li.classList.add("me");
    const state = v.gameId ? "in a game" : v.ready ? "ready" : "waiting";
    li.innerHTML = `<span class="pip"></span>
                    <span class="who"></span>
                    <span class="state${v.ready && !v.gameId ? " on" : ""}"></span>`;
    li.querySelector(".pip").textContent = v.emoji || "•";
    li.querySelector(".who").textContent = v.name + (k === uid ? " (you)" : "");
    li.querySelector(".state").textContent = state;
    el.rosterList.appendChild(li);
  });

  const mine = lobbySnapshot[uid];
  el.readyBar.hidden = !mine;
  if (mine){
    el.btnReady.dataset.on = mine.ready ? "1" : "0";
    el.btnReady.textContent = mine.ready ? "Cancel ready" : "Ready up";
  }
  if (mine && mine.ready && !mine.gameId) tryMatch();
}

el.btnJoin.addEventListener("click", async () => {
  const name = el.nameInput.value.trim();
  if (!name)      return hintSignon("Type a name first.");
  if (!me.emoji)  return hintSignon("Pick a marker so your opponent can tell you apart.");
  me.name = name;
  hintSignon("");
  el.btnJoin.disabled = true;
  try {
    await set(ref(db, `lobby/${uid}`), {
      name, emoji: me.emoji, ready: false, gameId: null, joinedAt: serverTimestamp()
    });
    onDisconnect(ref(db, `lobby/${uid}`)).remove();
    store.set(LS_ME, { name, emoji: me.emoji });
    el.btnJoin.textContent = "You're in the lobby";
  } catch (err){
    el.btnJoin.disabled = false;
    hintSignon("Write refused: " + (err.message || err));
  }
});
function hintSignon(msg){
  el.signonHint.textContent = msg;
  el.signonHint.classList.toggle("bad", !!msg);
}

el.btnReady.addEventListener("click", () => {
  const mine = lobbySnapshot[uid];
  if (!mine) return;
  fire(update(ref(db, `lobby/${uid}`), { ready: !mine.ready }), "ready up");
});

/* ── pairing ────────────────────────────────────────────────
   One shared lobby: the two earliest players who are ready and
   not already in a game get matched. A transaction on /lobby
   makes sure only one client can claim a given pair.
   ──────────────────────────────────────────────────────────── */
async function tryMatch(){
  if (tryMatch._busy || gameId) return;
  const ready = Object.entries(lobbySnapshot).filter(([,v]) => v.ready && !v.gameId);
  if (ready.length < 2) return;
  tryMatch._busy = true;

  const gid = pendingGameId || (pendingGameId = push(ref(db, "games")).key);

  try {
    /* applyLocally:false is load-bearing, not a tidy-up.

       With the default (true), Firebase raises a local event for the
       *tentative* pairing the instant this callback returns - before the
       server has accepted anything. In a two-client race both clients write a
       provisional pairing, so the loser's own lobby listener fired with a
       gameId that was about to be rolled back. It called enterGame() on a game
       nobody would ever create, and enterGame()'s dropListeners() took the
       lobby listener down with it - so when the real gameId arrived moments
       later, nothing was listening. That client sat on the lobby screen
       forever while its opponent played on.

       Suppressing the local echo means we only ever act on a pairing the
       server has actually committed. */
    const res = await runTransaction(ref(db, "lobby"), lobby => {
      if (!lobby || !lobby[uid] || !lobby[uid].ready || lobby[uid].gameId) return;
      const waiting = Object.entries(lobby)
        .filter(([,v]) => v && v.ready && !v.gameId)
        .sort((a,b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0) || a[0].localeCompare(b[0]));
      if (waiting.length < 2) return;
      const pair = waiting.slice(0, 2);
      if (!pair.some(([k]) => k === uid)) return;   // not my turn to be paired
      pair[0][1].gameId = gid; pair[0][1].seat = 1;
      pair[1][1].gameId = gid; pair[1][1].seat = 2;
      return lobby;
    }, { applyLocally: false });

    if (res.committed){
      const lobby = res.snapshot.val() || {};
      const pair = Object.entries(lobby).filter(([,v]) => v.gameId === gid);
      if (pair.length === 2 && pair.some(([k]) => k === uid)) await createGame(gid, pair);
    }
  } catch (err){
    logErr("pairing", err);
  } finally {
    tryMatch._busy = false;
  }
}

async function createGame(gid, pair){
  const players = {};
  pair.forEach(([k,v]) => { players[k] = { name: v.name, emoji: v.emoji, seat: v.seat }; });
  await set(ref(db, `games/${gid}`), {
    meta: { status: "choosing", show: null, turn: null, turnStartedAt: null,
            createdAt: serverTimestamp() },
    players
  });
}

/* ============================================================
   GAME
   ============================================================ */
function enterGame(gid){
  if (gameId === gid) return;           // a repeat lobby event isn't news
  console.log("[tally] entering game", gid);
  dropListeners();
  gameId = gid;
  pendingGameId = null;
  revealPublished = false;
  G = { meta:null, players:null, log:null, pending:null, presence:null, identity:null };
  show = null;
  crossed = loadCrosses(gid);
  assigning = false;
  clearDealFallback();
  el.board.dataset.sig = "";
  store.set(LS_GAME, gid);
  renderJoining();
  armJoinWatch(gid);

  const base = `games/${gid}`;
  fire(set(ref(db, `${base}/presence/${uid}`), true), "presence");
  onDisconnect(ref(db, `${base}/presence/${uid}`)).set(false);

  /* Seven separate listeners, one per branch, because identities/$uid is
     read-locked to its owner and a single listener on games/$gid would hand
     both secrets to both players. Each one now carries an error callback. */
  const on = (sub, fn) => track(onValue(ref(db, `${base}/${sub}`), fn,
                                        err => logErr("listener " + sub, err)));

  on("meta",              s => { G.meta = s.val();       joinOk(); render(); });
  on("players",           s => { G.players = s.val();    joinOk(); render(); });
  on("presence",          s => { G.presence = s.val();   render(); });
  on("pendingGuess",      s => { G.pending = s.val();    adjudicate(); render(); });
  on("log",               s => { G.log = s.val();        onLog(); render(); });
  on(`identities/${uid}`, s => { G.identity = s.val();   adjudicate(); render(); });
  on("reveal",            s => { G.revealData = s.val(); render(); });
}

/* -- join watchdog -------------------------------------------------------
   Entering a game whose data never arrives was a silent freeze: render()
   returned early on a null meta and left whatever screen was already up. Now
   we notice, tell the two causes apart, and either self-heal or say so.
   ----------------------------------------------------------------------- */
function armJoinWatch(gid){
  clearTimeout(joinTimer);
  joinTimer = setTimeout(() => checkJoin(gid), 8000);
}
function joinOk(){
  if (G.meta && G.players){ clearTimeout(joinTimer); joinTimer = null; }
}
async function checkJoin(gid){
  if (gid !== gameId || (G.meta && G.players)) return;

  let listed = false;
  try { listed = (await get(ref(db, `games/${gid}/players/${uid}`))).exists(); }
  catch (err){ return logErr("join check", err); }
  if (gid !== gameId || (G.meta && G.players)) return;

  if (listed){
    console.error("[tally] game " + gid + " exists and lists us, but meta/players "
      + "never arrived - check the read rules on those two branches");
    return toast("Can't read this game. See the console.");
  }
  console.warn("[tally] game " + gid + " was never created - releasing the pairing");
  await backToLobby("That pairing didn't take. Ready up again.");
}

function mySeat(){ return G.players && G.players[uid] ? G.players[uid].seat : null; }

function render(){
  if (!G.meta || !G.players){
    if (gameId) renderJoining();
    return;
  }
  const st = G.meta.status;

  if (st === "choosing")      return renderChoosing();
  if (st === "playing")       return renderPlaying();
  if (st === "finished")      return renderFinished();
}

/* Shown while a game's data is still in flight. Reuses the show screen's
   waiting block rather than adding a sixth screen. */
function renderJoining(){
  screen("show");
  el.showpick.hidden = true;
  el.showWaiting.hidden = false;
  el.showSubtitle.textContent = "Joining";
  el.showWaitingText.textContent = "Joining the game…";
}

/* ── show selection (seat 2 picks) ──────────────────────────── */
function renderChoosing(){
  screen("show");
  const picked = !!G.meta.show;
  const iPick = mySeat() === 2 && !picked;
  el.showpick.hidden = !iPick;
  el.showWaiting.hidden = iPick;
  const them = G.players[otherUid()];

  if (iPick){
    el.showSubtitle.textContent = "You pick tonight's show";
    if (!el.showpick.childElementCount){
      SHOWS.forEach(s => {
        const b = document.createElement("button");
        b.className = "show-btn";
        b.style.setProperty("--h", s.hue);
        b.innerHTML = `<span class="t"></span><span class="n">18 characters</span>`;
        b.querySelector(".t").textContent = s.title;
        b.addEventListener("click", () => {
          fire(update(ref(db, `games/${gameId}/meta`), { show: s.id }), "pick show");
        });
        el.showpick.appendChild(b);
      });
    }
  } else if (picked){
    el.showSubtitle.textContent = "Dealing";
    el.showWaitingText.textContent = "Shuffling the deck…";
  } else {
    el.showSubtitle.textContent = "Standing by";
    el.showWaitingText.textContent =
      `${them ? them.name : "Your opponent"} is picking the show.`;
  }

  maybeDeal();
  watchStall(!iPick);
  if (picked) armDealFallback();
}

/* Nothing here can fail loudly — if the other player's tab is gone, this
   screen would otherwise spin forever with no explanation. */
function watchStall(waiting){
  clearTimeout(watchStall._t);
  const note = $("show-stall");
  if (!waiting){ note.hidden = true; return; }
  if (!note.hidden) return;
  watchStall._t = setTimeout(() => { note.hidden = false; }, 12000);
}

/* Seat 2 picks the show; seat 1 deals the two secret characters, so neither
   client both chooses the show and knows the answers. If seat 1 doesn't deal
   within a few seconds — closed tab, failed write — seat 2 deals instead
   rather than leaving the game deadlocked. */
function armDealFallback(){
  if (dealTimer || mySeat() !== 2) return;
  dealTimer = setTimeout(() => {
    dealFallback = true;
    console.warn("[tally] seat 1 never dealt — dealing from seat 2");
    maybeDeal();
  }, 6000);
}
function clearDealFallback(){
  clearTimeout(dealTimer);
  dealTimer = null;
  dealFallback = false;
}

async function maybeDeal(){
  if (assigning) return;
  if (!G.meta || !G.players) return;
  if (G.meta.status !== "choosing" || !G.meta.show) return;
  if (mySeat() !== 1 && !dealFallback) return;

  const s   = SHOWS.find(x => x.id === G.meta.show);
  const opp = otherUid();
  if (!s || !opp){
    console.error("[tally] cannot deal", { show: G.meta.show, opp, players: G.players });
    return;
  }

  assigning = true;
  try {
    const n = s.characters.length;
    const a = Math.floor(Math.random() * n);
    let b; do { b = Math.floor(Math.random() * n); } while (b === a);

    await update(ref(db, `games/${gameId}`), {
      [`identities/${uid}`]: s.characters[a].id,
      [`identities/${opp}`]: s.characters[b].id,
      "meta/turn": Object.keys(G.players).find(k => G.players[k].seat === 1) || uid,
      "meta/turnStartedAt": serverTimestamp(),
      "meta/status": "playing"
    });
    clearDealFallback();
  } catch (err){
    assigning = false;
    logErr("deal", err);
    toast("Couldn't deal the cards — check the console.");
  }
}

/* Handy in DevTools: tally() prints everything needed to diagnose a stall. */
window.tally = () => ({
  build: BUILD, uid, gameId, seat: mySeat(), assigning, dealFallback,
  lobbyEntry: lobbySnapshot[uid] || null, left: [...leftGames],
  meta: G.meta, players: G.players, identity: G.identity
});

/* ── the board ──────────────────────────────────────────────── */
function renderPlaying(){
  screen("game");
  clearDealFallback();
  show = SHOWS.find(s => s.id === G.meta.show);
  if (!show) return;

  document.documentElement.style.setProperty("--hue", show.hue);
  el.board.style.setProperty("--h", show.hue);
  el.gameShow.textContent = show.title;

  const mineChar = show.characters.find(c => c.id === G.identity);
  el.secretName.textContent = mineChar ? mineChar.name : "…";

  const myTurn = G.meta.turn === uid;
  const them = otherUid();
  renderSeat(el.seatMe,   uid,  myTurn);
  renderSeat(el.seatThem, them, !myTurn);

  el.btnEnd.disabled = !myTurn;
  el.turnBanner.className = "turn-banner " + (myTurn ? "live" : "wait");
  el.turnBanner.textContent = myTurn
    ? "You're live — cross off suspects or lock in a guess"
    : `${G.players[them] ? G.players[them].name : "Opponent"} is thinking`;

  if (G.pending && G.pending.by === uid){
    el.turnBanner.className = "turn-banner wait";
    el.turnBanner.textContent = "Guess locked in. Checking…";
  }
  if (G.presence && them && G.presence[them] === false){
    el.turnBanner.className = "turn-banner wait";
    el.turnBanner.textContent = "Your opponent dropped out. Wait, or head back to the lobby.";
  }

  buildBoard();
  startClock();
  renderFeed();
}

function renderSeat(node, id, live){
  const p = id && G.players ? G.players[id] : null;
  node.className = "seat" + (live ? " live" : "") +
                   (G.presence && id && G.presence[id] === false ? " gone" : "");
  node.innerHTML = `<span class="pip"></span><span class="nm"></span>`;
  node.querySelector(".pip").textContent = p ? p.emoji : "•";
  node.querySelector(".nm").textContent  = p ? (id === uid ? "You" : p.name) : "—";
}

function buildBoard(){
  const sig = show.id + "|" + [...crossed].sort().join(",") + "|" + G.identity;
  if (el.board.dataset.sig === sig) return;
  el.board.dataset.sig = sig;
  el.board.innerHTML = "";

  show.characters.forEach((c, i) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "card" + (crossed.has(c.id) ? " crossed" : "") +
                     (c.id === G.identity ? " mine" : "");
    card.style.setProperty("--h", show.hue);
    card.innerHTML = `
      <span class="card-ch">${String(i + 1).padStart(2, "0")}</span>
      <span class="thumb">
        <img alt="" loading="lazy">
        <span class="testcard"><span class="bars"></span><span class="ini"></span></span>
      </span>
      <span class="card-name"></span>`;
    card.querySelector(".ini").textContent = c.ini;
    card.querySelector(".card-name").textContent = c.name;

    const img = card.querySelector("img");
    img.addEventListener("error", () => card.classList.add("noimg"));
    img.src = c.img;

    card.addEventListener("click", () => openSheet(c));
    el.board.appendChild(card);
  });
}

/* ── clock ──────────────────────────────────────────────────── */
function startClock(){
  clearInterval(clockTimer);
  const tick = () => {
    const t0 = G.meta && G.meta.turnStartedAt;
    el.clock.textContent = typeof t0 === "number" ? mmss(now() - t0) : "0:00";
    el.clockLabel.textContent = G.meta && G.meta.turn === uid ? "Your turn" : "Their turn";
  };
  tick();
  clockTimer = setInterval(tick, 500);
}

/* ── card action sheet ──────────────────────────────────────── */
function openSheet(c){
  openCard = c;
  el.sheetName.textContent = c.name;
  el.sheetConfirm.hidden = true;
  el.actCross.dataset.on = crossed.has(c.id) ? "1" : "0";
  el.actCrossLabel.textContent = crossed.has(c.id) ? "Undo cross" : "Cross off";
  const myTurn = G.meta && G.meta.turn === uid && G.meta.status === "playing";
  el.actGuess.disabled = !myTurn || !!G.pending;
  el.overlay.hidden = false;
}
function closeSheet(){ el.overlay.hidden = true; openCard = null; }

el.actCross.addEventListener("click", () => {
  if (!openCard) return;
  crossed.has(openCard.id) ? crossed.delete(openCard.id) : crossed.add(openCard.id);
  saveCrosses();
  buildBoard();
  el.actCross.dataset.on = crossed.has(openCard.id) ? "1" : "0";
  el.actCrossLabel.textContent = crossed.has(openCard.id) ? "Undo cross" : "Cross off";
});

el.actGuess.addEventListener("click", () => {
  if (!openCard) return;
  el.confirmName.textContent = openCard.name;
  el.sheetConfirm.hidden = false;
});
el.confirmNo.addEventListener("click", () => { el.sheetConfirm.hidden = true; });
el.confirmYes.addEventListener("click", async () => {
  if (!openCard) return;
  const target = openCard.id;
  closeSheet();
  await fire(set(ref(db, `games/${gameId}/pendingGuess`),
                 { by: uid, target, at: serverTimestamp() }), "submit guess");
});
el.sheetClose.addEventListener("click", closeSheet);
el.overlay.addEventListener("click", e => { if (e.target === el.overlay) closeSheet(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeSheet(); });

el.btnEnd.addEventListener("click", () => {
  if (!G.meta || G.meta.turn !== uid) return;
  fire(update(ref(db, `games/${gameId}/meta`), {
    turn: otherUid(), turnStartedAt: serverTimestamp()
  }), "end turn");
});

/* ── adjudication ───────────────────────────────────────────
   Only the player being guessed can check the answer, because
   only they can read their own identity. They write the verdict.
   ──────────────────────────────────────────────────────────── */
async function adjudicate(){
  const p = G.pending;
  if (!p || adjudicating) return;
  if (p.by === uid) return;                 // the guesser never judges
  if (!G.identity || !show) return;

  adjudicating = true;
  const correct = p.target === G.identity;
  const guesser = p.by;
  const targetName = (show.characters.find(c => c.id === p.target) || {}).name || p.target;

  try {
    await push(ref(db, `games/${gameId}/log`), {
      by: guesser, byName: G.players[guesser] ? G.players[guesser].name : "?",
      target: p.target, targetName, correct, at: serverTimestamp()
    });
    if (correct){
      await update(ref(db, `games/${gameId}/meta`), { status: "finished", winner: guesser });
    } else {
      await update(ref(db, `games/${gameId}/meta`), {
        turn: uid, turnStartedAt: serverTimestamp()
      });
    }
    await remove(ref(db, `games/${gameId}/pendingGuess`));
  } catch (err){
    logErr("adjudication", err);
  } finally {
    adjudicating = false;
  }
}

/* wrong guesses cross themselves off on the guesser's board */
function onLog(){
  if (!G.log) return;
  let changed = false;
  Object.values(G.log).forEach(e => {
    if (e.by === uid && !e.correct && !crossed.has(e.target)){
      crossed.add(e.target); changed = true;
    }
  });
  if (changed){ saveCrosses(); buildBoard(); }
}

function renderFeed(){
  el.feed.innerHTML = "";
  const rows = Object.values(G.log || {}).sort((a,b) => (b.at || 0) - (a.at || 0)).slice(0, 6);
  rows.forEach(e => {
    const li = document.createElement("li");
    const who = e.by === uid ? "You" : e.byName;
    li.innerHTML = `<span></span> <span class="${e.correct ? "hit" : "miss"}"></span>`;
    li.children[0].textContent = `${who} guessed ${e.targetName} —`;
    li.children[1].textContent = e.correct ? "correct" : "wrong";
    el.feed.appendChild(li);
  });
}

/* ── result ─────────────────────────────────────────────────── */
function renderFinished(){
  clearInterval(clockTimer);
  clearTimeout(watchStall._t);
  store.drop(LS_GAME);
  screen("result");

  if (!revealPublished && G.identity){
    revealPublished = true;
    fire(set(ref(db, `games/${gameId}/reveal/${uid}`), G.identity), "publish reveal");
  }

  const iWon = G.meta.winner === uid;
  el.resultVerdict.textContent = iWon ? "You win" : "You lose";
  el.resultVerdict.className = "result-verdict " + (iWon ? "win" : "lose");

  const them = otherUid();
  const themName = G.players[them] ? G.players[them].name : "Your opponent";
  el.resultLine.textContent = iWon
    ? `You named ${themName}'s character.`
    : `${themName} named your character first.`;

  const s = SHOWS.find(x => x.id === G.meta.show);
  const nameOf = id => {
    const c = s && s.characters.find(c => c.id === id);
    return c ? c.name : "…";
  };
  const rv = G.revealData || {};
  el.reveal.innerHTML = `
    <div class="r"><div class="rl">You were</div><div class="rn" id="rv-me"></div></div>
    <div class="r"><div class="rl">${themName} was</div><div class="rn" id="rv-them"></div></div>`;
  $("rv-me").textContent   = nameOf(rv[uid] || G.identity);
  $("rv-them").textContent = nameOf(rv[them]);
}

async function backToLobby(msg){
  clearInterval(clockTimer);
  clearTimeout(joinTimer);
  dropListeners();
  const oldGame = gameId;
  /* The lobby listener now survives this, so it would happily drag us straight
     back into the game we just left - our lobby entry still points at it until
     the write below lands. */
  if (oldGame) leftGames.add(oldGame);
  gameId = null; show = null; crossed = new Set();
  el.board.dataset.sig = ""; el.showpick.innerHTML = "";
  el.overlay.hidden = true;
  clearTimeout(watchStall._t);
  clearDealFallback();
  $("show-stall").hidden = true;
  store.drop(LS_GAME);
  if (oldGame){
    try { localStorage.removeItem(crossKey(oldGame)); } catch(e){}
    try { await set(ref(db, `games/${oldGame}/presence/${uid}`), false); } catch(e){}
  }
  if (me.name){
    await set(ref(db, `lobby/${uid}`), {
      name: me.name, emoji: me.emoji, ready: false, gameId: null, joinedAt: serverTimestamp()
    });
    onDisconnect(ref(db, `lobby/${uid}`)).remove();
    el.btnJoin.disabled = true;
    el.btnJoin.textContent = "You're in the lobby";
  }
  startLobby();
  toast(msg || "Back in the lobby. Ready up when you are.");
}
/* Wrapped, not passed directly - addEventListener would hand backToLobby the
   click event as its message argument. */
el.btnAgain.addEventListener("click", () => backToLobby());
$("btn-leave").addEventListener("click", () => backToLobby());
$("btn-leave-show").addEventListener("click", () => backToLobby());

/* ── local, private cross-offs ──────────────────────────────── */
function crossKey(gid){ return `tally:${gid}:${uid}`; }
function loadCrosses(gid){
  try { return new Set(JSON.parse(localStorage.getItem(crossKey(gid)) || "[]")); }
  catch(e){ return new Set(); }
}
function saveCrosses(){
  try { localStorage.setItem(crossKey(gameId), JSON.stringify([...crossed])); } catch(e){}
}