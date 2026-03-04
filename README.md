# 🃏 PROMPT — The AI Confession Party Game

> *You know those questions you ask AI at 2am when you think absolutely no one is watching?*
> *Everyone's got 'em. Now everyone's gonna see 'em.*

**PROMPT** is a Discord party game where players respond to embarrassingly human AI queries — the kind of stuff people actually type into chatbots when they believe the conditions are private. Think: *"How do I remove the hair patch above my buttcrack without telling anyone"* or *"How to make money without selling my body or leaving the house."*

One player is the **Dealer** (rotates like a poker dealer button, clockwise each round). A PROMPT is revealed. Everyone else responds how they think an AI *would* — or *should* — answer. The funniest, most fitting, most disturbingly accurate response wins by majority vote. No majority? The Dealer picks.

It's Cards Against Humanity meets Quiplash meets the weird intimacy of a chatbot conversation at midnight.

---

## 🎮 How to Play

### Setup
1. Invite the bot to your server (see [Installation](#installation))
2. Everyone types `/prompt-join` to sit down (3–9 players)
3. Any player types `/prompt-start` when the table is ready

### Each Round
1. 🎙️ **The Dealer is announced** — they don't submit a response this round; they break ties
2. 📣 **A PROMPT is revealed** — a real, embarrassing, innocent-sounding thing a human would actually ask an AI
3. 💬 **Everyone clicks "Submit My Response"** — a private text box appears. Type your best AI-style response. You have **5 minutes.**
4. 🗳️ **Voting opens** — all responses are shown anonymously. Everyone (except the Dealer) votes for their favorite. **1 minute to vote.**
5. 🏆 **Results revealed** — votes are tallied publicly. Majority wins. On a tie, the Dealer picks the winner.
6. **+1 point** to the winner. Dealer button shifts left. Next round begins automatically.

### Winning
- Play until someone hits a target score (default: first to 10, or most after 20 rounds)
- `/prompt-scores` shows the scoreboard at any time

---

## ✨ Features

- **150 built-in PROMPT cards** — the cringey, oblivious, deeply personal questions people actually type into AI
- **Live anonymous voting** — players see "🔒 locked in" status updates in real time
- **Dealer rotation** — moves left after each round, poker-style
- **Tie-breaking** — Dealer picks winner when votes split
- **5-minute submission window** — auto-advances even if not everyone submits
- **1-minute voting window** — auto-resolves to prevent stalls
- **No duplicate prompts** in a session until the whole deck cycles
- **3–9 players** per game
- **Per-server games** — multiple Discord servers can run simultaneously

---

## 🤖 Bot Commands

| Command | Description |
|---|---|
| `/prompt-join` | Sit down at the table |
| `/prompt-leave` | Leave the lobby |
| `/prompt-start` | Start the game (need 3+ players) |
| `/prompt-scores` | Show current scoreboard |
| `/prompt-end` | End the game (mod only) |

---

## 🔧 Installation

### Prerequisites
- [Node.js 18+](https://nodejs.org/)
- A Discord account and server where you have "Manage Server" permission
- About 10 minutes

### Step 1: Create a Discord Application

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **"New Application"** → name it `PROMPT` (or whatever you like)
3. Go to **Bot** → Click **"Add Bot"**
4. Under **Token**, click **"Reset Token"** and copy it — this is your `DISCORD_TOKEN`
5. Copy your **Application ID** — this is your `CLIENT_ID`
6. Under **Privileged Gateway Intents**, enable:
   - ✅ Message Content Intent
   - ✅ Server Members Intent (optional but useful)

### Step 2: Invite the Bot to Your Server

In the Discord Developer Portal:
1. Go to **OAuth2 → URL Generator**
2. Scopes: ✅ `bot`, ✅ `applications.commands`
3. Bot Permissions: ✅ `Send Messages`, ✅ `Embed Links`, ✅ `Read Message History`, ✅ `Use Slash Commands`
4. Copy the generated URL → open it → select your server → Authorize

### Step 3: Clone & Configure

```bash
git clone https://github.com/YOUR_USERNAME/prompt-game.git
cd prompt-game
npm install
cp .env.example .env
```

Edit `.env`:
```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
GUILD_ID=your_server_id_here   # optional: for faster dev command registration
```

### Step 4: Register Slash Commands

```bash
npm run deploy
```

> **Note:** With `GUILD_ID` set, commands appear instantly in that server.
> Without it, global registration takes up to 1 hour to propagate.

### Step 5: Start the Bot

```bash
npm start
```

You should see:
```
🤖 PROMPT Bot is online as PROMPT#1234
📦 Loaded 150 prompts
```

---

## 📁 Project Structure

```
prompt-game/
├── index.js              # Entry point
├── deploy-commands.js    # Slash command registration (run once)
├── src/
│   ├── bot.js            # Discord client, interaction routing
│   ├── gameManager.js    # Core game logic, state machine
│   └── prompts.js        # The 150-card PROMPT deck
├── .env.example          # Environment variable template
├── package.json
└── README.md
```

---

## 🃏 Sample PROMPT Cards

Because you need to know what you're getting into:

> *"How do I remove the hair patch above my buttcrack without telling anyone"*

> *"Is my belly button supposed to smell like that or is that just me"*

> *"How to make money without selling my body or leaving the house"*

> *"Can cats see ghosts — serious answers only"*

> *"Is it normal to talk to my AI more than my friends"*

> *"Am I secretly attractive and just don't know it"*

> *"How do I know if I'm the problem in a situation without asking the other people in the situation"*

> *"Do I need to be nice to AI or is that just a me problem"*

There are 150 total. None of them are safe. All of them are things real humans type when alone.

---

## 🤝 Contributing

Want to add more prompts? Better yet — *embarrassing* prompts you've actually typed into an AI? Contributions welcome.

1. Fork the repo
2. Add prompts to `src/prompts.js`
3. Keep them: innocent-seeming, personal, oblivious, mildly mortifying, not overtly sexual
4. Submit a PR

Prompt quality bar: *"Would a person be mildly embarrassed if this appeared on their screen in a meeting?"* ✅

---

## 📜 License

MIT — go nuts.

---

*"It's not embarrassing if everyone's doing it."*
*— PROMPT, the game*
