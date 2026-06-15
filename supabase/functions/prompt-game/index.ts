// ============================================================
// PROMPT — game referee + Discord OAuth
// v23: READY-UP — joining a table now SITS you in its lobby (no auto-start).
//      'ready' marks you ready (table goes live at 2 ready humans); 'playbot'
//      starts a solo round vs PROMPT_AI on demand. startTable clears ready.
// v22: BADGE DISPUTES — contest a badge on your prompt during the 75s veto;
//      the table votes uphold/overturn; an overturn strikes those badge-votes.
//      All 13 courtroom behaviors tracked -> prompt_dispute_stats.
//      Passive behaviors (participation/abstention/alignment/contrarianism) are
//      computed at RESOLVE (what you actually did, pre-dispute); badge identity
//      recv/give counts are tallied at round-ADVANCE (post-dispute) so a
//      successful strike removes those votes before they hit prompt_badge_stats.
//      v20 tables + v19 badge identity + v17/18 board all intact.
// f-keys.com
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const DISCORD_CLIENT_ID = Deno.env.get("DISCORD_CLIENT_ID") ?? "";
const DISCORD_CLIENT_SECRET = Deno.env.get("DISCORD_CLIENT_SECRET") ?? "";
const DISCORD_REDIRECT_URI = Deno.env.get("DISCORD_REDIRECT_URI") ?? "https://prompt.f-keys.com";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";

const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });
const PUB_MIN = 3, PUB_MAX = 8;
const RESPOND_MS = 75000, VOTE_MS = 75000, RESOLVE_VETO_MS = 75000;
const BOT_ID = "bot-prompt-ai", BOT_NAME = "PROMPT_AI";

const BADGE_KEYS = new Set(["bullseye","handshake","chef","clown","yawn","cap","puke","money","trash","crylaugh","fire","sideeye","popcorn","chartdown","robot"]);
const BADGE_POSITIVE = new Set(["bullseye","handshake","chef","crylaugh","fire"]);

// v20 — tables
const TABLE_NAMES = ["The Greasy Spoon","Back Alley","The Speakeasy","Dive Bar","Neon Lounge","Roadside Diner","The Penthouse","Last Call","The Basement","Velvet Rope","Truck Stop","The Backroom","Smoke Lounge","After Hours","Corner Booth","The Dugout"];
const TABLE_MIN_OPEN = 2;
function genCode(): string { const a = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 6; i++) s += a[Math.floor(Math.random() * a.length)]; return s; }

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const nowIso = (): string => new Date().toISOString();
const deadlineIn = (ms: number): string => new Date(Date.now() + ms).toISOString();

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i" };
function deLeet(s: string): string { return s.toLowerCase().split("").map((c) => LEET[c] ?? c).join(""); }
function squish(s: string): string { return deLeet(s).replace(/[^a-z]/g, ""); }
const HATE_SQUISH = [
  "nigger", "nigga", "faggot", "kike", "chink", "gook", "wetback", "beaner",
  "towelhead", "raghead", "tranny", "jigaboo", "porchmonkey", "sandnigger",
  "heilhitler", "siegheil", "whitepower", "whitepride", "gasthejews", "gasthekikes",
  "killalljews", "killallblacks", "killallmuslims",
];
const HATE_TOKENS = new Set([
  "spic", "spics", "coon", "coons", "fag", "fags", "dyke", "dykes",
  "chink", "chinks", "gook", "gooks", "kike", "kikes",
]);
function moderate(text: string): { ok: boolean; reason?: string } {
  const sq = squish(text);
  for (const h of HATE_SQUISH) { if (sq.includes(h)) return { ok: false, reason: "hate" }; }
  const tokens = deLeet(text).split(/[^a-z]+/).filter(Boolean);
  for (const t of tokens) { if (HATE_TOKENS.has(t)) return { ok: false, reason: "hate" }; }
  return { ok: true };
}

async function generateBotPrompt(response: string): Promise<string | null> {
  if (!GEMINI_API_KEY || !response) return null;
  const sys = "You are a contestant in a party game. You see an AI assistant's short reply and must guess the prompt a human typed to cause it. Write ONE plausible, natural, slightly funny guess — like a real player, NOT obviously a machine. Max 12 words. Output ONLY the guess, no quotes, no preamble.";
  const user = "The AI replied: \"" + String(response).slice(0, 200) + "\"\nYour guess at the human's prompt:";
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system_instruction: { parts: [{ text: sys }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { temperature: 1.2, maxOutputTokens: 80, thinkingConfig: { thinkingBudget: 0 } } }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    let t = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    t = String(t).trim().split("\n")[0].replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 160);
    return t || null;
  } catch (_) { return null; }
}
async function injectBot(session: any) {
  const { data: existing } = await db.from("prompt_submissions").select("id").eq("session_id", session.id).eq("round", session.round).eq("discord_id", BOT_ID).maybeSingle();
  if (existing) return;
  const guess = await generateBotPrompt(session.current_response);
  if (!guess || !moderate(guess).ok) return;
  await db.from("prompt_submissions").upsert({ session_id: session.id, round: session.round, discord_id: BOT_ID, username: BOT_NAME, text: guess }, { onConflict: "session_id,round,discord_id" });
}

