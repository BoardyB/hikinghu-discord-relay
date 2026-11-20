# Testing guide

Two layers. Run layers in order:

1. `npm test` — fast unit tests, Node only, no network. Run on every change.
2. **End-to-end playtest** against real Reddit and Discord (section 1). Run before every `devvit publish`.

All commands run from the root folder.

- [1. End-to-end playtest](#1-end-to-end-playtest)
- [2. Pre-publish checklist](#2-pre-publish-checklist)
- [3. Troubleshooting](#3-troubleshooting)
- [4. Thread cleanup script](#4-thread-cleanup-script)

---

## 1. End-to-end playtest

### One-time setup

1. **Discord.** Create a **Forum channel** for testing (no tags required). Create a bot per the README's setup steps (application, token copied, invited with scope `bot` and no permissions, allowed on the forum channel only: View Channel, Create Posts, Send Messages in Posts, Manage Threads) and copy the channel ID. Use your own bot, never the production one.
2. **Test subreddit.** Create a private subreddit you moderate (under 200 subscribers), e.g. `hikinghu_relay_dev`. `devvit.json` uses `bbdevtest` — use that, or change `dev.subreddit`, or export `DEVVIT_SUBREDDIT=your_test_sub` per session.
3. **Log in.** `npm install`, then `npx devvit login`.
4. **Create the app on Reddit's side**, once: `npx devvit init --force` (keep the app name `hikinghu-relay`).

### Start and configure

```sh
npm run dev
```

This builds, installs a playtest version on the test subreddit, rebuilds on save, and streams logs. Wait for the **Playtest ready** box (`Warning: scripts.dev exited before producing a first build` means the watch script is wrong — see [Troubleshooting](#3-troubleshooting)).

Then, as a moderator of the test subreddit, set the token and channel in the app's settings — exactly what the moderators will do (there is no `devvit settings set` step):

1. Open the app's settings for your test subreddit.
2. Paste the bot token into **Discord bot token** and the channel ID into **Discord forum channel ID**, save.

Each subreddit has its own setting values, so testing cannot post into a production channel. Note every moderator of the test subreddit can read the token.

### Scenarios

Run in order; create posts as normal text posts; watch the playtest log stream.

**Relaying:**

| #   | Scenario                                   | Do                                                                                                                           | Expected                                                                                                                                                              |
| --- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Happy path**                             | Create a post.                                                                                                               | One thread named after the title, containing `**New post on r/<sub>**` and the link. Log: `relayed t3_… to Discord`.                                                  |
| 2   | **De-duplication**                         | Refresh and re-trigger the same post.                                                                                        | Still exactly one thread.                                                                                                                                             |
| 3   | **Long or emoji title**                    | Title of ~120 characters, emoji near the end.                                                                                | Thread name cut at 90 characters, no broken character.                                                                                                                |
| 4   | **Settings validation**                    | Save `two words` as the token and `#forum` as the channel ID.                                                                | Each form shows an error (spaces in the token; "Copy Channel ID" for the channel). Empty values save fine; a leading `Bot ` on the token is fine.                     |
| 5   | **Pause**                                  | Clear the token (or channel ID), then post.                                                                                  | No thread. Log: `relay is not configured … skipping`. No Modmail.                                                                                                     |
| 6   | **Reset token (permanent, 401)**           | Restore settings, reset the bot's token in the developer portal without updating the app, then post.                         | No thread. One Modmail _"Discord relay is not working"_ naming the rejected token, with the post link. A second failing post the same day sends **no** second notice. |
| 7   | **Wrong channel (permanent, 400/403/404)** | Paste a normal _text_ channel's ID, try a made-up ID, and once remove the bot's Create Posts permission.                     | The Modmail hint mentions a Forum channel (400), the channel ID and invite (404), or Create Posts (403).                                                              |
| 8   | **Recovery**                               | Paste the new token or the right channel ID and post.                                                                        | Thread appears. Later posts relay normally.                                                                                                                           |
| 9   | **Transient failure (optional)**           | Hard to force against real Discord — rely on unit tests, or point the code at an unreachable endpoint on a throwaway branch. | `503` in the logs, **no** Modmail, lock released so a retry can succeed.                                                                                              |

**Removal — run scenario 10 first and read its log.** It is the one place where three assumptions that cannot be checked offline get confirmed against the real services: (a) `DELETE /channels/<thread>` as the bot removes the whole forum post, (b) the create call's answer carries the thread's id as `id`, (c) removals reach the app via `onModAction`, `onPostDelete`, or both — the log says which trigger fired. If (a) fails, do not publish until it is sorted out. (Background: an earlier build that deleted only the first message through a webhook left the thread behind as "Original message was deleted"; that is why the app uses a bot.)

| #   | Scenario                        | Do                                                                                                                                      | Expected                                                                                                                                                                                           |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10  | **Mod removal**                 | Create a post, wait for its thread, remove it as a moderator.                                                                           | Thread disappears. Log: `mod-action: removelink on t3_…`, `Discord answered 200 to deleting the thread of t3_…`, `the Discord thread of t3_… is gone`. Note whether `post-delete:` also appears.   |
| 11  | **Spam removal**                | Same, but mark the post as spam.                                                                                                        | Same, with `spamlink`.                                                                                                                                                                             |
| 12  | **Author deletion**             | Create a post, delete it as its author.                                                                                                 | Thread disappears. Log: `post-delete: received …`.                                                                                                                                                 |
| 13  | **Removed while being relayed** | Remove a post immediately after creating it, or add an AutoModerator rule that removes posts with a certain word and use it in a title. | No leftover thread. Log: `removed before it was relayed, skipping` or `removed while it was being relayed, deleting its thread`.                                                                   |
| 14  | **Unrelated mod actions**       | On a post with a thread: approve, lock, change flair.                                                                                   | Thread stays. No `Discord answered … to deleting` line.                                                                                                                                            |
| 15  | **Missing Manage Threads**      | Take Manage Threads from the bot on the forum channel, create a post, remove it.                                                        | Thread stays. Log: `failed permanently, not retrying`. One Modmail _"Discord relay could not delete a thread"_, mentioning Manage Threads. Give the permission back and delete the thread by hand. |

The delete notice (scenario 15) has its own once-a-day limit, separate from the relay notice (scenario 6). For scenario 6, the cooldown lasts 24 hours — to re-test the same day, use a fresh install on another test subreddit or wait. Do not shorten the cooldown in production code.

### Reading logs

```sh
npx devvit logs <your_test_sub> --since=15m --verbose
```

- **Relay:** `relayed <id> to Discord`, `the botToken setting is empty` (or `forumChannelId`) followed by `relay is not configured for r/<sub>, skipping <id>`, `onPostCreate missing post fields, skipping`, `onPostCreate permanent failure: …`, `onPostCreate failed, asking for retry: …`, `could not notify mods: …`.
- **Removal adds:** `mod-action: <action> on <id> in r/<sub>`, `post-delete: received <id> …`, `Discord answered <status> to deleting the thread of <id>`, `the Discord thread of <id> is gone`, `no thread recorded for <id>, nothing to delete` (normal for posts relayed before this feature or never relayed), `<id> was removed before it was relayed, skipping`, `<id> was removed while it was being relayed, deleting its thread`, `Discord did not say which thread it created for <id> …` (thread cannot be deleted later — check assumption (b)), `… failed permanently, not retrying: …` (a delete Discord refused).

---

## 2. Pre-publish checklist

- [ ] `npm test` passes and `npm run build` succeeds, locally and in CI.
- [ ] `package-lock.json` is committed and in sync (`npm ci` works).
- [ ] Scenarios 1, 2, 4, 5, 6, 8 pass on the test subreddit.
- [ ] Scenarios 10, 12, 13 pass; scenario 10's log confirmed which removal trigger fires.
- [ ] The scenario 6 Modmail notice actually arrived and reads well to a non-developer.
- [ ] `discord.com` approved under the app's developer settings.
- [ ] Terms & Conditions and Privacy Policy links are set.
- [ ] No `.env` file or bot token committed.
- [ ] README support contact and maintainer-of-record placeholders filled in.
- [ ] Published with `--public` and Reddit's approval email arrived (an unlisted version cannot be installed by other moderators).
- [ ] Moderators have the install link and the README's setup steps.

After the moderators install it, run scenario 1 once in the real subreddit and confirm they can find the settings and the Modmail notifications.

---

## 3. Troubleshooting

| Symptom                                                                           | Cause and fix                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Failed to POST … /internal/triggers/post-create; … fetch failed`                 | The platform could not reach your server: `index.ts` must call `serve({ fetch: app.fetch, createServer, port: getServerPort() })`. A bare `export default app` builds fine but never starts a server. Rebuild and reload the playtest. |
| `Warning: scripts.dev exited before producing a first build`                      | `scripts.dev` in `devvit.json` must be `npm run build:server -- --watch=forever`. Without the `--`, npm swallows `--watch`, esbuild runs once and exits.                                                                               |
| `Warning: This app was built with Node.js … which is outdated`                    | Informational. Use Node.js 24.                                                                                                                                                                                                         |
| Playtest works but no thread appears, no logs                                     | `discord.com` not yet approved under the app's developer settings (requested on first playtest, can take a while). After approval, just post again — no redeploy needed.                                                               |
| `relay is not configured … skipping` in logs                                      | Bot token or forum channel ID setting is empty. Set both.                                                                                                                                                                              |
| `Discord rejected the request with 401`                                           | Token reset or wrong. Paste the current one.                                                                                                                                                                                           |
| `Discord rejected the request with 403`                                           | Bot lacks View Channel, Create Posts or Send Messages in Posts on the forum channel.                                                                                                                                                   |
| `Discord rejected the request with 404`                                           | Wrong channel ID, or the bot was never invited to the server.                                                                                                                                                                          |
| `Discord rejected the request with 400`                                           | The channel is not a Forum channel, or the forum requires a tag on every post.                                                                                                                                                         |
| `Discord returned 429`                                                            | Discord rate limit; treated as transient, so the post is retried. If it persists, reduce posting bursts.                                                                                                                               |
| A removed post's thread stays, no `mod-action:` or `post-delete:` line in the log | Trigger did not reach the app. Check `devvit.json` lists `onModAction` and `onPostDelete`, rebuild, reload the playtest.                                                                                                               |
| `Discord did not say which thread it created for …`                               | The create call's answer had no usable message/thread ids, so no record was kept. Check the create call answered 2xx with a JSON channel object carrying an `id`.                                                                      |
| `no thread recorded for … nothing to delete` for a post that does have a thread   | Thread made before this feature, record expired after 30 days, or Redis reset by a fresh install. Nothing to fix.                                                                                                                      |
| `could not notify mods: …`                                                        | Modmail failed (missing `reddit` permission in `devvit.json`, or an API error). The relay itself is unaffected. Fix the permission and republish.                                                                                      |
| `subreddit is missing from Context` when you `curl` the server locally            | Expected. Devvit's wrapper requires the platform's `devvit-*` headers, which Reddit adds. Test via `app.request(...)` in unit tests or a real playtest instead.                                                                        |
| `EADDRINUSE … :::5678`                                                            | You ran `devvit logs` while `npm run dev` is already streaming. Use the playtest's own log output, or stop it first.                                                                                                                   |

---

## 4. Thread cleanup script

The cleanup job (README: [Thread cleanup workflow](#thread-cleanup-workflow)) runs daily on GitHub Actions, reads no Reddit data, and needs the `DISCORD_BOT_TOKEN` and `DISCORD_CHANNEL_ID` repository secrets (the same bot token and forum channel as the app's settings).

| Check                  | How                                                                                                                   | Expected                                                                                                                                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests             | `npm test` (includes `src/discord/cleanup.test.ts`, no network).                                                      | Pass.                                                                                                                                                                                                                                 |
| Local dry run          | `npm run build:cleanup`, then run `dist/cleanup/index.cjs` with the two env vars, `INACTIVE_DAYS=30`, `DRY_RUN=true`. | Header `DRY RUN MODE ENABLED`, `[DRY RUN] Would delete inactive thread: …` only for empty threads older than the cutoff, then `=== Summary ===` with `Threads checked` and `Threads deleted`. No thread deleted — verify the channel. |
| CI dry run             | Actions tab, Cleanup Inactive Threads, Run workflow, tick **Dry run**.                                                | Same as the local run, in the job log.                                                                                                                                                                                                |
| CI live run            | Run workflow with **Dry run** off, after a dry run looked sane.                                                       | Empty, old threads disappear; threads with replies stay. Delete lines read `Deleting inactive thread: …`.                                                                                                                             |
| Bad or missing secret  | Temporarily invalidate the `DISCORD_BOT_TOKEN` secret, run the workflow.                                              | Job fails with a channel/token error message, exits nonzero.                                                                                                                                                                          |
| Missing Manage Threads | Remove the bot's Manage Threads permission on the forum channel, run live.                                            | Per-thread `Permission denied to access thread: '…'` lines; the run still ends with a summary.                                                                                                                                        |

`DRY_RUN` parsing is fail-safe: only `false`, `0` or `no` enables deletions — any other value (typo, missing variable) is a dry run. `INACTIVE_DAYS` must be a positive number or the job fails with a clear message.
