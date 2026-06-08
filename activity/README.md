# PROMPT — Reverse Mode (Discord Activity)

The green-terminal Embedded App. This is a **separate web app** from the bot in `../src`.
The bot runs text play; this Activity is the visual table that loads inside a Discord
voice channel.

> **Status: M1.** It loads inside Discord and completes the SDK handshake. It does **not**
> yet read real usernames (M2 — needs a backend) or sync multiplayer state (M3). Right now
> it's the terminal + a local demo loop.

---

## What this is

A Discord Activity is an HTML/JS app Discord loads in a sandboxed iframe. It must be served
over **public HTTPS**, and it talks to Discord through the **Embedded App SDK**. Because of the
sandbox: no CDN fonts (we bundle them), no AdSense (removed), and the SDK loads as a module
(so this is a Vite project, not a single file).

---

## 1. One-time setup

```bash
cd activity
npm install
cp .env.example .env.local
```

Open `.env.local` and paste your **Application ID**
(Discord Dev Portal → your app → General Information → Application ID):

```
VITE_DISCORD_CLIENT_ID=123456789012345678
```

---

## 2. See the look right now (no Discord)

```bash
npm run dev
```

Open http://localhost:3000 — it runs in **DEMO MODE** (boot sequence, transmissions, you can
type guesses). Or just double-click `preview.html` for the standalone version.

---

## 3. Run it *inside* Discord (the dev loop)

Discord can't load `localhost`, so you expose your dev server with a tunnel:

```bash
# terminal A
npm run dev
# terminal B  (install cloudflared first: https://github.com/cloudflare/cloudflared)
cloudflared tunnel --url http://localhost:3000
```

Cloudflared prints a public `https://something.trycloudflare.com` URL. Then in the
**Discord Developer Portal → your app → Activities** (labels shift, but you're looking for
**Embedded App / Activities**):

1. **Enable Activities** for the app.
2. **URL Mappings** → add a mapping: `Prefix: /` → `Target: something.trycloudflare.com`
   (the host from cloudflared, no `https://`).
3. Make sure the app is **installed to your test server** (OAuth2 → URL Generator →
   scopes `applications.commands` + `bot`, invite it — you already did this for the bot).

Now in Discord: join a **voice channel** → click the **rocket/Activities icon** → launch your
app. You should see the terminal boot and the status line flip to **LINK ESTABLISHED**.

> Every time you restart cloudflared you get a new URL — update the URL Mapping to match.

---

## 4. Ship it for real (production)

```bash
npm run build      # outputs dist/
```

Host `dist/` on **GitHub Pages, Cloudflare-proxied** (your standard stack). Then set the
**URL Mapping** `Prefix: /` → `Target: your-activity-domain` instead of the tunnel. Purge
Cloudflare cache after each deploy.

---

## Next milestones

- **M2 — real usernames / participants.** Add the OAuth handshake
  (`sdk.commands.authorize` → exchange the `code` for a token). The token exchange uses your
  **client secret**, which must NOT live in the browser — put it in a **Cloudflare Worker**
  (fits your stack) that the Activity POSTs the code to. Wire the result into `STATE.handle`
  in `src/main.js` (marked with an M2 comment).
- **M3 — multiplayer state.** Share rounds/votes across participants via **Supabase realtime**
  (you already use Supabase) or by bridging to the existing bot. This is where it becomes the
  real reverse-prompt game, not a per-user demo.

---

`www.zengine.site | © 2026 Zengine™`
