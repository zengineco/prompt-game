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

// COMBOS — unlock when both badges hit Lv10+ on the axis (recv for these, give for the givers).
// Keys are the two/three badge keys sorted alphabetically + '+'. (Goyim's canon; deltas + reskins applied.)
var RECEIVER_COMBOS = {
  'bullseye+clown': 'Precision Idiot', 'bullseye+yawn': 'Captain Obvious', 'bullseye+trash': 'The Midwit', 'bullseye+chartdown': 'Snatching Defeat',
  'cap+handshake': 'Snake Oil', 'handshake+money': 'The Enabler', 'handshake+trash': 'Groupthink Garbage', 'handshake+robot': 'The NPC Hivemind',
  'chef+clown': 'The Gourmet Clown', 'chef+yawn': 'Over-Engineered Mid', 'cap+chef': 'The Catfish', 'chef+puke': 'The Toxic Asset',
  'chef+money': 'Backstreet Chef', 'chef+trash': 'Gourmet Garbage', 'chef+sideeye': 'The Mad Scientist', 'chef+popcorn': 'The Instigator',
  'chartdown+chef': 'Kitchen Nightmare', 'chef+robot': 'The Microwave Chef',
  'clown+yawn': 'The Mime', 'cap+clown': 'The Clout Chaser', 'clown+puke': 'The Cringe Lord', 'clown+money': 'The Sugar Daddy',
  'clown+trash': 'The Circus Act', 'clown+crylaugh': 'The Laughingstock', 'clown+fire': 'Crash Test Dummy', 'clown+sideeye': 'The Local Eccentric',
  'clown+popcorn': 'Main Character Energy', 'chartdown+clown': 'The Fumbled Bit', 'clown+robot': 'The Botnik',
  'cap+yawn': 'Unimaginative Lie', 'puke+yawn': 'Aggressively Mediocre', 'money+yawn': 'Quiet Luxury', 'trash+yawn': 'Room Temperature Take',
  'crylaugh+yawn': 'The Pity Laugh', 'fire+yawn': 'The Slow Burn', 'sideeye+yawn': 'The Lurker', 'popcorn+yawn': 'The Side Character',
  'chartdown+yawn': 'Dead Cat Bounce', 'robot+yawn': 'Default Settings',
  'cap+puke': 'The Sleazeball', 'cap+money': 'The Crypto Bro', 'cap+trash': 'The Fraud', 'cap+crylaugh': 'Tall Tale',
  'cap+fire': "Fool's Gold", 'cap+sideeye': 'The Suspect', 'cap+popcorn': 'Reality TV Star', 'cap+chartdown': 'Caught In 4K', 'cap+robot': 'The Hallucination',
  'money+puke': 'The Flex Offender', 'puke+trash': 'Barf Bag', 'crylaugh+puke': "So Bad It's Good", 'fire+puke': 'The Spicy Cringe',
  'puke+sideeye': 'The HR Nightmare', 'popcorn+puke': 'The Hate-Watch', 'chartdown+puke': 'The Meltdown', 'puke+robot': 'The Uncanny Valley',
  'money+trash': 'Rich Trash', 'crylaugh+money': 'The High Stakes Bit', 'fire+money': 'The Beautiful Disaster', 'money+sideeye': 'Menace to Society',
  'money+popcorn': 'The Chaos Investor', 'chartdown+money': 'The Bankruptcy', 'money+robot': 'The Paid Actor',
  'crylaugh+trash': 'The High-Tier Shitpost', 'fire+trash': 'Dumpster Fire', 'sideeye+trash': 'The Red Flag', 'popcorn+trash': 'The Trash Collector',
  'chartdown+trash': 'Rock Bottom', 'robot+trash': 'The Slop Engine',
  'crylaugh+fire': 'The Roast Master', 'crylaugh+sideeye': 'The Unhinged Laugh', 'crylaugh+popcorn': 'The Heckler', 'chartdown+crylaugh': 'The Flop Era',
  'crylaugh+robot': 'Comedy Algorithm',
  'fire+sideeye': 'The Threat', 'fire+popcorn': 'The Pyromaniac', 'chartdown+fire': 'The Icarus', 'fire+robot': 'The Deepfake',
  'popcorn+sideeye': 'Disaster Tourist', 'chartdown+sideeye': 'Throwing the Game', 'robot+sideeye': 'The Narc',
  'chartdown+popcorn': 'Box Office Bomb', 'popcorn+robot': 'The Content Farm', 'chartdown+robot': 'System Error'
};
var RECEIVER_TRIPLETS = {
  'cap+chef+robot': 'The Ghost Kitchen', 'bullseye+chartdown+puke': 'The Whistleblower', 'clown+handshake+trash': 'The Circus Committee',
  'chef+money+sideeye': 'Street Pharmacist', 'cap+clown+popcorn': 'The Clout Parasite', 'puke+robot+yawn': 'Corporate Slop',
  'cap+chartdown+money': 'The Fyre Festival', 'crylaugh+puke+trash': 'The Toxic Shitpost', 'money+popcorn+sideeye': 'The Hedge Fund Manager',
  'fire+robot+trash': 'Automated Dumpster Fire', 'crylaugh+fire+sideeye': 'Cruel Intentions', 'bullseye+robot+yawn': 'The NPC Protocol'
};
var GIVER_COMBOS = {
  'bullseye+handshake': "People-Pleaser's Fact Check", 'bullseye+chef': 'Litigator', 'bullseye+clown': 'Ackshually Heckler', 'bullseye+yawn': 'Clipboard Killjoy',
  'bullseye+cap': 'Burden of Proof Guy', 'bullseye+puke': 'Cringe Calipers', 'bullseye+money': 'Bylaw Reporter', 'bullseye+trash': 'Nitpicky',
  'bullseye+crylaugh': 'The Laugh Meter', 'bullseye+sideeye': 'Receipt Collector', 'bullseye+popcorn': 'Court Stenographer', 'bullseye+chartdown': 'The Coroner',
  'bullseye+robot': 'CAPTCHA: Skill Issue',
  'chef+handshake': 'Focus Group Zombie', 'clown+handshake': 'Hand-Crafted Coattail', 'handshake+yawn': 'Beige Personified', 'handshake+puke': 'Sanctimony Sponge',
  'crylaugh+handshake': 'Canned Applause', 'fire+handshake': 'Parasocial', 'handshake+popcorn': 'Railbird', 'handshake+robot': 'Doppler Ganger',
  'chef+clown': 'Review Bomber', 'chef+yawn': 'Creative Director Of Nothing', 'cap+chef': 'Counterfeiter', 'chef+puke': 'Karen Customer',
  'chef+money': 'Red-Tape Gourmet', 'chef+trash': 'One-Star Oracle', 'chef+robot': 'Whiz Cuisine',
  'clown+yawn': 'Vibe Sniper', 'cap+clown': 'The Contrarian', 'clown+puke': 'Bitter Beer Face', 'clown+trash': 'Comment Section Legend',
  'clown+sideeye': 'Burn Book', 'clown+popcorn': 'The Shit-Stirrer', 'chartdown+clown': 'Gallows Comic', 'clown+robot': 'Smack Talker',
  'cap+yawn': 'Cynical', 'puke+yawn': 'Allergic To Fun', 'money+yawn': 'Municipal Buzzkill', 'trash+yawn': 'Black Hole Signatory',
  'fire+yawn': "Everything's Mid", 'chartdown+yawn': 'Doomscroller', 'robot+yawn': 'Cold Mapper',
  'cap+puke': 'Purity Truther', 'cap+sideeye': 'The Witch Hunt', 'cap+popcorn': 'Tinfoil Productions', 'cap+chartdown': 'Market Crash Prophet', 'cap+robot': 'The Deepfake Detective',
  'money+puke': 'Church Lady Energy', 'puke+trash': 'Disliker', 'puke+sideeye': 'Moral Surveillance Van', 'puke+robot': 'Robotripper',
  'money+trash': 'Neighborhood Facebook Admin', 'money+sideeye': 'Criminologist', 'money+popcorn': 'Concern Troll', 'money+robot': 'Humanity Checkpoint',
  'crylaugh+trash': 'Spite Viewer', 'fire+trash': 'Polarized', 'sideeye+trash': 'Screenshot Gremlin', 'chartdown+trash': 'Rapture Rating', 'robot+trash': 'Legacy Hardware',
  'crylaugh+fire': 'Engagement Farmer', 'crylaugh+popcorn': 'Must-See Comedy', 'crylaugh+robot': 'Synthetic Enthusiasm',
  'fire+sideeye': 'Paranoid Pyro', 'fire+popcorn': 'Chaos Influencer', 'fire+robot': 'Pulse Checker',
  'popcorn+sideeye': 'Group Chat Forensics', 'chartdown+sideeye': 'Disaster Archivist', 'robot+sideeye': 'Turing Examiner',
  'chartdown+popcorn': 'Vulture Capitalist', 'popcorn+robot': 'CSI: Discord', 'chartdown+robot': 'Ctrl-Alt-Deceased'
};
var GIVER_TRIPLETS = {
  'bullseye+popcorn+sideeye': 'Discovery Channel Lawyer', 'clown+popcorn+trash': 'Geekshow', 'cap+robot+sideeye': 'An Eye For Talent',
  'bullseye+cap+chartdown': 'Black Box Recorder', 'chef+puke+trash': 'Rotten Tomato', 'crylaugh+fire+handshake': 'Borrowed Personality',
  'cap+money+sideeye': 'HOA Conspiracy Board', 'chartdown+trash+yawn': 'The Great Filter', 'cap+clown+popcorn': 'Crisis Actor',
  'bullseye+robot+sideeye': 'Falsifiably Weary', 'money+puke+sideeye': 'Vice Detective', 'chartdown+robot+trash': 'Auto-Sloppy-Copy'
};