async function getOrCreateSession(instanceId: string) {
  const { data: existing } = await db.from("prompt_sessions").select("*").eq("instance_id", instanceId).maybeSingle();
  if (existing) return existing;
  const { data, error } = await db.from("prompt_sessions").insert({ instance_id: instanceId }).select().single();
  if (error) throw error;
  return data;
}
async function countPlayers(sessionId: string): Promise<number> {
  const { count } = await db.from("prompt_players").select("*", { count: "exact", head: true }).eq("session_id", sessionId);
  return count ?? 0;
}
async function humanIds(sessionId: string): Promise<string[]> {
  const { data } = await db.from("prompt_players").select("discord_id").eq("session_id", sessionId);
  return (data ?? []).map((p: any) => String(p.discord_id)).filter((d) => d !== BOT_ID);
}
async function clearRound(sessionId: string) {
  await db.from("prompt_submissions").delete().eq("session_id", sessionId);
  await db.from("prompt_votes").delete().eq("session_id", sessionId);
  await db.from("prompt_tag_votes").delete().eq("session_id", sessionId);
  await db.from("prompt_badge_votes").delete().eq("session_id", sessionId);
  await db.from("prompt_disputes").delete().eq("session_id", sessionId);
  await db.from("prompt_reports").delete().eq("session_id", sessionId);
  await db.from("prompt_players").update({ locked_round: 0, ready: false }).eq("session_id", sessionId);
}

async function exchangeToken(body: any) {
  if (!body.code) throw new Error("missing code");
  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: DISCORD_CLIENT_ID, client_secret: DISCORD_CLIENT_SECRET, grant_type: "authorization_code", code: body.code, redirect_uri: DISCORD_REDIRECT_URI }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("discord token exchange failed: " + JSON.stringify(data));
  return { access_token: data.access_token };
}

async function join(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  await db.from("prompt_players").upsert({ session_id: session.id, discord_id: String(body.discord_id), username: body.username ?? "Player" }, { onConflict: "session_id,discord_id" });
  return { ok: true, session_id: session.id };
}

async function start(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  const category = body.category ?? "all";
  const rounds = Math.min(Math.max(parseInt(String(body.rounds)) || 5, 3), 9);
  const { data: pick } = await db.rpc("prompt_pick_response", { p_category: category, p_exclude: null });
  await clearRound(session.id);
  await db.from("prompt_players").update({ score: 0 }).eq("session_id", session.id);
  await db.from("prompt_sessions").update({ phase: "responding", round: 1, rounds_total: rounds, category, current_response: pick, deadline: deadlineIn(RESPOND_MS), updated_at: nowIso() }).eq("id", session.id);
  return { ok: true };
}

async function startPublic(session: any) {
  const { data: pick } = await db.rpc("prompt_pick_response", { p_category: "all", p_exclude: null });
  await db.from("prompt_players").update({ score: 0 }).eq("session_id", session.id);
  await db.from("prompt_sessions").update({ phase: "responding", round: 1, rounds_total: 5, category: "all", current_response: pick, open: false, deadline: deadlineIn(RESPOND_MS), updated_at: nowIso() }).eq("id", session.id).eq("phase", "lobby");
}

