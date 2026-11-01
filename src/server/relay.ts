import {redis, settings} from "@devvit/web/server";
import type {OnPostCreateRequest} from "@devvit/web/shared";

const DEDUPE_KEY_PREFIX = "posted:";
// Short lock while the Discord call is in flight, extended once it succeeds.
// If the process dies mid-flight the lock expires by itself instead of
// silently swallowing the post for 30 days.
const LOCK_TTL_SECONDS = 5 * 60;
const DONE_TTL_SECONDS = 30 * 24 * 60 * 60;
const FETCH_TIMEOUT_MS = 10_000;
const THREAD_NAME_MAX = 90; // Discord allows 100; keep headroom.

/** Retrying cannot help (bad webhook, 4xx from Discord). `hint` is mod-facing advice. */
export class PermanentError extends Error {
  override name = "PermanentError";
  constructor(
    message: string,
    readonly hint = "Open the app settings and check the Discord webhook URL.",
  ) {
    super(message);
  }
}

function discordRejectionHint(status: number): string {
  switch (status) {
    case 400:
      return "Discord refused the message. Most often the webhook's channel is not a Forum channel (only forum channels can create threads).";
    case 401:
    case 403:
      return "Discord rejected the webhook token. Create a new webhook and paste its URL into the app settings.";
    case 404:
      return "The webhook no longer exists (it was probably deleted). Create a new one and paste its URL into the app settings.";
    default:
      return "Check that the webhook still works in Discord, then re-paste its URL in the app settings.";
  }
}

export function buildWebhookBody(
  title: string,
  permalink: string,
  subredditName: string,
): Record<string, unknown> {
  // Spread by code point so an emoji is never cut in half at the boundary.
  const threadName = [...title.trim()].slice(0, THREAD_NAME_MAX).join("") || "New post";
  return {
    thread_name: threadName,
    content: `**New post on r/${subredditName}**\nhttps://www.reddit.com${permalink}`,
    allowed_mentions: { parse: [] },
  };
}

export function parseWebhookUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PermanentError("The webhook URL is not a valid URL.");
  }
  if (url.protocol !== "https:" || url.host !== "discord.com" || !url.pathname.startsWith("/api/webhooks/")) {
    throw new PermanentError(`The webhook URL must start with https://discord.com/api/webhooks/ (got host ${url.host}).`);
  }
  return url;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` (cause: ${error.cause.message})` : "";
  return `${error.name}: ${error.message}${cause}`;
}

async function release(key: string): Promise<void> {
  await redis.del(key).catch((error) => console.error(`failed to release ${key}: ${describe(error)}`));
}

// Resolves when the post was relayed or intentionally skipped.
// Throws PermanentError when retrying is pointless, any other Error when it may help.
export async function handleOnPostCreate(input: OnPostCreateRequest): Promise<void> {
  const post = input.post;
  if (!post?.id || !post.title || !post.permalink) {
    console.warn("onPostCreate missing post fields, skipping");
    return;
  }

  const subredditName = input.subreddit?.name ?? "";
  const rawUrl = await settings.get<string>("discordWebhookUrl");
  if (!rawUrl) {
    // Installed but not configured yet (or paused by a mod): not an error.
    console.warn(`no webhook configured for r/${subredditName}, skipping ${post.id}`);
    return;
  }
  const webhookUrl = parseWebhookUrl(rawUrl);

  const key = DEDUPE_KEY_PREFIX + post.id;
  const acquired = await redis.set(key, "1", {
    nx: true,
    expiration: new Date(Date.now() + LOCK_TTL_SECONDS * 1000),
  });
  if (!acquired) {
    console.log(`${post.id} was already handled, skipping duplicate delivery`);
    return;
  }

  console.log(`sending ${post.id} to Discord`);
  let response: Response;
  try {
    response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildWebhookBody(post.title, post.permalink, subredditName)),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (error) {
    await release(key);
    throw new Error(`discord fetch failed for ${post.id}: ${describe(error)}`);
  }

  console.log(`Discord answered ${response.status} for ${post.id}`);
  if (response.status === 200 || response.status === 204) {
    await redis
      .expire(key, DONE_TTL_SECONDS)
      .catch((error) => console.error(`failed to extend ${key}: ${describe(error)}`));
    console.log(`relayed ${post.id} to Discord`);
    return;
  }

  await release(key);
  const retryAfter = response.headers?.get("retry-after");
  if (response.status === 429 || response.status >= 500) {
    throw new Error(`Discord returned ${response.status}${retryAfter ? ` (retry-after ${retryAfter}s)` : ""}`);
  }
  throw new PermanentError(`Discord rejected the webhook with ${response.status}`, discordRejectionHint(response.status));
}