// CROSSES (R×G) — receive one badge a lot AND give another a lot. Key: "recv>give". (CROSS_TITLES.md)
var RECV_GIVE_CROSSES = {
  'bullseye>puke':'Precision Hater','bullseye>trash':'Peak Ruiner','bullseye>yawn':'Human Buzzkill','bullseye>sideeye':'Conspiracy Auditor','bullseye>cap':'Truth Truther','bullseye>chartdown':'Doom Calculator',
  'handshake>puke':'Selective Empath','handshake>trash':'Two-Faced Yelp','handshake>sideeye':'Friendly Narc','handshake>chartdown':'Anxiety Broker','handshake>cap':'Agreement Hoarder',
  'chef>yawn':'Burnt-Out Genius','chef>puke':'Flexing Taste-Tester','chef>trash':'No-Chill Stove-Top','chef>sideeye':'Recipe Gatekeeper','chef>robot':'Artisanal AI Detector',
  'clown>puke':'Self-Hating Entertainer','clown>sideeye':'Court Jester CIA','clown>chartdown':'Doom Mascot','clown>trash':'Professional Heckler','clown>cap':'Irony Addict',
  'yawn>fire':'Forced Hype Man','yawn>crylaugh':'Laugh Track Operator','yawn>popcorn':'Spectator Vegetable','yawn>puke':'Disgusted Furniture','yawn>bullseye':'Spreadsheet Comedian',
  'cap>bullseye':'False Prophet','cap>sideeye':'Tin-Foil Detective','cap>robot':'Synthetic Skeptic','cap>chartdown':'Apocalypse Influencer',
  'puke>handshake':'Toxic Positivity','puke>crylaugh':'Cringe Tourist','puke>popcorn':'Carnage Critic','puke>fire':'Rage Reactor','puke>chef':'Food Critic Energy',
  'money>handshake':'Cool Mom','money>sideeye':'Self Snitch','money>chartdown':'Bankruptcy Oracle','money>puke':'Moral Hangover',
  'trash>handshake':'Polite Hater','trash>crylaugh':'Bully With A Podcast','trash>fire':'Chaos Reviewer','trash>popcorn':'Dumpster Tourist','trash>sideeye':'Grievance Archivist',
  'crylaugh>puke':'Pageant Judge','crylaugh>chartdown':'Doom Comic','crylaugh>sideeye':'Suspicious Giggler',
  'fire>yawn':'Burnout Engine','fire>puke':'Hot Take Factory','fire>trash':'Arson Inspector','fire>chartdown':'Apocalypse DJ',
  'sideeye>handshake':'Federal Bestie','sideeye>crylaugh':'Gossip Hyena','sideeye>popcorn':'Surveillance Enjoyer','sideeye>robot':'CAPTCHA Vigilante',
  'popcorn>puke':'Drama Puritan','popcorn>trash':'Balcony Heckler','popcorn>chartdown':'Collapse Enthusiast','popcorn>sideeye':'Reality TV Detective',
  'chartdown>fire':'Motivational Doomer','chartdown>crylaugh':'Gallows Influencer','chartdown>handshake':'Supportive Pessimist','chartdown>popcorn':'Recession Obsessive',
  'robot>bullseye':'Algorithm Judge','robot>puke':'Slop Exorcist','robot>sideeye':'Slop Sheriff','robot>trash':'Prompt Archaeologist','robot>chartdown':'Silicon Doomer'
};

