import { createDevvitTest } from "@devvit/test/server/vitest";
import { reddit, redis } from "@devvit/web/server";
import { expect, vi } from "vitest";
import { app } from "./app";
import { parseConfig, PermanentError } from "./discord";
import { buildThreadBody, handleOnPostCreate } from "./relay";

const TOKEN = "MTIzNDU2Nzg5.Gabcde.super-secret-token-value";
const CHANNEL_ID = "1100000000000000001";
const THREAD_ID = "1200000000000000002";
const CREATE_URL = `https://discord.com/api/v10/channels/${CHANNEL_ID}/threads`;

const test = createDevvitTest({
  settings: { botToken: TOKEN, forumChannelId: CHANNEL_ID },
});
const prefixedTokenTest = createDevvitTest({
  settings: { botToken: `Bot ${TOKEN}`, forumChannelId: CHANNEL_ID },
});
const noTokenTest = createDevvitTest({ settings: { botToken: "", forumChannelId: CHANNEL_ID } });
const noChannelTest = createDevvitTest({ settings: { botToken: TOKEN, forumChannelId: "" } });
const badChannelTest = createDevvitTest({ settings: { botToken: TOKEN, forumChannelId: "general" } });

const POST = {
  id: "t3_abc",
  title: "My trip to Dobogókő",
  permalink: "/r/hikingHungary/comments/abc/my_trip/",
};

const event = (post: unknown, subreddit = "hikingHungary") =>
    ({ type: "PostCreate", post, subreddit: { id: "t5_test", name: subreddit } }) as never;

