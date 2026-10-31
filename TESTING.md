# E2E Test Guide

One-time setup, then two commands. Goal: a post in your test subreddit creates a
thread in your Discord channel.

## One-time setup

1. **Discord webhook** — In your test channel: Channel settings → Integrations →
   Webhooks → New Webhook → Copy URL. Confirm the URL starts with
   `https://discord.com/` (not the legacy `discordapp.com`, which isn't
   allow-listed).
2. **Test subreddit** — easiest: create a private one at
   [reddit.com/subreddits/create](https://www.reddit.com/subreddits/create)
   named e.g. `hikinghu_relay_dev` (unique name, type Private). Creating it
   makes you a moderator automatically; private is ideal for playtest noise.
3. **Login** —
   ```sh
   cd devvit-app && npm install
   npx devvit login
   ```
4. **Create the app on Reddit's side** (one-time, needs the login from step 3):
   ```sh
   npx devvit init --force
   ```
   Follow the browser confirmation and keep the app name `hikinghu-relay`.
5. **Configure the playtest subreddit** — either set it once:
   ```sh
   # devvit.json
   "dev": { "subreddit": "your_test_sub" }
   ```
   or export `DEVVIT_SUBREDDIT=your_test_sub` each session.

## Run a test

6. **Start the playtest** (installs the app on your test sub, rebuilds on save,
   streams logs):
   ```sh
   npm run dev
   ```
7. **Set the secret** — after the first install (the CLI needs one install).
   Run the key-only command and paste the webhook URL at the prompt:
   ```sh
   npx devvit settings set webhookUrl
   ```
8. **Post something** in your test subreddit (a normal text post, frontend or
   API).
9. **Check Discord** — a thread named `<title>` containing
   `**New post on r/hikingHungary**` + the Reddit link should appear within
   seconds. Only one thread, even if you refresh/re-trigger — that's the Redis
   dedupe.
10. **Watch logs** to trace what happened:
   ```sh
   npx devvit logs your_test_sub --since=15m --verbose
   ```

## If it fails

- **`Failed to POST ... fetch failed`** — the outbound call was blocked before
  it reached Discord: check that `discord.com` is approved under your app's
  Developer Settings (requests are submitted on first playtest; global-allowlist
  domains usually clear in 1–2 business days at most). After approval, just
  post again — no redeploy needed. If already approved, re-check the webhook
  secret (step 7).
- **No thread, no logs** — check that `discord.com` is approved under your app's
  Developer Settings (requests are submitted on first playtest; global-allowlist
  domains usually clear in 1–2 business days at most).
- **`webhookUrl secret is not set`** — repeat step 7.
- **503 / "Discord webhook returned ..."** in logs — Redis dedupe is working
  (release + retry). Fix the cause, then re-trigger a new post.
- **Regenerated webhook?** — just re-run step 7; no code change.
- **`EADDRINUSE ... :::5678`** — you ran `devvit logs` while `npm run dev` is
  streaming. Use the playtest's own log output, or stop it first.