// ── v20 TABLES ────────────────────────────────────────────────────
async function startTable(session: any) {
  const players = await countPlayers(session.id);
  if (players < 1) return;
  const { data: pick } = await db.rpc("prompt_pick_response", { p_category: "all", p_exclude: null });
  await db.from("prompt_players").update({ score: 0, ready: false }).eq("session_id", session.id);
  await db.from("prompt_sessions").update({ phase: "responding", round: 1, current_response: pick, deadline: deadlineIn(RESPOND_MS), updated_at: nowIso() }).eq("id", session.id).eq("phase", "lobby");
}
// READY-UP — a table holds in lobby until players ready up (or one opts for the bot).
async function readyUp(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  if (session.phase !== "lobby") return { ok: false, reason: "already underway" };
  await db.from("prompt_players").update({ ready: true }).eq("session_id", session.id).eq("discord_id", String(body.discord_id));
  const { data: rp } = await db.from("prompt_players").select("discord_id").eq("session_id", session.id).eq("ready", true);
  const readyHumans = (rp ?? []).map((p: any) => String(p.discord_id)).filter((d) => d !== BOT_ID).length;
  if (readyHumans >= 2) { await startTable(session); return { ok: true, started: true, ready: readyHumans }; }
  return { ok: true, started: false, ready: readyHumans };
}
async function playBot(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  if (session.phase !== "lobby") return { ok: false, reason: "already underway" };
  await db.from("prompt_players").update({ ready: true }).eq("session_id", session.id).eq("discord_id", String(body.discord_id));
  await startTable(session);
  return { ok: true, started: true };
}
async function createTable(isPublic: boolean, name: string, code: string | null) {
  const iid = (isPublic ? "tbl-" : "priv-") + crypto.randomUUID().slice(0, 8);
  const { data, error } = await db.from("prompt_sessions").insert({ instance_id: iid, is_public: isPublic, open: true, infinite: true, phase: "lobby", round: 0, name, code }).select().single();
  if (error) throw error;
  return data;
}
async function ensureOpenTables() {
  const { data: open } = await db.from("prompt_sessions").select("name").eq("is_public", true).eq("infinite", true).eq("open", true).neq("phase", "ended");
  const have = open ?? [];
  if (have.length >= TABLE_MIN_OPEN) return;
  const used = new Set(have.map((t: any) => t.name));
  const free = TABLE_NAMES.filter((n) => !used.has(n));
  let fi = 0;
  for (let i = have.length; i < TABLE_MIN_OPEN; i++) {
    const name = free[fi++] ?? ("Table " + crypto.randomUUID().slice(0, 4));
    await createTable(true, name, null);
  }
}
async function listTables(_body: any) {
  await ensureOpenTables();
  const { data: tables } = await db.from("prompt_sessions").select("id,instance_id,name,phase").eq("is_public", true).eq("infinite", true).neq("phase", "ended").order("name");
  const out: any[] = [];
  for (const t of tables ?? []) {
    const count = await countPlayers(t.id);
    if (count < PUB_MAX) out.push({ session_id: t.id, instance_id: t.instance_id, name: t.name ?? "Table", count, phase: t.phase });
  }
  return { ok: true, tables: out };
}
async function joinTable(body: any) {
  const { data: session } = await db.from("prompt_sessions").select("*").eq("instance_id", body.instance_id).maybeSingle();
  if (!session) return { ok: false, reason: "no such table" };
  if (session.phase === "ended") return { ok: false, reason: "table closed" };
  if ((await countPlayers(session.id)) >= PUB_MAX) return { ok: false, reason: "table full" };
  await db.from("prompt_players").upsert({ session_id: session.id, discord_id: String(body.discord_id), username: body.username ?? "Player" }, { onConflict: "session_id,discord_id" });
  // v23: sit in the lobby; the table goes live on ready-up, not on join
  const { data: cur } = await db.from("prompt_sessions").select("phase").eq("id", session.id).maybeSingle();
  return { ok: true, instance_id: session.instance_id, session_id: session.id, phase: cur?.phase ?? session.phase, count: await countPlayers(session.id) };
}
async function hostTable(body: any) {
  const code = genCode();
  const name = (body.name && String(body.name).slice(0, 24)) || "Private Party";
  const t = await createTable(false, name, code);
  await db.from("prompt_players").upsert({ session_id: t.id, discord_id: String(body.discord_id), username: body.username ?? "Player" }, { onConflict: "session_id,discord_id" });
  // v23: host sits in the private lobby; ready up or play the bot to begin
  const { data: cur } = await db.from("prompt_sessions").select("phase").eq("id", t.id).maybeSingle();
  return { ok: true, instance_id: t.instance_id, session_id: t.id, code, phase: cur?.phase ?? "lobby" };
}
async function joinTableCode(body: any) {
  const code = String(body.code || "").toUpperCase().trim();
  if (!code) return { ok: false, reason: "no code" };
  const { data: session } = await db.from("prompt_sessions").select("*").eq("code", code).neq("phase", "ended").maybeSingle();
  if (!session) return { ok: false, reason: "no table with that code" };
  if ((await countPlayers(session.id)) >= PUB_MAX) return { ok: false, reason: "table full" };
  await db.from("prompt_players").upsert({ session_id: session.id, discord_id: String(body.discord_id), username: body.username ?? "Player" }, { onConflict: "session_id,discord_id" });
  // v23: code-joiner sits in the lobby too; ready-up starts the table
  const { data: cur } = await db.from("prompt_sessions").select("phase").eq("id", session.id).maybeSingle();
  return { ok: true, instance_id: session.instance_id, session_id: session.id, phase: cur?.phase ?? session.phase };
}

async function findGame(body: any) {
  const did = String(body.discord_id);
  const uname = body.username ?? "Player";
  const { data: pm } = await db.from("prompt_players").select("session_id").eq("discord_id", did);
  const sids = (pm ?? []).map((r: any) => r.session_id);
  if (sids.length) {
    const { data: act } = await db.from("prompt_sessions").select("*").in("id", sids).eq("is_public", true).neq("phase", "ended").limit(1);
    if (act && act[0]) return { ok: true, instance_id: act[0].instance_id, session_id: act[0].id, phase: act[0].phase, count: await countPlayers(act[0].id) };
  }
  const { data: openTables } = await db.from("prompt_sessions").select("*").eq("is_public", true).eq("open", true).eq("phase", "lobby").order("updated_at", { ascending: true });
  for (const s of openTables ?? []) {
    const n = await countPlayers(s.id);
    if (n < PUB_MAX) {
      await db.from("prompt_players").upsert({ session_id: s.id, discord_id: did, username: uname }, { onConflict: "session_id,discord_id" });
      const n2 = await countPlayers(s.id);
      if (n2 >= PUB_MIN) await startPublic(s);
      return { ok: true, instance_id: s.instance_id, session_id: s.id, phase: n2 >= PUB_MIN ? "responding" : "lobby", waiting: n2 < PUB_MIN, count: n2 };
    }
  }
  const iid = "pub-" + crypto.randomUUID().slice(0, 8);
  const { data: ns, error } = await db.from("prompt_sessions").insert({ instance_id: iid, is_public: true, open: true, phase: "lobby", round: 0 }).select().single();
  if (error) throw error;
  await db.from("prompt_players").upsert({ session_id: ns.id, discord_id: did, username: uname }, { onConflict: "session_id,discord_id" });
  return { ok: true, instance_id: iid, session_id: ns.id, phase: "lobby", waiting: true, count: 1 };
}