// R×G×G Boss Forms: recv X + give Y + give Z (Y,Z distinct). key "recvX|giveA+giveB" (gives sorted).
var BOSS_FORMS = {
  'bullseye|puke+sideeye':'Forensic Hater','bullseye|sideeye+trash':'Receipt Goblin','bullseye|chartdown+puke':'Doom Engineer','bullseye|cap+sideeye':'Conspiracy Accountant','bullseye|puke+yawn':'Joy Coroner','bullseye|robot+sideeye':'Turing Inquisitor',
  'chef|puke+trash':'Sender Backer','chef|sideeye+trash':'Recipe Warlord','chef|chartdown+puke':'Burnout Prophet','chef|cap+sideeye':'Culinary Truther',
  'handshake|sideeye+trash':'Informal Informant','handshake|chartdown+puke':'Red Flag Industrial Complex','handshake|cap+sideeye':'Plausible Deniability','handshake|crylaugh+puke':'Passive-Aggressive Angel',
  'clown|chartdown+puke':'Doom Clown','clown|sideeye+trash':'Court Jester General','clown|crylaugh+puke':'Self-Aware Trainwreck','clown|cap+sideeye':'Irony Terrorist',
  'yawn|crylaugh+fire':'Corporate Hype Zombie','yawn|puke+sideeye':'Professional Disappointer','yawn|chartdown+trash':'Black Hole Reviewer','yawn|bullseye+puke':'Spreadsheet Executioner',
  'cap|chartdown+sideeye':'Basement Oracle','cap|robot+sideeye':'Synthetic Bloodhound','cap|puke+trash':'Professional Debunker','cap|popcorn+sideeye':'Conspiracy Spectator',
  'puke|crylaugh+popcorn':'Cringe Vulture','puke|sideeye+trash':'Vice Principal of Hell','puke|crylaugh+fire':'Outrage Influencer','puke|chartdown+sideeye':'Moral Bankruptcy Auditor',
  'money|puke+sideeye':'Weekend Narc','money|chartdown+crylaugh':'Bankruptcy Comedian','money|sideeye+trash':'Fun Detective','money|chartdown+puke':'Regret Speedrun',
  'trash|crylaugh+sideeye':'Gossip Hyena Prime','trash|puke+sideeye':'Grievance Dragon','trash|chartdown+popcorn':'Collapse Tourist','trash|handshake+sideeye':'Smiling Assassin',
  'crylaugh|popcorn+sideeye':'Drama Wildlife Photographer','crylaugh|puke+trash':'Judgment Airlines','crylaugh|chartdown+sideeye':'Gallows Investigator','crylaugh|cap+sideeye':'Irony Launderer',
  'fire|puke+trash':'Hot Take Crematorium','fire|chartdown+sideeye':'Apocalypse Evangelist','fire|cap+crylaugh':'Discourse Engineer','fire|puke+sideeye':'Rage Reactor Core',
  'sideeye|chartdown+trash':'Case Builder','sideeye|puke+trash':'Human Terms of Service','sideeye|crylaugh+popcorn':'Reality Show Coroner','sideeye|chartdown+robot':'CAPTCHA Inquisitor',
  'popcorn|puke+sideeye':'Rubbernecker Supreme','popcorn|chartdown+crylaugh':'Collapse Connoisseur','popcorn|sideeye+trash':'Balcony Intelligence Agency','popcorn|fire+puke':'Riot Food Critic',
  'chartdown|puke+sideeye':'Failure Archaeologist','chartdown|crylaugh+popcorn':'End Times Entertainer','chartdown|sideeye+trash':'Career Undertaker','chartdown|fire+puke':'Motivational Arsonist',
  'robot|puke+sideeye':'Slop Exterminator','robot|sideeye+trash':'Prompt Detective','robot|chartdown+sideeye':'Silicon Prophet','robot|bullseye+puke':'Algorithmic Snob'
};
// G×R×R Self-Mythology: give X + recv Y + recv Z. key "giveX|recvA+recvB" (recvs sorted; doubled => >=20).
var SELF_MYTH = {
  'puke|bullseye+bullseye':'Perfectionist Cannibal','puke|crylaugh+fire':'Fun Allergy','puke|chef+handshake':'Bitter Celebrity Chef','puke|crylaugh+popcorn':'Cringe Influencer','puke|bullseye+fire':'Elite Snoblin',
  'trash|bullseye+chef':'Masterpiece Hater','trash|crylaugh+handshake':'Toxic Sweetheart','trash|fire+popcorn':'Disaster Curator','trash|bullseye+handshake':'Professional Contrarian','trash|crylaugh+crylaugh':'Laughing Executioner',
  'sideeye|bullseye+bullseye':'Internal Affairs','sideeye|handshake+handshake':'Suspicious Golden Retriever','sideeye|crylaugh+popcorn':'Gossip Cryptid','sideeye|bullseye+chef':'Pattern Addict','sideeye|crylaugh+fire':'Viral Detective',
  'chartdown|bullseye+bullseye':'Catastrophe Engineer','chartdown|crylaugh+fire':'Party Undertaker','chartdown|chef+handshake':'Supportive Ruiner','chartdown|crylaugh+popcorn':'Doomsday Host','chartdown|bullseye+fire':'Doom Visionary',
  'cap|bullseye+bullseye':'Reality Denier Pro Max','cap|handshake+handshake':'Community Cryptid','cap|crylaugh+fire':'Clickbait Messiah','cap|bullseye+chef':'Fabrication Artisan','cap|crylaugh+popcorn':'Conspiracy Content Creator',
  'yawn|fire+fire':'Burnout Sun','yawn|crylaugh+crylaugh':'Dead-Eyed Comedian','yawn|bullseye+chef':'Talented Bore','yawn|handshake+handshake':'Beige Messiah','yawn|fire+popcorn':'Reluctant Spectacle',
  'clown|bullseye+bullseye':'Self-Fulfilling Prophecy','clown|crylaugh+fire':'Crowd Control Hazard','clown|handshake+popcorn':'Class Clown President','clown|bullseye+chef':'Weaponized Goofball','clown|bullseye+fire':'Chaos Savant',
  'handshake|bullseye+chef':'Validation Emperor','handshake|crylaugh+fire':'Human LinkedIn','handshake|crylaugh+popcorn':"People's Parasocialist",'handshake|bullseye+bullseye':'Consensus Machine','handshake|chef+fire':'Certified Fresh',
  'chef|bullseye+bullseye':'Main Chef Energy','chef|crylaugh+fire':'Yelp Autofiller','chef|handshake+handshake':"Teacher's Favorite Teacher",'chef|crylaugh+popcorn':'Culinary Drama Queen','chef|bullseye+fire':'Peak Performance Goblin',
  'crylaugh|bullseye+bullseye':'Natural Disaster of Charm','crylaugh|handshake+handshake':'Community Property','crylaugh|fire+fire':'Content Reactor','crylaugh|bullseye+chef':'Joke Craftsman','crylaugh|popcorn+popcorn':'Main Character Accident',
  'fire|bullseye+bullseye':'Hype Tyrant','fire|bullseye+chef':'Excellence Addict','fire|crylaugh+crylaugh':'Engagement Singularity','fire|handshake+handshake':'Cult Leader Lite','fire|crylaugh+popcorn':'Walking Season Finale',
  'popcorn|bullseye+bullseye':'Drama Physicist','popcorn|crylaugh+fire':'Audience Surrogate','popcorn|handshake+handshake':'Community Vulture','popcorn|bullseye+chef':'Spectacle Architect',
  'robot|bullseye+bullseye':'Human CAPTCHA','robot|crylaugh+fire':'Slop Magnet','robot|handshake+handshake':'Synthetic Empath','robot|bullseye+chef':'Prompt Black Belt','robot|crylaugh+popcorn':'AI Apocalypse Tourist'
};

