import { createDevvitTest } from "@devvit/test/server/vitest";
import { reddit, redis } from "@devvit/web/server";
import { expect, vi } from "vitest";
import { app } from "./app";
import { PermanentError } from "./discord";
import { handleOnPostCreate, handleRemoval } from "./relay";

const TOKEN = "MTIzNDU2Nzg5.Gabcde.super-secret-token-value";
// Different values on purpose, so a test fails if the forum channel is used where the thread belongs.
const CHANNEL_ID = "1100000000000000001";
const THREAD_ID = "1200000000000000002";
const DELETE_URL = `https://discord.com/api/v10/channels/${THREAD_ID}`;

const settings = { botToken: TOKEN, forumChannelId: CHANNEL_ID };
const test = createDevvitTest({ settings });
const pausedTest = createDevvitTest({ settings: { ...settings, botToken: "" } });

const POST = {
  id: "t3_abc",
  title: "My trip to Dobogókő",
  permalink: "/r/hikingHungary/comments/abc/my_trip/",
};
const SUBREDDIT = { id: "t5_test", name: "hikingHungary" };

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
type Call = { url: string; init: RequestInit };

const CREATED: Reply = { status: 201, body: { id: THREAD_ID, parent_id: CHANNEL_ID } };
const DELETED: Reply = { status: 200, body: { id: THREAD_ID } };

function mockDiscord(handler: (call: Call) => Reply | Promise<Reply>): Call[] {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const { status, body, headers } = await handler(call);
    return new Response(body === undefined || status === 204 ? null : JSON.stringify(body), { status, headers });
  });
  return calls;
}

const discord = (remove: Reply = DELETED) =>
  mockDiscord(({ init }) => (init.method === "DELETE" ? remove : CREATED));

const deletes = (calls: Call[]) => calls.filter((call) => call.init.method === "DELETE");

const createEvent = (post: unknown = POST) => ({ type: "PostCreate", post, subreddit: SUBREDDIT }) as never;
const relayPost = () => handleOnPostCreate(createEvent());
const storedThread = () => redis.get("thread:abc");

test("create: records the thread Discord answered with", async () => {
  discord();

  await relayPost();

  expect(await storedThread()).toBe(THREAD_ID);
});

test("create: still succeeds when Discord's answer names no thread", async () => {
  mockDiscord(() => ({ status: 201 }));

  await expect(relayPost()).resolves.toBeUndefined();

  expect(await redis.get("posted:t3_abc")).toBeTruthy(); // de-duplication is unaffected
  expect(await redis.get("thread:abc")).toBeFalsy();
});

test("create: does not trust ids that are not Discord ids", async () => {
  mockDiscord(() => ({ status: 200, body: { id: "../../x", parent_id: CHANNEL_ID } }));

  await relayPost();

  expect(await redis.get("thread:abc")).toBeFalsy();
});

