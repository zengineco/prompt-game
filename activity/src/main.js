// ============================================================
// PROMPT — Discord Activity client v0.2.0 (live multiplayer)
// Discord OAuth (real usernames) + Supabase realtime (shared game state)
// f-keys.com
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

// award_key -> emoji, so the voting picker + chips read at a glance
var EMOJI = {
  dead_on: '🎯', chefs_kiss: '🤌', blursed: '🌀',
  actually: '🤓', too_real: '😭', unhinged: '🤪', wellness: '🩺', hr_flagged: '💼', bozo: '🤡',
  self_report: '🫣', word_salad: '🥗', get_carried: '⚓',
  shutout: '🧹', landslide: '🏔️', flawless: '💎', vindicated: '✊', overruled: '🔨', hanging_judge: '⚖️',
  bot_bait: '🎣'
};
function awEmoji(k) { return EMOJI[k] || '🏷️'; }
var BOT_ID = 'bot-prompt-ai';   // PROMPT_AI — the fake contestant

// v17 — the 15 reaction badges (drag/tap one onto each prompt). Keys match the referee.
var BADGES = [
  { key: 'bullseye', e: '🎯', label: 'Bullseye — nailed it' },
  { key: 'handshake', e: '🤝', label: 'Handshake — real recognizes real' },
  { key: 'chef', e: '🧑‍🍳', label: 'Chef — let him cook' },
  { key: 'clown', e: '🤡', label: 'Clown — bozo energy' },
  { key: 'yawn', e: '🥱', label: 'Yawn — mid' },
  { key: 'cap', e: '🧢', label: 'Cap — lies' },
  { key: 'puke', e: '🤮', label: 'Puke — the ick' },
  { key: 'money', e: '💸', label: 'Money — out of pocket' },
  { key: 'trash', e: '🗑️', label: 'Trash — garbage take' },
  { key: 'crylaugh', e: '😂', label: 'Cry-Laugh — landed it' },
  { key: 'fire', e: '🔥', label: 'Fire — bars' },
  { key: 'sideeye', e: '👀', label: 'Side-Eye — sus' },
  { key: 'popcorn', e: '🍿', label: 'Popcorn — here for it' },
  { key: 'chartdown', e: '📉', label: 'Chart Down — fumbled' },
  { key: 'robot', e: '🤖', label: 'Robot — AI slop' }
];
var BADGE_E = {}; BADGES.forEach(function (b) { BADGE_E[b.key] = b.e; });
function badgeEmoji(k) { return BADGE_E[k] || '🏷️'; }

// ── TIER 1: IDENTITY ENGINE — badges become names (Goyim's canon) ────────────
// recv = badges that landed on YOUR prompts; give = badges YOU handed out.
// Title rungs unlock at career count 5/10/20/30/40 and ★50 (apex).
var LEVELS = [5, 10, 20, 30, 40, 50];
function levelIdx(count) { var idx = -1; for (var i = 0; i < LEVELS.length; i++) { if (count >= LEVELS[i]) idx = i; } return idx; }

