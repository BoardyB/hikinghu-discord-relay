import {redis} from "@devvit/web/server";

// Only ids are stored here, never titles or links (see PRIVACY.md).
const THREAD_KEY_PREFIX = "thread:";
// Left by a removal, so a post removed while it is being relayed does not leave an orphan
// thread behind: the relay checks it before and right after creating the thread.
const REMOVED_KEY_PREFIX = "removed:";

export const THREAD_TTL_SECONDS = 30 * 24 * 60 * 60; // same as the de-duplication key
export const REMOVED_TTL_SECONDS = 24 * 60 * 60;

const SNOWFLAKE = /^\d{1,25}$/;

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE.test(value);
}

// Reddit's events spell post ids differently (`t3_abc` or `abc`), so every key uses the bare id.
export function normalizePostId(id: string): string {
  return id.startsWith("t3_") ? id.slice("t3_".length) : id;
}

function expiresIn(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

export async function saveThread(postId: string, threadId: string): Promise<void> {
  await redis.set(THREAD_KEY_PREFIX + normalizePostId(postId), threadId, {
    expiration: expiresIn(THREAD_TTL_SECONDS),
  });
}

export async function loadThread(postId: string): Promise<string | undefined> {
  const raw = await redis.get(THREAD_KEY_PREFIX + normalizePostId(postId));
  if (!raw) return undefined;
  // The id ends up in a request path, so only accept what a Discord id looks like.
  if (isSnowflake(raw)) return raw;
  console.warn(`stored thread record for ${postId} is unreadable, ignoring it`);
  return undefined;
}

export async function clearThread(postId: string): Promise<void> {
  await redis.del(THREAD_KEY_PREFIX + normalizePostId(postId));
}

export async function markRemoved(postId: string): Promise<void> {
  await redis.set(REMOVED_KEY_PREFIX + normalizePostId(postId), "1", {
    expiration: expiresIn(REMOVED_TTL_SECONDS),
  });
}

export async function isMarkedRemoved(postId: string): Promise<boolean> {
  return Boolean(await redis.get(REMOVED_KEY_PREFIX + normalizePostId(postId)));
}
