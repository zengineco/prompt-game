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
  lastPhase: null,      // for phase-transition FX
  awardDefs: [],        // the award deck (registry)
  awardsByKey: {},      // key -> award def
  roundGrants: [],      // awards granted this round (for the results screen)
  myTags: [],           // my crown/read this round
  myTitles: [],         // my unlocked title collection (for the picker)
  disputes: [],         // disputes this round
  disputeVotes: [],     // votes on this round's disputes
  reports: []           // content reports this round (who flagged what)
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
  // award-system tables (session-scoped)
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_tag_votes', filter: 'session_id=eq.' + STATE.sessionId }, function () { refresh(); });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_award_grants', filter: 'session_id=eq.' + STATE.sessionId }, function () { refresh(); });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_disputes', filter: 'session_id=eq.' + STATE.sessionId }, function () { refresh(); });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_dispute_votes' }, function () { refresh(); });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_reports', filter: 'session_id=eq.' + STATE.sessionId }, function () { refresh(); });
  // global: profile/rank/prestige changes
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
    var lb = await sb.from('prompt_profiles').select('username,prestige,rank,calltag').order('prestige', { ascending: false }).limit(8);
    STATE.leaderboard = lb.data || [];
    var mtt = await sb.from('prompt_player_titles').select('*').eq('discord_id', STATE.user.id).order('tier', { ascending: false });
    STATE.myTitles = mtt.data || [];
    // award system: deck (load once), this round's grants (results), my own tags this round
    if (!STATE.awardDefs.length) {
      var ad = await sb.from('prompt_award_defs').select('*').eq('active', true);
      STATE.awardDefs = ad.data || [];
      STATE.awardsByKey = {};
      STATE.awardDefs.forEach(function (a) { STATE.awardsByKey[a.key] = a; });
    }
    var gr = await sb.from('prompt_award_grants').select('id,recipient,award_key,rarity').eq('session_id', STATE.sessionId).eq('round', round);
    STATE.roundGrants = gr.data || [];
    var dsp = await sb.from('prompt_disputes').select('*').eq('session_id', STATE.sessionId).eq('round', round);
    STATE.disputes = dsp.data || [];
    STATE.disputeVotes = [];
    var dispIds = STATE.disputes.map(function (d) { return d.id; });
    if (dispIds.length) {
      var dv = await sb.from('prompt_dispute_votes').select('*').in('dispute_id', dispIds);
      STATE.disputeVotes = dv.data || [];
    }
    var mt = await sb.from('prompt_tag_votes').select('submission_id,award_key,slot').eq('session_id', STATE.sessionId).eq('round', round).eq('voter', STATE.user.id);
    STATE.myTags = mt.data || [];
    var rp = await sb.from('prompt_reports').select('submission_id,reporter').eq('session_id', STATE.sessionId).eq('round', round);
    STATE.reports = rp.data || [];
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
  else if (phase === 'ended') renderGameOver();
  else el('game').innerHTML = '<div class="muted">connecting...</div>';
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
    '<select id="rounds-select"><option value="3">3 rounds</option><option value="5" selected>5 rounds</option><option value="7">7 rounds</option></select>' +
    '<button id="start-btn"' + (canStart ? '' : ' disabled') + '>START</button></div>' +
    (canStart ? '' : '<div class="muted">need 2+ players to start</div>') +
    titlePickerHtml() +
    leaderboardHtml();
  el('cat-select').addEventListener('change', function (e) { STATE.category = e.target.value; });
  el('start-btn').addEventListener('click', function () {
    var rounds = parseInt(el('rounds-select').value) || 5;
    callFn('start', { category: STATE.category, rounds: rounds });
  });
  if (el('title-sel')) {
    el('title-sel').addEventListener('change', function (e) {
      STATE.supabase.rpc('prompt_set_title', { p_discord: STATE.user.id, p_title_key: e.target.value }).then(function () { refresh(); });
    });
  }
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
      '<button id="submit-btn">TRANSMIT</button></div><div class="submit-note" id="submit-note"></div>';

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
  var btn = el('submit-btn');
  var note = el('submit-note');
  var val = (input.value || '').trim();
  if (!val) return;
  input.disabled = true;
  if (btn) btn.disabled = true;
  if (note) { note.textContent = ''; note.className = 'submit-note'; }
  callFn('submit', { discord_id: STATE.user.id, username: STATE.user.username, text: val })
    .then(function (res) {
      // server moderation rejected it — let them rewrite, don't lock the round
      if (res && res.blocked) {
        input.disabled = false;
        if (btn) btn.disabled = false;
        input.focus(); input.select();
        if (note) { note.textContent = '🚫 ' + (res.reason || "That can't be submitted."); note.className = 'submit-note blocked'; }
      }
    })
    .catch(function (e) {
      input.disabled = false;
      if (btn) btn.disabled = false;
      if (note) { note.textContent = '⚠ ' + e.message; note.className = 'submit-note blocked'; }
    });
}