// RECEIVER ladders — what your prompts earn
var RECEIVER_LADDERS = {
  bullseye: ['Marksman', 'Deadeye', 'Sharpshooter', 'Aimbot', 'The Hitman', 'TRUE NORTH'],
  handshake: ['Cosignee', 'Trusted Source', 'The Plug', "People's Champ", 'Word Is Bond', 'THE GOSPEL'],
  chef: ['Line Cook', 'Foodie Influencer', 'Kitchen Manager', 'Sous Chef', 'Iron Chef', 'MICHELIN STAR'],
  clown: ['Shitposter', 'Class Clown', 'Certified Bozo', 'Ringmaster', "King's Jester", 'GIGACLOWN'],
  yawn: ['Background Noise', 'Asleep At The Wheel', 'The Sandman', 'Human Ambien', 'Cure for Insomnia', 'DEAD WEIGHT'],
  cap: ['Bullshitter', 'Storyteller', 'Shill', 'Fabricator', 'Con Artist', 'LIVING A LIE'],
  puke: ['The Ick', 'Tough To Watch', 'Walking Turnoff', 'Hazardous Material', 'Biological Waste', 'SOCIETAL VIRUS'],
  money: ['Sketchy', 'Inconsiderate', 'Hair Trigger', 'Loose Cannon', 'Total Liability', 'WALKING CRASHOUT'],
  trash: ['Litterbug', 'Scrapper', 'Hoarder', 'Sanitation Dept', 'Landfill Owner', 'OSCAR AWARD WINNER'],
  crylaugh: ['Knee Slapper', 'Laugh Track', 'Open Mic Enthusiast', 'Crowd Pleaser', 'Local Headliner', 'THE LAST LAUGH'],
  fire: ['Playing With Matches', 'Heating-Up', 'The Arsonist', 'Wildfire', 'Solar Flare', 'SUPERNOVA'],
  sideeye: ['Sus', 'Wellness-Check', 'Person of Interest', 'Red Flag Factory', 'Under Investigation', 'ANOMALOUS'],
  popcorn: ['Just Browsing', 'Spectator', 'Tourist', 'Fan Of Cinema', 'Art Historian', 'GOLDEN TICKETHOLDER'],
  chartdown: ['Fumbler', 'Loss Harvester', 'Downtrend Catalyst', 'Free-Fall Economist', 'Greater Fool', 'CHAPTER 11'],
  robot: ['NPC', 'Reeks Of A.I.', 'Autocompleted', 'Frontier Grade', 'Sentient Slop', 'DATACENTER']
};
// GIVER ladders — the Projection: who you become by handing it out
var GIVER_LADDERS = {
  bullseye: ['The Well Actually', 'Wiki Editor', 'Reddit Moderator', 'The Fun Police', 'Citation Machine', 'ALL CAPS'],
  handshake: ['Peacemaker', 'Tagalong', 'Follow-For-Follow', 'Yes-Man', 'Professional Glazer', 'THE HUMAN RETWEET'],
  chef: ['Microwaver', 'Foodie', 'Uber Eater', 'Room For Dessert', 'Yelp Warrior', 'THE HEALTH INSPECTOR'],
  clown: ['Haughty', 'Jeerleader', 'Rage Baiter', 'Edge Lord', 'Lobby Goblin', 'FREAKSHOW ADMIN'],
  yawn: ['Wet Blanket', 'Mood Killer', 'Vibe Burglar', 'Energy Vampire', 'Fun Extinguisher', 'THE ABYSS'],
  cap: ['Doubter', 'Bullshit Detector', '"Source?"', 'Polygraphic', 'Info Warrior', 'THE CONSPIRACIST'],
  puke: ['Snowflake', 'Pearl Clutcher', 'Ick-Magnet', 'Repeat Offendee', 'Career Victim', 'SCAT SNOB'],
  money: ['Hall Monitor', 'Tattletale', "Citizen's Arrest", 'Discord Admin', 'HR Representative', 'COMPLIANCE OFFICER'],
  trash: ['Lowkey A Hater', 'Salt Miner', 'Dump Trucker', 'Biodegrader', 'Scrapyard Sovereign', 'THE GARBAGE PAIL KID'],
  crylaugh: ['Tickled', 'Pity Laugh Track', 'Reaction Merchant', 'Sympathy Bot', 'Studio Audience', 'A REAL HOOTENANNY'],
  fire: ['Cosigner', 'Stan', 'Gas Leak', 'Accelerant', 'Combustor', 'COPE LORD'],
  sideeye: ['Alt-Watcher', 'Packet Sniffer', 'Encrypted', 'Log Farmer', 'Federal Agent', 'THE PANOPTICON'],
  popcorn: ['Goon', 'Drama Mogul', 'Clip Farmer', 'Pot Stirrer', 'Narrative Director', 'CLASS ACTION CINEMA'],
  chartdown: ['Doomer', 'Blackpiller', 'Short Seller', 'Margin Calling', 'Liquidation Engine', 'THE RECESSION'],
  robot: ['Bot-Caller', 'You Robot', 'Analog Averse', 'Em-Dash Whisperer', 'Autocaptcha', 'SLOP SOMMELIER']
};

// from raw stats -> the titles you hold + your worn calltag (highest)
function computeIdentity(stats) {
  var recvTitles = [], giveTitles = [];
  (stats || []).forEach(function (s) {
    var ri = levelIdx(s.recv);
    if (ri >= 0 && RECEIVER_LADDERS[s.badge]) recvTitles.push({ badge: s.badge, label: RECEIVER_LADDERS[s.badge][ri], idx: ri, count: s.recv, axis: 'recv' });
    var gi = levelIdx(s.give);
    if (gi >= 0 && GIVER_LADDERS[s.badge]) giveTitles.push({ badge: s.badge, label: GIVER_LADDERS[s.badge][gi], idx: gi, count: s.give, axis: 'give' });
  });
  var all = recvTitles.concat(giveTitles).sort(function (a, b) {
    return (b.idx - a.idx) || (b.count - a.count) || ((a.axis === 'recv' ? 0 : 1) - (b.axis === 'recv' ? 0 : 1));
  });
  return { recvTitles: recvTitles, giveTitles: giveTitles, calltag: all.length ? all[0].label : null };
}

// the dossier panel — your earned ranks + the Projection + progress to next
function dossierHtml() {
  var id = STATE.myIdentity;
  if (!id || (!id.recvTitles.length && !id.giveTitles.length)) {
    return '<div class="panel dossier"><div class="label">🪪 YOUR DOSSIER</div>' +
      '<div class="muted">no rank yet — earn badges on your prompts, and hand them out, to unlock your name.</div></div>';
  }
  function row(t, axis) {
    var ladder = axis === 'recv' ? RECEIVER_LADDERS : GIVER_LADDERS;
    var nextThresh = t.idx < LEVELS.length - 1 ? LEVELS[t.idx + 1] : null;
    var prog = nextThresh
      ? t.count + '/' + nextThresh + ' → ' + ladder[t.badge][t.idx + 1]
      : 'MAX ★';
    return '<div class="dz-row"><span class="dz-badge">' + badgeEmoji(t.badge) + '</span>' +
      '<span class="dz-title">' + escapeHtml(t.label) + '</span>' +
      '<span class="dz-prog muted">' + escapeHtml(prog) + '</span></div>';
  }
  function bySort(a, b) { return (b.idx - a.idx) || (b.count - a.count); }
  var recv = id.recvTitles.slice().sort(bySort), give = id.giveTitles.slice().sort(bySort);
  var html = '<div class="panel dossier"><div class="label">🪪 YOUR DOSSIER</div>';
  if (id.calltag) html += '<div class="dz-calltag">WORN: <b>' + escapeHtml(id.calltag) + '</b></div>';
  if (recv.length) html += '<div class="dz-sub">WHAT YOUR PROMPTS EARN</div>' + recv.map(function (t) { return row(t, 'recv'); }).join('');
  if (give.length) html += '<div class="dz-sub">THE PROJECTION — what you inflict</div>' + give.map(function (t) { return row(t, 'give'); }).join('');
  return html + '</div>';
}

