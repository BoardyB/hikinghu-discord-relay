# hikinghu-relay

A [Devvit](https://developers.reddit.com) app that relays every new post in a subreddit to Discord. For each
Reddit post it creates one thread in a Discord **forum channel** containing a link to the post. It replaces the old
RSS-polling `bot.py`.

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
   │  1. read the subreddit's "Discord webhook URL" setting (skip if empty)
   │  2. take a short Redis lock for the post id (de-duplication)
   │  3. POST to the Discord webhook (10 s timeout)
   ▼
Discord forum channel: one thread per post
```

| Outcome | What the app does |
| --- | --- |
| Success (Discord 200/204) | Keeps the de-duplication key for 30 days. |
| Setting empty (paused or not configured yet) | Logs and skips. Not an error. |
| Duplicate delivery of the same post | Skipped, so there is never a second thread. |
| **Transient failure**: network error, timeout, Discord 429 or 5xx | Releases the lock and answers `503`, asking Reddit to retry. |
| **Permanent failure**: any other Discord 4xx (deleted webhook, bad token, not a forum channel) | Releases the lock, answers `200` (retrying cannot help) and sends the mod team a **Modmail notification**, at most once per day. |

Design choices worth knowing:

- **Short lock, then extend.** The de-duplication key is first taken for 5 minutes, and only extended to 30 days after
  Discord confirms. If the process dies mid-request, the lock expires by itself instead of silently swallowing the
  post for a month.
- **Per-subreddit webhook.** Each community pastes its own webhook URL into the app's settings. The app has no
  hard-coded subreddit, and a playtest on a dev subreddit uses its own webhook, so it cannot post into a production
  channel.
- **Pings are disabled.** Messages are sent with `allowed_mentions: { parse: [] }`, so a post title can never ping
  `@everyone`.
- **Only `discord.com` webhook URLs are accepted**, both when the setting is saved and again before every request.

---

## For moderators: setup and support

You do not need to be a developer. Setup takes a few minutes.

### Set up

**In Discord** (you need the *Manage Webhooks* permission):

1. Choose or create a **Forum channel**. A normal text channel will not work, because only forum channels can create
   threads from a webhook.
2. Open the channel's settings, then **Integrations**, then **Webhooks**, then **New Webhook**.
3. Copy the webhook URL. It looks like `https://discord.com/api/webhooks/…`. **Treat it like a password.**

**On Reddit** (you need to be a moderator of the subreddit):

1. Open the app's install page (ask the maintainer for the link) and choose **Add to community**.
2. Open the app's settings for your subreddit and paste the URL into **Discord webhook URL**. Saving checks that the
   URL looks like a Discord webhook.
3. Make a test post. A thread should appear in Discord within a few seconds.

### Day-to-day

| I want to… | Do this |
| --- | --- |
| Pause the relay | Clear the **Discord webhook URL** field and save. Posts are skipped until you paste a URL again. |
| Move to another channel | Create a webhook there and paste the new URL. No reinstall is needed. |
| Regenerated or deleted the webhook | Paste the new URL. Posts made while it was broken are **not** re-sent. |
| Remove the app | Uninstall it from the subreddit's installed apps. |

> The webhook URL is stored as a normal subreddit setting, which Reddit does not let apps mark as secret. It is visible
> to the moderators who can open the app's settings. Share it only with people you trust, and if it leaks, delete the
> webhook in Discord and create a new one.

### Troubleshooting

If the relay breaks in a way retrying cannot fix, the app sends a **Modmail notification** titled
*"Discord relay is not working"* with the cause, advice, and a link to the post that was not relayed. It is sent at
most once a day.

| Symptom or message | Likely cause | Fix |
| --- | --- | --- |
| Modmail: *"webhook no longer exists"* (Discord 404) | The webhook was deleted in Discord. | Create a new webhook and paste its URL. |
| Modmail: *"rejected the webhook token"* (Discord 401/403) | The webhook was regenerated or revoked. | Create a new webhook and paste its URL. |
| Modmail: *"not a Forum channel"* (Discord 400) | The webhook's channel is a normal text channel. | Create the webhook in a **Forum** channel. |
| Saving the setting shows an error | The URL is not `https://discord.com/api/webhooks/…`. | Copy it again from Discord. Old `discordapp.com` URLs are not accepted. |
| No thread and no Modmail | Setting is empty, the app is not installed, or the post was removed by safety checks. | Check the setting. New posts are relayed only after Reddit's checks pass. |
| Thread appears twice | Should not happen (de-duplicated). | Tell the maintainer. |

Still stuck? Contact the maintainer: **[https://www.reddit.com/user/boardyb/]**.

---

## For developers

### Requirements

- Node.js 24 recommended (the Devvit CLI warns about older versions) and npm.
- A Reddit account with access to [developers.reddit.com](https://developers.reddit.com).
- A **test subreddit** you moderate with fewer than 200 subscribers (the dev subreddit in `devvit.json` is
  `bbdevtest`).
- A Discord **forum channel** and webhook for testing.

### Commands

The app lives in the `devvit-app/` folder. Run everything below from there.

```sh
cd devvit-app
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
devvit-app/devvit.json                    app config: server entry, permissions, trigger, settings, dev subreddit
devvit-app/src/server/index.ts            starts the HTTP server (Hono on Devvit's createServer, on getServerPort())
devvit-app/src/server/app.ts              routes: the post-create trigger and the settings validation endpoint
devvit-app/src/server/relay.ts            the relay: lookup, de-duplication, Discord call, error classification
devvit-app/src/server/alerts.ts           Modmail failure notice with a once-a-day cooldown
devvit-app/src/server/relay.test.ts       unit tests (mocked Redis, fetch and Modmail)
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
- **Subreddit settings cannot be secrets.** Devvit allows `isSecret` only on global (developer-set) settings. That is
  why the webhook is a per-subreddit setting that mods manage themselves.

### Permissions

| Permission | Why |
| --- | --- |
| `redis` | De-duplication keys and the alert cooldown. |
| `http` → `discord.com` | Posting to the Discord webhook. |
| `reddit` | Sending the Modmail failure notice. |

### Continuous integration

`.github/workflows/ci.yml` runs `npm ci`, `npm test` and `npm run build` on every push and pull request. Keep
`package-lock.json` in sync with `package.json`, because `npm ci` fails otherwise. Never commit `.env` or a webhook
URL.

---

## Publishing and handover

`devvit upload` is for development only: the version is visible only to the app owner and can be installed only on a
small test subreddit (under 200 subscribers). To let moderators of a real community install the app:

1. Make sure the fetch-domain request for `discord.com` is approved and that the **Terms & Conditions** and **Privacy
   Policy** links are set (required for apps that use `fetch`). Both are on the app's developer settings page,
   `https://developers.reddit.com/apps/<app-slug>/developer-settings`. Use the GitHub URLs of [TERMS.md](TERMS.md)
   and [PRIVACY.md](PRIVACY.md) (`https://github.com/BoardyB/hikinghu-discord-relay/blob/master/TERMS.md` and
   `.../PRIVACY.md`). `devvit publish` refuses to continue until both are set.
2. Run `npx devvit publish`. This uploads the source and files a publish request. It is **unlisted** by default, so the
   app is not in the public directory and is installed through its link. `--public` requests a public listing.
   `--bump major|minor|patch` controls the version (patch by default).
3. Wait for Reddit's review.
4. Send the moderators the app's install link and the [setup steps](#for-moderators-setup-and-support) above.

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
- Moderators can reconfigure the webhook, pause the relay, and uninstall or reinstall the app. They cannot change
  code. That is why failures are reported to them by Modmail instead of only in logs.
- If the app should outlive any one person's involvement, publish it from a dedicated shared account whose credentials
  are kept in the team's password manager, and record that decision here.

**Maintainer of record:** **[https://www.reddit.com/user/boardyb/]**

---

## Fetch domains

The following domain is requested for this app:

- `discord.com`: used to POST new Reddit posts to an incoming Discord webhook (thread creation) on behalf of the
  installed community. Requests go only to the webhook URL the community's moderators configured in the app settings,
  and the app refuses any URL that is not `https://discord.com/api/webhooks/…`. Only the post title and a link to the
  post are sent. No other data leaves Reddit.

This use complies with Reddit's fetch guidelines: `discord.com` is a publicly documented API (incoming webhooks),
requested by its exact hostname and used only for the purpose above. The data involved is described in the
[Privacy Policy](PRIVACY.md), and the usage terms are in [TERMS.md](TERMS.md).

---

## Known limitations

- **Retry behaviour is the platform's.** The app answers `503` for transient failures so Reddit can retry. How many
  times, and whether it retries at all, is controlled by Reddit and has not been verified. If a long Discord outage
  matters to you, add a scheduler-based retry or a small Redis queue.
- **The 10-second Discord timeout is unverified on the platform.** The app passes an abort signal to `fetch`. It is
  covered by no test, and it has not been confirmed that Devvit's runtime honors it or what its own request time limit is.
- **Posts that fail permanently are not re-sent.** After fixing the webhook, earlier posts do not appear in Discord.
- **Removed posts are not removed from Discord.** The thread is created when the post is created.
- **One webhook per subreddit**, one forum channel, one thread per post.
- **Failure alerts need the Modmail notification API** and the `reddit` permission. If Reddit changes either,
  failures fall back to being visible only in the maintainer's logs.