function renderVoting() {
  var crowns = STATE.awardDefs.filter(function (a) { return a.earn === 'hand' && a.valence === 'crown'; });
  var reads = STATE.awardDefs.filter(function (a) { return a.earn === 'hand' && a.valence !== 'crown'; });
  var myCrown = STATE.myTags.find(function (t) { return t.slot === 'crown'; });
  var myRead = STATE.myTags.find(function (t) { return t.slot === 'read'; });

  var crownOpts = crowns.map(function (a) { return '<option value="' + a.key + '">' + escapeHtml(a.label) + '</option>'; }).join('');
  var readOpts = reads.map(function (a) { return '<option value="' + a.key + '">' + escapeHtml(a.label) + '</option>'; }).join('');

  var cards = STATE.submissions.map(function (s) {
    var isMine = s.discord_id === STATE.user.id;
    if (s.hidden) return '<div class="sub-card2 removed"><div class="sub-text">🚫 removed by the table</div></div>';
    var tags = '';
    if (myCrown && myCrown.submission_id === s.id) tags += '<span class="my-tag">👑 ' + escapeHtml((STATE.awardsByKey[myCrown.award_key] || {}).label || '') + '</span>';
    if (myRead && myRead.submission_id === s.id) tags += '<span class="my-tag">🏷️ ' + escapeHtml((STATE.awardsByKey[myRead.award_key] || {}).label || '') + '</span>';
    var iReported = STATE.reports.some(function (r) { return r.submission_id === s.id && r.reporter === STATE.user.id; });
    var reportBtn = isMine ? ''
      : (iReported ? '<span class="reported">🚩 flagged</span>'
                   : '<button class="report-btn" data-sub="' + s.id + '" title="report hate / slurs">🚩</button>');
    var actions = '<div class="sub-actions">' +
      (isMine
        ? '<span class="muted">your prompt</span>'
        : '<button class="crown-btn" data-sub="' + s.id + '"' + (myCrown ? ' disabled' : '') + '>👑 crown</button>') +
      '<button class="read-btn" data-sub="' + s.id + '"' + (myRead ? ' disabled' : '') + '>🏷️ read</button>' +
      reportBtn +
      '</div>';
    return '<div class="sub-card2"><div class="sub-text">&gt; ' + escapeHtml(s.text) + '</div>' + tags + actions + '</div>';
  }).join('');

  var status = (myCrown ? '👑 crown cast' : '👑 crown REQUIRED') + ' &nbsp;·&nbsp; ' + (myRead ? '🏷️ read cast' : '🏷️ read optional');

  el('game').innerHTML =
    '<div class="panel"><div class="label">&gt;&gt; The AI answered</div>' +
    '<div class="transmission-small">"' + escapeHtml(STATE.session.current_response) + '"</div></div>' +
    '<div class="prompt-line"><span class="arrow">&gt;</span> CROWN the best reconstruction, then optionally drop a READ:</div>' +
    '<div class="award-pickers">CROWN <select id="crown-sel">' + crownOpts + '</select> &nbsp; READ <select id="read-sel">' + readOpts + '</select></div>' +
    '<div class="subs">' + cards + '</div>' +
    '<div class="muted">' + status + '</div>' +
    '<div class="row-actions"><button id="skip-btn" class="ghost">force results ▸</button></div>';

  Array.prototype.forEach.call(document.querySelectorAll('.crown-btn'), function (b) {
    b.addEventListener('click', function () {
      callFn('tagvote', { voter_discord_id: STATE.user.id, submission_id: b.getAttribute('data-sub'), award_key: el('crown-sel').value, slot: 'crown' });
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.read-btn'), function (b) {
    b.addEventListener('click', function () {
      callFn('tagvote', { voter_discord_id: STATE.user.id, submission_id: b.getAttribute('data-sub'), award_key: el('read-sel').value, slot: 'read' });
    });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.report-btn'), function (b) {
    b.addEventListener('click', function () {
      b.disabled = true; b.textContent = '🚩…';
      callFn('report', { reporter: STATE.user.id, submission_id: b.getAttribute('data-sub') });
    });
  });
  el('skip-btn').addEventListener('click', function () { callFn('skip', {}); });
}

function renderResolving() {
  var byKey = STATE.awardsByKey;
  function scoreOf(sub) {
    return STATE.roundGrants.filter(function (g) { return g.recipient === sub.discord_id; })
      .reduce(function (a, g) { return a + ((byKey[g.award_key] || {}).value || 0); }, 0);
  }
  function nameOf(id) { var p = STATE.players.find(function (x) { return x.id === id; }); return p ? p.username : id; }

  var myDispute = STATE.disputes.find(function (d) { return d.disputer === STATE.user.id; });
  var openDisputes = STATE.disputes.filter(function (d) { return d.status === 'open'; });

  // open dispute → table votes uphold/overturn
  var disputeHtml = openDisputes.map(function (d) {
    var votes = STATE.disputeVotes.filter(function (v) { return v.dispute_id === d.id; });
    var up = votes.filter(function (v) { return v.uphold; }).length;
    var over = votes.length - up;
    var amDisputer = d.disputer === STATE.user.id;
    var iVoted = votes.some(function (v) { return v.voter === STATE.user.id; });
    var awardLabel = (byKey[d.award_key] || {}).label || d.award_key;
    var ctrl = (amDisputer || iVoted)
      ? '<span class="muted">' + (amDisputer ? 'awaiting the verdict...' : 'voted') + '</span>'
      : '<button class="dv-up" data-d="' + d.id + '">UPHOLD</button> <button class="dv-over" data-d="' + d.id + '">OVERTURN</button>';
    return '<div class="panel dispute-panel"><div class="label">⚖️ DISPUTE</div>' +
      '<div class="sub-text"><b>' + escapeHtml(nameOf(d.disputer)) + '</b> contests <span class="award-chip">' + escapeHtml(awardLabel) + '</span> — does it stick?</div>' +
      '<div class="row-actions">' + ctrl + '</div>' +
      '<div class="muted">uphold ' + up + ' · overturn ' + over + '</div></div>';
  }).join('');

  var resolvedHtml = STATE.disputes.filter(function (d) { return d.status !== 'open'; }).map(function (d) {
    var awardLabel = (byKey[d.award_key] || {}).label || d.award_key;
    return '<div class="muted">⚖️ ' + escapeHtml(awardLabel) + (d.status === 'overturned' ? ' — STRUCK by the table' : ' — UPHELD') + '</div>';
  }).join('');

  var rows = STATE.submissions.slice().sort(function (a, b) { return scoreOf(b) - scoreOf(a); });
  var top = rows.length ? scoreOf(rows[0]) : 0;

  var html = rows.map(function (s) {
    if (s.hidden) return '<div class="result-row removed"><span class="who">' + escapeHtml(s.username) + '</span> <span class="muted">🚫 removed by the table</span></div>';
    var grants = STATE.roundGrants.filter(function (g) { return g.recipient === s.discord_id; });
    var isMine = s.discord_id === STATE.user.id;
    var chips = grants.map(function (g) {
      var d = byKey[g.award_key] || {};
      var canDispute = isMine && !myDispute;
      var dbtn = canDispute ? ' <button class="dispute-btn" data-grant="' + g.id + '" title="dispute this tag">⚖️</button>' : '';
      return '<span class="award-chip rarity-' + escapeHtml(g.rarity) + '">' + escapeHtml(d.label || g.award_key) + '</span>' + dbtn;
    }).join(' ');
    var win = (scoreOf(s) === top && top > 0) ? ' win' : '';
    return '<div class="result-row' + win + '"><span class="who">' + escapeHtml(s.username) + '</span> ' +
      (win ? '🏆 ' : '') + '<span class="muted">(' + scoreOf(s) + ')</span>' +
      '<div class="sub-text">&gt; ' + escapeHtml(s.text) + '</div>' +
      (chips ? '<div class="award-row">' + chips + '</div>' : '<div class="muted">— no awards —</div>') +
      '</div>';
  }).join('');

  el('game').innerHTML =
    '<div class="panel"><div class="label">&gt;&gt; Round ' + STATE.session.round + ' — Awards</div>' +
    '<div class="transmission-small">"' + escapeHtml(STATE.session.current_response) + '"</div></div>' +
    disputeHtml + (resolvedHtml ? '<div class="results">' + resolvedHtml + '</div>' : '') +
    '<div class="results">' + html + '</div>' +
    '<div class="row-actions"><button id="next-btn"' + (openDisputes.length ? ' disabled' : '') + '>NEXT ROUND ▸</button></div>';

  Array.prototype.forEach.call(document.querySelectorAll('.dispute-btn'), function (b) {
    b.addEventListener('click', function () { callFn('dispute', { grant_id: b.getAttribute('data-grant'), disputer: STATE.user.id }); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.dv-up'), function (b) {
    b.addEventListener('click', function () { callFn('disputevote', { dispute_id: b.getAttribute('data-d'), voter: STATE.user.id, uphold: true }); });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.dv-over'), function (b) {
    b.addEventListener('click', function () { callFn('disputevote', { dispute_id: b.getAttribute('data-d'), voter: STATE.user.id, uphold: false }); });
  });
  var nb = el('next-btn'); if (nb) nb.addEventListener('click', function () { callFn('next', {}); });

  // auto-advance only when no dispute is open
  if (STATE.advanceTimer) clearTimeout(STATE.advanceTimer);
  if (!openDisputes.length) {
    var ms = 12000;
    if (STATE.session.deadline) ms = Math.max(2000, new Date(STATE.session.deadline).getTime() - Date.now());
    STATE.advanceTimer = setTimeout(function () { callFn('next', {}); }, ms);
  }
}

function renderGameOver() {
  var sorted = STATE.players.slice().sort(function (a, b) { return b.score - a.score; });
  var champ = sorted[0];
  var champProf = champ ? (STATE.profilesById[champ.id] || {}) : {};
  var standings = sorted.map(function (p, i) {
    var medal = ['🥇', '🥈', '🥉'][i] || (i + 1) + '.';
    var prof = STATE.profilesById[p.id] || {};
    var sig = prof.calltag ? ' <span class="title-tag">' + escapeHtml(prof.calltag) + '</span>' : '';
    return '<div class="result-row' + (i === 0 ? ' win' : '') + '">' + medal + ' <span class="who">' +
      escapeHtml(p.username) + '</span>' + sig + ' — ' + p.score + ' pts</div>';
  }).join('');

  el('game').innerHTML =
    '<div class="panel"><div class="label">&gt;&gt; GAME OVER</div>' +
    (champ ? '<div class="champion">🏆 CHAMPION: <b>' + escapeHtml(champ.username) + '</b>' +
      (champProf.calltag ? ', the <b>' + escapeHtml(champProf.calltag) + '</b>' : '') + '</div>' : '') +
    '</div>' +
    '<div class="results">' + standings + '</div>' +
    '<div class="row-actions"><button id="again-btn">▸ PLAY AGAIN</button></div>';

  el('again-btn').addEventListener('click', function () { callFn('reset', {}); });
}

function renderScoreboard() {
  var sorted = STATE.players.slice().sort(function (a, b) { return b.score - a.score; });
  var medals = ['🥇', '🥈', '🥉'];
  var board = sorted.map(function (p, i) {
    var m = medals[i] || (i + 1) + '.';
    var me = p.id === STATE.user.id ? ' (you)' : '';
    var prof = STATE.profilesById[p.id];
    var title = (prof && prof.calltag) ? ' <span class="title-tag">' + escapeHtml(prof.calltag) + '</span>' : '';
    return '<span class="score-chip">' + m + ' ' + escapeHtml(p.username) + me + title + ' — ' + p.score + '</span>';
  }).join('');
  var mine = '';
  if (STATE.myProfile) {
    var tag = STATE.myProfile.calltag ? ' · <b>' + escapeHtml(STATE.myProfile.calltag) + '</b>' : '';
    mine = '<div class="my-rank">RANK: <b>' + escapeHtml(STATE.myProfile.rank || 'UNRANKED') + '</b>' + tag +
      ' · ' + (STATE.myProfile.prestige || 0) + ' prestige</div>';
  }
  el('scoreboard').innerHTML = (board ? '<div class="label">SCOREBOARD</div>' + board : '') + mine;
}

// All-time cross-game leaderboard (shown in the lobby — the "reason to return")
function leaderboardHtml() {
  if (!STATE.leaderboard || !STATE.leaderboard.length) return '';
  var rows = STATE.leaderboard.map(function (p, i) {
    var medal = ['🥇', '🥈', '🥉'][i] || (i + 1) + '.';
    var sig = p.calltag ? ' <span class="title-tag">' + escapeHtml(p.calltag) + '</span>' : '';
    return '<div class="lb-row">' + medal + ' <span class="who">' + escapeHtml(p.username) + '</span>' + sig +
      ' · ' + (p.prestige || 0) + 'p</div>';
  }).join('');
  return '<div class="panel"><div class="label">🏆 Hall of Fame — by prestige</div><div class="leaderboard">' + rows + '</div></div>';
}

// Title picker — wear any title you've unlocked (combos rank above ladders)
function titlePickerHtml() {
  if (!STATE.myProfile || !STATE.myTitles.length) return '';
  var chosen = STATE.myProfile.chosen_title;
  var opts = STATE.myTitles.slice().sort(function (a, b) {
    var ra = a.kind === 'combo' ? a.tier + 1000 : a.tier;
    var rb = b.kind === 'combo' ? b.tier + 1000 : b.tier;
    return rb - ra;
  }).map(function (t) {
    var sel = (chosen === t.title_key) ? ' selected' : '';
    var tag = t.kind === 'combo' ? ' (' + t.tier + '-way)' : '';
    return '<option value="' + escapeHtml(t.title_key) + '"' + sel + '>' + escapeHtml(t.label) + tag + '</option>';
  }).join('');
  return '<div class="prompt-line"><span class="arrow">&gt;</span> YOUR TITLE — wear what you earned:</div>' +
    '<div class="input-row"><select id="title-sel">' + opts + '</select></div>';
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