// fake "decoding" fragments the terminal flickers while a player is still typing
var SCRAMBLE_WORDS = [
  'manifest parking spot', 'is it illegal to', 'asking for a friend', 'how do i explain this',
  'can my landlord legally', 'what does it mean when he', 'undo a sent text', 'define situationship',
  'reverse a paternity test', 'my search history', 'is it weird that i', 'how long until they notice'
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
  badgeVotes: [],      // v17 board: one badge per (voter, prompt) this round
  armedBadge: null,    // v17 board: badge picked up, awaiting a card (tap-to-place)
  badgeStats: [],      // Tier 1: my career badge tallies [{badge,recv,give}]
  myIdentity: null,    // Tier 1: computed titles + worn calltag
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
  reports: [],          // content reports this round (who flagged what)
  homeInstanceId: null, // the friends/guest room to return to after a public game
  channel: null,        // active realtime channel (so we can swap it when matchmaking)
  lbTab: 'global',      // leaderboard view: 'global' | 'friends'
  tick: null,           // countdown + scramble interval
  crownVoters: {},      // discord_id -> true for players who've locked a crown this round
  revealRound: -1,      // staged results: which round's reveal has already played
  revealStage: 0,       // 0 = vote counts, 1 = authors revealed, 2 = full awards + dispute
  revealT1: null, revealT2: null
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
      'F-KEYS TERMINAL v2.1 — display online',
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
  // guest-only debug hooks (no-op in Discord) for local verification
  window.__uid = STATE.user.id;
  window.__prompt = { computeIdentity: computeIdentity, dossierHtml: dossierHtml, STATE: STATE };
}

async function joinSession() {
  var res = await callFn('join', { discord_id: STATE.user.id, username: STATE.user.username });
  if (res && res.session_id) STATE.sessionId = res.session_id;
  if (!STATE.homeInstanceId) STATE.homeInstanceId = STATE.instanceId; // remember the room we came from
}

// ── Matchmaking — hop between the home room and a public stranger table ──────
async function switchSession(instanceId, sessionId) {
  if (STATE.channel) { try { STATE.supabase.removeChannel(STATE.channel); } catch (e) {} STATE.channel = null; }
  STATE.instanceId = instanceId;
  STATE.sessionId = sessionId;
  STATE.lastPhase = null;       // force a CRT flash on the new table
  STATE.submissions = []; STATE.roundGrants = []; STATE.disputes = []; STATE.reports = [];
  subscribe();
  await refresh();
}

async function findGame(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'searching for a table…'; }
  try {
    var res = await callFn('findgame', { discord_id: STATE.user.id, username: STATE.user.username });
    if (res && res.session_id) await switchSession(res.instance_id, res.session_id);
  } catch (e) {
    console.error('findGame:', e);
    if (btn) { btn.disabled = false; btn.textContent = '🌐 FIND A PUBLIC GAME'; }
  }
}

async function leavePublic() {
  try { await callFn('leavegame', { discord_id: STATE.user.id }); } catch (e) {}
  STATE.instanceId = STATE.homeInstanceId;            // point callFn at home
  var res = await callFn('join', { discord_id: STATE.user.id, username: STATE.user.username });
  await switchSession(STATE.homeInstanceId, res && res.session_id);
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
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_badge_votes', filter: 'session_id=eq.' + STATE.sessionId }, function () { refresh(); });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_badge_stats', filter: 'discord_id=eq.' + STATE.user.id }, function () { refresh(); });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_award_grants', filter: 'session_id=eq.' + STATE.sessionId }, function () { refresh(); });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_disputes', filter: 'session_id=eq.' + STATE.sessionId }, function () { refresh(); });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_dispute_votes' }, function () { refresh(); });
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_reports', filter: 'session_id=eq.' + STATE.sessionId }, function () { refresh(); });
  // global: profile/rank/prestige changes
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'prompt_profiles' }, function () { refresh(); });
  ch.subscribe();
  STATE.channel = ch;
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
    var bvs = await sb.from('prompt_badge_votes').select('voter,submission_id,badge').eq('session_id', STATE.sessionId).eq('round', round);
    STATE.badgeVotes = bvs.data || [];
    // v2.2 — titles/streaks for session players + all-time leaderboard
    var ids = STATE.players.map(function (x) { return x.id; });
    STATE.profilesById = {};
    if (ids.length) {
      var pr = await sb.from('prompt_profiles').select('*').in('discord_id', ids);
      (pr.data || []).forEach(function (pf) { STATE.profilesById[pf.discord_id] = pf; });
    }
    STATE.myProfile = STATE.profilesById[STATE.user.id] || null;
    // Tier 1 — my badge tallies become my identity; wear the highest as my calltag
    var bsr = await sb.from('prompt_badge_stats').select('badge,recv,give').eq('discord_id', STATE.user.id);
    STATE.badgeStats = bsr.data || [];
    STATE.myIdentity = computeIdentity(STATE.badgeStats);
    if (STATE.myIdentity.calltag && STATE.myProfile && STATE.myProfile.calltag !== STATE.myIdentity.calltag) {
      sb.rpc('prompt_set_calltag', { p_discord: STATE.user.id, p_calltag: STATE.myIdentity.calltag });
    }
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
    var av = await sb.from('prompt_tag_votes').select('voter,slot').eq('session_id', STATE.sessionId).eq('round', round).eq('slot', 'crown');
    STATE.crownVoters = {}; (av.data || []).forEach(function (v) { STATE.crownVoters[v.voter] = true; });
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
  scheduleAutoAdvance();
  startTick();
}

