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

1. **Discord.** Create a **Forum channel** for testing (it must not require tags). Create a bot as described in the
   README's setup steps: an application with a bot, its token copied, the bot invited with the scope `bot` and no
   permissions, then allowed on the forum channel only: View Channel, Create Posts, Send Messages in Posts and Manage
   Threads. Copy the channel's ID (Developer Mode, right-click the channel, Copy Channel ID). Use a bot of your own for
   testing, never the production one.
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

### Configure the bot (per subreddit, in the app's settings)

There is no `devvit settings set` step. The bot token and the channel are per-subreddit settings, exactly as the
moderators will use them.

1. Open the app's settings for your test subreddit (as a moderator, in Reddit's installed-apps settings for that
   subreddit. The exact menu location is Reddit's and may change).
2. Paste the bot token into **Discord bot token** and the channel ID into **Discord forum channel ID**, and save.

Your test subreddit has its own setting values, so testing can never post into a production Discord channel. Note
that every moderator of the test subreddit can read the token.

### Scenarios

Run these in order. Create posts as a normal text post in the test subreddit. Watch the playtest log stream.

| # | Scenario | Do | Expected |
| --- | --- | --- | --- |
| 1 | **Happy path** | Create a post. | One thread named after the title, containing `**New post on r/<sub>**` and the link. Log: `relayed t3_… to Discord`. |
| 2 | **De-duplication** | Refresh and re-trigger the same post. | Still exactly one thread. |
| 3 | **Long or emoji title** | Post a title of about 120 characters, with emoji near the end. | Thread name is cut at 90 characters with no broken character. |
| 4 | **Settings validation** | Save `two words` as the token and `#forum` as the channel ID. | Each form shows an error (spaces in the token, "Copy Channel ID" for the channel). Empty values save fine, and so does a token pasted with a leading `Bot `. |
| 5 | **Pause** | Clear the token (or the channel ID), then post. | No thread. Log: `relay is not configured … skipping`. No Modmail. |
| 6 | **Reset token (permanent, 401)** | Put the settings back, reset the bot's token in the developer portal without updating the app, then post. | No thread. One Modmail notification *"Discord relay is not working"* saying Discord rejected the bot token, with the post link. A second failing post the same day sends **no** second notice. |
| 7 | **Wrong channel (permanent, 400 or 404)** | Paste the ID of a normal *text* channel, then post. Try a made-up ID too, and remove the bot's Create Posts permission once. | The Modmail hint mentions a Forum channel (400), the channel ID and the invite (404), or Create Posts (403). |
| 8 | **Recovery** | Paste the new token or the right channel ID and post. | Thread appears. Later posts are relayed normally. |
| 9 | **Transient failure (optional)** | Hard to force against real Discord. Rely on the unit tests, or temporarily point the code at an unreachable endpoint in a throwaway branch. | `503` in the logs, **no** Modmail, and the lock is released so a retry can succeed. |

Scenarios 10 to 15 cover removal. **Run scenario 10 first and read its log**: it is the one place where three
assumptions that cannot be checked offline get confirmed against the real services. They are that (a) `DELETE
/channels/<thread>` as the bot removes the whole forum post, (b) Discord's answer to the create call carries the
thread's id as `id`, and (c) the removal reaches the app through `onModAction`, `onPostDelete`, or both. The log says
which trigger fired. (An earlier build that deleted only the first message through a webhook left the thread behind
as "Original message was deleted", which is why the app uses a bot.) If (a) fails, do not publish until it is sorted
out.

| # | Scenario | Do | Expected |
| --- | --- | --- | --- |
| 10 | **Mod removal** | Create a post, wait for its thread, then remove the post as a moderator. | The thread disappears from the forum channel. Log: `mod-action: removelink on t3_…`, `Discord answered 200 to deleting the thread of t3_…` and `the Discord thread of t3_… is gone`. Note whether `post-delete:` also appears. |
| 11 | **Spam removal** | Same, but mark the post as spam. | Same, with `spamlink`. |
| 12 | **Author deletion** | Create a post, then delete it as its author. | The thread disappears. Log: `post-delete: received …`. |
| 13 | **Removed while being relayed** | Remove a post immediately after creating it, or add an AutoModerator rule that removes posts with a certain word and use it in a title. | No thread is left over. Log shows `removed before it was relayed, skipping` or `removed while it was being relayed, deleting its thread`. |
| 14 | **Unrelated mod actions** | On a post that has a thread, approve it, lock it and change its flair. | The thread stays. No `Discord answered … to deleting` line. |
| 15 | **Missing Manage Threads** | Take Manage Threads away from the bot on the forum channel, create a post, then remove it. | The thread stays. Log: `failed permanently, not retrying`. One Modmail *"Discord relay could not delete a thread"*, mentioning Manage Threads. Give the permission back and delete the thread by hand. |

