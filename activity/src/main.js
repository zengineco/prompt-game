// ============================================================
// PROMPT (Reverse Mode) — Discord Activity client v0.2.0 (live multiplayer)
// Discord OAuth (real usernames) + Supabase realtime (shared game state)
// Zengine™ | www.zengine.site
// ============================================================
//
// WORKFLOW STACK:
// 1. boot()        — CRT power-on sequence
// 2. init()        — Discord SDK ready + OAuth, OR browser guest mode (no Discord)
// 3. patchUrlMappings — route Supabase through Discord's proxy (in-Discord only)
// 4. joinSession() — Edge Function 'join' → session_id
// 5. subscribe()   — Supabase realtime on this session's rows → refresh()+render()
// 6. render()      — draws the terminal per phase (lobby/responding/voting/resolving)
//    All game WRITES go through the 'prompt-game' Edge Function (the referee).
//
// ASSET MANIFEST:
// - @fontsource/vt323, @fontsource/share-tech-mono  (bundled CRT fonts)
// - ./style.css
// - @discord/embedded-app-sdk (DiscordSDK, patchUrlMappings)
// - @supabase/supabase-js (createClient — realtime reads, function calls)
// - env: VITE_DISCORD_CLIENT_ID, VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
//
// BOOT ORDER:
// - DOMContentLoaded -> boot() -> init() -> joinSession() -> subscribe() -> render()
//
// BROWSER GUEST MODE:
// - Opened outside Discord (no frame_id), each tab becomes a "guest" player.
//   Open prompt.f-keys.com/?room=test in two tabs to playtest the full loop.
// ============================================================

import '@fontsource/vt323';
import '@fontsource/share-tech-mono';
import './style.css';
import { DiscordSDK, patchUrlMappings } from '@discord/embedded-app-sdk';
import { createClient } from '@supabase/supabase-js';

var CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID;
var SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
var SUPABASE_ANON = import.meta.env.VITE_SUPABASE_ANON_KEY;
var SUPABASE_HOST = (SUPABASE_URL || '').replace('https://', '');

var CATEGORIES = [
  { key: 'all', label: 'Mixed Deck' },
  { key: 'legal', label: 'Legal' },
  { key: 'hr', label: 'HR' },
  { key: 'incident', label: 'Incident' },
  { key: 'existential', label: 'Existential' },
  { key: 'aipanic', label: 'AI Panic' },
  { key: 'doom', label: 'Doom' },
  { key: 'unhinged', label: 'Unhinged' },
  { key: 'relatable', label: 'Relatable' }
];

// ── STATE — all mutable client state lives here ────────────────────────────
var STATE = {
  sdk: null,
  supabase: null,
  inDiscord: false,
  user: null,          // { id, username }
  instanceId: null,
  sessionId: null,
  session: null,       // prompt_sessions row
  players: [],
  submissions: [],
  votes: [],
  lastTyped: null,     // last current_response we animated
  category: 'all',
  advanceTimer: null,
  leaderboard: [],      // top profiles all-time
  profilesById: {},     // discord_id -> profile (for session players' titles)
  myProfile: null,      // this player's profile
  lastPhase: null       // for phase-transition FX
};

// ── Small helpers ──────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

// typeText — typewriter-print into an element, then call done
function typeText(node, text, speed, done) {
  try {
    node.textContent = '';
    var i = 0;
    var timer = setInterval(function () {
      node.textContent = text.slice(0, i);
      i++;
      if (i > text.length) {
        clearInterval(timer);
        var c = document.createElement('span');
        c.className = 'cursor';
        node.appendChild(c);
        if (typeof done === 'function') done();
      }
    }, speed);
  } catch (err) {
    console.error('typeText:', err);
    node.textContent = text;
  }
}

function setStatus(msg) { var s = el('link-status'); if (s) s.textContent = msg; }