function renderLobby() {
  if (STATE.session.is_public) return renderPublicWaiting();
  var roster = STATE.players.map(function (p) { return '<div class="chip">▸ ' + escapeHtml(p.username) + '</div>'; }).join('') + '<div class="chip botchip">🤖 PROMPT_AI</div>';
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
    '<div class="prompt-line"><span class="arrow">&gt;</span> NO FRIENDS ONLINE?</div>' +
    '<div class="row-actions"><button id="findgame-btn" class="ghost">🌐 FIND A PUBLIC GAME</button></div>' +
    dossierHtml() +
    leaderboardHtml();
  el('cat-select').addEventListener('change', function (e) { STATE.category = e.target.value; });
  el('start-btn').addEventListener('click', function () {
    var rounds = parseInt(el('rounds-select').value) || 5;
    callFn('start', { category: STATE.category, rounds: rounds });
  });
  el('findgame-btn').addEventListener('click', function () { findGame(el('findgame-btn')); });
  if (el('title-sel')) {
    el('title-sel').addEventListener('change', function (e) {
      STATE.supabase.rpc('prompt_set_title', { p_discord: STATE.user.id, p_title_key: e.target.value }).then(function () { refresh(); });
    });
  }
  wireLeaderboardTabs();
}

// Public matchmaking waiting room — strangers gather here; auto-starts at 3.
function renderPublicWaiting() {
  var n = STATE.players.length;
  var roster = STATE.players.map(function (p) {
    var me = p.id === STATE.user.id ? ' (you)' : '';
    return '<div class="chip">▸ ' + escapeHtml(p.username) + me + '</div>';
  }).join('') + '<div class="chip botchip">🤖 PROMPT_AI</div>';
  el('game').innerHTML =
    '<div class="panel"><div class="label">&gt;&gt; PUBLIC TABLE — matchmaking</div>' +
    '<div class="roster">' + (roster || '<span class="muted">you\'re first in...</span>') + '</div></div>' +
    '<div class="prompt-line"><span class="arrow">&gt;</span> WAITING FOR PLAYERS — ' + n + '/3 to start <span class="muted">(seats up to 8)</span></div>' +
    '<div class="muted">the table auto-starts the moment a third stranger sits down.</div>' +
    '<div class="row-actions"><button id="leave-btn" class="ghost">◂ leave table</button></div>' +
    leaderboardHtml();
  el('leave-btn').addEventListener('click', function () {
    var b = el('leave-btn'); b.disabled = true; b.textContent = 'leaving…';
    leavePublic();
  });
  wireLeaderboardTabs();
}

// ── Living-terminal pieces — the table explains its own state ───────────────
function pad2(n) { return (n < 10 ? '0' : '') + n; }
function deckLabel() {
  var c = CATEGORIES.find(function (x) { return x.key === STATE.session.category; });
  return (c ? c.label : (STATE.session.category || 'Mixed')).toUpperCase();
}
// the ROUND / DECK / recovered-response header used by responding + voting
function termHeadHtml(label, typed) {
  var body = typed
    ? '<div class="transmission" id="transmission"></div>'
    : '<div class="transmission-small">"' + escapeHtml(STATE.session.current_response || '') + '"</div>';
  return '<div class="panel term-head">' +
    '<div class="term-top">ROUND ' + pad2(STATE.session.round) + ' &nbsp;·&nbsp; DECK: ' + escapeHtml(deckLabel()) + '</div>' +
    '<div class="label">' + label + '</div>' + body + '</div>';
}
// per-player status so nobody asks "are we waiting on someone?"
function playersPanelHtml(mode) {
  var rows = STATE.players.map(function (p) {
    var me = p.id === STATE.user.id;
    var statusCell;
    if (mode === 'voting') {
      var locked = (p.locked_round === STATE.session.round);
      statusCell = locked ? '<span class="pstatus on">[LOCKED IN]</span>'
                          : '<span class="pstatus wait">DECIDING…</span>';
    } else {
      var done = STATE.submissions.some(function (s) { return (s.discord_id === p.id || s.discord_id === p.discord_id) && !s.hidden; });
      statusCell = done ? '<span class="pstatus on">[SUBMITTED]</span>'
                        : '<span class="pstatus wait">RECONSTRUCTING <span class="scramble">…</span></span>';
    }
    return '<div class="prow"><span class="pname">&#9658; ' + escapeHtml(p.username) +
      (me ? ' <span class="me">(you)</span>' : '') + '</span>' + statusCell + '</div>';
  }).join('');
  // PROMPT_AI is always at the table (joins its guess at vote time) — show it so it never feels absent
  var botRow = '<div class="prow"><span class="pname">&#129302; PROMPT_AI <span class="bot-tag">BOT</span></span>' +
    (mode === 'voting'
      ? '<span class="pstatus on">[IN THE MIX]</span>'
      : '<span class="pstatus wait">RECONSTRUCTING <span class="scramble">…</span></span>') + '</div>';
  return '<div class="panel players-panel"><div class="label">PLAYERS</div>' + rows + botRow + '</div>';
}
function timerBarHtml() {
  if (!STATE.session || !STATE.session.deadline) return '';
  return '<div class="timer"><div class="timer-track"><div class="timer-fill" id="timer-fill"></div></div>' +
    '<span class="timer-secs" id="timer-secs">—</span></div>';
}
// one interval drives the countdown bar AND the scramble "decoding" flicker
function tickAll() {
  var s = STATE.session;
  var secsEl = el('timer-secs');
  if (secsEl && s && s.deadline) {
    var rem = Math.max(0, Math.ceil((new Date(s.deadline).getTime() - Date.now()) / 1000));
    secsEl.textContent = rem + 's';
    var total = s.phase === 'voting' ? 75 : (s.phase === 'resolving' ? 12 : 75);
    var fill = el('timer-fill');
    if (fill) { fill.style.width = Math.max(0, Math.min(100, (rem / total) * 100)) + '%'; fill.className = 'timer-fill' + (rem <= 8 ? ' low' : ''); }
  }
  var sc = document.querySelectorAll('.scramble');
  if (sc.length) {
    var g = SCRAMBLE_WORDS[Math.floor(Math.random() * SCRAMBLE_WORDS.length)];
    var cut = g.slice(0, 4 + Math.floor(Math.random() * Math.max(1, g.length - 4)));
    Array.prototype.forEach.call(sc, function (n) { n.textContent = cut; });
  }
}
function startTick() {
  if (STATE.tick) { clearInterval(STATE.tick); STATE.tick = null; }
  if (!el('timer-secs') && !document.querySelector('.scramble')) return;
  tickAll();
  STATE.tick = setInterval(tickAll, 140);
}

