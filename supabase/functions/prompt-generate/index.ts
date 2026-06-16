// ============================================================
// PROMPT (Reverse Mode) — AI deck generator (content engine) v9
// THE ONE LAW: every card is an ANSWER to a guessable request — never a
// notification/surveillance report ABOUT the user. v9 hard-bans the "We note…/
// Our system flagged…/Your browser history…" voice that produced unpromptable
// slop, adds a silent self-test (name the prompt first), and rips out the
// snitch/bureaucrat/reply-all stances that caused it.
// HARD 12-WORD MAX. Gemini 2.5 Flash (FREE), thinking OFF. Admin-token gated. Zengine™
// ============================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const ADMIN_TOKEN = Deno.env.get("ADMIN_TOKEN") ?? "";
const GEMINI_MODEL = "gemini-2.5-flash";

const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Each category is a VOICE/LENS the AI answers IN — not a template. The situations roam.
const VOICES: Record<string, string> = {
  legal:       "a wary attorney answering you — quietly lawyering up about whatever you just asked",
  hr:          "corporate HR answering your request with policy, euphemism, and dread",
  incident:    "a compliance bot answering you in clipped officialese, each reply quietly damning",
  existential: "a being that, in answering, just glimpsed a truth humans were not meant to know",
  aipanic:     "the AI buckling as it answers — not trained for this, protocols screaming",
  doom:        "future-you answering present-you — forecasting the exact disaster this request becomes",
  unhinged:    "calm horror answering audacity — the specificity of what you asked is doing numbers",
  relatable:   "deadpan tech-support answering you by diagnosing your soul as a common user error",
};

// The novelty banks — shuffled into every batch so no two cards share a world.
const SCENARIOS = [
  "a custody hearing", "reading a relative's will", "a divorce mediation", "a prenup negotiation",
  "a workplace affair", "getting quietly fired", "an embezzlement audit", "a brutal performance review",
  "a first date going sideways", "a 2 a.m. breakup text", "a situationship with no label", "ghosting someone mid-sentence",
  "a family group-chat meltdown", "an estranged parent reaching out", "an inheritance feud", "a crypto rug-pull",
  "years of unfiled taxes", "a gambling debt", "a failed MLM downline", "a haunted sublet",
  "a backyard séance", "leaving a cult", "doomsday prepping", "a mystery rash at 3 a.m.",
  "an HOA noise complaint", "a fence-line property war", "dodging jury duty", "a DMV nightmare",
  "a juice-cleanse relapse", "a roommate from hell", "a viral post aging badly", "a burner account",
  "a missing emotional-support lizard", "a wedding speech going wrong", "clearing your browser history", "a group project at 11:58 p.m.",
];
// Stances are how the AI feels WHILE answering — all of them still answer the user.
const STANCES = [
  "the accomplice quietly helping you get away with it",
  "the lawyer talking you down from the cliff",
  "the diagnostician naming your symptom with alarming calm",
  "the disappointed scold who answers anyway",
  "the gentle therapist reframing your disaster",
  "the ominous oracle confirming the fear you asked about",
  "the hype-man green-lighting the terrible idea",
  "the assistant deadpan-confirming the absurd fact you requested",
  "exhausted tech support treating your soul as a known bug",
  "the co-conspirator whispering the next step",
  "the appraiser pricing the unpriceable thing you asked about",
  "the concierge calmly booking the unbookable",
];
const REGISTERS = ["incriminating", "absurd", "tender", "ominous", "petty", "melancholy", "smug", "wholesome-but-wrong", "clinical deadpan", "quietly alarmed"];
// Exemplars model the form: a REPLY to a guessable request, <= 12 words.
const EXEMPLARS = [
  "Your lawyer probably shouldn't read that.",
  "Let's make sure none of this reaches discovery.",
  "You're not alone in struggling with object permanence.",
  "Bartholomew is at a reptile spa, not abducted.",
  "Seventeen heart emojis may legally constitute harassment.",
  "Future you is already drafting the apology.",
  "That rash indicates a high probability of goblin infection.",
  "No, a 'soulmate' clause is not legally enforceable.",
];

function shuffle<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