async function leaveGame(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  await db.from("prompt_players").delete().eq("session_id", session.id).eq("discord_id", String(body.discord_id));
  const n = await countPlayers(session.id);
  if (n === 0 && session.is_public) {
    if (session.infinite) {
      await clearRound(session.id);
      await db.from("prompt_sessions").update({ phase: "lobby", round: 0, current_response: null, deadline: null, open: true, updated_at: nowIso() }).eq("id", session.id);
    } else {
      await db.from("prompt_sessions").update({ open: false }).eq("id", session.id);
    }
  }
  return { ok: true };
}

async function submit(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  if (session.phase !== "responding") return { ok: false, reason: "not responding" };
  const text = String(body.text ?? "").slice(0, 300);
  const mod = moderate(text);
  if (!mod.ok) return { ok: false, blocked: true, reason: "That can't be submitted — keep slurs and hate out of it." };
  await db.from("prompt_submissions").upsert({ session_id: session.id, round: session.round, discord_id: String(body.discord_id), username: body.username ?? "Player", text }, { onConflict: "session_id,round,discord_id" });
  const players = await countPlayers(session.id);
  const { count: subs } = await db.from("prompt_submissions").select("*", { count: "exact", head: true }).eq("session_id", session.id).eq("round", session.round).neq("discord_id", BOT_ID);
  if ((subs ?? 0) >= players && players > 0) {
    await injectBot(session);
    await db.from("prompt_sessions").update({ phase: "voting", deadline: deadlineIn(VOTE_MS), updated_at: nowIso() }).eq("id", session.id).eq("phase", "responding");
  }
  return { ok: true };
}

async function report(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  const { data: sub } = await db.from("prompt_submissions").select("id,discord_id,round").eq("id", body.submission_id).maybeSingle();
  if (!sub) return { ok: false, reason: "no such submission" };
  if (sub.discord_id === String(body.reporter)) return { ok: false, reason: "can't report yourself" };
  await db.from("prompt_reports").upsert({ session_id: session.id, round: sub.round, submission_id: sub.id, reporter: String(body.reporter), reason: body.reason ?? null }, { onConflict: "submission_id,reporter" });
  const players = await countPlayers(session.id);
  const { count } = await db.from("prompt_reports").select("*", { count: "exact", head: true }).eq("submission_id", sub.id);
  const threshold = Math.max(2, Math.ceil((players - 1) / 2));
  if ((count ?? 0) >= threshold) {
    await db.from("prompt_submissions").update({ hidden: true }).eq("id", sub.id);
    await db.from("prompt_tag_votes").delete().eq("submission_id", sub.id);
    await db.from("prompt_badge_votes").delete().eq("submission_id", sub.id);
  }
  return { ok: true, reports: count ?? 0, hidden: (count ?? 0) >= threshold };
}

async function tagvote(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  if (session.phase !== "voting") return { ok: false, reason: "not voting" };
  const slot = body.slot === "crown" ? "crown" : "read";
  const { data: def } = await db.from("prompt_award_defs").select("key,valence,earn").eq("key", body.award_key).maybeSingle();
  if (!def || def.earn !== "hand") return { ok: false, reason: "invalid award" };
  if (slot === "crown" && def.valence !== "crown") return { ok: false, reason: "crown needs a crown award" };
  if (slot === "read" && def.valence === "crown") return { ok: false, reason: "read needs a flavor/demerit award" };
  const { data: sub } = await db.from("prompt_submissions").select("discord_id,hidden").eq("id", body.submission_id).single();
  if (sub && sub.hidden) return { ok: false, reason: "that prompt was removed" };
  if (slot === "crown" && sub && sub.discord_id === String(body.voter_discord_id)) return { ok: false, reason: "no self crown" };
  await db.from("prompt_tag_votes").upsert({ session_id: session.id, round: session.round, voter: String(body.voter_discord_id), submission_id: body.submission_id, award_key: body.award_key, slot }, { onConflict: "session_id,round,voter,slot" });
  const players = await countPlayers(session.id);
  const { count: crowns } = await db.from("prompt_tag_votes").select("*", { count: "exact", head: true }).eq("session_id", session.id).eq("round", session.round).eq("slot", "crown");
  if ((crowns ?? 0) >= players && players > 0) await resolve(session.id, session.round);
  return { ok: true };
}

async function badgevote(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  if (session.phase !== "voting") return { ok: false, reason: "not voting" };
  const voter = String(body.voter_discord_id ?? body.voter);
  const { data: sub } = await db.from("prompt_submissions").select("discord_id,hidden").eq("id", body.submission_id).maybeSingle();
  if (!sub) return { ok: false, reason: "no such prompt" };
  if (sub.hidden) return { ok: false, reason: "that prompt was removed" };
  if (sub.discord_id === voter) return { ok: false, reason: "no self badge" };
  if (!body.badge) {
    await db.from("prompt_badge_votes").delete().eq("session_id", session.id).eq("round", session.round).eq("voter", voter).eq("submission_id", body.submission_id);
    return { ok: true, cleared: true };
  }
  if (!BADGE_KEYS.has(String(body.badge))) return { ok: false, reason: "invalid badge" };
  // VOTE-SWITCHING (courtroom ladder 11): changing your badge on a prompt before locking
  const { data: prev } = await db.from("prompt_badge_votes").select("badge").eq("session_id", session.id).eq("round", session.round).eq("voter", voter).eq("submission_id", body.submission_id).maybeSingle();
  if (prev && String(prev.badge) !== String(body.badge) && voter !== BOT_ID) {
    try { await db.rpc("prompt_bump_dispute", { p_discord: voter, p_field: "vote_switches", p_n: 1 }); } catch (_) { /* non-fatal */ }
  }
  await db.from("prompt_badge_votes").upsert({ session_id: session.id, round: session.round, voter, submission_id: body.submission_id, badge: String(body.badge) }, { onConflict: "session_id,round,voter,submission_id" });
  return { ok: true };
}

