import { createDevvitTest } from "@devvit/test/server/vitest";
import { reddit, redis } from "@devvit/web/server";
import { expect, vi } from "vitest";
import { app } from "./app";
import { buildWebhookBody, handleOnPostCreate, parseWebhookUrl, PermanentError } from "./relay";

const WEBHOOK_URL = "https://discord.com/api/webhooks/123/abc";

const test = createDevvitTest({
  settings: { discordWebhookUrl: WEBHOOK_URL },
});

const POST = {
  id: "t3_abc",
  title: "My trip to Dobogókő",
  permalink: "/r/hikingHungary/comments/abc/my_trip/",
};

const event = (post: unknown, subreddit = "hikingHungary") =>
    ({ type: "PostCreate", post, subreddit: { id: "t5_test", name: subreddit } }) as never;

function mockFetch(status: number, headers: Record<string, string> = {}) {
  const fetchMock = vi.fn(async () => new Response(null, { status, headers }));
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock);
  return fetchMock;
}

test("posts payload to the webhook", async () => {
  const fetchMock = mockFetch(204);

  await expect(handleOnPostCreate(event(POST))).resolves.toBeUndefined();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
  expect(url.href).toBe(WEBHOOK_URL);
  expect(init.method).toBe("POST");
  expect(JSON.parse(String(init.body))).toEqual({
    thread_name: "My trip to Dobogókő",
    content: "**New post on r/hikingHungary**\nhttps://www.reddit.com/r/hikingHungary/comments/abc/my_trip/",
    allowed_mentions: { parse: [] },
  });
});

test("uses the subreddit name from the event in the message", async () => {
  const fetchMock = mockFetch(204);

  await handleOnPostCreate(event(POST, "SomeOtherHikingSub"));

  const init = (fetchMock.mock.calls[0] as unknown as [URL, RequestInit])[1];
  expect(JSON.parse(String(init.body)).content).toContain("r/SomeOtherHikingSub");
});

test("truncates thread name by code point without splitting emoji", () => {
  const body = buildWebhookBody("🥾".repeat(120), "/r/x/comments/abc/x/", "x");
  expect([...String(body.thread_name)]).toHaveLength(90);
  expect(String(body.thread_name)).not.toContain("�");
});

test("rejects webhook URLs that are not discord.com", () => {
  expect(() => parseWebhookUrl("https://evil.example/api/webhooks/1/a")).toThrow(PermanentError);
  expect(() => parseWebhookUrl("http://discord.com/api/webhooks/1/a")).toThrow(PermanentError);
  expect(() => parseWebhookUrl("not a url")).toThrow(PermanentError);
  expect(parseWebhookUrl(WEBHOOK_URL).host).toBe("discord.com");
});

test("dedupes duplicate deliveries", async () => {
  const fetchMock = mockFetch(204);

  await handleOnPostCreate(event(POST));
  await handleOnPostCreate(event(POST));

  expect(fetchMock).toHaveBeenCalledOnce();
});

test("keeps the dedupe key for the long TTL after success", async () => {
  mockFetch(204);

  await handleOnPostCreate(event(POST));

  expect(await redis.get("posted:t3_abc")).toBeTruthy();
});

test("releases the key and throws a retryable error on 5xx", async () => {
  mockFetch(500);

  await expect(handleOnPostCreate(event(POST))).rejects.toThrow("Discord returned 500");
  expect(await redis.get("posted:t3_abc")).toBeFalsy();

  const succeeding = mockFetch(204);
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
  const fetchMock = mockFetch(204);

  await expect(handleOnPostCreate(event(null))).resolves.toBeUndefined();

  expect(fetchMock).not.toHaveBeenCalled();
});

// --- HTTP route -------------------------------------------------------------

const post = (body: string) =>
    app.request("/internal/triggers/post-create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

test("route: 200 on success", async () => {
  mockFetch(204);
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

const validate = async (value?: string) => {
  const res = await app.request("/internal/settings/webhook-url", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ value, isEditing: false }),
  });
  return res.json();
};

test("validation: accepts a Discord webhook and empty (paused)", async () => {
  expect(await validate(WEBHOOK_URL)).toEqual({ success: true });
  expect(await validate(undefined)).toEqual({ success: true });
});

test("validation: rejects other hosts with a readable error", async () => {
  const res = (await validate("https://example.com/api/webhooks/1/a")) as { success: boolean; error: string };
  expect(res.success).toBe(false);
  expect(res.error).toContain("discord.com");
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
  expect(arg.bodyMarkdown).toContain("no longer exists");
  expect(arg.bodyMarkdown).toContain("https://www.reddit.com/r/hikingHungary/comments/abc/my_trip/");
  expect(arg.bodyMarkdown).not.toContain("webhooks/123");
});

test("alert: a dead webhook does not produce one message per post", async () => {
  const modmail = mockModmail();
  mockFetch(404);

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