function renderResponding() {
  var did = mine(STATE.submissions, 'discord_id');
  var doneCount = STATE.submissions.length;
  var total = STATE.players.length;

  var input = did
    ? '<div class="muted">✅ prompt locked in — waiting (' + doneCount + '/' + total + ')</div>'
    : '<div class="input-row"><input id="guess" type="text" maxlength="160" placeholder="what you&#39;d ask him…" autocomplete="off" />' +
      '<button id="submit-btn">SEND IT</button></div><div class="submit-note" id="submit-note"></div>';

  el('game').innerHTML =
    termHeadHtml('&gt;&gt; THE AI SAID', true) +
    '<div class="prompt-line"><span class="arrow">&gt;</span> HERE — JUST TYPE WHAT MAKES HIM SAY THAT:</div>' +
    input +
    playersPanelHtml('responding') +
    timerBarHtml() +
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

// ── v17 board voting — drop one badge per prompt (drag desktop / tap mobile) ──
function placeBadge(subId, badgeKey) {
  callFn('badgevote', { voter_discord_id: STATE.user.id, submission_id: subId, badge: badgeKey || '' })
    .catch(function (e) { console.error('badgevote:', e); });
}
function wireBoard() {
  Array.prototype.forEach.call(document.querySelectorAll('.badge-btn'), function (b) {
    b.addEventListener('click', function () {
      var k = b.getAttribute('data-badge');
      STATE.armedBadge = (STATE.armedBadge === k) ? null : k;
      Array.prototype.forEach.call(document.querySelectorAll('.badge-btn'), function (x) {
        x.classList.toggle('armed', x.getAttribute('data-badge') === STATE.armedBadge);
      });
      var instr = el('board-instr');
      if (instr) instr.innerHTML = STATE.armedBadge
        ? 'now tap a prompt to drop ' + badgeEmoji(STATE.armedBadge) + ' on it'
        : 'pick up a badge, drop it on a prompt (drag, or tap then tap)';
    });
    b.addEventListener('dragstart', function (e) { try { e.dataTransfer.setData('text/badge', b.getAttribute('data-badge')); } catch (x) {} });
  });
  Array.prototype.forEach.call(document.querySelectorAll('.vcard[data-sub]'), function (card) {
    var subId = card.getAttribute('data-sub');
    card.addEventListener('click', function () {
      if (!STATE.armedBadge) return;
      var cur = card.getAttribute('data-mybadge') || '';
      placeBadge(subId, cur === STATE.armedBadge ? '' : STATE.armedBadge);
    });
    card.addEventListener('dragover', function (e) { e.preventDefault(); card.classList.add('drop-hover'); });
    card.addEventListener('dragleave', function () { card.classList.remove('drop-hover'); });
    card.addEventListener('drop', function (e) {
      e.preventDefault(); card.classList.remove('drop-hover');
      var k = ''; try { k = e.dataTransfer.getData('text/badge'); } catch (x) {}
      if (k) placeBadge(subId, k);
    });
  });
}

function renderVoting() {
  var subs = STATE.submissions.slice().filter(function (s) { return !s.hidden; });
  var myBadge = {};
  STATE.badgeVotes.forEach(function (v) { if (v.voter === STATE.user.id) myBadge[v.submission_id] = v.badge; });
  var iLocked = STATE.players.some(function (p) { return p.id === STATE.user.id && p.locked_round === STATE.session.round; });
  var placed = Object.keys(myBadge).length;
  var LET = 'ABCDEFGH';

  var palette = BADGES.map(function (b) {
    var armed = STATE.armedBadge === b.key ? ' armed' : '';
    return '<button class="badge-btn' + armed + '" data-badge="' + b.key + '" draggable="true" title="' + escapeHtml(b.label) + '">' + b.e + '</button>';
  }).join('');

  var cards = subs.map(function (s, i) {
    var isMine = s.discord_id === STATE.user.id;
    var isBot = s.discord_id === BOT_ID;
    // authorship stays hidden during voting — the bot must be able to fool the room
    var tag = 'PROMPT ' + LET[i] + (isMine ? ' · yours' : '');
    if (isMine) {
      return '<div class="vcard mine"><div class="vcard-tag">' + tag + '</div>' +
        '<div class="vcard-text">&gt; ' + escapeHtml(s.text) + '</div></div>';
    }
    var iReported = STATE.reports.some(function (r) { return r.submission_id === s.id && r.reporter === STATE.user.id; });
    var rep = iReported ? '<span class="reported" title="flagged">🚩</span>'
      : '<button class="report-btn" data-sub="' + s.id + '" title="report hate / slurs">🚩</button>';
    var mb = myBadge[s.id];
    var slot = mb ? '<span class="placed">' + badgeEmoji(mb) + '</span>' : '<span class="slot-empty">+</span>';
    return '<div class="vcard' + (iLocked ? ' locked' : '') + (mb ? ' has-badge' : '') + '" data-sub="' + s.id + '" data-mybadge="' + (mb || '') + '">' +
      '<div class="vcard-tag">' + tag + '<span class="vcard-rep">' + rep + '</span></div>' +
      '<div class="vcard-text">&gt; ' + escapeHtml(s.text) + '</div>' +
      '<div class="vcard-slot">' + slot + '</div></div>';
  }).join('');

  el('game').innerHTML =
    termHeadHtml('&gt;&gt; THE AI ANSWERED — badge every prompt that made noise', false) +
    '<div class="prompt-line"><span class="arrow">&gt;</span> <span id="board-instr">' +
      (iLocked ? 'LOCKED IN — waiting on the table…' : 'pick up a badge, drop it on a prompt (drag, or tap then tap)') + '</span></div>' +
    '<div class="board' + (iLocked ? ' board-locked' : '') + '">' +
      '<div class="palette">' + palette + '</div>' +
      '<div class="board-cards">' + cards + '</div>' +
    '</div>' +
    '<div class="muted board-tally">' + placed + ' placed · one badge per prompt</div>' +
    '<div class="row-actions"><button id="lock-btn" class="primary"' + (iLocked ? ' disabled' : '') + '>' + (iLocked ? '✅ LOCKED IN' : '🔒 LOCK IN') + '</button> ' +
    '<button id="skip-btn" class="ghost">force results ▸</button></div>' +
    playersPanelHtml('voting') +
    timerBarHtml();

  if (!iLocked) {
    wireBoard();
    Array.prototype.forEach.call(document.querySelectorAll('.report-btn'), function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        b.disabled = true; b.textContent = '🚩…';
        callFn('report', { reporter: STATE.user.id, submission_id: b.getAttribute('data-sub') });
      });
    });
    var lb = el('lock-btn');
    if (lb) lb.addEventListener('click', function () { lb.disabled = true; lb.textContent = '✅ LOCKED IN'; callFn('lockvote', { voter_discord_id: STATE.user.id }); });
  }
  el('skip-btn').addEventListener('click', function () { callFn('skip', {}); });
}

