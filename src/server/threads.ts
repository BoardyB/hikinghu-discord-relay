import {redis} from "@devvit/web/server";

// Which Discord thread belongs to which Reddit post, so the thread can be deleted
// when the post is removed. Only ids are stored, never titles or links.
const THREAD_KEY_PREFIX = "thread:";
// Written when a removal arrives and there is no thread to delete (yet). The relay
// checks it before and right after creating a thread, so a post that is removed while
// it is being relayed does not leave an orphan thread behind.
const REMOVED_KEY_PREFIX = "removed:";

export const THREAD_TTL_SECONDS = 30 * 24 * 60 * 60; // same as the de-duplication key
export const REMOVED_TTL_SECONDS = 24 * 60 * 60;

const SNOWFLAKE = /^\d{1,25}$/;

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE.test(value);
}

/**
 * Reddit events do not agree on how they spell a post id (`t3_abc` or `abc`), and the
 * removal events arrive from triggers other than the one that created the thread, so
 * every key here uses the bare id.
 */
export function normalizePostId(id: string): string {
  return id.startsWith("t3_") ? id.slice("t3_".length) : id;
}

function expiresIn(seconds: number): Date {
  return new Date(Date.now() + seconds * 1000);
}

/** In a forum channel a post is a thread, and the thread is a channel of its own: this is its id. */
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