// THE COURTROOM — 13 dispute/voting-behavior ladders (DISPUTE_LADDERS.md), keyed by DB column.
// Same 5/10/20/30/40/★50 thresholds as badges; single-stat ladders.
var DISPUTE_LADDERS = {
  disputes_raised:      { label: 'Disputes Raised',      e: '⚖️', t: ['Argumentative', 'Receipt Requester', 'Objection Poster', 'Comment Section Lawyer', 'Legally Ambitious', 'Due Process Dandy'] },
  defenses_won:         { label: 'Defenses Won',         e: '🛡️', t: ['Against The Grain', 'Misunderstood', 'Wrongfully Accused', 'Beating The Allegations', 'Shark Out Of Water', 'Allegation-Proof'] },
  defenses_lost:        { label: 'Defenses Lost',        e: '⛓️', t: ['Denial', 'Not Helping', 'Digging Deeper', 'Making It Worse', 'Exhibit A', 'Convicted By Vibes'] },
  judgments_upheld:     { label: 'Judgments Upheld',     e: '🔨', t: ['Technically Correct', 'Called It', 'Good Read', 'Receipt Holder', 'Proven Nonfiction', 'Lore Accurate'] },
  judgments_overturned: { label: 'Judgments Overturned', e: '🔄', t: ['Incorrect', 'Reaching', 'Bad Call', 'Community Noted', 'Instant Replay', 'Fact Checked Live'] },
  mercy_votes:          { label: 'Mercy Votes',          e: '🕊️', t: ['Benefit Of The Doubt', 'Soft Spot', 'Defense Attorney', 'Public Defender', 'Free My Boy', 'Not Guilty By Vibes'] },
  nomercy_votes:        { label: 'No-Mercy Votes',       e: '🍅', t: ['Tough Crowd', 'No Excuses', 'Throwing Tomatoes', 'Hang Em High', 'Maximum Sentence', 'Pack Watch Judge'] },
  deciding_votes:       { label: 'Deciding Votes',       e: '👑', t: ['Swing Vote', 'Tie Breaker', 'Decider', 'Kingmaker', 'Final Say', 'Patch Notes'] },
  rounds_voted:         { label: 'Participation',        e: '🗳️', t: ['Enrolled', 'Participator', 'Registered Voter', 'Civic Duty', 'Democracy Dilettante', 'Voice Of The People'] },
  rounds_abstained:     { label: 'Abstention',           e: '😶', t: ['Lurking', 'Seen It', 'On The Fence', 'Window Shopper', 'Ghost Voter', 'Read Receipts Enabled'] },
  vote_switches:        { label: 'Vote-Switching',       e: '🤝', t: ['Wavering', 'Folded', 'Walking It Back', 'Flip Flopper', 'Weathervane', 'Crowd-Sourced Opinion'] },
  crowd_aligned:        { label: 'Crowd Alignment',      e: '🐑', t: ['Nodding Along', 'Same Here', 'Go With The Flow', 'Consensus Enjoyer', 'Sheepish', 'NPC Dialogue Option'] },
  contrarian_votes:     { label: 'Contrarianism',        e: '🙅', t: ['Different Story', 'Pushback', "Devil's Advocate", 'Contrarian', 'Lone Dissenter', 'Opposite Day CEO'] }
};