function renderResolving() {
  var r = STATE.session.round;
  // staged reveal once per round: badge counts → authors + badges
  if (STATE.revealRound !== r) {
    STATE.revealRound = r; STATE.revealStage = 0;
    if (STATE.revealT1) clearTimeout(STATE.revealT1);
    if (STATE.revealT2) clearTimeout(STATE.revealT2);
    STATE.revealT1 = setTimeout(function () { if (STATE.revealStage < 1) STATE.revealStage = 1; if (STATE.session && STATE.session.phase === 'resolving') render(); }, 2200);
  }
  var stage = STATE.revealStage || 0;

  function badgesOf(sub) { return STATE.badgeVotes.filter(function (v) { return v.submission_id === sub.id; }); }
  function countOf(sub) { return badgesOf(sub).length; }
  var LET = 'ABCDEFGH';
  var subs = STATE.submissions.slice().filter(function (s) { return !s.hidden; });
  var sorted = subs.slice().sort(function (a, b) { return countOf(b) - countOf(a); });
  var top = sorted.length ? countOf(sorted[0]) : 0;
  var botWon = sorted.length > 0 && sorted[0].discord_id === BOT_ID && top > 0;

  var head =
    '<div class="panel"><div class="label">&gt;&gt; Round ' + r + ' — Results</div>' +
    '<div class="transmission-small">"' + escapeHtml(STATE.session.current_response) + '"</div></div>';

  var bodyHtml;
  if (stage === 0) {
    // STAGE 1: badge counts only, authors hidden
    bodyHtml = '<div class="panel"><div class="label">TALLYING THE BADGES…</div>' +
      sorted.map(function (s, i) {
        var c = countOf(s);
        return '<div class="result-row"><span class="who">PROMPT ' + LET[i] + '</span> <span class="muted">…… ' + c + (c === 1 ? ' badge' : ' badges') + '</span></div>';
      }).join('') + '</div>' +
      '<div class="muted">…revealing who…</div>';
  } else {
    // STAGE 2: authors + the badges each prompt collected
    var rowsHtml = sorted.map(function (s, i) {
      var isBot = s.discord_id === BOT_ID;
      var c = countOf(s);
      var win = (c === top && top > 0) ? ' win' : '';
      var chips = badgesOf(s).map(function (v) { return '<span class="bchip">' + badgeEmoji(v.badge) + '</span>'; }).join('');
      var who = '<span class="reveal-let">' + LET[i] + '</span> ' + escapeHtml(s.username) + (isBot ? ' <span class="bot-tag">🤖 BOT</span>' : '');
      return '<div class="result-row' + win + (isBot ? ' botrow' : '') + '"><span class="who">' + who + '</span> ' +
        (win ? '🏆 ' : '') + '<span class="muted">(' + c + ')</span>' +
        '<div class="sub-text">&gt; ' + escapeHtml(s.text) + '</div>' +
        (chips ? '<div class="bchips">' + chips + '</div>' : '<div class="muted">— no badges —</div>') + '</div>';
    }).join('');
    var roast = botWon ? '<div class="panel roast"><div class="label">🤖 PROMPT_AI TOPPED THE BOARD</div><div class="sub-text">the machine pulled the most badges this round. humbling.</div></div>' : '';
    bodyHtml = roast + '<div class="results">' + rowsHtml + '</div>';
  }

  el('game').innerHTML =
    head + bodyHtml + timerBarHtml() +
    (stage >= 1 ? '<div class="row-actions"><button id="next-btn">NEXT ROUND ▸</button></div>' : '');

  var nb = el('next-btn'); if (nb) nb.addEventListener('click', function () { callFn('next', {}); });
  // (auto-advance is handled globally by scheduleAutoAdvance() in render())
}