// ── FX — reusable visual hooks. Add new screen effects here (glitch, shake, etc.)
// fxFlash() = CRT channel-change flash; called on every phase transition.
function fxFlash() {
  var f = el('fx-flash');
  if (!f) return;
  f.classList.remove('fx-active');
  void f.offsetWidth;        // force reflow so the animation can re-trigger
  f.classList.add('fx-active');
}

// ── Boot sequence ──────────────────────────────────────────────────────────
function boot() {
  try {
    var lines = [
      'ZENGINE TERMINAL v2.1 — phosphor display online',
      'loading deck ............ OK',
      'establishing reverse-prompt link ............',
      ''
    ].join('\n');
    typeText(el('boot'), lines, 14);
  } catch (err) { console.error('boot:', err); }
}

// ── Edge Function caller (the referee) ─────────────────────────────────────
async function callFn(action, payload) {
  var body = Object.assign({ action: action, instance_id: STATE.instanceId }, payload || {});
  var res = await STATE.supabase.functions.invoke('prompt-game', { body: body });
  if (res.error) {
    var detail = res.error.message || JSON.stringify(res.error);
    console.error('callFn ' + action + ':', res.error);
    throw new Error('fn[' + action + ']: ' + detail);
  }
  if (res.data && res.data.error) throw new Error('fn[' + action + ']: ' + res.data.error);
  return res.data;
}

// ── Init: Discord OAuth path, or browser guest path ────────────────────────
async function init() {
  STATE.inDiscord = new URLSearchParams(window.location.search).has('frame_id');

  if (STATE.inDiscord) {
    await initDiscord();
  } else {
    initGuest();
  }

  // Supabase client (after patchUrlMappings in the Discord path)
  STATE.supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } }
  });

  if (STATE.inDiscord) await authenticateDiscord();

  await joinSession();
  subscribe();
  await refresh();
}

async function initDiscord() {
  setStatus('players: linking to Discord...');
  STATE.sdk = new DiscordSDK(CLIENT_ID);
  await STATE.sdk.ready();
  STATE.instanceId = STATE.sdk.instanceId;
  // Route Supabase through Discord's proxy (needs matching portal Proxy Path Mapping)
  patchUrlMappings([{ prefix: '/supabase', target: SUPABASE_HOST }]);
}

// Exchange the OAuth code (via Edge Function) and resolve the real username.
// Errors propagate to init() so they show on screen.
async function authenticateDiscord() {
  setStatus('players: authorizing...');
  var auth = await STATE.sdk.commands.authorize({
    client_id: CLIENT_ID,
    response_type: 'code',
    state: '',
    prompt: 'none',
    scope: ['identify']
  });
  setStatus('players: exchanging token...');
  var tok = await callFn('token', { code: auth.code });
  if (!tok || !tok.access_token) throw new Error('token exchange returned no access_token');
  var result = await STATE.sdk.commands.authenticate({ access_token: tok.access_token });
  var u = result.user || {};
  STATE.user = { id: u.id, username: u.global_name || u.username || 'Player' };
  setStatus('players: LINK ESTABLISHED — ' + STATE.user.username);
}

// Browser guest mode — each tab is a player; ?room= groups them
function initGuest() {
  var rng = Math.random().toString(36).slice(2, 7);
  STATE.user = { id: 'guest-' + rng, username: 'GUEST-' + rng.toUpperCase() };
  STATE.instanceId = new URLSearchParams(window.location.search).get('room') || 'browser-demo';
  setStatus('players: GUEST MODE (' + STATE.user.username + ') — room "' + STATE.instanceId + '"');
}

async function joinSession() {
  var res = await callFn('join', { discord_id: STATE.user.id, username: STATE.user.username });
  if (res && res.session_id) STATE.sessionId = res.session_id;
}

// ── Realtime: any change to this session → refetch + render ────────────────
function subscribe() {
  if (!STATE.sessionId) return;
  var ch = STATE.supabase.channel('prompt-' + STATE.sessionId);
  var tables = ['prompt_sessions', 'prompt_players', 'prompt_submissions', 'prompt_votes'];
  tables.forEach(function (t) {
    var filter = (t === 'prompt_sessions' ? 'id=eq.' : 'session_id=eq.') + STATE.sessionId;
    ch.on('postgres_changes', { event: '*', schema: 'public', table: t, filter: filter }, function () { refresh(); });
  });
  // global: profile/title/leaderboard changes (not session-scoped)
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_profiles' }, function () { refresh(); });
  ch.subscribe();
}

