import {redis, settings} from "@devvit/web/server";
import type {OnPostCreateRequest} from "@devvit/web/shared";
import {
  createRejectionHint,
  deleteRejectionHint,
  type DiscordConfig,
  discordError,
  discordRequest,
  parseConfig,
} from "./discord";
import {clearThread, isMarkedRemoved, isSnowflake, loadThread, markRemoved, saveThread} from "./threads";

const DEDUPE_KEY_PREFIX = "posted:";
// Short lock while the Discord call is in flight, extended once it succeeds: a crash
// mid-flight must not swallow the post for 30 days.
const LOCK_TTL_SECONDS = 5 * 60;
const DONE_TTL_SECONDS = 30 * 24 * 60 * 60;
const THREAD_NAME_MAX = 90; // Discord allows 100; keep headroom

export function buildThreadBody(
  title: string,
  permalink: string,
  subredditName: string,
): Record<string, unknown> {
  // Spread by code point so an emoji is never cut in half at the boundary.
  const threadName = [...title.trim()].slice(0, THREAD_NAME_MAX).join("") || "New post";
  return {
    name: threadName,
    message: {
      content: `**New post on r/${subredditName}**\nhttps://www.reddit.com${permalink}`,
      allowed_mentions: { parse: [] },
    },
  };
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? ` (cause: ${error.cause.message})` : "";
  return `${error.name}: ${error.message}${cause}`;
}

async function release(key: string): Promise<void> {
  await redis.del(key).catch((error) => console.error(`failed to release ${key}: ${describe(error)}`));
}

// Empty means paused or not configured yet, which is not an error.
async function readConfig(): Promise<DiscordConfig | undefined> {
  const [token, channelId] = await Promise.all([
    settings.get<string>("botToken"),
    settings.get<string>("forumChannelId"),
  ]);
  if (!token || !channelId) {
    const missing = [!token && "botToken", !channelId && "forumChannelId"].filter(Boolean).join(" and ");
    console.warn(`the ${missing} setting is empty`);
    return undefined;
  }
  return parseConfig(token, channelId);
}

export async function handleOnPostCreate(input: OnPostCreateRequest): Promise<void> {
  const post = input.post;
  if (!post?.id || !post.title || !post.permalink) {
    console.warn("onPostCreate missing post fields, skipping");
    return;
  }

  const subredditName = input.subreddit?.name ?? "";
  const config = await readConfig();
  if (!config) {
    console.warn(`relay is not configured for r/${subredditName}, skipping ${post.id}`);
    return;
  }

  if (await isMarkedRemoved(post.id)) {
    // AutoModerator can remove a post within moments of its creation.
    console.log(`${post.id} was removed before it was relayed, skipping`);
    return;
  }

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
    response = await discordRequest(
      config,
      "POST",
      `/channels/${config.channelId}/threads`,
      buildThreadBody(post.title, post.permalink, subredditName),
    );
  } catch (error) {
    await release(key);
    throw new Error(`discord fetch failed for ${post.id}: ${describe(error)}`);
  }

  console.log(`Discord answered ${response.status} for ${post.id}`);
  if (response.ok) {
    await redis
      .expire(key, DONE_TTL_SECONDS)
      .catch((error) => console.error(`failed to extend ${key}: ${describe(error)}`));
    console.log(`relayed ${post.id} to Discord`);
    await rememberThread(post.id, config, response);
    return;
  }

  await release(key);
  throw discordError(response, `Discord rejected the request with ${response.status}`, createRejectionHint(response.status));
}

// Never throws: the post is already in Discord, and failing here would only make Reddit retry
// a post that is now de-duplicated.
async function rememberThread(postId: string, config: DiscordConfig, response: Response): Promise<void> {
  let threadId: string | undefined;
  try {
    // Discord answers with the thread it created, and a forum post's thread is a channel with its own id.
    const body = (await response.json()) as { id?: unknown } | null;
    if (isSnowflake(body?.id)) threadId = body.id;
  } catch {
    // No body, or not JSON.
  }
  if (!threadId) {
    console.warn(`Discord did not say which thread it created for ${postId}, so it cannot be deleted if the post is removed`);
    return;
  }

  try {
    await saveThread(postId, threadId);
    if (await isMarkedRemoved(postId)) {
      console.log(`${postId} was removed while it was being relayed, deleting its thread`);
      await deleteThread(config, postId, threadId);
    }
  } catch (error) {
    console.error(`could not record or clean up the thread of ${postId}: ${describe(error)}`);
  }
}

// Deletes the thread itself. A webhook could only delete the first message and would leave the
// thread behind.
async function deleteThread(config: DiscordConfig, postId: string, threadId: string): Promise<void> {
  let response: Response;
  try {
    response = await discordRequest(config, "DELETE", `/channels/${threadId}`);
  } catch (error) {
    throw new Error(`discord delete failed for ${postId}: ${describe(error)}`);
  }

  console.log(`Discord answered ${response.status} to deleting the thread of ${postId}`);
  if (response.ok || response.status === 404) {
    // 404 means the thread is already gone, which is the outcome we wanted.
    await clearThread(postId);
    console.log(`the Discord thread of ${postId} is gone`);
    return;
  }

  throw discordError(
    response,
    `Discord refused to delete the thread of a removed post (${response.status})`,
    deleteRejectionHint(response.status),
  );
}

export async function handleRemoval(postId: string): Promise<void> {
  const config = await readConfig();
  if (!config) {
    // Paused or not configured: nothing is relayed, and there is no bot to delete with.
    console.warn(`relay is not configured, cannot delete the thread of ${postId}`);
    return;
  }

  // Mark first, look up second. The relay does the opposite (records the thread first, checks the
  // marker second), so whichever side comes later sees the other's write: the lookup below finds
  // the thread, or the relay sees the marker and deletes it. At worst both delete, and the second
  // delete gets a harmless 404.
  await markRemoved(postId);

  const threadId = await loadThread(postId);
  if (!threadId) {
    // Never relayed, already deleted, or still being relayed. The marker covers the last case:
    // the relay deletes the thread as soon as it exists.
    console.log(`no thread recorded for ${postId}, nothing to delete`);
    return;
  }

  await deleteThread(config, postId, threadId);
}