test("removal: deletes the recorded thread as the bot and forgets it", async () => {
  const calls = discord();
  await relayPost();

  await handleRemoval("t3_abc");

  const [call, ...others] = deletes(calls);
  expect(others).toHaveLength(0);
  expect(call!.url).toBe(DELETE_URL);
  expect(call!.init.method).toBe("DELETE");
  expect((call!.init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
  expect(await redis.get("thread:abc")).toBeFalsy();
});

test("removal: finds the thread whether or not the post id has the t3_ prefix", async () => {
  const calls = discord();
  await relayPost();

  await handleRemoval("abc");

  expect(deletes(calls)).toHaveLength(1);
});

test("removal: a 204 is a success too", async () => {
  discord({ status: 204 });
  await relayPost();

  await expect(handleRemoval("t3_abc")).resolves.toBeUndefined();

  expect(await redis.get("thread:abc")).toBeFalsy();
});

test("removal: a 404 means the thread is already gone", async () => {
  discord({ status: 404 });
  await relayPost();

  await expect(handleRemoval("t3_abc")).resolves.toBeUndefined();

  expect(await redis.get("thread:abc")).toBeFalsy();
});

test("removal: 5xx and 429 are retryable and keep the record for the retry", async () => {
  discord({ status: 500 });
  await relayPost();
  await expect(handleRemoval("t3_abc")).rejects.toThrow("Discord returned 500");
  expect(await storedThread()).toBe(THREAD_ID);

  discord({ status: 429, headers: { "retry-after": "2" } });
  const error = await handleRemoval("t3_abc").catch((e) => e);
  expect(error).not.toBeInstanceOf(PermanentError);
  expect(String(error)).toContain("retry-after 2s");

  const calls = discord();
  await handleRemoval("t3_abc");
  expect(deletes(calls)).toHaveLength(1);
  expect(await redis.get("thread:abc")).toBeFalsy();
});

test("removal: a network failure is retryable", async () => {
  discord();
  await relayPost();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed", { cause: new Error("ECONNRESET") }));

  const error = await handleRemoval("t3_abc").catch((e) => e);

  expect(error).not.toBeInstanceOf(PermanentError);
  expect(String(error)).toContain("ECONNRESET");
  expect(await storedThread()).toBe(THREAD_ID);
});

test("removal: other 4xx are permanent, with advice for the mods", async () => {
  discord({ status: 403 });
  await relayPost();

  const error = await handleRemoval("t3_abc").catch((e) => e);

  expect(error).toBeInstanceOf(PermanentError);
  expect(error.message).toContain("403");
  expect(error.hint).toContain("Manage Threads");
  expect(await storedThread()).toBe(THREAD_ID); // kept, so a later removal can try again
});

test("removal: a rejected token gets its own advice", async () => {
  discord({ status: 401 });
  await relayPost();

  const error = await handleRemoval("t3_abc").catch((e) => e);

  expect(error).toBeInstanceOf(PermanentError);
  expect(error.hint).toContain("reset");
});

test("removal: without a recorded thread nothing is deleted and the post is marked as removed", async () => {
  const calls = discord();

  await handleRemoval("t3_abc");

  expect(calls).toHaveLength(0);
  expect(await redis.get("removed:abc")).toBeTruthy();
});

test("removal: ignores a thread record that cannot be read", async () => {
  const calls = discord();
  await redis.set("thread:abc", "{nope");

  await handleRemoval("t3_abc");

  expect(calls).toHaveLength(0);
  expect(await redis.get("removed:abc")).toBeTruthy();
});

test("removal: a record in the old webhook format is ignored, not trusted", async () => {
  const calls = discord();
  await redis.set("thread:abc", JSON.stringify({ webhookId: "123", threadId: THREAD_ID, messageId: THREAD_ID }));

  await handleRemoval("t3_abc");

  expect(calls).toHaveLength(0);
  expect(await redis.get("removed:abc")).toBeTruthy();
});

pausedTest("removal: does nothing while the relay is paused", async () => {
  const calls = discord();

  await handleRemoval("t3_abc");

  expect(calls).toHaveLength(0);
  expect(await redis.get("removed:abc")).toBeFalsy();
});

test("race: a post removed before it was relayed is never relayed", async () => {
  const calls = discord();
  await handleRemoval("t3_abc"); // the removal event wins the race

  await relayPost();

  expect(calls).toHaveLength(0);
});

test("race: a post removed while Discord is creating its thread has the thread deleted right away", async () => {
  const calls = mockDiscord(async ({ init }) => {
    if (init.method === "DELETE") return DELETED;
    await handleRemoval("t3_abc"); // the removal event arrives while the create is in flight
    return CREATED;
  });

  await relayPost();

  expect(deletes(calls)).toHaveLength(1);
  expect(deletes(calls)[0]!.url).toBe(DELETE_URL);
  expect(await redis.get("thread:abc")).toBeFalsy();
});

test("race: a removal that looked for the thread just before the relay recorded it still has it deleted", async () => {
  // The narrow window: the removal's lookup finds nothing, and only then does the relay finish
  // creating the thread, record it and check for a removal marker.
  let finishCreate!: () => void;
  const discordAnswers = new Promise<void>((resolve) => (finishCreate = resolve));
  const calls = mockDiscord(async ({ init }) => {
    if (init.method === "DELETE") return DELETED;
    await discordAnswers;
    return CREATED;
  });
  const create = relayPost();

  const realGet = redis.get.bind(redis);
  vi.spyOn(redis, "get").mockImplementation(async (key) => {
    const found = await realGet(key); // what the removal's lookup sees: no thread yet
    if (key === "thread:abc") {
      finishCreate();
      await create; // the relay now records the thread and checks for a marker
    }
    return found;
  });

  await handleRemoval("t3_abc");

  expect(deletes(calls)).toHaveLength(1); // the marker was already there, so the relay deleted the thread
  expect(await realGet("thread:abc")).toBeFalsy();
});

test("race: a failing clean-up never breaks the create", async () => {
  mockDiscord(async ({ init }) => {
    if (init.method === "DELETE") return { status: 500 };
    await handleRemoval("t3_abc");
    return CREATED;
  });

  await expect(relayPost()).resolves.toBeUndefined();

  expect(await redis.get("posted:t3_abc")).toBeTruthy();
});

const route = (name: string, body: unknown) =>
  app.request(`/internal/triggers/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const modAction = (action: string, targetPost: unknown = POST) =>
  route("mod-action", { type: "ModAction", action, targetPost, subreddit: SUBREDDIT });
const postDelete = (postId: string) =>
  route("post-delete", { type: "PostDelete", postId, source: 1, reason: 0, subreddit: SUBREDDIT });

for (const action of ["removelink", "spamlink"]) {
  test(`route mod-action: ${action} deletes the thread`, async () => {
    const calls = discord();
    await relayPost();

    expect((await modAction(action)).status).toBe(200);

    expect(deletes(calls)).toHaveLength(1);
    expect(await redis.get("thread:abc")).toBeFalsy();
  });
}

test("route mod-action: other actions are ignored", async () => {
  const calls = discord();
  await relayPost();

  for (const action of ["approvelink", "removecomment", "banuser", "lock", "editflair"]) {
    expect((await modAction(action)).status).toBe(200);
  }

  expect(deletes(calls)).toHaveLength(0);
  expect(await storedThread()).toBe(THREAD_ID);
});

test("route mod-action: a removal without a target post is skipped", async () => {
  const calls = discord();

  expect((await modAction("removelink", undefined)).status).toBe(200);

  expect(calls).toHaveLength(0);
});

test("route post-delete: deletes the thread, whichever way the id is spelled", async () => {
  const calls = discord();
  await relayPost();

  expect((await postDelete("abc")).status).toBe(200);

  expect(deletes(calls)).toHaveLength(1);
  expect(await redis.get("thread:abc")).toBeFalsy();
});

test("route post-delete: a payload without a post id is skipped", async () => {
  const calls = discord();

  expect((await route("post-delete", { type: "PostDelete", subreddit: SUBREDDIT })).status).toBe(200);

  expect(calls).toHaveLength(0);
});

test("routes: 400 on malformed JSON", async () => {
  expect((await route("mod-action", "{nope")).status).toBe(400);
  expect((await route("post-delete", "{nope")).status).toBe(400);
});

test("routes: 503 on a retryable failure, 200 on a permanent one", async () => {
  discord({ status: 500 });
  await relayPost();
  expect((await modAction("removelink")).status).toBe(503);
  expect((await postDelete("t3_abc")).status).toBe(503);

  discord({ status: 403 });
  expect((await modAction("removelink")).status).toBe(200);
  expect((await postDelete("t3_abc")).status).toBe(200);
});

const mockModmail = () => vi.spyOn(reddit.modMail, "createModNotification").mockResolvedValue("conv_1");

test("alert: a permanent delete failure sends one Modmail notice with its own text", async () => {
  const modmail = mockModmail();
  discord({ status: 403 });
  await relayPost();

  await modAction("removelink");
  await modAction("removelink"); // the daily limit applies

  expect(modmail).toHaveBeenCalledOnce();
  const arg = modmail.mock.calls[0]![0];
  expect(arg.subredditId).toBe("t5_test");
  expect(arg.subject).toBe("Discord relay could not delete a thread");
  expect(arg.bodyMarkdown).toContain("still visible in Discord");
  expect(arg.bodyMarkdown).toContain("https://www.reddit.com/r/hikingHungary/comments/abc/my_trip/");
  expect(arg.bodyMarkdown).not.toContain(TOKEN);
});

test("alert: a delete failure does not use up the notice for posts that stopped reaching Discord", async () => {
  const modmail = mockModmail();
  discord({ status: 403 });
  await relayPost();
  await modAction("removelink");

  mockDiscord(() => ({ status: 404 })); // now the forum channel is gone altogether
  await route("post-create", { type: "PostCreate", post: { ...POST, id: "t3_def" }, subreddit: SUBREDDIT });

  expect(modmail.mock.calls.map(([arg]) => arg.subject)).toEqual([
    "Discord relay could not delete a thread",
    "Discord relay is not working",
  ]);
});

test("alert: the post-delete trigger sends the delete notice too, with the same separate daily limit", async () => {
  const modmail = mockModmail();
  discord({ status: 403 });
  await relayPost();
  await postDelete("t3_abc");

  mockDiscord(() => ({ status: 404 })); // now the forum channel is gone altogether
  await route("post-create", { type: "PostCreate", post: { ...POST, id: "t3_def" }, subreddit: SUBREDDIT });

  expect(modmail.mock.calls.map(([arg]) => arg.subject)).toEqual([
    "Discord relay could not delete a thread",
    "Discord relay is not working",
  ]);
});

test("alert: transient delete failures do not alert mods", async () => {
  const modmail = mockModmail();
  discord({ status: 500 });
  await relayPost();

  await modAction("removelink");
  await postDelete("t3_abc");

  expect(modmail).not.toHaveBeenCalled();
});