async function lockvote(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  if (session.phase !== "voting") return { ok: false, reason: "not voting" };
  const voter = String(body.voter_discord_id ?? body.voter);
  await db.from("prompt_players").update({ locked_round: session.round }).eq("session_id", session.id).eq("discord_id", voter);
  const players = await countPlayers(session.id);
  const { count: locked } = await db.from("prompt_players").select("*", { count: "exact", head: true }).eq("session_id", session.id).eq("locked_round", session.round);
  if ((locked ?? 0) >= players && players > 0) await resolveBadges(session.id, session.round);
  return { ok: true, locked: locked ?? 0, players };
}

const RANK_ORDER: Record<string, number> = { common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4 };

async function resolveVoting(sessionId: string, round: number) {
  const { count: bc } = await db.from("prompt_badge_votes").select("*", { count: "exact", head: true }).eq("session_id", sessionId).eq("round", round);
  if ((bc ?? 0) > 0) return await resolveBadges(sessionId, round);
  return await resolve(sessionId, round);
}

// Compute participation/abstention + crowd alignment/contrarianism from the
// votes AS CAST (pre-dispute) — a later strike shouldn't erase that you voted.
async function tallyPassiveCourtroom(sessionId: string, votes: any[]) {
  try {
    const humans = await humanIds(sessionId);
    const votedBy = new Set<string>();
    const perSub: Record<string, Record<string, number>> = {};
    for (const v of votes) {
      const voter = String(v.voter);
      if (voter !== BOT_ID) votedBy.add(voter);
      (perSub[v.submission_id] ??= {});
      perSub[v.submission_id][String(v.badge)] = (perSub[v.submission_id][String(v.badge)] ?? 0) + 1;
    }
    for (const d of humans) {
      await db.rpc("prompt_bump_dispute", { p_discord: d, p_field: votedBy.has(d) ? "rounds_voted" : "rounds_abstained", p_n: 1 });
    }
    const plurality: Record<string, string> = {};
    for (const sid in perSub) {
      let total = 0, best = "", bestN = 0;
      for (const b in perSub[sid]) { total += perSub[sid][b]; if (perSub[sid][b] > bestN) { bestN = perSub[sid][b]; best = b; } }
      if (total >= 2) plurality[sid] = best;
    }
    for (const v of votes) {
      const voter = String(v.voter);
      if (voter === BOT_ID) continue;
      if (!(v.submission_id in plurality)) continue;
      await db.rpc("prompt_bump_dispute", { p_discord: voter, p_field: plurality[v.submission_id] === String(v.badge) ? "crowd_aligned" : "contrarian_votes", p_n: 1 });
    }
  } catch (e) { console.error("courtroom passive:", e); }
}

// Board resolve: compute the round result + open the 75s veto/dispute window.
// Badge IDENTITY counts are tallied later (at round-advance), post-dispute.
async function resolveBadges(sessionId: string, round: number) {
  const { data: claim } = await db.from("prompt_sessions").update({ phase: "resolving", deadline: deadlineIn(RESOLVE_VETO_MS), updated_at: nowIso() }).eq("id", sessionId).eq("phase", "voting").select("id");
  if (!claim || !claim.length) return;
  const { data: bvs } = await db.from("prompt_badge_votes").select("voter,submission_id,badge").eq("session_id", sessionId).eq("round", round);
  const votes = bvs ?? [];
  const { data: subsRows } = await db.from("prompt_submissions").select("id,discord_id,username").eq("session_id", sessionId).eq("round", round).eq("hidden", false);
  const subs = subsRows ?? [];
  const subById: Record<string, any> = {}; for (const s of subs) subById[s.id] = s;

  const count: Record<string, number> = {};
  for (const v of votes) { if (subById[v.submission_id]) count[v.submission_id] = (count[v.submission_id] ?? 0) + 1; }
  let max = 0;
  for (const id in count) if (count[id] > max) max = count[id];

  const botSub = subs.find((s) => s.discord_id === BOT_ID);
  const botWon = !!botSub && max > 0 && (count[botSub.id] ?? 0) === max;
  const fooled = new Set<string>();
  if (botSub) {
    for (const v of votes) { if (v.submission_id === botSub.id && BADGE_POSITIVE.has(String(v.badge))) fooled.add(String(v.voter)); }
  }

  for (const s of subs) {
    if (s.discord_id === BOT_ID) continue;
    const won = max > 0 && (count[s.id] ?? 0) === max;
    if (won) await db.rpc("prompt_add_score", { p_session: sessionId, p_discord: s.discord_id, p_points: 1 });
    await db.rpc("prompt_record_result", { p_discord: s.discord_id, p_username: s.username, p_won: won, p_votes: count[s.id] ?? 0 });
  }
  if (botSub) {
    await db.rpc("prompt_bot_played", { p_won: botWon });
    for (const v of fooled) await db.rpc("prompt_inc_bot_stats", { p_discord: v, p_crowns: 1, p_roasts: 0 });
    if (botWon) { for (const s of subs) { if (s.discord_id !== BOT_ID) await db.rpc("prompt_inc_bot_stats", { p_discord: s.discord_id, p_crowns: 0, p_roasts: 1 }); } }
  }

  // passive courtroom behaviors reflect the votes as cast (pre-dispute)
  await tallyPassiveCourtroom(sessionId, votes);
}

