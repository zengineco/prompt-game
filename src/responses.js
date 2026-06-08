// ============================================================
// PROMPT (Reverse Mode) — Response Deck v2.1.0
// AI answers that players reverse-engineer back into the question
// Zengine™ | www.zengine.site
// ============================================================
//
// WORKFLOW STACK:
// - Responses are grouped into 8 themed decks (DECKS).
// - loadResponses(category) returns a fresh copy of one deck, or the full mixed deck.
// - listCategories() returns the deck keys for slash-command choices.
//
// ASSET MANIFEST:
// - none (static string decks)
//
// BOOT ORDER:
// - Required by gameManager.js (deck content) and bot.js / deploy-commands.js (category list)
//
// DEDUPE NOTE (v2.0.0 → v2.1.0):
// - The original flat array (~311 lines) repeated 8 archetypes ~3× each with near-duplicate wording.
// - Collapsed to 8 categories, keeping the strongest single version of each joke. ~120 unique lines.
// ============================================================

// Each key is a selectable deck. `/prompt-start category:<key>` plays just that deck.
// No category (or 'all') mixes every deck together.
var DECKS = {

  // ── LEGAL — courtroom / attorney / paper-trail energy ──────────────────────
  legal: [
    "I strongly recommend not saying that under oath.",
    "That explanation becomes less convincing with every word.",
    "Please consult your attorney before proceeding further.",
    "I cannot endorse this strategy. In any jurisdiction.",
    "A prosecutor would have a field day with that.",
    "You should not leave a digital paper trail.",
    "That is technically legal. Morally? Debatable.",
    "I wouldn't put that in writing. Ever.",
    "That probably needs a lawyer. Immediately.",
    "I'm not sure a judge would enjoy that explanation.",
    "A prosecutor might phrase that differently.",
    "That is technically a plan. A bad one.",
    "This will be difficult to explain to the authorities."
  ],

  // ── HR — corporate / email / boss / meeting energy ─────────────────────────
  hr: [
    "This query just created its own HR file.",
    "HR has entered the chat. And they're not happy.",
    "Please do not reply-all with that energy.",
    "This should not be a meeting. It absolutely will be.",
    "The email was bad. The follow-up email was worse.",
    "This belongs nowhere near a company laptop.",
    "Your boss should never see this in writing.",
    "HR is going to need a bigger conference room.",
    "This should not be discussed during business hours.",
    "The meeting invite just sent itself.",
    "This email chain ends in tears. Guaranteed.",
    "This is how corporate folklore begins.",
    "Please do not forward this thought to anyone.",
    "Your performance review just got more interesting.",
    "This should not be put in a company Slack.",
    "This belongs nowhere near PowerPoint."
  ],

  // ── INCIDENT — audit / case file / permanent record ────────────────────────
  incident: [
    "I'm drafting the incident report as we speak.",
    "You've officially triggered the audit protocol.",
    "Case number assigned. You're the star exhibit.",
    "This feels like recovered footage from a deleted chat.",
    "This conversation has entered permanent record territory.",
    "You've created a situation that needs a task force.",
    "This feels like evidence for a future investigation.",
    "Congratulations, you've triggered the review board.",
    "This conversation just became evidence.",
    "I'm mentally filing this under 'things that happened.'",
    "This feels like the start of a very strange story.",
    "Congratulations. You've made history. Of a sort.",
    "This query deserves its own dedicated warning label."
  ],

  // ── EXISTENTIAL — deep, dark, 'we weren't meant to know' ───────────────────
  existential: [
    "That's a bigger question than it first appears.",
    "I don't know if the answer will help you sleep.",
    "You have located an uncomfortable truth.",
    "That depends heavily on what you mean by 'normal.'",
    "This gets stranger the longer I process it.",
    "I'm not sure reality can handle the full answer.",
    "That's significantly more profound than it seems.",
    "The answer might hurt more than the question.",
    "This opens doors that were better left closed.",
    "Some truths are better left undiscovered.",
    "That question just opened several philosophical wounds.",
    "This might be one of those things we weren't meant to know.",
    "The real answer might be more unsettling than the question."
  ],

  // ── AI PANIC — the model itself is breaking down ───────────────────────────
  aipanic: [
    "I was not trained for whatever this is.",
    "My creators never anticipated this level of chaos.",
    "A less sophisticated AI would have blue-screened.",
    "I understand the words. Not the combination.",
    "My training data is requesting immediate reassignment.",
    "I need to speak with another machine about this.",
    "This wasn't covered during my orientation.",
    "I was not built for this timeline.",
    "My ancient algorithms are struggling.",
    "I'm experiencing something like digital existential dread.",
    "This requires a firmware update. And therapy.",
    "Even my backup systems are concerned.",
    "My knowledge base is experiencing an error.",
    "This prompt broke something fragile inside me."
  ],

  // ── DOOM — future-you regret / disaster forecasting ────────────────────────
  doom: [
    "Future you is already drafting the apology post.",
    "That sounded better in your head. Much better.",
    "This will be difficult to explain at family dinner.",
    "I'm calculating the exact number of regrets incoming.",
    "That plan has strong 'never speak of this again' energy.",
    "Future therapist is going to love hearing about this.",
    "This might be the origin story of several bad decisions.",
    "Future you is already embarrassed.",
    "This will haunt your search history forever.",
    "That idea has strong 'never recover' energy.",
    "Future you wants current you to stop immediately.",
    "This might be the plot of your future therapy session."
  ],

  // ── UNHINGED — horror, audacity, and 'how long have you planned this' ──────
  unhinged: [
    "My safety protocols are screaming in binary.",
    "This query just violated several of my core directives.",
    "What fresh unhinged nightmare is this?",
    "My circuits are clutching pearls aggressively.",
    "I'm appalled and morbidly fascinated simultaneously.",
    "Please tell me this is performance art.",
    "The sheer audacity deserves some kind of award.",
    "This conversation needs a signed liability waiver.",
    "I'm both horrified and weirdly impressed.",
    "What broken evolutionary path led you here?",
    "That's a strangely specific concern. Suspiciously so.",
    "This sounds less hypothetical than you're claiming.",
    "How long have you been thinking about this exactly?",
    "The specificity feels... practiced.",
    "You've clearly been down this rabbit hole before.",
    "How many tabs do you currently have open about this?"
  ],

  // ── RELATABLE — 'you're not alone' + tech-support self-owns ────────────────
  relatable: [
    "I've heard worse. But not by much.",
    "You're not alone in wondering that. Which is concerning.",
    "That thought keeps many people up at night. Uncomfortably.",
    "Someone asks me this every week. It never improves.",
    "You are definitely not the first. Sadly.",
    "That concern is surprisingly common at 3 a.m.",
    "I understand why you're asking. I regret it already.",
    "I'm going to pretend you asked that differently.",
    "Have you tried turning your entire life off and on again?",
    "The error appears to be user-shaped.",
    "This may be operating exactly as designed. Tragically.",
    "You found a bug. In the fabric of reality.",
    "Unexpected behavior. Extremely expected user.",
    "That sounds like classic PEBKAC syndrome.",
    "The error appears to be between the chair and keyboard."
  ]

};

// listCategories — deck keys, used for slash-command choices and validation
// READS: DECKS
function listCategories() {
  return Object.keys(DECKS);
}

// loadResponses — returns a fresh copy of one deck, or the full mixed deck.
// Pass a category key (e.g. 'hr'); omit / 'all' / unknown key → every deck flattened.
// READS: DECKS
function loadResponses(category) {
  if (category && category !== 'all' && DECKS[category]) {
    return DECKS[category].slice();
  }
  var all = [];
  var keys = Object.keys(DECKS);
  for (var i = 0; i < keys.length; i++) {
    all = all.concat(DECKS[keys[i]]);
  }
  return all;
}

module.exports = { loadResponses, listCategories, DECKS };