// from raw stats -> the titles you hold + your worn calltag (highest)
function computeIdentity(stats, dstats) {
  var recv = {}, give = {};
  (stats || []).forEach(function (s) { recv[s.badge] = s.recv; give[s.badge] = s.give; });
  var recvTitles = [], giveTitles = [], comboTitles = [], crossTitles = [], disputeTitles = [], totalPrestige = 0;

  function singles(counts, ladders, axis, out) {
    Object.keys(counts).forEach(function (b) {
      var c = counts[b], i = levelIdx(c);
      if (i >= 0 && ladders[b]) { var pr = Math.floor(c / 50); out.push({ badge: b, label: ladders[b][i], idx: i, count: c, axis: axis, tier: 1, prestige: pr }); totalPrestige += pr; }
    });
  }
  singles(recv, RECEIVER_LADDERS, 'recv', recvTitles);
  singles(give, GIVER_LADDERS, 'give', giveTitles);

  // a badge qualifies for combos at Lv10+ (count >= 10) on that axis
  function combos(counts, pairMap, tripMap, axis) {
    var q = Object.keys(counts).filter(function (b) { return counts[b] >= 10; }).sort();
    var i, j, k;
    for (i = 0; i < q.length; i++) for (j = i + 1; j < q.length; j++) {
      var pk = q[i] + '+' + q[j];
      if (pairMap[pk]) comboTitles.push({ label: pairMap[pk], axis: axis, tier: 2, badges: [q[i], q[j]], strength: Math.min(counts[q[i]], counts[q[j]]) });
    }
    for (i = 0; i < q.length; i++) for (j = i + 1; j < q.length; j++) for (k = j + 1; k < q.length; k++) {
      var tk = q[i] + '+' + q[j] + '+' + q[k];
      if (tripMap[tk]) comboTitles.push({ label: tripMap[tk], axis: axis, tier: 3, badges: [q[i], q[j], q[k]], strength: Math.min(counts[q[i]], counts[q[j]], counts[q[k]]) });
    }
  }
  combos(recv, RECEIVER_COMBOS, RECEIVER_TRIPLETS, 'recv');
  combos(give, GIVER_COMBOS, GIVER_TRIPLETS, 'give');

  // CROSSES (R×G): receive X heavily AND give Y heavily — the moat persona
  for (var ck in RECV_GIVE_CROSSES) {
    var cp = ck.split('>'), rx = cp[0], gy = cp[1];
    if ((recv[rx] || 0) >= 10 && (give[gy] || 0) >= 10) {
      crossTitles.push({ label: RECV_GIVE_CROSSES[ck], axis: 'cross', tier: 2, badges: [rx, gy], strength: Math.min(recv[rx], give[gy]) });
    }
  }

  // 3-badge crosses (tier 3, rarest): Boss Forms (recv X + give Y,Z) & Self-Mythology (give X + recv Y,Z)
  function tripleCross(map, prim, sec, kind) {
    for (var tk in map) {
      var tp = tk.split('|'), p = tp[0], ss = tp[1].split('+');
      if ((prim[p] || 0) < 10) continue;
      var ok = ss[0] === ss[1] ? (sec[ss[0]] || 0) >= 20 : ((sec[ss[0]] || 0) >= 10 && (sec[ss[1]] || 0) >= 10);
      if (ok) crossTitles.push({ label: map[tk], axis: kind, tier: 3, badges: [p].concat(ss), strength: Math.min(prim[p], sec[ss[0]] || 0, sec[ss[1]] || 0) });
    }
  }
  tripleCross(BOSS_FORMS, recv, give, 'boss');
  tripleCross(SELF_MYTH, give, recv, 'myth');

  // THE COURTROOM: each dispute/voting behavior is its own single-stat ladder (tier 1, like a badge)
  if (dstats) {
    Object.keys(DISPUTE_LADDERS).forEach(function (col) {
      var c = dstats[col] || 0, i = levelIdx(c);
      if (i >= 0) disputeTitles.push({ col: col, label: DISPUTE_LADDERS[col].t[i], idx: i, count: c, axis: 'dispute', tier: 1, prestige: Math.floor(c / 50) });
    });
  }

  // calltag: highest tier (triplet > combo > single), then prestige, rung, strength
  var all = recvTitles.concat(giveTitles).concat(comboTitles).concat(crossTitles).concat(disputeTitles).slice().sort(function (a, b) {
    return ((b.tier || 1) - (a.tier || 1)) || ((b.prestige || 0) - (a.prestige || 0)) || ((b.idx || 0) - (a.idx || 0)) || ((b.strength || b.count || 0) - (a.strength || a.count || 0));
  });
  return { recvTitles: recvTitles, giveTitles: giveTitles, comboTitles: comboTitles, crossTitles: crossTitles, disputeTitles: disputeTitles, totalPrestige: totalPrestige, calltag: all.length ? all[0].label : null, calltagPrestige: all.length ? (all[0].prestige || 0) : 0 };
}

