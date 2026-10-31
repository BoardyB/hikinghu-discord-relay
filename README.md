# hikinghu-relay

Devvit app that relays every new post in an installed subreddit to a Discord
webhook, creating a Discord thread per Reddit post (replaces the RSS polling in
`bot.py`).

- Trigger: `onPostCreate` (waits for platform safety verification, like the old
  RSS behavior)
- De-duplication: Redis `SET NX` with a 30-day TTL (at-least-once delivery is
  safe; replaces `posted.json`)
- Webhook URL is stored as the `webhookUrl` secret
  (`npx devvit settings set webhookUrl`)
- Webhook failures (non-200/204 or network error) release the dedupe key and
  return 503 so Reddit retries

## Commands

```sh
npm install
npm run test      # typecheck + @devvit/test unit tests (mocked Redis/fetch)
npm run dev       # npm run build then devvit playtest (requires npx devvit login)
npm run build     # bundles server to dist/server/index.cjs (CJS, as required)
```

End-to-end testing (Reddit → Discord): see [TESTING.md](TESTING.md).

## Fetch Domains

The following domains are requested for this app:

- `discord.com` — Used to POST new Reddit posts to an incoming Discord webhook
  (thread creation) on behalf of the installed community. Requests only go to
  the webhook URL configured as the `webhookUrl` secret. No other data leaves
  Reddit.

## Publishing prerequisites

- `npx devvit settings set webhookUrl` after first install (secret value moved
  from the `DISCORD_WEBHOOK_URL` GitHub secret).
- Terms & Conditions and Privacy Policy links are required for fetch-using apps
  before `npx devvit publish`.
