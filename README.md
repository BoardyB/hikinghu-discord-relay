# hikinghu-relay

A [Devvit](https://developers.reddit.com) app that relays every new post in a subreddit to Discord. For each
Reddit post it creates one thread in a Discord **forum channel** containing a link to the post. When the post is later
removed by a moderator or deleted, the app deletes that thread again, so removed posts do not pile up in Discord. It
replaces the old RSS-polling.

Reddit hosts and runs the server. There is nothing to deploy or keep running yourself.

- [How it works](#how-it-works)
- [For moderators: setup and support](#for-moderators-setup-and-support)
- [For developers](#for-developers)
- [Publishing and handover](#publishing-and-handover)
- [Fetch domains](#fetch-domains)
- [Known limitations](#known-limitations)

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

| Outcome | What the app does |
| --- | --- |
| Success (Discord 2xx) | Keeps the de-duplication key and the thread record for 30 days. |
| A setting is empty (paused or not configured yet) | Logs and skips. Not an error. |
| Duplicate delivery of the same post | Skipped, so there is never a second thread. |
| **Transient failure**: network error, timeout, Discord 429 or 5xx | Releases the lock and answers `503`, asking Reddit to retry. |
| **Permanent failure**: any other Discord 4xx (revoked token, missing permission, wrong channel) | Releases the lock, answers `200` (retrying cannot help) and sends the mod team a **Modmail notification**, at most once per day. |
| Post removed or deleted, its thread is known | Deletes the thread and forgets it. Discord answering 404 (already gone) counts as success. |
| Post removed before its thread exists | Every removal first leaves a marker for 24 hours and only then looks for the thread, while the relay records the thread first and checks the marker second, so one side always sees the other. A post removed before the relay got to it is skipped, and one removed while Discord is still creating its thread has the thread deleted the moment it exists. |
| Post removed, but no thread is known (never relayed, relayed by an older version, or already deleted) | Nothing to delete. |
| Transient failure while deleting | Answers `503`, asking Reddit to retry. |
| Permanent failure while deleting (for example Discord 401/403) | Answers `200` and sends a **separate** Modmail notification, with its own once-a-day limit. |

Design choices worth knowing:

- **Short lock, then extend.** The de-duplication key is first taken for 5 minutes, and only extended to 30 days after
  Discord confirms. If the process dies mid-request, the lock expires by itself instead of silently swallowing the
  post for a month.
- **A bot, not a webhook.** A webhook can only delete messages it created, and deleting the first message of a forum
  post leaves the thread behind as an empty "Original message was deleted" shell (checked against live Discord). Only
  a bot with the Manage Threads permission can delete the thread itself. Using the bot for creating posts as well
  keeps one way of talking to Discord.
- **Per-subreddit bot.** Each community pastes its own bot token and forum channel ID into the app's settings. The
  app has no hard-coded subreddit, server or token, and a playtest on a dev subreddit uses its own bot and channel,
  so it cannot post into a production channel.
- **Pings are disabled.** Messages are sent with `allowed_mentions: { parse: [] }`, so a post title can never ping
  `@everyone`.
- **The token goes nowhere but Discord.** Requests go only to `https://discord.com/api/v10/`, with paths built from
  validated ids. The token is never logged and never put in a Modmail notice (a test checks both).
- **Only ids are kept.** To delete a thread later the app stores its id, never the title, link or text.
- **Only removals delete.** The app acts on the `removelink` and `spamlink` mod actions and on post deletions.
  Approvals, locks, flair changes and bans are ignored, and a post a moderator re-approves later is not re-relayed.
- **Two separate Modmail limits.** A failing delete and a failing relay each get their own once-a-day notice, so one
  cannot hide the other.

---

## For moderators: setup and support

You do not need to be a developer. Setup takes a few minutes.

### Set up

You need a **Discord bot** for your server. It is only used to create and delete posts, and it never "goes online"
(it makes no gateway connection, so it shows as offline in the member list. That is normal).

**In Discord** (you need to manage the server):

1. Choose or create a **Forum channel**. A normal text channel will not work. The forum must not require a tag on
   every post.
2. In the [Discord developer portal](https://discord.com/developers/applications) create an application (**New
   Application**). Open its **Bot** page, choose **Reset Token** and copy the token. **Treat it like a password.** No
   privileged intents are needed.
3. Invite the bot to your server: **OAuth2**, **URL Generator**, tick the scope `bot` and **no** permissions, open the
   generated URL and pick your server. Keep the bot's permissions that small on purpose, see the note below.
4. Open the forum channel's settings, **Permissions**, add the bot, and allow exactly these four: **View Channel**,
   **Create Posts**, **Send Messages in Posts** and **Manage Threads** (Discord may label the last one differently
   on forum channels. It is the permission that lets the bot delete posts).
5. Turn on **Developer Mode** (User Settings, Advanced), right-click the forum channel and choose **Copy Channel ID**.

**On Reddit** (you need to be a moderator of the subreddit):

1. Open the app's page (find **hikinghu-relay** in the Reddit App Directory, or use the link from the maintainer) and
   choose **Add to community**.
2. Open the app's settings for your subreddit and paste the token into **Discord bot token** and the number into
   **Discord forum channel ID**. Saving checks that both look right.
3. Make a test post. A thread should appear in Discord within a few seconds.

### Day-to-day

| I want to… | Do this |
| --- | --- |
| Pause the relay | Clear the **Discord bot token** or the **Discord forum channel ID** field and save. Posts are skipped until both are filled again. |
| Move to another forum channel | Give the bot the four permissions there and paste the new channel ID. No reinstall is needed. Threads in the old channel can only be deleted while the bot still has **Manage Threads** there. |
| Reset the token (it leaked, or a moderator left) | Reset it in the Discord developer portal and paste the new one. Posts made while it was broken are **not** re-sent. |
| Remove the app | Uninstall it from the subreddit's installed apps. |

> The bot token is stored as a normal subreddit setting, which Reddit does not let apps mark as secret. **Every
> moderator who can open the app's settings can read it.** That is why the bot should only have the four permissions
> above, granted on the forum channel alone and not through a server-wide role: a leaked token can then do no more
> than create and delete posts in that one channel. If it leaks, or a moderator leaves, reset the token in the Discord
> developer portal.

### Troubleshooting

If the relay breaks in a way retrying cannot fix, the app sends a **Modmail notification** titled
*"Discord relay is not working"* with the cause, advice, and a link to the post that was not relayed. It is sent at
most once a day.

| Symptom or message | Likely cause | Fix |
| --- | --- | --- |
| Modmail: *"rejected the bot token"* (Discord 401) | The token was reset or is wrong. | Reset the token in the developer portal and paste the new one. |
| Modmail: *"not allowed to create posts there"* (Discord 403) | The bot lacks a permission on the forum channel. | Allow View Channel, Create Posts and Send Messages in Posts for the bot on that channel. |
| Modmail: *"cannot find that channel"* (Discord 404) | Wrong channel ID, or the bot is not on the server. | Copy the channel ID again and check the bot was invited. |
| Modmail: *"not a Forum channel"* (Discord 400) | The channel is a normal text channel, or the forum requires tags. | Use a **Forum** channel that does not require a tag. |
| Saving a setting shows an error | The token has spaces in it, or the channel ID is not a number of 17 to 20 digits. | Copy it again. A leading `Bot ` in the token is fine. |
| No thread and no Modmail | A setting is empty, the app is not installed, or the post was removed by safety checks. | Check both settings. New posts are relayed only after Reddit's checks pass. |
| Thread appears twice | Should not happen (de-duplicated). | Tell the maintainer. |
| Modmail: *"Discord relay could not delete a thread"* | Discord refused to delete the thread of a removed post, usually because the bot lacks **Manage Threads** on that channel. | Give the bot the permission. Delete the leftover thread by hand in Discord. |
| A removed post's thread is still in Discord | The thread was made before this feature existed, or the post was removed more than 30 days after it was relayed. | Delete the thread by hand. New posts are handled automatically. |

Still stuck? Contact the maintainer: **[https://www.reddit.com/user/boardyb/]**.

---

## For developers

### Requirements

- Node.js 24 recommended (the Devvit CLI warns about older versions) and npm.
- A Reddit account with access to [developers.reddit.com](https://developers.reddit.com).
- A **test subreddit** you moderate with fewer than 200 subscribers (the dev subreddit in `devvit.json` is
  `bbdevtest`).
- A Discord **forum channel** and a **bot** (see the setup steps above) for testing.

### Commands

```sh
npm install
npx devvit login          # once
npm test                  # typecheck + unit tests (no network, no Reddit)
npm run build             # bundle the server to dist/server/index.cjs
npm run dev               # devvit playtest: installs to the dev subreddit, rebuilds on save, streams logs
```

End-to-end testing against real Reddit and Discord: see [TESTING.md](TESTING.md).

### Project layout

```
.github/workflows/ci.yml                 CI: npm ci, npm test, npm run build
devvit.json                    app config: server entry, permissions, triggers, settings, dev subreddit
src/server/index.ts            starts the HTTP server (Hono on Devvit's createServer, on getServerPort())
src/server/app.ts              routes: the post-create, mod-action and post-delete triggers and the settings validation endpoints
src/server/relay.ts            the relay: lookup, de-duplication, Discord create and delete calls
src/server/discord.ts          Discord basics: bot token and channel checks, the REST call, advice per status, retryable-or-permanent classification (no Devvit imports)
src/server/threads.ts          Redis records: the Discord thread id of each post, and which posts were removed
src/server/alerts.ts           Modmail failure notices (relaying, deleting) with a once-a-day cooldown each
src/server/relay.test.ts       unit tests for relaying, validation and alerts (mocked Redis, fetch and Modmail)
src/server/removal.test.ts     unit tests for removing threads, the removal race, the new routes and their alerts
```

### Things that are easy to get wrong

- **The bundle must start a server.** `index.ts` has to call `serve(...)` with `createServer` and `getServerPort()`.
  Exporting the Hono app alone builds fine, but nothing listens, and the platform's trigger call then fails with
  `Failed to POST … fetch failed`. `createServer` also sets up the request context that `redis`, `settings` and
  `reddit` rely on.
- **`dev` must pass `--watch` through to esbuild.** In `devvit.json`, `scripts.dev` is
  `npm run build:server -- --watch=forever`. Without the `--`, npm swallows the flag, esbuild builds once and exits,
  and Devvit warns `scripts.dev exited before producing a first build`.
- **Keep the app testable.** Routes live in `app.ts` and only `index.ts` starts a server, so tests can call
  `app.request(...)` without opening a port.
- **Whether a failure is retried is decided by its error type.** Throw `PermanentError` (from `discord.ts`) only when
  retrying cannot help: the routes then answer `200` and notify the mods by Modmail. Any other error answers `503`, so
  Reddit retries, and `discordError()` already sorts Discord's answers this way.
- **Subreddit settings cannot be secrets.** Devvit allows `isSecret` only on global (developer-set) settings, which
  would mean one bot token for every install. The per-subreddit token (so that every community brings its own bot) is
  therefore visible to that subreddit's moderators. The README tells them to keep the bot's permissions to the one
  forum channel.
- **Never log the token or put it in a notice.** `parseConfig` errors, the Modmail texts and the validation endpoints
  never include it, and a test checks the logs.

### Permissions

| Permission | Why |
| --- | --- |
| `redis` | De-duplication keys, the thread record of each relayed post, removal markers and the alert cooldowns. |
| `http` → `discord.com` | Creating a thread as the configured bot, and deleting it when its post is removed. |
| `reddit` | Sending the Modmail failure notice. |

### Continuous integration

`.github/workflows/ci.yml` runs `npm ci`, `npm test` and `npm run build` on every push and pull request. Keep
`package-lock.json` in sync with `package.json`, because `npm ci` fails otherwise. Never commit `.env` or a bot token.

---

## Publishing and handover

Who can install a version depends on how it was published (as reported by Devvit CLI 0.15.1):

| Command | Who can install it | Review |
| --- | --- | --- |
| `devvit upload` | Only the app owner, and only on a test subreddit under 200 subscribers | None |
| `devvit publish` (unlisted, the default) | Only the app owner, on any subreddit the owner moderates | None: available immediately |
| `devvit publish --public` | Any moderator of any subreddit | Reddit reviews it first |

**Moderators who do not own the app can install it only after a public publish has been approved.** An unlisted
version is useful for the owner's own subreddits, and for trying a version before requesting review. To let the
moderators of a real community install the app:

1. Make sure the fetch-domain request for `discord.com` is approved and that the **Terms & Conditions** and **Privacy
   Policy** links are set (required for apps that use `fetch`). Both are on the app's developer settings page,
   `https://developers.reddit.com/apps/<app-slug>/developer-settings`. Use the GitHub URLs of [TERMS.md](TERMS.md)
   and [PRIVACY.md](PRIVACY.md) (`https://github.com/BoardyB/hikinghu-discord-relay/blob/master/TERMS.md` and
   `.../PRIVACY.md`). `devvit publish` refuses to continue until both are set.
2. Check the README. Reddit's reviewers read it, and a public listing shows it to every moderator browsing the App
   Directory. The CLI picks it up from the root folder, so confirm that the listing shows the text you
   expect.
3. Run `npx devvit publish --public --version <x.y.z>`. This builds the app, uploads the source and
   files a publish request. Use a version number that has not been published before: submitting the same version twice
   fails with "already been submitted for review". `--bump major|minor|patch` picks the next number automatically
   (patch by default).
4. Wait for Reddit's review. You will get an email when the app is approved. The review time is not documented.
5. After approval, send the moderators the app's link and the [setup steps](#for-moderators-setup-and-support) above.

Until the app is approved, only the owner account can install it. If you need it running sooner, the owner account
must moderate the subreddit: run `npx devvit install r/<sub> hikinghu-relay@<version>` from that account.

Useful commands afterwards:

```sh
npx devvit list apps                 # apps you have published
npx devvit list installs r/<sub>     # what is installed in a subreddit
npx devvit view                      # details of an app version
npx devvit logs <sub> --since=15m    # logs of an installation (maintainer only)
npx devvit uninstall <sub>           # remove the app from a subreddit
```

### Ownership and who can fix what

- The Reddit account that runs `devvit publish` **owns the app**, and the CLI has no ownership-transfer or
  collaborator command. Only the owner can ship code changes and read logs.
- Moderators can reconfigure the bot token and channel, pause the relay, and uninstall or reinstall the app. They cannot change
  code. That is why failures are reported to them by Modmail instead of only in logs.
- A private or unlisted version can be installed, reinstalled or updated only by the owner. A **public** listing is what
  lets the mod team reinstall the app themselves if an installation is ever removed.
- If the app should outlive any one person's involvement, publish it from a dedicated shared account whose credentials
  are kept in the team's password manager, and record that decision here.

**Maintainer of record:** **[https://www.reddit.com/user/boardyb/]**

---

## Fetch domains

The following domain is requested for this app:

- `discord.com`: used to create a forum post (a thread) as the bot the installed community's moderators configured, one
  per new Reddit post, and to delete that thread when the post is removed or deleted. Requests go only to
  `https://discord.com/api/v10/`. Creating a thread sends only the post title and a link to the post. Deleting one
  sends no post data, only the thread's id. The bot token is sent as the credential and is stored only in the
  community's own app settings. No other data leaves Reddit.

This use complies with Reddit's fetch guidelines: `discord.com` is a publicly documented API (the REST API),
requested by its exact hostname and used only for the purpose above. The data involved is described in the
[Privacy Policy](PRIVACY.md), and the usage terms are in [TERMS.md](TERMS.md).

---

## Known limitations

- **Retry behaviour is the platform's.** The app answers `503` for transient failures so Reddit can retry. How many
  times, and whether it retries at all, is controlled by Reddit and has not been verified. If a long Discord outage
  matters to you, add a scheduler-based retry or a small Redis queue.
- **The 10-second Discord timeout is unverified on the platform.** The app passes an abort signal to `fetch`. It is
  covered by no test, and it has not been confirmed that Devvit's runtime honors it or what its own request time limit is.
- **Posts that fail permanently are not re-sent.** After fixing the token or the channel, earlier posts do not appear in Discord.
- **Only threads created by this version can be deleted.** Threads made before the thread record existed (including
  those of the earlier webhook-based builds) are left alone. Records last 30 days, so a post removed later than that
  keeps its thread.
- **The bot calls are unverified against live Discord.** That `DELETE /channels/<thread>` removes a whole forum post
  (the documented behaviour), that the create answer's `id` is the thread's id, and which of `onModAction` and
  `onPostDelete` fire for each kind of removal have not been confirmed end to end with the bot. An earlier build that
  deleted only the first message through a webhook was tried live and left the thread behind, which is why the app
  uses a bot. Scenarios 10 to 15 in [TESTING.md](TESTING.md) check all of it.
- **A post that AutoModerator only *filters* into the mod queue** is not treated as removed. Whether Reddit reports
  that as a `removelink` mod action has not been verified. Its thread goes when a moderator removes the post.
- **Re-approved posts are not re-relayed.** If a moderator approves a post after removing it, the thread stays deleted.
- **A delete that fails while the thread is still being created is only logged.** Nothing retries it. The normal
  removal path, by contrast, answers `503` so Reddit retries.
- **One bot token and one forum channel per subreddit**, one thread per post.
- **Failure alerts need the Modmail notification API** and the `reddit` permission. If Reddit changes either,
  failures fall back to being visible only in the maintainer's logs.