// ── AFK auto-advance — keep a table moving even if someone goes silent ───────
// Every timed phase carries a server deadline. When it passes, ONE client fires
// the advance. We stagger by roster position so if the first player's tab is
// gone, the next picks it up ~1.5s later — no single AFK player can stall it.
function scheduleAutoAdvance() {
  if (STATE.advanceTimer) { clearTimeout(STATE.advanceTimer); STATE.advanceTimer = null; }
  var s = STATE.session;
  if (!s || !s.deadline) return;
  var phase = s.phase;
  var action = (phase === 'responding' || phase === 'voting') ? 'skip'
    : (phase === 'resolving') ? 'next' : null;
  if (!action) return;
  // don't auto-advance the results while a dispute is still being argued
  if (phase === 'resolving' && STATE.disputes.some(function (d) { return d.status === 'open'; })) return;
  var ids = STATE.players.map(function (p) { return p.id; }).sort();
  var myIdx = ids.indexOf(STATE.user.id); if (myIdx < 0) myIdx = ids.length;
  var fireAt = new Date(s.deadline).getTime() + myIdx * 1500; // staggered single-firer
  var ms = Math.max(1000, fireAt - Date.now());
  STATE.advanceTimer = setTimeout(function () {
    if (STATE.session && STATE.session.phase === phase) callFn(action, {}); // re-check phase before firing
  }, ms);
}