async function refresh() {
  try {
    var sb = STATE.supabase;
    var s = await sb.from('prompt_sessions').select('*').eq('id', STATE.sessionId).maybeSingle();
    STATE.session = s.data;
    var p = await sb.from('prompt_players').select('*').eq('session_id', STATE.sessionId).order('joined_at', { ascending: true });
    STATE.players = p.data || [];
    var round = STATE.session ? STATE.session.round : 0;
    var subs = await sb.from('prompt_submissions').select('*').eq('session_id', STATE.sessionId).eq('round', round);
    STATE.submissions = subs.data || [];
    var votes = await sb.from('prompt_votes').select('*').eq('session_id', STATE.sessionId).eq('round', round);
    STATE.votes = votes.data || [];
    // v2.2 — titles/streaks for session players + all-time leaderboard
    var ids = STATE.players.map(function (x) { return x.id; });
    STATE.profilesById = {};
    if (ids.length) {
      var pr = await sb.from('prompt_profiles').select('*').in('discord_id', ids);
      (pr.data || []).forEach(function (pf) { STATE.profilesById[pf.discord_id] = pf; });
    }
    STATE.myProfile = STATE.profilesById[STATE.user.id] || null;
    var lb = await sb.from('prompt_profiles').select('username,rounds_won,best_streak,title').order('rounds_won', { ascending: false }).limit(8);
    STATE.leaderboard = lb.data || [];
    render();
  } catch (err) { console.error('refresh:', err); }
}

// ── Rendering ──────────────────────────────────────────────────────────────
function mine(list, idField) {
  return list.find(function (x) { return x[idField] === STATE.user.id; });
}

function render() {
  if (!STATE.session) { el('game').innerHTML = '<div class="muted">connecting...</div>'; return; }
  var phase = STATE.session.phase;
  if (phase !== STATE.lastPhase) { fxFlash(); STATE.lastPhase = phase; }   // CRT channel-change on transitions
  if (phase === 'lobby') renderLobby();
  else if (phase === 'responding') renderResponding();
  else if (phase === 'voting') renderVoting();
  else if (phase === 'resolving') renderResolving();
  else el('game').innerHTML = '<div class="muted">game over</div>';
  renderScoreboard();
}

function renderLobby() {
  var roster = STATE.players.map(function (p) { return '<div class="chip">▸ ' + escapeHtml(p.username) + '</div>'; }).join('');
  var opts = CATEGORIES.map(function (c) {
    return '<option value="' + c.key + '"' + (c.key === STATE.category ? ' selected' : '') + '>' + c.label + '</option>';
  }).join('');
  var canStart = STATE.players.length >= 2;
  el('game').innerHTML =
    '<div class="panel"><div class="label">&gt;&gt; Lobby — recover the question that broke the AI</div>' +
    '<div class="roster">' + (roster || '<span class="muted">waiting for players...</span>') + '</div></div>' +
    '<div class="prompt-line"><span class="arrow">&gt;</span> DECK:</div>' +
    '<div class="input-row"><select id="cat-select">' + opts + '</select>' +
    '<button id="start-btn"' + (canStart ? '' : ' disabled') + '>START</button></div>' +
    (canStart ? '' : '<div class="muted">need 2+ players to start</div>') +
    leaderboardHtml();
  el('cat-select').addEventListener('change', function (e) { STATE.category = e.target.value; });
  el('start-btn').addEventListener('click', function () { callFn('start', { category: STATE.category }); });
}