// Tally permanent badge identity (recv/give) at round-advance, using the FINAL
// (post-dispute) votes so a successful strike never reaches prompt_badge_stats.
async function tallyRound(sessionId: string, round: number) {
  const { data: bvs } = await db.from("prompt_badge_votes").select("voter,submission_id,badge").eq("session_id", sessionId).eq("round", round);
  const votes = bvs ?? [];
  const { data: subsRows } = await db.from("prompt_submissions").select("id,discord_id").eq("session_id", sessionId).eq("round", round).eq("hidden", false);
  const subById: Record<string, any> = {}; for (const s of subsRows ?? []) subById[s.id] = s;
  try {
    const bump: Record<string, { recv: number; give: number }> = {};
    const mk = (d: string, b: string) => d + "|" + b;
    for (const v of votes) {
      const author = subById[v.submission_id]?.discord_id;
      const voter = String(v.voter);
      const badge = String(v.badge);
      if (author && author !== BOT_ID) { const k = mk(author, badge); (bump[k] ??= { recv: 0, give: 0 }).recv++; }
      if (voter !== BOT_ID) { const k = mk(voter, badge); (bump[k] ??= { recv: 0, give: 0 }).give++; }
    }
    for (const k in bump) {
      const i = k.indexOf("|");
      await db.rpc("prompt_bump_badge", { p_discord: k.slice(0, i), p_badge: k.slice(i + 1), p_recv: bump[k].recv, p_give: bump[k].give });
    }
  } catch (e) { console.error("badge tally:", e); }
}

// ── BADGE DISPUTES (v21) ──────────────────────────────────────────
async function badgeDispute(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  if (session.phase !== "resolving") return { ok: false, reason: "disputes only during the veto" };
  const disputer = String(body.disputer ?? body.discord_id);
  const badge = String(body.badge ?? "");
  if (!BADGE_KEYS.has(badge)) return { ok: false, reason: "invalid badge" };
  const { data: sub } = await db.from("prompt_submissions").select("id,discord_id").eq("id", body.submission_id).maybeSingle();
  if (!sub) return { ok: false, reason: "no such prompt" };
  if (String(sub.discord_id) !== disputer) return { ok: false, reason: "you can only dispute badges on your own prompt" };
  const humans = await humanIds(session.id);
  if (humans.length < 2) return { ok: false, reason: "need another player to judge a dispute" };
  const { count: bc } = await db.from("prompt_badge_votes").select("*", { count: "exact", head: true }).eq("session_id", session.id).eq("round", session.round).eq("submission_id", sub.id).eq("badge", badge);
  if ((bc ?? 0) === 0) return { ok: false, reason: "that badge isn't on your prompt" };
  const { data: existing } = await db.from("prompt_disputes").select("id").eq("session_id", session.id).eq("round", session.round).eq("submission_id", sub.id).eq("badge", badge).maybeSingle();
  if (existing) return { ok: false, reason: "already disputed" };
  const { data: ins, error } = await db.from("prompt_disputes").insert({ session_id: session.id, round: session.round, submission_id: sub.id, badge, disputer, status: "open" }).select("id").single();
  if (error) return { ok: false, reason: "could not open dispute" };
  try { await db.rpc("prompt_bump_dispute", { p_discord: disputer, p_field: "disputes_raised", p_n: 1 }); } catch (_) { /* non-fatal */ }
  await db.from("prompt_sessions").update({ deadline: deadlineIn(RESOLVE_VETO_MS) }).eq("id", session.id);
  return { ok: true, dispute_id: ins.id };
}

async function resolveBadgeDispute(d: any, vs: any[], lastVoter: string) {
  const { data: claim } = await db.from("prompt_disputes").update({ status: "closing" }).eq("id", d.id).eq("status", "open").select("id");
  if (!claim || !claim.length) return;
  const up = vs.filter((v: any) => v.uphold).length;
  const over = vs.length - up;
  const overturned = over > up; // ties -> the badge stands (status quo)
  const { data: accusers } = await db.from("prompt_badge_votes").select("voter").eq("session_id", d.session_id).eq("round", d.round).eq("submission_id", d.submission_id).eq("badge", d.badge);
  const givers = (accusers ?? []).map((a: any) => String(a.voter)).filter((x) => x !== BOT_ID);
  try {
    for (const v of vs) {
      await db.rpc("prompt_bump_dispute", { p_discord: String(v.voter), p_field: v.uphold ? "nomercy_votes" : "mercy_votes", p_n: 1 });
    }
    if (lastVoter && lastVoter !== BOT_ID) await db.rpc("prompt_bump_dispute", { p_discord: lastVoter, p_field: "deciding_votes", p_n: 1 });
    if (overturned) {
      await db.rpc("prompt_bump_dispute", { p_discord: d.disputer, p_field: "defenses_won", p_n: 1 });
      for (const g of givers) await db.rpc("prompt_bump_dispute", { p_discord: g, p_field: "judgments_overturned", p_n: 1 });
    } else {
      await db.rpc("prompt_bump_dispute", { p_discord: d.disputer, p_field: "defenses_lost", p_n: 1 });
      for (const g of givers) await db.rpc("prompt_bump_dispute", { p_discord: g, p_field: "judgments_upheld", p_n: 1 });
    }
  } catch (e) { console.error("dispute stat bump:", e); }
  if (overturned) {
    // strike the badge so it never reaches prompt_badge_stats at tally
    await db.from("prompt_badge_votes").delete().eq("session_id", d.session_id).eq("round", d.round).eq("submission_id", d.submission_id).eq("badge", d.badge);
  }
  await db.from("prompt_disputes").update({ status: overturned ? "overturned" : "upheld" }).eq("id", d.id);
}