The delete notice has its own once-a-day limit, separate from the relay notice of scenario 6.

For scenario 6, the cooldown lasts 24 hours. To re-test the notice on the same day, either use a fresh install on
another test subreddit or wait. Do not shorten the cooldown in production code.

### Reading logs

```sh
npx devvit logs <your_test_sub> --since=15m --verbose
```

Log lines the app writes: `relayed <id> to Discord`, `the botToken setting is empty` (or `forumChannelId`) followed by
`relay is not configured for r/<sub>, skipping <id>`,
`onPostCreate missing post fields, skipping`, `onPostCreate permanent failure: …`,
`onPostCreate failed, asking for retry: …`, `could not notify mods: …`.

Removal adds: `mod-action: <action> on <id> in r/<sub>`, `post-delete: received <id> …`,
`Discord answered <status> to deleting the thread of <id>`, `the Discord thread of <id> is gone`,
`no thread recorded for <id>, nothing to delete` (normal for posts relayed before this feature, or never relayed),
`<id> was removed before it was relayed, skipping`, `<id> was removed while it was being relayed, deleting its thread`,
`Discord did not say which thread it created for <id> …` (the thread cannot be deleted later, so check scenario 10's
assumption (b)), and `… failed permanently, not retrying: …` for a delete Discord refused.

---

## 2. Pre-publish checklist

- [ ] `npm test` passes and `npm run build` succeeds, locally and in CI.
- [ ] `package-lock.json` is committed and in sync (`npm ci` works).
- [ ] Scenarios 1, 2, 4, 5, 6 and 8 pass on the test subreddit.
- [ ] Scenarios 10, 12 and 13 pass, and scenario 10's log confirmed which removal trigger fires (see its note above).
- [ ] The Modmail notice in scenario 6 actually arrived and reads well to a non-developer.
- [ ] `discord.com` is approved under the app's developer settings.
- [ ] Terms & Conditions and Privacy Policy links are set.
- [ ] No `.env` file or bot token is committed.
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
| `relay is not configured … skipping` in logs | The bot token or the forum channel ID setting is empty. Set both (see above). |
| `Discord rejected the request with 401` | The bot token was reset or is wrong. Paste the current one. |
| `Discord rejected the request with 403` | The bot lacks View Channel, Create Posts or Send Messages in Posts on the forum channel. |
| `Discord rejected the request with 404` | Wrong channel ID, or the bot was never invited to the server. |
| `Discord rejected the request with 400` | The channel is not a Forum channel, or the forum requires a tag on every post. |
| `Discord returned 429` | Discord rate limit. It is treated as transient, so the post is retried. If it persists, reduce posting bursts. |
| A removed post's thread stays and the log has no `mod-action:` or `post-delete:` line | The triggers did not reach the app. Check that `devvit.json` lists `onModAction` and `onPostDelete`, rebuild, and reload the playtest. |
| `Discord did not say which thread it created for …` | Discord's answer to the create call had no usable message and thread ids, so no record was kept. Check that the create call answered 2xx with a JSON channel object carrying an `id`. |
| `no thread recorded for … nothing to delete` for a post that does have a thread | The thread was made before this feature, or its record expired after 30 days, or Redis was reset by a fresh install. Nothing to fix. |
| `could not notify mods: …` | Modmail failed (missing `reddit` permission in `devvit.json`, or an API error). The relay itself is unaffected. Fix the permission and republish. |
| `subreddit is missing from Context` when you `curl` the server locally | Expected. Devvit's wrapper requires the platform's `devvit-*` headers, which Reddit adds. Test through `app.request(...)` in unit tests or through a real playtest instead. |
| `EADDRINUSE … :::5678` | You ran `devvit logs` while `npm run dev` is already streaming. Use the playtest's own log output, or stop it first. |