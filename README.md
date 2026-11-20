# hikinghu-relay

A [Devvit](https://developers.reddit.com) app: every new post in a subreddit becomes one thread in a Discord **forum channel**, and when Reddit removes or deletes that post, the app deletes the thread again. Replaces the old RSS-polling. Reddit hosts it — nothing to deploy or keep running.

This repo also ships a **thread cleanup workflow** (GitHub Actions) that deletes stale threads from the forum channel. It is separate from the app and documented under [Thread cleanup workflow](#thread-cleanup-workflow).

- [For moderators: setup](#for-moderators-setup) ← start here, not a developer
- [Day-to-day and troubleshooting](#day-to-day)
- [How it works](#how-it-works)
- [For developers](#for-developers)
- [Publishing and handover](#publishing-and-handover)
- [Fetch domains](#fetch-domains)
- [Thread cleanup workflow](#thread-cleanup-workflow)
- [Known limitations](#known-limitations)

---

## For moderators: setup

Setup takes a few minutes. You need a Discord **bot** for your server. It only creates and deletes posts and never "goes online" (no gateway connection, so it shows as offline in the member list — that is normal).

**In Discord** (you need to manage the server):

1. Choose or create a **Forum channel**. A normal text channel will not work, and the forum must not require a tag on every post.
2. In the [Discord developer portal](https://discord.com/developers/applications) create an application (**New Application**), open its **Bot** page, **Reset Token**, and copy the token. **Treat it like a password.** No privileged intents are needed.
3. Invite the bot: **OAuth2**, **URL Generator**, tick scope `bot`, **no** permissions, open the URL, pick your server. Fewer permissions is deliberate — see the note below.
4. In the forum channel's settings, **Permissions**, add the bot and allow exactly four things: **View Channel**, **Create Posts**, **Send Messages in Posts**, **Manage Threads** (Discord may label the last one differently on forums; it is the one that lets the bot delete posts).
5. Turn on **Developer Mode** (User Settings, Advanced), right-click the forum channel, **Copy Channel ID**.

**On Reddit** (you need to be a moderator of the subreddit):

1. Open the app's page (find **hikinghu-relay** in the Reddit App Directory, or use the link from the maintainer) and choose **Add to community**.
2. In the app's settings for your subreddit, paste the token into **Discord bot token** and the number into **Discord forum channel ID**. Saving validates both.
3. Make a test post. A thread should appear in Discord within a few seconds.

> **Why so few permissions:** the token is stored as a normal subreddit setting (Reddit does not let apps mark these secret), so every moderator who can open the app's settings can read it. With only the four permissions above, granted on the forum channel alone and not through a server-wide role, a leaked token can do no more than create and delete posts in that one channel. If it leaks, or a moderator leaves, reset the token in the developer portal.

## Day-to-day

| I want to…                                       | Do this                                                                                                                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause the relay                                  | Clear the **Discord bot token** or the **Discord forum channel ID** field and save. Posts are skipped until both are filled again.                                                          |
| Move to another forum channel                    | Give the bot the four permissions there and paste the new channel ID. No reinstall needed. Threads in the old channel can only be deleted while the bot still has **Manage Threads** there. |
| Reset the token (it leaked, or a moderator left) | Reset it in the Discord developer portal and paste the new one. Posts made while it was broken are **not** re-sent.                                                                         |
| Remove the app                                   | Uninstall it from the subreddit's installed apps.                                                                                                                                           |

### Troubleshooting

When something breaks in a way retrying cannot fix, the app sends a **Modmail notification** titled _"Discord relay is not working"_ with the cause, advice, and a link to the post that was not relayed. At most once a day.

| Symptom or message                                           | Likely cause                                                                                      | Fix                                                                                      |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Modmail: _"rejected the bot token"_ (Discord 401)            | Token was reset or is wrong.                                                                      | Reset the token in the developer portal and paste the new one.                           |
| Modmail: _"not allowed to create posts there"_ (Discord 403) | Bot lacks a permission on the forum channel.                                                      | Allow View Channel, Create Posts and Send Messages in Posts for the bot on that channel. |
| Modmail: _"cannot find that channel"_ (Discord 404)          | Wrong channel ID, or the bot is not on the server.                                                | Copy the channel ID again and check the bot was invited.                                 |
| Modmail: _"not a Forum channel"_ (Discord 400)               | Channel is a normal text channel, or the forum requires tags.                                     | Use a **Forum** channel that does not require a tag.                                     |
| Saving a setting shows an error                              | Token has spaces in it, or the channel ID is not a number of 17 to 20 digits.                     | Copy it again. A leading `Bot ` in the token is fine.                                    |
| No thread and no Modmail                                     | A setting is empty, the app is not installed, or the post was removed by Reddit's safety checks.  | Check both settings. New posts are relayed only after Reddit's checks pass.              |
| Thread appears twice                                         | Should not happen (de-duplicated).                                                                | Tell the maintainer.                                                                     |
| Modmail: _"Discord relay could not delete a thread"_         | Discord refused to delete the thread of a removed post, usually missing **Manage Threads**.       | Give the bot the permission. Delete the leftover thread by hand in Discord.              |
| A removed post's thread is still in Discord                  | The thread predates this feature, or the post was removed more than 30 days after it was relayed. | Delete the thread by hand. New posts are handled automatically.                          |

Still stuck? Contact the maintainer: **[https://www.reddit.com/user/boardyb/]**.

---

## How it works

```
Reddit (new post, after platform safety checks)
   │  onPostCreate trigger
   ▼
POST /internal/triggers/post-create   ← this app, hosted by Reddit
   │  1. read the subreddit's "bot token" and "forum channel ID" settings (skip if either is empty)
   │  2. skip the post if it was already removed
   │  3. take a short Redis lock for the post id (de-duplication)
   │  4. POST /channels/<forum>/threads as the bot (10 s timeout). Discord answers with the thread it made
   │  5. remember which thread belongs to the post
   ▼
Discord forum channel: one thread per post

Reddit (a mod removes or spams the post, or the post is deleted)
   │  onModAction trigger (removelink, spamlink) and onPostDelete trigger
   ▼
POST /internal/triggers/mod-action  and  /internal/triggers/post-delete
   │  1. read the two settings (skip if either is empty)
   │  2. look up the thread that was created for the post
   │  3. DELETE /channels/<thread> as the bot
   ▼
Thread gone from Discord
```

On failure and on every non-happy path:

| Case                                                                                            | What the app does                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Transient failure** (network error, timeout, Discord 429 or 5xx)                              | Releases the lock and answers `503` so Reddit retries.                                                                                                                                                                                           |
| **Permanent failure** (any other Discord 4xx: revoked token, missing permission, wrong channel) | Releases the lock, answers `200` (retrying cannot help) and sends the mod team a **Modmail notification**, at most once a day.                                                                                                                   |
| A setting is empty (paused or not configured yet)                                               | Logs and skips. Not an error.                                                                                                                                                                                                                    |
| Duplicate delivery of the same post                                                             | Skipped, so there is never a second thread.                                                                                                                                                                                                      |
| A post removed while its thread is being created (or before the relay reached it)               | The removal first leaves a 24-hour marker; the relay and the removal side are ordered so one always sees the other — the thread is skippped or deleted the moment it exists. Discord answering 404 on a delete (already gone) counts as success. |

Design choices, one line each:

- **Short lock, then extend.** The de-duplication key is taken for 5 minutes and only extended to 30 days after Discord confirms; if the process dies mid-request, the lock expires by itself instead of swallowing the post for a month.
- **A bot, not a webhook.** Only a bot with Manage Threads can delete a forum post's thread itself; it is also used for creating posts, so there is one way of talking to Discord. (Why a webhook failed: TESTING.md, scenario 10.)
- **Per-subreddit bot.** Each community pastes its own token and channel ID into the app's settings. No hard-coded subreddit, server or token; a playtest on a dev subreddit uses its own bot and channel, so it cannot post into a production channel.
- **Pings are disabled.** Messages are sent with `allowed_mentions: { parse: [] }`, so a post title can never ping `@everyone`.
- **The token goes nowhere but Discord.** Requests go only to `https://discord.com/api/v10/`, with paths built from validated ids. The token is never logged and never put in a Modmail notice (a test checks both).
- **Only ids are kept.** To delete a thread later the app stores its id, never the title, link or text.
- **Only removals delete.** The app acts on `removelink`, `spamlink` and post deletions. Approvals, locks, flair changes and bans are ignored, and a re-approved post is not re-relayed.
- **Two separate Modmail limits.** A failing delete and a failing relay each get their own once-a-day notice, so one cannot hide the other.

---

## For developers

### Requirements

1. Node.js 24 recommended (the Devvit CLI warns about older versions) and npm.
2. A Reddit account with access to [developers.reddit.com](https://developers.reddit.com).
3. A **test subreddit** you moderate with fewer than 200 subscribers (the dev subreddit in `devvit.json` is `bbdevtest`).
4. A Discord **forum channel** and a **bot** (steps 1–5 under [For moderators: setup](#for-moderators-setup)) for testing.

### Commands

```sh
npm install
npx devvit login          # once
npm test                  # typecheck + unit tests (no network, no Reddit)
npm run build             # bundle the server and the cleanup script to dist/
npm run build:cleanup     # only the cleanup bundle: dist/cleanup/index.cjs
npm run dev               # devvit playtest: installs to the dev subreddit, rebuilds on save, streams logs
```

End-to-end testing against real Reddit and Discord: [TESTING.md](TESTING.md).

### Project layout

```
.github/workflows/ci.yml                 CI: npm ci, npm test, npm run build
.github/workflows/cleanup.yml            thread cleanup job, runs on GitHub Actions (separate from the app)
devvit.json                    app config: server entry, permissions, triggers, settings, dev subreddit
src/server/index.ts            starts the HTTP server (Hono on Devvit's createServer, on getServerPort())
src/server/app.ts              routes: post-create, mod-action and post-delete triggers, settings validation
src/server/relay.ts            the relay: lookup, de-duplication, Discord create and delete calls
src/discord/client.ts          Discord basics: token/channel checks, the REST call, advice per status, retryable-or-permanent classification (no Devvit imports; also used by the cleanup script)
src/discord/cleanup.ts         thread cleanup: list, classify, delete; rate-limit-aware, injected transport for tests
src/discord/cleanup-main.ts    entry point of the cleanup bundle: env parsing, calls runCleanup
src/discord/cleanup.test.ts    unit tests: snowflake dates, classification, runCleanup with a canned transport
src/server/threads.ts          Redis records: the Discord thread id of each post, and which posts were removed
src/server/alerts.ts           Modmail failure notices (relaying, deleting) with a once-a-day cooldown each
src/server/relay.test.ts       unit tests for relaying, validation and alerts (mocked Redis, fetch and Modmail)
src/server/removal.test.ts     unit tests for removing threads, the removal race, the new routes and their alerts
```

### Things that are easy to get wrong

- **The bundle must start a server.** `index.ts` must call `serve(...)` with `createServer` and `getServerPort()`. Exporting the Hono app alone builds fine, but nothing listens and trigger calls fail with `Failed to POST … fetch failed`. `createServer` also sets up the request context that `redis`, `settings` and `reddit` rely on.
- **`dev` must pass `--watch` through to esbuild.** In `devvit.json`, `scripts.dev` is `npm run build:server -- --watch=forever`. Without the `--`, npm swallows the flag, esbuild builds once and exits, and Devvit warns `scripts.dev exited before producing a first build`.
- **Keep the app testable.** Routes live in `app.ts`; only `index.ts` starts a server, so tests call `app.request(...)` without opening a port.
- **Retry-or-permanent rides on the error type.** Throw `PermanentError` (from `discord.ts`) only when retrying cannot help: routes then answer `200` and notify mods by Modmail. Any other error answers `503`, so Reddit retries; `discordError()` already sorts Discord's answers this way.
- **Subreddit settings cannot be secrets.** Devvit allows `isSecret` only on global (developer-set) settings, which would mean one token for every install. The per-subreddit token is therefore visible to that subreddit's moderators — hence the minimal bot permissions (see the setup note).
- **Never log the token or put it in a notice.** `parseConfig` errors, Modmail texts and validation endpoints never include it, and a test checks the logs.

### Permissions

| Permission             | Why                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `redis`                | De-duplication keys, the thread record of each relayed post, removal markers and the alert cooldowns. |
| `http` → `discord.com` | Creating a thread as the configured bot, and deleting it when its post is removed.                    |
| `reddit`               | Sending the Modmail failure notice.                                                                   |

### Continuous integration

`.github/workflows/ci.yml` runs `npm ci`, `npm test` and `npm run build` on every push and pull request. `npm test` includes Prettier checking (`npm run format:check`; `npm run format` fixes), `tsc --noEmit` and the vitest suite. Keep `package-lock.json` in sync with `package.json` or `npm ci` fails. Never commit `.env` or a bot token.

---

## Publishing and handover

Who can install a version depends on how it was published (Devvit CLI 0.15.1):

| Command                                  | Who can install it                                                     | Review                      |
| ---------------------------------------- | ---------------------------------------------------------------------- | --------------------------- |
| `devvit upload`                          | Only the app owner, and only on a test subreddit under 200 subscribers | None                        |
| `devvit publish` (unlisted, the default) | Only the app owner, on any subreddit the owner moderates               | None: available immediately |
| `devvit publish --public`                | Any moderator of any subreddit                                         | Reddit reviews it first     |

**Moderators who do not own the app can install it only after a public publish is approved.** To get there:

1. Set `discord.com` as an approved fetch domain and set the **Terms & Conditions** and **Privacy Policy** links (required for apps that use `fetch`). Both live at `https://developers.reddit.com/apps/<app-slug>/developer-settings`; use the GitHub URLs of [TERMS.md](TERMS.md) and [PRIVACY.md](PRIVACY.md) (`https://github.com/BoardyB/hikinghu-discord-relay/blob/master/TERMS.md` and `.../PRIVACY.md`). `devvit publish` refuses to continue until both are set.
2. Check the README: Reddit's reviewers read it and a public listing shows it to every moderator browsing the App Directory. The CLI picks it up from the root folder, so confirm the listing shows the text you expect.
3. Run `npx devvit publish --public --version <x.y.z>` — it builds, uploads and files the request. Never reuse a version number ("already been submitted for review"); `--bump major|minor|patch` picks the next one (patch by default).
4. Wait for Reddit's review (email on approval; review time not documented).
5. Send the moderators the app link and the [setup steps](#for-moderators-setup).

Until approval, only the owner can install. To run it sooner, the owner account must moderate the subreddit: `npx devvit install r/<sub> hikinghu-relay@<version>`.

Useful commands:

```sh
npx devvit list apps                 # apps you have published
npx devvit list installs r/<sub>     # what is installed in a subreddit
npx devvit view                      # details of an app version
npx devvit logs <sub> --since=15m    # logs of an installation (maintainer only)
npx devvit uninstall <sub>           # remove the app from a subreddit
```

### Ownership

- The Reddit account that runs `devvit publish` **owns the app**, and the CLI has no ownership-transfer or collaborator command. Only the owner can ship code changes and read logs.
- Moderators can reconfigure the token and channel, pause the relay, and uninstall or reinstall the app — not change code. That is why failures are reported to them by Modmail, not only in logs.
- An unlisted version can be installed, reinstalled or updated only by the owner. A **public** listing is what lets the mod team reinstall the app themselves.
- If the app should outlive any one person, publish it from a dedicated shared account whose credentials live in the team's password manager, and record that decision here.

**Maintainer of record:** **[https://www.reddit.com/user/boardyb/]**

> Publishing is deliberately manual with the Devvit CLI, not a GitHub Actions workflow: Reddit offers no dedicated CI credential, and the CLI token is a session artifact the CLI auto-refreshes (rotating its refresh token) — a workflow's long-lived copy goes stale between uses. Investigated in 2026-11 and rejected as not worth the token upkeep.

---

## Fetch domains

- `discord.com` — the app's only outbound domain (`https://discord.com/api/v10/`): one thread per new Reddit post, deleted when the post is, as the community's own bot; delete calls send the thread id only [Privacy Policy](PRIVACY.md) · [TERMS.md](TERMS.md).

---

## Thread cleanup workflow

A standalone GitHub Actions job (`.github/workflows/cleanup.yml`) that deletes stale threads from the forum channel. **Not part of the Devvit app**: it runs outside Reddit, reads nothing from it, and has no effect on the app's permissions, fetch domains, [Terms & Conditions](TERMS.md) or [Privacy Policy](PRIVACY.md).

Daily at 2 AM UTC (cron `0 2 * * *`) it lists the forum channel's active and archived threads and deletes those that have **no replies** (`message_count` 0 — the count excludes the starter post) and were **created more than `INACTIVE_DAYS` days ago** (age from the snowflake id). Threads with any reply are kept, whatever their age.

| Variable             | Meaning                                                                                                                     | Default                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `DISCORD_BOT_TOKEN`  | Bot token, from the `DISCORD_BOT_TOKEN` repository secret                                                                   | required                                 |
| `DISCORD_CHANNEL_ID` | Forum channel ID, from the `DISCORD_CHANNEL_ID` repository secret                                                           | required                                 |
| `INACTIVE_DAYS`      | Delete empty threads older than this many days                                                                              | `14` in the code; the workflow sets `30` |
| `DRY_RUN`            | Report without deleting. Fail-safe: only `false`, `0` or `no` turns it off, any other value (including a typo) is a dry run | dry run                                  |

Manual runs (Actions tab, **Run workflow**) accept two inputs that override the scheduled defaults: `inactive_days` (default `30`) and `dry_run` (default off, meaning real deletions — run a dry run first).

Notes:

- **The token and channel are shared with the app.** The secrets hold the same bot token and channel ID the moderators configured as the app's settings. If the token is reset, update both the app settings and the repository secrets; until then cleanup fails with Discord 401. The channel ID must match the relayed forum channel.
- **Permissions.** Cleanup needs only View Channel and Manage Threads on the forum channel — the four from the app's setup already cover it. It creates no posts and sends no messages.
- **Message counts.** Discord reports `message_count` approximately and stops counting at 50; fine for the "no replies" check, but busy threads may log 50.
- **Listing failures warn but do not stop the run.** If listing (not deleting) fails, the affected part is skipped and the run ends with fewer threads checked. Compare "Threads checked" in the log or GitHub run summary against expectations; a much smaller number than usual means part of the channel was not examined.

Run locally:

```sh
npm run build:cleanup
DISCORD_BOT_TOKEN=... DISCORD_CHANNEL_ID=... INACTIVE_DAYS=30 DRY_RUN=true node dist/cleanup/index.cjs
```

Code: `src/discord/cleanup.ts` (logic), `src/discord/cleanup-main.ts` (entry point), `src/discord/cleanup.test.ts` (tests). How to check it: [TESTING.md](TESTING.md).

---

## Known limitations

- **Retry behaviour is the platform's.** The app answers `503` for transient failures; how many times Reddit retries, or whether at all, is Reddit's and unverified. If a long Discord outage matters, add a scheduler-based retry or a small Redis queue.
- **The 10-second Discord timeout is unverified.** The app passes an abort signal to `fetch`; covered by no test, and unconfirmed whether Devvit's runtime honors it or what its own request time limit is.
- **Posts that fail permanently are not re-sent.** After fixing the token or channel, earlier posts do not appear in Discord.
- **Only threads created by this version can be deleted.** Threads made before the thread record existed (including the earlier webhook-based builds) are left alone, and records last 30 days — a post removed later keeps its thread.
- **The bot calls are unverified against live Discord.** That `DELETE /channels/<thread>` removes a whole forum post (the documented behaviour), that the create answer's `id` is the thread's id, and which of `onModAction`/`onPostDelete` fire per removal kind are not confirmed end to end with the bot. Scenarios 10–15 in [TESTING.md](TESTING.md) check all of it.
- **Edge cases kept as-is.** AutoModerator _filtered_ posts are not treated as removed (whether Reddit reports that as `removelink` is unverified); re-approved posts are not re-relayed; a delete failing while the thread is still being created is only logged (the normal removal path does answer `503`); one bot token and one forum channel per subreddit, one thread per post; failure alerts need the Modmail API and the `reddit` permission — if Reddit changes either, failures fall back to maintainer logs only.