function renderResponding() {
  var did = mine(STATE.submissions, 'discord_id');
  var doneCount = STATE.submissions.length;
  var total = STATE.players.length;
  var checks = STATE.players.map(function (p) {
    var ok = STATE.submissions.some(function (s) { return s.discord_id === p.id || s.discord_id === p.discord_id; });
    return '<div class="chip">' + (ok ? '✅' : '⏳') + ' ' + escapeHtml(p.username) + '</div>';
  }).join('');

  var input = did
    ? '<div class="muted">✅ prompt locked in — waiting (' + doneCount + '/' + total + ')</div>'
    : '<div class="input-row"><input id="guess" type="text" maxlength="160" placeholder="what did someone ask..." autocomplete="off" />' +
      '<button id="submit-btn">TRANSMIT</button></div>';

  el('game').innerHTML =
    '<div class="panel"><div class="label">&gt;&gt; Recovered AI Transmission — Round ' + STATE.session.round + '</div>' +
    '<div class="transmission" id="transmission"></div></div>' +
    '<div class="prompt-line"><span class="arrow">&gt;</span> RECONSTRUCT THE PROMPT THAT CAUSED IT:</div>' +
    input +
    '<div class="roster">' + checks + '</div>' +
    '<div class="row-actions"><button id="skip-btn" class="ghost">force vote ▸</button></div>';

  paintTransmission();
  if (!did) {
    el('submit-btn').addEventListener('click', doSubmit);
    el('guess').addEventListener('keydown', function (e) { if (e.key === 'Enter') doSubmit(); });
  }
  el('skip-btn').addEventListener('click', function () { callFn('skip', {}); });
}

function doSubmit() {
  var input = el('guess');
  var val = (input.value || '').trim();
  if (!val) return;
  input.disabled = true;
  callFn('submit', { discord_id: STATE.user.id, username: STATE.user.username, text: val });
}

function renderVoting() {
  var votable = STATE.submissions.filter(function (s) { return s.discord_id !== STATE.user.id; });
  var didVote = mine(STATE.votes, 'voter_discord_id');
  var letters = ['🅰️', '🅱️', '🇨', '🇩', '🇪', '🇫', '🇬', '🇭', '🇮'];

  var cards = votable.map(function (s, i) {
    var btn = didVote ? '' : '<button class="vote-btn" data-sub="' + s.id + '">' + letters[i] + '</button>';
    return '<div class="sub-card">' + btn + '<div class="sub-text">&gt; ' + escapeHtml(s.text) + '</div></div>';
  }).join('');

  el('game').innerHTML =
    '<div class="panel"><div class="label">&gt;&gt; The AI answered</div>' +
    '<div class="transmission-small">"' + escapeHtml(STATE.session.current_response) + '"</div></div>' +
    '<div class="prompt-line"><span class="arrow">&gt;</span> WHICH PROMPT CAUSED IT? (no self-votes)</div>' +
    '<div class="subs">' + (cards || '<span class="muted">no other prompts to vote on</span>') + '</div>' +
    (didVote ? '<div class="muted">🔒 vote locked — waiting (' + STATE.votes.length + '/' + STATE.players.length + ')</div>' : '') +
    '<div class="row-actions"><button id="skip-btn" class="ghost">force results ▸</button></div>';

  if (!didVote) {
    Array.prototype.forEach.call(document.querySelectorAll('.vote-btn'), function (b) {
      b.addEventListener('click', function () {
        callFn('vote', { voter_discord_id: STATE.user.id, submission_id: b.getAttribute('data-sub') });
      });
    });
  }
  el('skip-btn').addEventListener('click', function () { callFn('skip', {}); });
}