// Discord answers a successful create with the thread it made (status 201).
function mockFetch(status: number, headers: Record<string, string> = {}, body: unknown = { id: THREAD_ID }) {
  const fetchMock = vi.fn(async () =>
    new Response(status === 204 || status >= 400 ? null : JSON.stringify(body), { status, headers }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  return fetchMock;
}

const requestOf = (fetchMock: ReturnType<typeof mockFetch>, index = 0) =>
  fetchMock.mock.calls[index] as unknown as [string, RequestInit];

test("creates a forum post as the bot", async () => {
  const fetchMock = mockFetch(201);

  await expect(handleOnPostCreate(event(POST))).resolves.toBeUndefined();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = requestOf(fetchMock);
  expect(url).toBe(CREATE_URL);
  expect(init.method).toBe("POST");
  expect((init.headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
  expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
  expect(JSON.parse(String(init.body))).toEqual({
    name: "My trip to Dobogókő",
    message: {
      content: "**New post on r/hikingHungary**\nhttps://www.reddit.com/r/hikingHungary/comments/abc/my_trip/",
      allowed_mentions: { parse: [] },
    },
  });
});

prefixedTokenTest("a token pasted with the 'Bot ' prefix is still sent as 'Bot <token>'", async () => {
  const fetchMock = mockFetch(201);

  await handleOnPostCreate(event(POST));

  expect((requestOf(fetchMock)[1].headers as Record<string, string>).Authorization).toBe(`Bot ${TOKEN}`);
});

test("uses the subreddit name from the event in the message", async () => {
  const fetchMock = mockFetch(201);

  await handleOnPostCreate(event(POST, "SomeOtherHikingSub"));

  const body = JSON.parse(String(requestOf(fetchMock)[1].body));
  expect(body.message.content).toContain("r/SomeOtherHikingSub");
});

test("truncates thread name by code point without splitting emoji", () => {
  const body = buildThreadBody("🥾".repeat(120), "/r/x/comments/abc/x/", "x");
  expect([...String(body.name)]).toHaveLength(90);
  expect(String(body.name)).not.toContain("�");
});

test("an empty title still gets a thread name", () => {
  expect(buildThreadBody("   ", "/r/x/comments/abc/x/", "x").name).toBe("New post");
});

test("dedupes duplicate deliveries", async () => {
  const fetchMock = mockFetch(201);

  await handleOnPostCreate(event(POST));
  await handleOnPostCreate(event(POST));

  expect(fetchMock).toHaveBeenCalledOnce();
});

test("keeps the dedupe key for the long TTL after success", async () => {
  mockFetch(201);

  await handleOnPostCreate(event(POST));

  expect(await redis.get("posted:t3_abc")).toBeTruthy();
});

test("releases the key and throws a retryable error on 5xx", async () => {
  mockFetch(500);

  await expect(handleOnPostCreate(event(POST))).rejects.toThrow("Discord returned 500");
  expect(await redis.get("posted:t3_abc")).toBeFalsy();

  const succeeding = mockFetch(201);
  await handleOnPostCreate(event(POST));
  expect(succeeding).toHaveBeenCalledOnce();
});

test("429 is retryable and surfaces retry-after", async () => {
  mockFetch(429, { "retry-after": "2" });

  const error = await handleOnPostCreate(event(POST)).catch((e) => e);
  expect(error).not.toBeInstanceOf(PermanentError);
  expect(String(error)).toContain("retry-after 2s");
});

test("4xx from Discord is permanent and releases the key", async () => {
  mockFetch(404);

  await expect(handleOnPostCreate(event(POST))).rejects.toBeInstanceOf(PermanentError);
  expect(await redis.get("posted:t3_abc")).toBeFalsy();
});

test("network failure releases the key and is retryable", async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed", { cause: new Error("ECONNRESET") }));

  const error = await handleOnPostCreate(event(POST)).catch((e) => e);
  expect(error).not.toBeInstanceOf(PermanentError);
  expect(String(error)).toContain("ECONNRESET");
  expect(await redis.get("posted:t3_abc")).toBeFalsy();
});

test("skips gracefully when post payload is absent", async () => {
  const fetchMock = mockFetch(201);

  await expect(handleOnPostCreate(event(null))).resolves.toBeUndefined();

  expect(fetchMock).not.toHaveBeenCalled();
});

// --- configuration ----------------------------------------------------------------

noTokenTest("pause: without a bot token nothing is sent and nothing fails", async () => {
  const fetchMock = mockFetch(201);

  await expect(handleOnPostCreate(event(POST))).resolves.toBeUndefined();

  expect(fetchMock).not.toHaveBeenCalled();
  expect(await redis.get("posted:t3_abc")).toBeFalsy(); // the post can still be relayed once configured
});

noChannelTest("pause: without a forum channel nothing is sent and nothing fails", async () => {
  const fetchMock = mockFetch(201);

  await expect(handleOnPostCreate(event(POST))).resolves.toBeUndefined();

  expect(fetchMock).not.toHaveBeenCalled();
});

badChannelTest("a forum channel id that cannot be right is a permanent failure and nothing is sent", async () => {
  const fetchMock = mockFetch(201);

  const error = await handleOnPostCreate(event(POST)).catch((e) => e);

  expect(error).toBeInstanceOf(PermanentError);
  expect(error.hint).toContain("forum channel ID");
  expect(fetchMock).not.toHaveBeenCalled();
});

test("parseConfig: accepts a token and channel id, trims, and strips a 'Bot ' prefix", () => {
  expect(parseConfig(`  Bot ${TOKEN}\n`, ` ${CHANNEL_ID} `)).toEqual({ token: TOKEN, channelId: CHANNEL_ID });
});

test("parseConfig: rejects what cannot be right, without echoing the token", () => {
  expect(() => parseConfig("two words", CHANNEL_ID)).toThrow(PermanentError);
  expect(() => parseConfig(TOKEN, "general")).toThrow(PermanentError);
  expect(() => parseConfig(TOKEN, "123")).toThrow(PermanentError);
  expect(() => parseConfig(TOKEN, "1100000000000000001/../x")).toThrow(PermanentError);
  const error = (() => { try { parseConfig(`${TOKEN} with spaces`, CHANNEL_ID); } catch (e) { return e as Error; } })();
  expect(error?.message).not.toContain(TOKEN);
});

test("the bot token never reaches the logs", async () => {
  const logged: string[] = [];
  for (const level of ["log", "warn", "error"] as const) {
    vi.spyOn(console, level).mockImplementation((...args) => void logged.push(args.map(String).join(" ")));
  }
  vi.spyOn(reddit.modMail, "createModNotification").mockResolvedValue("conv_1");

  mockFetch(201);
  await handleOnPostCreate(event(POST));
  mockFetch(401);
  await post(triggerBody);
  mockFetch(500);
  await post(triggerBody);
  await validate("bot-token", `Bot ${TOKEN} extra`);

  expect(logged.length).toBeGreaterThan(0);
  expect(logged.join("\n")).not.toContain(TOKEN);
});

// --- HTTP route -------------------------------------------------------------

const post = (body: string) =>
    app.request("/internal/triggers/post-create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

test("route: 200 on success", async () => {
  mockFetch(201);
  expect((await post(JSON.stringify({ post: POST, subreddit: { name: "hikingHungary" } }))).status).toBe(200);
});

test("route: 400 on malformed JSON", async () => {
  expect((await post("{nope")).status).toBe(400);
});

test("route: 503 on retryable failure, 200 on permanent failure", async () => {
  const body = JSON.stringify({ post: POST, subreddit: { name: "hikingHungary" } });

  mockFetch(500);
  expect((await post(body)).status).toBe(503);

  mockFetch(404);
  expect((await post(body)).status).toBe(200);
});

// --- settings validation ----------------------------------------------------

const validate = async (setting: "bot-token" | "forum-channel-id", value?: string) => {
  const res = await app.request(`/internal/settings/${setting}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value, isEditing: false }),
  });
  return res.json();
};

test("validation: accepts a bot token and a forum channel id, and empty (paused)", async () => {
  expect(await validate("bot-token", TOKEN)).toEqual({ success: true });
  expect(await validate("bot-token", `Bot ${TOKEN}`)).toEqual({ success: true });
  expect(await validate("forum-channel-id", CHANNEL_ID)).toEqual({ success: true });
  expect(await validate("bot-token", undefined)).toEqual({ success: true });
  expect(await validate("forum-channel-id", undefined)).toEqual({ success: true });
});

test("validation: rejects a token with spaces and a channel id that is not a number, with a readable error", async () => {
  const token = (await validate("bot-token", "not a token")) as { success: boolean; error: string };
  expect(token.success).toBe(false);
  expect(token.error).toContain("spaces");

  const channel = (await validate("forum-channel-id", "#forum")) as { success: boolean; error: string };
  expect(channel.success).toBe(false);
  expect(channel.error).toContain("Copy Channel ID");
});

// --- Modmail alerts ---------------------------------------------------------

const triggerBody = JSON.stringify({ post: POST, subreddit: { id: "t5_test", name: "hikingHungary" } });
const mockModmail = () => vi.spyOn(reddit.modMail, "createModNotification").mockResolvedValue("conv_1");

test("alert: permanent failure sends one Modmail notice with a hint and the post link", async () => {
  const modmail = mockModmail();
  mockFetch(404);

  expect((await post(triggerBody)).status).toBe(200);

  expect(modmail).toHaveBeenCalledOnce();
  const arg = modmail.mock.calls[0]![0];
  expect(arg.subredditId).toBe("t5_test");
  expect(arg.subject).toBe("Discord relay is not working");
  expect(arg.bodyMarkdown).toContain("forum channel ID");
  expect(arg.bodyMarkdown).toContain("https://www.reddit.com/r/hikingHungary/comments/abc/my_trip/");
  expect(arg.bodyMarkdown).not.toContain(TOKEN);
});

test("alert: the advice depends on what Discord said", async () => {
  const modmail = mockModmail();
  const advice: Record<number, string> = {
    400: "Forum channel",
    401: "reset",
    403: "Create Posts",
    404: "invited to the server",
  };

  for (const status of Object.keys(advice).map(Number)) {
    await redis.del("alert:relay-failure"); // one notice a day, so lift the limit between the cases
    mockFetch(status);
    await post(triggerBody);
  }

  const bodies = modmail.mock.calls.map(([arg]) => arg.bodyMarkdown);
  expect(bodies).toHaveLength(4);
  Object.values(advice).forEach((words, i) => expect(bodies[i]).toContain(words));
  bodies.forEach((body) => expect(body).not.toContain(TOKEN));
});

test("alert: a broken setup does not produce one message per post", async () => {
  const modmail = mockModmail();
  mockFetch(401);

  await post(triggerBody);
  await post(JSON.stringify({ post: { ...POST, id: "t3_def" }, subreddit: { id: "t5_test", name: "hikingHungary" } }));

  expect(modmail).toHaveBeenCalledOnce();
});

test("alert: transient failures (5xx, 429) do not alert mods", async () => {
  const modmail = mockModmail();

  mockFetch(500);
  await post(triggerBody);
  mockFetch(429, { "retry-after": "1" });
  await post(triggerBody);

  expect(modmail).not.toHaveBeenCalled();
});

test("alert: no subreddit id in the payload means no alert and no crash", async () => {
  const modmail = mockModmail();
  mockFetch(404);

  expect((await post(JSON.stringify({ post: POST }))).status).toBe(200);

  expect(modmail).not.toHaveBeenCalled();
});

test("alert: a Modmail failure never breaks the trigger and re-arms the alert", async () => {
  const modmail = mockModmail();
  modmail.mockRejectedValueOnce(new Error("modmail down"));
  mockFetch(404);

  expect((await post(triggerBody)).status).toBe(200); // send fails, trigger still OK
  expect(modmail).toHaveBeenCalledTimes(1);

  await post(triggerBody); // cooldown was released, so the next failure alerts again
  expect(modmail).toHaveBeenCalledTimes(2);
});