// ── Share card — the recruitment artifact. A green-CRT PNG of the best moment.
function wrapText(ctx, text, x0, y0, maxW, lineH, maxLines) {
  var words = String(text).split(/\s+/), line = '', yy = y0, lines = 0;
  for (var i = 0; i < words.length; i++) {
    var test = line ? line + ' ' + words[i] : words[i];
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x0, yy); line = words[i]; yy += lineH; lines++;
      if (maxLines && lines >= maxLines - 1) { /* let last line run */ }
    } else line = test;
  }
  if (line) { ctx.fillText(line, x0, yy); yy += lineH; }
  return yy;
}
// draws the card and returns the canvas element
function buildShareCard() {
  var W = 1080, H = 1080, GREEN = '#33ff66', DIM = '#1f9c43';
  var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  var x = cv.getContext('2d');
  var byKey = STATE.awardsByKey;
  function scoreOf(s) { return STATE.roundGrants.filter(function (g) { return g.recipient === s.discord_id; }).reduce(function (a, g) { return a + ((byKey[g.award_key] || {}).value || 0); }, 0); }
  var champ = STATE.players.slice().sort(function (a, b) { return b.score - a.score; })[0];
  var best = STATE.submissions.slice().filter(function (s) { return !s.hidden; }).sort(function (a, b) { return scoreOf(b) - scoreOf(a); })[0];
  var answer = STATE.session.current_response || '';

  x.fillStyle = '#050805'; x.fillRect(0, 0, W, H);
  x.globalAlpha = 0.05; x.fillStyle = GREEN;
  for (var sy = 0; sy < H; sy += 4) x.fillRect(0, sy, W, 1);
  x.globalAlpha = 1;
  x.strokeStyle = DIM; x.lineWidth = 4; x.strokeRect(26, 26, W - 52, H - 52);

  x.fillStyle = GREEN; x.font = "52px 'VT323', monospace";
  x.fillText('PROMPT', 64, 122);
  x.strokeStyle = GREEN; x.lineWidth = 3; x.strokeRect(W - 152, 70, 86, 64);
  x.font = "44px 'VT323', monospace"; x.fillText('ZG', W - 136, 118);
  x.strokeStyle = DIM; x.lineWidth = 2; x.beginPath(); x.moveTo(64, 156); x.lineTo(W - 64, 156); x.stroke();

  var y = 240;
  x.fillStyle = DIM; x.font = "30px 'Share Tech Mono', monospace"; x.fillText('THE AI SAID:', 64, y); y += 64;
  x.fillStyle = GREEN; x.font = "54px 'VT323', monospace";
  y = wrapText(x, '“' + answer + '”', 64, y, W - 128, 60) + 40;

  if (best) {
    x.fillStyle = DIM; x.font = "30px 'Share Tech Mono', monospace";
    x.fillText('RECONSTRUCTED BY ' + String(best.username || '').toUpperCase() + ':', 64, y); y += 54;
    x.fillStyle = GREEN; x.font = "36px 'Share Tech Mono', monospace";
    y = wrapText(x, '> ' + best.text, 64, y, W - 128, 48);
  }

  if (champ) { x.fillStyle = GREEN; x.font = "46px 'VT323', monospace"; x.fillText('🏆 CHAMPION: ' + champ.username, 64, H - 150); }
  x.strokeStyle = DIM; x.lineWidth = 2; x.beginPath(); x.moveTo(64, H - 112); x.lineTo(W - 64, H - 112); x.stroke();
  x.fillStyle = GREEN; x.font = "40px 'VT323', monospace"; x.fillText('PLAY IT → prompt.f-keys.com', 64, H - 62);
  x.fillStyle = DIM; x.font = "26px 'Share Tech Mono', monospace"; x.textAlign = 'right'; x.fillText('F-KEYS', W - 64, H - 62); x.textAlign = 'left';
  return cv;
}
async function makeShareCard() {
  var btn = el('sharecard-btn'); if (!btn) return;
  btn.disabled = true; btn.textContent = 'rendering…';
  try {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
    var cv = buildShareCard();
    var holder = el('share-holder'); holder.innerHTML = '';
    cv.className = 'share-canvas'; holder.appendChild(cv);
    var row = document.createElement('div'); row.className = 'row-actions';
    var dl = document.createElement('a'); dl.href = cv.toDataURL('image/png'); dl.download = 'prompt-card.png'; dl.className = 'share-dl'; dl.textContent = '⬇ SAVE IMAGE';
    row.appendChild(dl);
    if (navigator.clipboard && window.ClipboardItem && cv.toBlob) {
      var cp = document.createElement('button'); cp.className = 'ghost'; cp.textContent = '📋 COPY';
      cp.addEventListener('click', function () { cv.toBlob(function (b) { try { navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]).then(function () { cp.textContent = '✓ COPIED'; }, function () { cp.textContent = 'copy blocked'; }); } catch (e) { cp.textContent = 'copy blocked'; } }); });
      row.appendChild(cp);
    }
    holder.appendChild(row);
    var hint = document.createElement('div'); hint.className = 'muted'; hint.textContent = 'screenshot or save it — then drop it in a Discord that needs a game.';
    holder.appendChild(hint);
  } catch (e) { console.error('share card:', e); }
  btn.disabled = false; btn.textContent = '📸 SHARE CARD';
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
    '<div class="row-actions"><button id="again-btn">▸ PLAY AGAIN</button>' +
    '<button id="findgame-btn" class="ghost">🌐 FIND ANOTHER GAME</button>' +
    '<button id="sharecard-btn" class="ghost">📸 SHARE CARD</button></div>' +
    dossierHtml() +
    '<div class="share-holder" id="share-holder"></div>';

  el('again-btn').addEventListener('click', function () { callFn('reset', {}); });
  el('findgame-btn').addEventListener('click', function () { findGame(el('findgame-btn')); });
  el('sharecard-btn').addEventListener('click', makeShareCard);
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
    var fooled = STATE.myProfile.bot_crowns || 0;
    var foolStr = fooled > 0 ? ' · <span class="fooled">🤖 fooled ' + fooled + '×</span>' : '';
    mine = '<div class="my-rank">RANK: <b>' + escapeHtml(STATE.myProfile.rank || 'UNRANKED') + '</b>' + tag +
      ' · ' + (STATE.myProfile.prestige || 0) + ' prestige' + foolStr + '</div>';
  }
  el('scoreboard').innerHTML = (board ? '<div class="label">SCOREBOARD</div>' + board : '') + mine;
}

// Leaderboard — two views: GLOBAL (all-time) and THIS ROOM (who you're with now).
// The all-time board is the reason to return; the room board is bragging rights live.
function leaderboardHtml() {
  var tab = STATE.lbTab || 'global';
  var rows;
  if (tab === 'friends') {
    rows = STATE.players.map(function (p) {
      var prof = STATE.profilesById[p.id] || {};
      return { username: p.username, prestige: prof.prestige || 0, calltag: prof.calltag };
    }).sort(function (a, b) { return (b.prestige || 0) - (a.prestige || 0); });
  } else {
    rows = (STATE.leaderboard || []).slice();
  }
  var body = rows.map(function (p, i) {
    var medal = ['🥇', '🥈', '🥉'][i] || (i + 1) + '.';
    var isBot = p.username === 'PROMPT_AI';
    var sig = p.calltag ? ' <span class="title-tag">' + escapeHtml(p.calltag) + '</span>' : '';
    return '<div class="lb-row' + (isBot ? ' botrow' : '') + '">' + medal + ' ' + (isBot ? '🤖 ' : '') +
      '<span class="who">' + escapeHtml(p.username) + '</span>' + sig + ' · ' + (p.prestige || 0) + 'p</div>';
  }).join('') || '<div class="muted">no rankings yet — play a game</div>';
  var tabs = '<div class="lb-tabs">' +
    '<button class="lb-tab' + (tab === 'global' ? ' on' : '') + '" data-tab="global">🌐 GLOBAL</button>' +
    '<button class="lb-tab' + (tab === 'friends' ? ' on' : '') + '" data-tab="friends">👥 THIS ROOM</button>' +
    '</div>';
  var heading = tab === 'friends' ? 'This Room — by prestige' : 'Hall of Fame — all-time prestige';
  return '<div class="panel"><div class="label">🏆 ' + heading + '</div>' + tabs +
    '<div class="leaderboard">' + body + '</div></div>';
}

// wire the GLOBAL/THIS-ROOM toggle (called after any render that shows the board)
function wireLeaderboardTabs() {
  Array.prototype.forEach.call(document.querySelectorAll('.lb-tab'), function (b) {
    b.addEventListener('click', function () { STATE.lbTab = b.getAttribute('data-tab'); render(); });
  });
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
