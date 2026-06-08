// ============================================================
// PROMPT (Reverse Mode) — Discord Activity entry (M1)
// CRT terminal shell + Embedded App SDK ready() handshake
// Zengine™ | www.zengine.site
// ============================================================
//
// WORKFLOW STACK:
// 1. import bundled fonts + styles (so Discord's CSP can't block CDN assets)
// 2. boot()        — CRT power-on sequence, types boot lines, then first round
// 3. initDiscord() — if inside Discord, new DiscordSDK().ready() handshake (M1: no OAuth yet)
// 4. revealRound() — typewriter-prints the recovered AI transmission
// 5. submitGuess() — logs the player's reconstructed prompt to the feed
// 6. nextRound()   — advances through the demo deck
//
// ASSET MANIFEST:
// - @fontsource/vt323, @fontsource/share-tech-mono (bundled CRT fonts)
// - ./style.css
// - @discord/embedded-app-sdk (DiscordSDK)
// - VITE_DISCORD_CLIENT_ID (env) — your Application ID
//
// BOOT ORDER:
// - DOMContentLoaded -> wire buttons -> initDiscord() (async) -> boot() -> revealRound()
//
// MILESTONE: M1 = loads + ready() handshake. M2 adds OAuth (needs a backend for the
// token exchange — see README). M3 adds shared multiplayer state.
// ============================================================

import '@fontsource/vt323';
import '@fontsource/share-tech-mono';
import './style.css';
import { DiscordSDK } from '@discord/embedded-app-sdk';

// ── STATE — all mutable shell state lives here ─────────────────────────────
var STATE = {
  // Demo deck — the real build pulls these from the bot / responses.js / Supabase
  responses: [
    'This query just created its own HR file.',
    'The error appears to be user-shaped.',
    'I strongly recommend not saying that under oath.',
    'Future you is already drafting the apology post.',
    'My safety protocols are screaming in binary.',
    'You have located an uncomfortable truth.'
  ],
  bootLines: [
    'ZENGINE TERMINAL v2.1 — phosphor display online',
    'loading deck ............ OK (112 transmissions)',
    'establishing reverse-prompt link ............ OK',
    ''
  ],
  current: 0,
  typing: false,
  handle: 'YOU',
  sdk: null
};

// typeText — typewriter-print `text` into element `el`, then call `done`
// READS: STATE.typing  WRITES: STATE.typing, el.textContent
function typeText(el, text, speed, done) {
  try {
    STATE.typing = true;
    el.textContent = '';
    var i = 0;
    var timer = setInterval(function () {
      el.textContent = text.slice(0, i);
      i++;
      if (i > text.length) {
        clearInterval(timer);
        STATE.typing = false;
        appendCursor(el);
        if (typeof done === 'function') done();
      }
    }, speed);
  } catch (err) {
    console.error('typeText:', err);
    el.textContent = text;
    STATE.typing = false;
  }
}

// appendCursor — add a blinking block cursor to the end of an element
function appendCursor(el) {
  var c = document.createElement('span');
  c.className = 'cursor';
  el.appendChild(c);
}

// boot — CRT power-on sequence, then reveal the first round
// WRITES: #boot
function boot() {
  try {
    var bootEl = document.getElementById('boot');
    typeText(bootEl, STATE.bootLines.join('\n'), 18, function () {
      revealRound();
    });
  } catch (err) {
    console.error('boot:', err);
  }
}

// revealRound — typewriter the current recovered transmission
// READS: STATE.responses, STATE.current  WRITES: #transmission
function revealRound() {
  try {
    var el = document.getElementById('transmission');
    typeText(el, '"' + STATE.responses[STATE.current] + '"', 22);
  } catch (err) {
    console.error('revealRound:', err);
  }
}

// submitGuess — log the player's reconstructed prompt to the feed
// READS: #guess, STATE.handle  WRITES: #feed
function submitGuess() {
  try {
    var input = document.getElementById('guess');
    var val = (input.value || '').trim();
    if (!val) return;
    var feed = document.getElementById('feed');
    var entry = document.createElement('div');
    entry.className = 'entry';
    entry.innerHTML = '<span class="who">[' + escapeHtml(STATE.handle) + ']</span> &gt; ' + escapeHtml(val);
    feed.prepend(entry);
    input.value = '';
    input.focus();
  } catch (err) {
    console.error('submitGuess:', err);
  }
}

// nextRound — advance to the next transmission in the demo deck
// WRITES: STATE.current
function nextRound() {
  if (STATE.typing) return;
  STATE.current = (STATE.current + 1) % STATE.responses.length;
  revealRound();
}

// escapeHtml — prevent injection from free-text input (security)
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

// initDiscord — M1 handshake. If running inside Discord, open the SDK and call ready().
// OAuth (usernames/participants) is M2 and needs a backend — see README.
// WRITES: STATE.sdk, #link-status
async function initDiscord() {
  var statusEl = document.getElementById('link-status');
  try {
    var inDiscord = new URLSearchParams(window.location.search).has('frame_id');
    if (!inDiscord) {
      if (statusEl) statusEl.textContent = 'players: DEMO MODE — open inside Discord to link';
      return;
    }
    var clientId = import.meta.env.VITE_DISCORD_CLIENT_ID;
    if (!clientId) {
      if (statusEl) statusEl.textContent = 'players: ERROR — VITE_DISCORD_CLIENT_ID not set';
      return;
    }
    var sdk = new DiscordSDK(clientId);
    await sdk.ready();
    STATE.sdk = sdk;
    if (statusEl) statusEl.textContent = 'players: LINK ESTABLISHED — handshake OK';
    // M2 → const { code } = await sdk.commands.authorize({ ... });  then POST to backend for token
  } catch (err) {
    console.error('initDiscord:', err);
    if (statusEl) statusEl.textContent = 'players: LINK FAILED — see console';
  }
}

// ── BOOT ORDER ─────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  document.getElementById('submitBtn').addEventListener('click', submitGuess);
  document.getElementById('nextBtn').addEventListener('click', nextRound);
  document.getElementById('guess').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') submitGuess();
  });
  initDiscord();
  boot();
});