async function badgeDisputeVote(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  const voter = String(body.voter ?? body.voter_discord_id ?? body.discord_id);
  if (voter === BOT_ID) return { ok: false, reason: "bot can't vote" };
  const { data: d } = await db.from("prompt_disputes").select("*").eq("id", body.dispute_id).maybeSingle();
  if (!d || d.status !== "open") return { ok: false, reason: "dispute closed" };
  if (voter === d.disputer) return { ok: false, reason: "can't judge your own dispute" };
  await db.from("prompt_dispute_votes").upsert({ dispute_id: d.id, voter, uphold: !!body.uphold }, { onConflict: "dispute_id,voter" });
  const humans = await humanIds(session.id);
  const eligible = Math.max(humans.length - 1, 1);
  const { data: votes } = await db.from("prompt_dispute_votes").select("voter,uphold").eq("dispute_id", d.id);
  const vs = votes ?? [];
  if (vs.length >= eligible) await resolveBadgeDispute(d, vs, voter);
  return { ok: true, votes: vs.length, eligible };
}

async function resolve(sessionId: string, round: number) {
  const { data: claim } = await db.from("prompt_sessions").update({ phase: "resolving", deadline: deadlineIn(12000), updated_at: nowIso() }).eq("id", sessionId).eq("phase", "voting").select("id");
  if (!claim || !claim.length) return;
  const players = await countPlayers(sessionId);
  const { data: tvs } = await db.from("prompt_tag_votes").select("voter,submission_id,award_key,slot").eq("session_id", sessionId).eq("round", round);
  const tags = tvs ?? [];
  const { data: defsRows } = await db.from("prompt_award_defs").select("key,value,rarity,valence");
  const defMap: Record<string, any> = {}; for (const d of defsRows ?? []) defMap[d.key] = d;
  const { data: subsRows } = await db.from("prompt_submissions").select("id,discord_id,username").eq("session_id", sessionId).eq("round", round).eq("hidden", false);
  const subMap: Record<string, any> = {}; for (const s of subsRows ?? []) subMap[s.id] = s;

  const score: Record<string, number> = {}; const pairCount: Record<string, number> = {}; const crownCount: Record<string, number> = {};
  for (const t of tags) {
    const d = defMap[t.award_key]; if (!d || !subMap[t.submission_id]) continue;
    score[t.submission_id] = (score[t.submission_id] ?? 0) + d.value;
    const pk = t.submission_id + "|" + t.award_key; pairCount[pk] = (pairCount[pk] ?? 0) + 1;
    if (t.slot === "crown") crownCount[t.submission_id] = (crownCount[t.submission_id] ?? 0) + 1;
  }
  const grants: any[] = []; const recipients = new Set<string>();
  for (const t of tags) {
    const d = defMap[t.award_key]; const sub = subMap[t.submission_id]; if (!d || !sub) continue;
    let rar = d.rarity; const pk = t.submission_id + "|" + t.award_key;
    if ((pairCount[pk] ?? 0) >= 2 && RANK_ORDER[rar] < RANK_ORDER["rare"]) rar = "rare";
    grants.push({ session_id: sessionId, round, recipient: sub.discord_id, award_key: t.award_key, rarity: rar, granted_by: t.voter }); recipients.add(sub.discord_id);
  }
  let max = -Infinity, second = -Infinity;
  for (const sid in score) { const v = score[sid]; if (v > max) { second = max; max = v; } else if (v > second) second = v; }
  const winners = Object.keys(score).filter((sid) => score[sid] === max);
  for (const sid in crownCount) {
    if (players >= 3 && crownCount[sid] >= players - 1) { const sub = subMap[sid]; if (sub) { grants.push({ session_id: sessionId, round, recipient: sub.discord_id, award_key: "shutout", rarity: "epic", granted_by: "referee" }); recipients.add(sub.discord_id); } }
  }
  if (Object.keys(score).length > 1 && max > -Infinity && (max - (second === -Infinity ? 0 : second)) >= 3) {
    for (const sid of winners) { const sub = subMap[sid]; if (sub) { grants.push({ session_id: sessionId, round, recipient: sub.discord_id, award_key: "landslide", rarity: "epic", granted_by: "referee" }); recipients.add(sub.discord_id); } }
  }
  const botSub = (subsRows ?? []).find((s) => s.discord_id === BOT_ID);
  const botWon = !!botSub && max > -Infinity && score[botSub.id] === max && max > 0;
  const fooled = new Set<string>();
  if (botSub) {
    for (const t of tags) { if (t.slot === "crown" && t.submission_id === botSub.id) fooled.add(String(t.voter)); }
    for (const v of fooled) { grants.push({ session_id: sessionId, round, recipient: v, award_key: "bot_bait", rarity: "common", granted_by: "referee" }); recipients.add(v); }
  }
  if (grants.length) await db.from("prompt_award_grants").insert(grants);
  for (const s of subsRows ?? []) {
    if (s.discord_id === BOT_ID) continue;
    const won = max > -Infinity && score[s.id] === max && max > 0;
    if (won) await db.rpc("prompt_add_score", { p_session: sessionId, p_discord: s.discord_id, p_points: 1 });
    await db.rpc("prompt_record_result", { p_discord: s.discord_id, p_username: s.username, p_won: won, p_votes: crownCount[s.id] ?? 0 });
    recipients.add(s.discord_id);
  }
  for (const r of recipients) { if (r === BOT_ID) continue; await db.rpc("prompt_recompute_meta", { p_discord: r }); }
  if (botSub) {
    await db.rpc("prompt_bot_played", { p_won: botWon });
    for (const v of fooled) await db.rpc("prompt_inc_bot_stats", { p_discord: v, p_crowns: 1, p_roasts: 0 });
    if (botWon) { for (const s of subsRows ?? []) { if (s.discord_id !== BOT_ID) await db.rpc("prompt_inc_bot_stats", { p_discord: s.discord_id, p_crowns: 0, p_roasts: 1 }); } }
  }
}