function renderResolving() {
  // tally for display
  var tally = {};
  STATE.votes.forEach(function (v) { tally[v.submission_id] = (tally[v.submission_id] || 0) + 1; });
  var max = 0;
  Object.keys(tally).forEach(function (k) { if (tally[k] > max) max = tally[k]; });

  var rows = STATE.submissions.slice().sort(function (a, b) {
    return (tally[b.id] || 0) - (tally[a.id] || 0);
  }).map(function (s) {
    var n = tally[s.id] || 0;
    var win = (n === max && max > 0) ? ' win' : '';
    return '<div class="result-row' + win + '"><span class="who">' + escapeHtml(s.username) + '</span> ' +
      '(' + n + ' vote' + (n !== 1 ? 's' : '') + ')<div class="sub-text">&gt; ' + escapeHtml(s.text) + '</div></div>';
  }).join('');

  el('game').innerHTML =
    '<div class="panel"><div class="label">&gt;&gt; Round ' + STATE.session.round + ' — Recovered Prompts</div>' +
    '<div class="transmission-small">"' + escapeHtml(STATE.session.current_response) + '"</div></div>' +
    '<div class="results">' + rows + '</div>' +
    '<div class="row-actions"><button id="next-btn">NEXT ROUND ▸</button></div>';

  el('next-btn').addEventListener('click', function () { callFn('next', {}); });

  // Auto-advance at the deadline (idempotent — server only advances once)
  if (STATE.advanceTimer) clearTimeout(STATE.advanceTimer);
  var ms = 9000;
  if (STATE.session.deadline) ms = Math.max(1500, new Date(STATE.session.deadline).getTime() - Date.now());
  STATE.advanceTimer = setTimeout(function () { callFn('next', {}); }, ms);
}

function renderScoreboard() {
  var sorted = STATE.players.slice().sort(function (a, b) { return b.score - a.score; });
  var medals = ['🥇', '🥈', '🥉'];
  var board = sorted.map(function (p, i) {
    var m = medals[i] || (i + 1) + '.';
    var me = p.id === STATE.user.id ? ' (you)' : '';
    var prof = STATE.profilesById[p.id];
    var title = (prof && prof.title) ? ' <span class="title-tag">' + escapeHtml(prof.title) + '</span>' : '';
    return '<span class="score-chip">' + m + ' ' + escapeHtml(p.username) + me + title + ' — ' + p.score + '</span>';
  }).join('');
  var mine = '';
  if (STATE.myProfile) {
    mine = '<div class="my-rank">RANK: <b>' + escapeHtml(STATE.myProfile.title || 'UNRANKED') + '</b>' +
      ' · ' + STATE.myProfile.rounds_won + ' lifetime wins · streak ' + STATE.myProfile.current_streak +
      ' (best ' + STATE.myProfile.best_streak + ')</div>';
  }
  el('scoreboard').innerHTML = (board ? '<div class="label">SCOREBOARD</div>' + board : '') + mine;
}

// All-time cross-game leaderboard (shown in the lobby — the "reason to return")
function leaderboardHtml() {
  if (!STATE.leaderboard || !STATE.leaderboard.length) return '';
  var rows = STATE.leaderboard.map(function (p, i) {
    var medal = ['🥇', '🥈', '🥉'][i] || (i + 1) + '.';
    return '<div class="lb-row">' + medal + ' <span class="who">' + escapeHtml(p.username) + '</span> ' +
      '<span class="title-tag">' + escapeHtml(p.title || 'UNRANKED') + '</span> · ' + p.rounds_won + 'w</div>';
  }).join('');
  return '<div class="panel"><div class="label">🏆 Hall of Fame — all-time</div><div class="leaderboard">' + rows + '</div></div>';
}

// paint the transmission, animating only when the response text changes
function paintTransmission() {
  var node = el('transmission');
  if (!node) return;
  var text = '"' + (STATE.session.current_response || '') + '"';
  if (STATE.session.current_response && STATE.session.current_response !== STATE.lastTyped) {
    STATE.lastTyped = STATE.session.current_response;
    typeText(node, text, 20);
  } else {
    node.textContent = text;
  }
}

// ── BOOT ORDER ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  boot();
  init().catch(function (err) {
    console.error('init:', err);
    var msg = (err && err.message) ? err.message : String(err);
    setStatus('players: INIT FAILED');
    var g = el('game');
    if (g) g.innerHTML = '<div class="panel"><div class="label">&gt;&gt; INIT ERROR</div>' +
      '<div class="sub-text">' + escapeHtml(msg) + '</div></div>';
  });
});
