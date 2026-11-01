# Testing guide

Two layers: fast **unit tests** that need nothing but Node, and a manual **end-to-end playtest** against real Reddit
and Discord. Run the unit tests on every change. Run the end-to-end checklist before every `devvit publish`.

All commands below are run from the root folder.

- [1. End-to-end playtest](#1-end-to-end-playtest)
- [2. Pre-publish checklist](#2-pre-publish-checklist)
- [3. Troubleshooting](#3-troubleshooting)

---

## 1. End-to-end playtest

### One-time setup

1. **Discord.** Create a **Forum channel** for testing. Add a webhook (channel settings, Integrations, Webhooks, New
   Webhook) and copy the URL. It must start with `https://discord.com/`. The legacy `discordapp.com` host is not
   allowed.
2. **Test subreddit.** Create a small private subreddit you moderate (under 200 subscribers), for example
   `hikinghu_relay_dev`. This repo's `devvit.json` uses `bbdevtest`, so either use that or change `dev.subreddit`
   (or export `DEVVIT_SUBREDDIT=your_test_sub` per session).
3. **Log in.** `npm install` and then `npx devvit login`.
4. **Create the app on Reddit's side**, once: `npx devvit init --force`, and keep the app name `hikinghu-relay`.

### Start the playtest

```sh
npm run dev
```

This builds the server, installs a playtest version on the test subreddit, rebuilds on every save, and streams logs.
Wait for the **Playtest ready** box. `Warning: scripts.dev exited before producing a first build` means the watch
script is wrong (see [Troubleshooting](#4-troubleshooting)).

### Configure the webhook (per subreddit, in the app's settings)

There is no `devvit settings set` step any more. The webhook is a per-subreddit setting, exactly as the moderators
will use it.

1. Open the app's settings for your test subreddit (as a moderator, in Reddit's installed-apps settings for that
   subreddit. The exact menu location is Reddit's and may change).
2. Paste the test webhook URL into **Discord webhook URL** and save.

Your test subreddit has its own setting value, so testing can never post into a production Discord channel.

### Scenarios

Run these in order. Create posts as a normal text post in the test subreddit. Watch the playtest log stream.

| # | Scenario | Do | Expected |
| --- | --- | --- | --- |
| 1 | **Happy path** | Create a post. | One thread named after the title, containing `**New post on r/<sub>**` and the link. Log: `relayed t3_… to Discord`. |
| 2 | **De-duplication** | Refresh and re-trigger the same post. | Still exactly one thread. |
| 3 | **Long or emoji title** | Post a title of about 120 characters, with emoji near the end. | Thread name is cut at 90 characters with no broken character. |
| 4 | **Settings validation** | Save `https://example.com/x` in the setting. | The form shows an error mentioning `discord.com`. Empty value saves fine. |
| 5 | **Pause** | Clear the setting, then post. | No thread. Log: `no webhook configured … skipping`. No Modmail. |
| 6 | **Deleted webhook (permanent, 404)** | Put the URL back, delete the webhook in Discord, then post. | No thread. One Modmail notification *"Discord relay is not working"* saying the webhook no longer exists, with the post link. A second failing post the same day sends **no** second notice. |
| 7 | **Wrong channel type (permanent, 400)** | Create a webhook in a normal *text* channel, paste it, then post. | Modmail hint mentions a Forum channel. |
| 8 | **Recovery** | Paste a good webhook and post. | Thread appears. Later posts are relayed normally. |
| 9 | **Transient failure (optional)** | Hard to force against real Discord. Rely on the unit tests, or temporarily point the code at an unreachable endpoint in a throwaway branch. | `503` in the logs, **no** Modmail, and the lock is released so a retry can succeed. |

For scenario 6, the cooldown lasts 24 hours. To re-test the notice on the same day, either use a fresh install on
another test subreddit or wait. Do not shorten the cooldown in production code.

### Reading logs

```sh
npx devvit logs <your_test_sub> --since=15m --verbose
```

Log lines the app writes: `relayed <id> to Discord`, `no webhook configured for r/<sub>, skipping <id>`,
`onPostCreate missing post fields, skipping`, `onPostCreate permanent failure: …`,
`onPostCreate failed, asking for retry: …`, `could not notify mods: …`.

---

## 2. Pre-publish checklist

- [ ] `npm test` passes and `npm run build` succeeds, locally and in CI.
- [ ] `package-lock.json` is committed and in sync (`npm ci` works).
- [ ] Scenarios 1, 2, 4, 5, 6 and 8 pass on the test subreddit.
- [ ] The Modmail notice in scenario 6 actually arrived and reads well to a non-developer.
- [ ] `discord.com` is approved under the app's developer settings.
- [ ] Terms & Conditions and Privacy Policy links are set.
- [ ] No `.env` file or webhook URL is committed.
- [ ] The README's support contact and maintainer-of-record placeholders are filled in.
- [ ] The app was published with `--public` and Reddit's approval email has arrived. An unlisted version cannot be
    installed by other moderators.
- [ ] The moderators have the install link and the setup steps from the README.

After the moderators install it, run scenario 1 once in the real subreddit and confirm they can find the app's
settings and the Modmail notifications.

---

## 3. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Failed to POST … /internal/triggers/post-create; … fetch failed` | The platform could not reach your server. Most likely the bundle does not listen: `index.ts` must call `serve({ fetch: app.fetch, createServer, port: getServerPort() })`. A bare `export default app` builds fine but never starts a server. Rebuild and reload the playtest. |
| `Warning: scripts.dev exited before producing a first build` | `scripts.dev` in `devvit.json` must be `npm run build:server -- --watch=forever`. Without the `--`, npm swallows `--watch`, esbuild runs once and exits. |
| `Warning: This app was built with Node.js … which is outdated` | Informational. Use Node.js 24. |
| Playtest works but no thread appears, no logs | `discord.com` may not be approved yet under the app's developer settings (requested on first playtest, can take a while). After approval, just post again. No redeploy is needed. |
| `no webhook configured … skipping` in logs | The subreddit setting is empty. Set it (see above). |
| `Discord rejected the webhook with 404` or `401` / `403` | Webhook deleted or regenerated. Paste a new URL. |
| `Discord rejected the webhook with 400` | The channel is not a Forum channel. |
| `Discord returned 429` | Discord rate limit. It is treated as transient, so the post is retried. If it persists, reduce posting bursts. |
| `could not notify mods: …` | Modmail failed (missing `reddit` permission in `devvit.json`, or an API error). The relay itself is unaffected. Fix the permission and republish. |
| `subreddit is missing from Context` when you `curl` the server locally | Expected. Devvit's wrapper requires the platform's `devvit-*` headers, which Reddit adds. Test through `app.request(...)` in unit tests or through a real playtest instead. |
| `EADDRINUSE … :::5678` | You ran `devvit logs` while `npm run dev` is already streaming. Use the playtest's own log output, or stop it first. |