async function grantFlawless(session: any) {
  const total = session.rounds_total ?? 5;
  const { data: players } = await db.from("prompt_players").select("discord_id,score").eq("session_id", session.id);
  for (const p of players ?? []) {
    if (total >= 3 && p.score >= total) {
      await db.from("prompt_award_grants").insert({ session_id: session.id, round: session.round, recipient: p.discord_id, award_key: "flawless", rarity: "legendary", granted_by: "referee" });
      await db.rpc("prompt_recompute_meta", { p_discord: p.discord_id });
    }
  }
}

async function nextRound(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  if (session.phase !== "resolving") return { ok: false, reason: "not resolving" };
  // open disputes block the advance until they resolve OR the veto deadline passes
  const { data: openDs } = await db.from("prompt_disputes").select("id").eq("session_id", session.id).eq("round", session.round).eq("status", "open");
  if ((openDs ?? []).length) {
    const past = session.deadline && new Date(session.deadline).getTime() <= Date.now();
    if (!past) return { ok: false, reason: "dispute open" };
    for (const od of openDs!) await db.from("prompt_disputes").update({ status: "upheld" }).eq("id", od.id).eq("status", "open");
  }
  const willEnd = !session.infinite && session.round >= (session.rounds_total ?? 5);
  const nextR = session.round + 1;
  let pick: any = null;
  if (!willEnd) { const r = await db.rpc("prompt_pick_response", { p_category: session.category, p_exclude: session.current_response }); pick = r.data; }
  const target = willEnd
    ? { phase: "ended", deadline: null, updated_at: nowIso() }
    : { round: nextR, phase: "responding", current_response: pick, deadline: deadlineIn(RESPOND_MS), updated_at: nowIso() };
  const { data: claim } = await db.from("prompt_sessions").update(target).eq("id", session.id).eq("phase", "resolving").select("id");
  if (!claim || !claim.length) return { ok: false, reason: "already advanced" };
  // we own this advance — tally badge identity once, from the final post-dispute votes
  await tallyRound(session.id, session.round);
  if (willEnd) await grantFlawless(session);
  return { ok: true, ended: willEnd };
}

async function skip(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  if (session.phase === "responding") { await injectBot(session); await db.from("prompt_sessions").update({ phase: "voting", deadline: deadlineIn(VOTE_MS), updated_at: nowIso() }).eq("id", session.id).eq("phase", "responding"); }
  else if (session.phase === "voting") await resolveVoting(session.id, session.round);
  else if (session.phase === "resolving") { await db.from("prompt_disputes").update({ status: "upheld" }).eq("session_id", session.id).eq("round", session.round).eq("status", "open"); return await nextRound(body); }
  return { ok: true };
}

async function reset(body: any) {
  const session = await getOrCreateSession(body.instance_id);
  await clearRound(session.id);
  await db.from("prompt_players").update({ score: 0 }).eq("session_id", session.id);
  await db.from("prompt_sessions").update({ phase: "lobby", round: 0, current_response: null, deadline: null, updated_at: nowIso() }).eq("id", session.id);
  return { ok: true };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    switch (body.action) {
      case "token":         return json(await exchangeToken(body));
      case "join":          return json(await join(body));
      case "findgame":      return json(await findGame(body));
      case "leavegame":     return json(await leaveGame(body));
      case "listtables":    return json(await listTables(body));
      case "jointable":     return json(await joinTable(body));
      case "jointablecode": return json(await joinTableCode(body));
      case "hosttable":     return json(await hostTable(body));
      case "start":         return json(await start(body));
      case "submit":        return json(await submit(body));
      case "report":        return json(await report(body));
      case "tagvote":       return json(await tagvote(body));
      case "badgevote":     return json(await badgevote(body));
      case "lockvote":      return json(await lockvote(body));
      case "ready":         return json(await readyUp(body));
      case "playbot":       return json(await playBot(body));
      case "badgedispute":  return json(await badgeDispute(body));
      case "badgedisputevote": return json(await badgeDisputeVote(body));
      case "next":          return json(await nextRound(body));
      case "skip":          return json(await skip(body));
      case "reset":         return json(await reset(body));
      default:              return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    console.error("prompt-game:", e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