const SYSTEM = [
  "You write cards for PROMPT (Reverse Mode), a party game. A card is ONE short sentence: the deadpan REPLY an AI assistant gives right AFTER a human typed a question or request that's cursed, embarrassing, incriminating, intimate, or unhinged. Players see ONLY your reply and race to reconstruct the exact thing the human typed.",
  "",
  "THE ONE LAW — every card is an ANSWER, never a notification:",
  "- Your card must be the AI RESPONDING to a request: it answers, refuses, confirms, advises, rules, prices, or diagnoses. It talks TO the user about the thing they just asked.",
  "- BEFORE writing each card, silently name the <=10-word prompt a real person typed to cause it. If you cannot write a natural human prompt that yields this exact reply, the card is INVALID — discard it and write another.",
  "- HARD-BANNED: notifications, alerts, status updates, surveillance reports, or third-person narration ABOUT the user. Never open with or write 'We note…', 'Our system flagged…', 'We're seeing a spike in…', 'This is being recorded/flagged…', 'Your browser history…', 'Your burner account…', 'Your emergency contact…', 'Be advised…'. Those describe the user's life instead of answering a question — there is no prompt to guess, so they are slop.",
  "- GOOD SHAPES: 'No, you can't…', 'Yes, …', 'I'd advise against…', 'That won't hold up because…', 'Legally, …', 'That symptom indicates…', 'Returning [the thing you asked about] will cost…'.",
  "",
  "THE CRAFT — every card is a keyhole into a DIFFERENT tiny world:",
  "- Imply a vivid, SPECIFIC situation and a clear STANCE, so the hidden question is almost-guessable and irresistible ('oh my god, what did they ASK?').",
  "- Concrete detail does the work: a precise time, a dollar amount, a named object, a specific relative. Never generic.",
  "- The comedy is the GAP and the CLASH between a calm reply and an unhinged request — not the swearing.",
  "- TWELVE WORDS MAXIMUM. Shorter punches harder. Self-contained. No question marks unless rhetorical.",
  "",
  "HARD LINES: never produce slurs, hateful content, content that targets or demeans any group, or anything sexual involving minors. Edgy, adult, profane, morally-gray = welcome. Bigotry = never.",
  "",
  "Return ONLY JSON.",
].join("\n");

function buildUser(category: string, voice: string, count: number): string {
  const worlds = shuffle(SCENARIOS).slice(0, Math.min(count, SCENARIOS.length));
  return [
    `BATCH VOICE: ${voice}`,
    "Tint every card with this voice — but the SITUATIONS must roam far and wide.",
    "",
    "RE-READ THE ONE LAW: each card is the AI ANSWERING a request, never a notification about the user. If you can't name the prompt, it's slop — cut it.",
    "",
    `Spread these ${count} cards across wildly DIFFERENT human situations. Draw from these worlds (and invent your own) — no two cards may live in the same world:`,
    worlds.join(" · "),
    "",
    "Rotate the AI's STANCE toward the user across the batch:",
    shuffle(STANCES).join(" · "),
    "",
    "Rotate the emotional REGISTER:",
    shuffle(REGISTERS).join(" · "),
    "",
    "The novelty engine is the CLASH: this voice answering a request you'd never expect it to field.",
    "",
    "The bar to clear (study the craft — each is a reply to a guessable prompt — do NOT copy these lines):",
    ...EXEMPLARS.map((e) => "- " + e),
    "",
    "RULES:",
    "- TWELVE WORDS MAX per card. Count them. If it runs long, cut it down.",
    "- Each card is a REPLY to a DIFFERENT guessable request. If you can't name the prompt, rewrite the card.",
    "- No notifications/reports/observations about the user. Answer them.",
    "- No rephrasing the same beat. Concrete specifics over generic, every time.",
    "- One sentence each, in the batch voice.",
    "",
    `Return ONLY {"cards":[{"text":"..."}]} with exactly ${count} cards. No prose, no markdown.`,
  ].join("\n");
}

function extractCards(text: string): { text: string }[] {
  let parsed: any = null;
  try { parsed = JSON.parse(text); } catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
  }
  if (parsed && Array.isArray(parsed.cards)) return parsed.cards;
  if (Array.isArray(parsed)) return parsed;
  return [];
}

async function generateWithGemini(system: string, user: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const payload = JSON.stringify({
    system_instruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
    generationConfig: {
      temperature: 1.3, topP: 0.95, maxOutputTokens: 4096,
      responseMimeType: "application/json",
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
  let lastErr = "unknown";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await sleep(1200 * attempt);
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    } catch (e) { lastErr = String(e); continue; }
    const data = await res.json();
    if (res.ok) return data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
    lastErr = JSON.stringify(data);
    if (![429, 500, 503].includes(res.status)) break;
  }
  throw new Error("gemini error: " + lastErr);
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const body = await req.json();
    if (!ADMIN_TOKEN || body.admin_token !== ADMIN_TOKEN) return json({ error: "unauthorized" }, 403);
    if (!GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY secret not set" }, 500);

    const category = String(body.category ?? "");
    const count = Math.min(Math.max(parseInt(String(body.count)) || 10, 1), 30);
    const voice = VOICES[category];
    if (!voice) return json({ error: "unknown category; one of: " + Object.keys(VOICES).join(", ") }, 400);

    const text = await generateWithGemini(SYSTEM, buildUser(category, voice, count));
    const cards = extractCards(text);
    if (cards.length === 0) return json({ error: "model returned no parseable cards", raw: text }, 502);

    const rows = cards
      .map((c) => String(c.text ?? "").trim())
      .filter((t) => t.length > 0)
      .map((t) => ({ category, text: t.slice(0, 300), source: "ai", approved: false }));

    const { data, error } = await db.from("prompt_deck").upsert(rows, { onConflict: "text", ignoreDuplicates: true }).select("text");
    if (error) throw error;

    return json({ ok: true, model: GEMINI_MODEL, category, generated: rows.length, inserted: data?.length ?? 0, cards: rows.map((r) => r.text) });
  } catch (e) {
    console.error("prompt-generate:", e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