// gold ★ per completed prestige cycle (50 of a badge), capped for display
function stars(n) { n = n || 0; return n > 0 ? ' <span class="prestige-star">' + new Array(Math.min(n, 9) + 1).join('★') + '</span>' : ''; }

// the dossier panel — your earned ranks + the Projection + progress to next
function dossierHtml() {
  var id = STATE.myIdentity;
  if (!id || (!id.recvTitles.length && !id.giveTitles.length && !(id.disputeTitles || []).length)) {
    return '<div class="panel dossier"><div class="label">🪪 YOUR DOSSIER</div>' +
      '<div class="muted">no rank yet — earn badges on your prompts, and hand them out, to unlock your name.</div></div>';
  }
  function row(t, axis) {
    var glyph, rungs;
    if (axis === 'dispute') { var dl = DISPUTE_LADDERS[t.col]; glyph = dl.e; rungs = dl.t; }
    else { rungs = (axis === 'recv' ? RECEIVER_LADDERS : GIVER_LADDERS)[t.badge]; glyph = badgeEmoji(t.badge); }
    var nextThresh = t.idx < LEVELS.length - 1 ? LEVELS[t.idx + 1] : null;
    var prog = nextThresh
      ? t.count + '/' + nextThresh + ' → ' + rungs[t.idx + 1]
      : t.count + '/' + ((t.prestige + 1) * 50) + ' → ★' + (t.prestige + 1);
    return '<div class="dz-row"><span class="dz-badge">' + glyph + '</span>' +
      '<span class="dz-title">' + escapeHtml(t.label) + stars(t.prestige) + '</span>' +
      '<span class="dz-prog muted">' + escapeHtml(prog) + '</span></div>';
  }
  function bySort(a, b) { return (b.idx - a.idx) || (b.count - a.count); }
  var recv = id.recvTitles.slice().sort(bySort), give = id.giveTitles.slice().sort(bySort);
  var chosen = (STATE.myProfile && STATE.myProfile.chosen_title) || '__auto__';
  var worn = chosen === '__none__' ? '(hidden)' : ((STATE.myProfile && STATE.myProfile.calltag) || id.calltag || '—');
  var html = '<div class="panel dossier"><div class="label">🪪 YOUR DOSSIER</div>';
  html += '<div class="dz-calltag">WORN: <b>' + escapeHtml(worn) + '</b>' + stars(id.calltagPrestige) + '</div>';
  var seen = {}, opts = '<option value="__auto__"' + (chosen === '__auto__' ? ' selected' : '') + '>★ Auto (highest)</option>';
  (id.crossTitles || []).concat(id.comboTitles || []).concat(recv).concat(give).concat(id.disputeTitles || []).forEach(function (t) { if (seen[t.label]) return; seen[t.label] = 1; opts += '<option value="' + escapeHtml(t.label) + '"' + (chosen === t.label ? ' selected' : '') + '>' + escapeHtml(t.label) + '</option>'; });
  opts += '<option value="__none__"' + (chosen === '__none__' ? ' selected' : '') + '>— no label —</option>';
  html += '<div class="dz-pick">WEAR: <select id="calltag-sel">' + opts + '</select></div>';
  if (id.comboTitles && id.comboTitles.length) {
    html += '<div class="dz-sub">COMBOS UNLOCKED</div>';
    id.comboTitles.slice().sort(function (a, b) { return (b.tier - a.tier) || (b.strength - a.strength); }).forEach(function (c) {
      var bs = c.badges.map(function (b) { return badgeEmoji(b); }).join('');
      html += '<div class="dz-row"><span class="dz-badge dz-combobadge">' + bs + '</span>' +
        '<span class="dz-title dz-combotitle">' + escapeHtml(c.label) + '</span>' +
        '<span class="dz-prog muted">' + (c.tier === 3 ? 'TRIPLET' : 'combo') + ' · ' + (c.axis === 'recv' ? 'earned' : 'projected') + '</span></div>';
    });
  }
  if (id.crossTitles && id.crossTitles.length) {
    html += '<div class="dz-sub">⚡ CROSS PERSONAS — prompts × projection</div>';
    id.crossTitles.slice().sort(function (a, b) { return ((b.tier || 2) - (a.tier || 2)) || (b.strength - a.strength); }).forEach(function (c) {
      var bs = c.badges.map(function (b) { return badgeEmoji(b); }).join('');
      var lbl = c.axis === 'boss' ? 'BOSS FORM' : (c.axis === 'myth' ? 'MYTHOS' : 'cross');
      html += '<div class="dz-row"><span class="dz-badge dz-combobadge">' + bs + '</span>' +
        '<span class="dz-title dz-combotitle">' + escapeHtml(c.label) + '</span><span class="dz-prog muted">' + lbl + '</span></div>';
    });
  }
  if (recv.length) html += '<div class="dz-sub">WHAT YOUR PROMPTS EARN</div>' + recv.map(function (t) { return row(t, 'recv'); }).join('');
  if (give.length) html += '<div class="dz-sub">THE PROJECTION — what you inflict</div>' + give.map(function (t) { return row(t, 'give'); }).join('');
  var disp = (id.disputeTitles || []).slice().sort(bySort);
  if (disp.length) html += '<div class="dz-sub">⚖️ THE COURTROOM — how you handle judgment</div>' + disp.map(function (t) { return row(t, 'dispute'); }).join('');
  return html + '</div>';
}
// wire the calltag picker (auto / a specific earned title / no label)
function wireDossier() {
  var sel = el('calltag-sel');
  if (!sel) return;
  sel.addEventListener('change', function () {
    var v = sel.value, uid = STATE.user.id, sb = STATE.supabase;
    var args = v === '__auto__' ? { p_discord: uid, p_calltag: (STATE.myIdentity && STATE.myIdentity.calltag) || null, p_chosen: null }
      : v === '__none__' ? { p_discord: uid, p_calltag: null, p_chosen: '__none__' }
      : { p_discord: uid, p_calltag: v, p_chosen: v };
    sb.rpc('prompt_pick_calltag', args).then(function () { refresh(); });
  });
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

// ── Matrix digital rain behind the UI (the front-door vibe) ──────────────────
function startRain() {
  var cv = document.getElementById('rain'); if (!cv) return;
  var ctx = cv.getContext('2d'); if (!ctx) return;
  var fontSize = 14, drops = [], cols = 0;
  function resize() {
    var p = cv.parentElement || document.body;
    cv.width = p.clientWidth; cv.height = p.clientHeight;
    cols = Math.ceil(cv.width / fontSize);
    drops = []; for (var i = 0; i < cols; i++) drops[i] = Math.random() * -60;
  }
  resize(); window.addEventListener('resize', resize);
  var glyphs = 'PROMPT0123456789アイウエオカキク#%&<>=*+/$'.split('');
  function draw() {
    ctx.fillStyle = 'rgba(5,8,5,0.10)'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.font = fontSize + "px 'Share Tech Mono', monospace";
    for (var i = 0; i < cols; i++) {
      var y = drops[i] * fontSize;
      ctx.fillStyle = Math.random() > 0.985 ? '#9dffbe' : '#1f9c43';
      ctx.fillText(glyphs[Math.floor(Math.random() * glyphs.length)], i * fontSize, y);
      if (y > cv.height && Math.random() > 0.975) drops[i] = 0;
      drops[i] += 0.6;
    }
  }
  setInterval(draw, 55);
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

// ── v20 TABLE BROWSER — infinite tables: drop in, rack up points, leave anytime ──
function browseTables(btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'loading tables…'; }
  callFn('listtables', {}).then(function (res) {
    STATE.tablesList = (res && res.tables) || [];
    renderTableBrowser();
  }).catch(function (e) { console.error('listtables:', e); if (btn) { btn.disabled = false; btn.textContent = '🌐 BROWSE TABLES'; } });
}
function joinTableNow(iid, btn) {
  if (btn) { btn.disabled = true; btn.textContent = 'joining…'; }
  callFn('jointable', { instance_id: iid, discord_id: STATE.user.id, username: STATE.user.username })
    .then(function (res) { if (res && res.session_id) switchSession(res.instance_id, res.session_id); })
    .catch(function (e) { console.error('jointable:', e); if (btn) { btn.disabled = false; btn.textContent = 'JOIN'; } });
}
function renderTableBrowser() {
  var rows = (STATE.tablesList || []).map(function (t) {
    var full = t.count >= 8, live = t.phase !== 'lobby';
    return '<div class="table-row"><span class="table-name">🎲 ' + escapeHtml(t.name) + '</span>' +
      '<span class="table-meta muted">' + t.count + '/8 · ' + (live ? 'LIVE' : 'open') + '</span>' +
      '<button class="join-table-btn" data-iid="' + escapeHtml(t.instance_id) + '"' + (full ? ' disabled' : '') + '>' + (full ? 'FULL' : 'JOIN') + '</button></div>';
  }).join('') || '<div class="muted">spinning up tables…</div>';
  el('game').innerHTML =
    '<div class="panel"><div class="label">&gt;&gt; TABLES — grab any open seat</div>' +
    '<div class="muted">tables never end. jump in, rack up points, leave whenever.</div></div>' +
    '<div class="tables">' + rows + '</div>' +
    '<div id="host-result"></div>' +
    '<div class="prompt-line"><span class="arrow">&gt;</span> GOT AN INVITE CODE?</div>' +
    '<div class="input-row"><input id="code-input" type="text" maxlength="6" placeholder="6-char code" autocomplete="off" />' +
    '<button id="joincode-btn">JOIN</button></div>' +
    '<div class="submit-note" id="code-note"></div>' +
    '<div class="row-actions"><button id="host-btn" class="primary">➕ HOST A PRIVATE TABLE</button> ' +
    '<button id="refresh-tables-btn" class="ghost">⟳ refresh</button> ' +
    '<button id="back-lobby-btn" class="ghost">◂ back</button></div>';
  Array.prototype.forEach.call(document.querySelectorAll('.join-table-btn'), function (b) {
    b.addEventListener('click', function () { joinTableNow(b.getAttribute('data-iid'), b); });
  });
  el('joincode-btn').addEventListener('click', function () {
    var code = (el('code-input').value || '').trim();
    if (!code) return;
    el('joincode-btn').disabled = true;
    callFn('jointablecode', { code: code, discord_id: STATE.user.id, username: STATE.user.username })
      .then(function (res) {
        if (res && res.session_id) switchSession(res.instance_id, res.session_id);
        else { el('code-note').textContent = '🚫 no table with that code'; el('code-note').className = 'submit-note blocked'; el('joincode-btn').disabled = false; }
      })
      .catch(function () { el('code-note').textContent = '🚫 no table with that code'; el('code-note').className = 'submit-note blocked'; el('joincode-btn').disabled = false; });
  });
  el('host-btn').addEventListener('click', function () {
    el('host-btn').disabled = true; el('host-btn').textContent = 'creating…';
    callFn('hosttable', { discord_id: STATE.user.id, username: STATE.user.username })
      .then(function (res) {
        if (res && res.code) {
          el('host-result').innerHTML = '<div class="panel"><div class="label">YOUR PRIVATE TABLE IS OPEN</div>' +
            '<div class="code-display">CODE: <b>' + escapeHtml(res.code) + '</b></div><div class="muted">share it with your crew — taking you in…</div></div>';
          setTimeout(function () { switchSession(res.instance_id, res.session_id); }, 1600);
        }
      })
      .catch(function (e) { console.error('hosttable:', e); el('host-btn').disabled = false; el('host-btn').textContent = '➕ HOST A PRIVATE TABLE'; });
  });
  el('refresh-tables-btn').addEventListener('click', function () { browseTables(el('refresh-tables-btn')); });
  el('back-lobby-btn').addEventListener('click', function () { render(); });
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
    // normalize id -> discord_id so player↔profile↔me lookups (profilesById[p.id], p.id===user.id) work
    STATE.players = (p.data || []).map(function (x) { x.id = x.discord_id; return x; });
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
    var dsr = await sb.from('prompt_dispute_stats').select('*').eq('discord_id', STATE.user.id).maybeSingle();
    STATE.disputeStats = dsr.data || null;
    STATE.myIdentity = computeIdentity(STATE.badgeStats, STATE.disputeStats);
    // auto-wear the highest ONLY until the player has made a choice (chosen_title set)
    var chosenT = STATE.myProfile && STATE.myProfile.chosen_title;
    if (!chosenT && STATE.myIdentity.calltag && (!STATE.myProfile || STATE.myProfile.calltag !== STATE.myIdentity.calltag)) {
      sb.rpc('prompt_set_calltag', { p_discord: STATE.user.id, p_calltag: STATE.myIdentity.calltag }).then(function () {}, function () {});
    }
    if (STATE.myIdentity.totalPrestige && (!STATE.myProfile || (STATE.myProfile.prestige || 0) !== STATE.myIdentity.totalPrestige)) {
      sb.rpc('prompt_set_prestige', { p_discord: STATE.user.id, p_prestige: STATE.myIdentity.totalPrestige }).then(function () {}, function () {});
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
    '<button id="start-btn"' + (canStart ? '' : ' disabled') + '>START</button></div>' +
    (canStart ? '' : '<div class="muted">need 2+ players to start</div>') +
    '<div class="prompt-line"><span class="arrow">&gt;</span> OR DROP INTO A LIVE TABLE:</div>' +
    '<div class="row-actions"><button id="findgame-btn" class="ghost">🌐 BROWSE TABLES</button></div>' +
    dossierHtml() +
    leaderboardHtml();
  el('cat-select').addEventListener('change', function (e) { STATE.category = e.target.value; });
  el('start-btn').addEventListener('click', function () {
    callFn('start', { category: STATE.category, rounds: 5 });
  });
  el('findgame-btn').addEventListener('click', function () { browseTables(el('findgame-btn')); });
  wireDossier();
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
    '<button id="findgame-btn" class="ghost">🌐 BROWSE TABLES</button>' +
    '<button id="sharecard-btn" class="ghost">📸 SHARE CARD</button></div>' +
    dossierHtml() +
    '<div class="share-holder" id="share-holder"></div>';

  el('again-btn').addEventListener('click', function () { callFn('reset', {}); });
  el('findgame-btn').addEventListener('click', function () { browseTables(el('findgame-btn')); });
  el('sharecard-btn').addEventListener('click', makeShareCard);
  wireDossier();
}

function renderScoreboard() {
  var sorted = STATE.players.slice().sort(function (a, b) { return b.score - a.score; });
  var medals = ['🥇', '🥈', '🥉'];
  var board = sorted.map(function (p, i) {
    var m = medals[i] || (i + 1) + '.';
    var me = p.id === STATE.user.id ? ' (you)' : '';
    var prof = STATE.profilesById[p.id];
    var title = (prof && prof.calltag) ? ' <span class="title-tag">' + escapeHtml(prof.calltag) + '</span>' : '';
    title += stars(prof && prof.prestige);
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
  var inTable = STATE.session && STATE.session.is_public && STATE.session.phase !== 'ended' && STATE.session.phase !== 'lobby';
  var leaveBtn = inTable ? '<div class="row-actions"><button id="leave-table-btn" class="ghost">◂ leave table</button></div>' : '';
  el('scoreboard').innerHTML = (board ? '<div class="label">SCOREBOARD</div>' + board : '') + mine + leaveBtn;
  if (el('leave-table-btn')) el('leave-table-btn').addEventListener('click', function () { var b = el('leave-table-btn'); b.disabled = true; b.textContent = 'leaving…'; leavePublic(); });
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
      '<span class="who">' + escapeHtml(p.username) + '</span>' + sig + stars(p.prestige) + '</div>';
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
  startRain();
  init().catch(function (err) {
    console.error('init:', err);
    var msg = (err && err.message) ? err.message : String(err);
    setStatus('players: INIT FAILED');
    var g = el('game');
    if (g) g.innerHTML = '<div class="panel"><div class="label">&gt;&gt; INIT ERROR</div>' +
      '<div class="sub-text">' + escapeHtml(msg) + '</div></div>';
  });
});
