import {expect, test} from "vitest";
import {type Fetch, classify, runCleanup, snowflakeToDate, type CleanupThread} from "./cleanup";
import type {DiscordConfig} from "./client";

const CUTOFF = new Date(1_700_000_000_000);

test("snowflakeToDate maps a Discord snowflake to its creation time", () => {
  // A snowflake of 1 maps exactly to Discord's epoch, 2015-01-01T00:00:00Z.
  expect(snowflakeToDate("1").getTime()).toBe(1_420_070_400_000);
  // 1 << 22 is the smallest snowflake one millisecond past the epoch.
  expect(snowflakeToDate(String(1 << 22)).getTime()).toBe(1_420_070_400_001);
});

test("classify deletes an old thread with no replies", () => {
  const old = String(1 << 22);
  expect(classify({id: old, message_count: 0}, CUTOFF)).toEqual({
    action: "delete",
    created: new Date(1_420_070_400_001),
    count: 0,
  });
});

test("classify skips a thread created after the cutoff", () => {
  const recent = String((BigInt(CUTOFF.getTime()) - 1_420_070_400_000n + 1n) << 22n);
  expect(classify({id: recent, message_count: 0}, CUTOFF).action).toBe("skip");
});

test("classify keeps an old thread that has replies", () => {
  expect(classify({id: String(1 << 22), message_count: 3}, CUTOFF).action).toBe("keep");
});

test("classify keeps an old thread with an unknown message count", () => {
  expect(classify({id: String(1 << 22)}, CUTOFF).action).toBe("keep");
});

// --- runCleanup with a canned transport -------------------------------------

const CONFIG: DiscordConfig = {token: "t".repeat(59), channelId: "123456789012345678"};
// Created at the Discord epoch (2015), so classify() treats it as old for any sane cutoff.
const OLD_ID = String(1 << 22);
const ARCHIVED_THREAD = {id: OLD_ID, name: "old", thread_metadata: {archive_timestamp: "2024-01-01T00:00:00+00:00"}};

type Call = {method: string; path: string};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {status, headers: {"content-type": "application/json"}});
}

/** Transport that records every call, answers the channel/active calls, and hands out archived pages in order. */
function cannedFetch(archivedPages: Array<{threads: CleanupThread[]; has_more: boolean}>, deletes: string[]): {fetch: Fetch; calls: Call[]} {
  const calls: Call[] = [];
  let archivedPagesSeen = 0;
  const fetch: Fetch = async (_config, method, path) => {
    calls.push({method, path});
    if (method === "DELETE") {
      deletes.push(path);
      return jsonResponse({}, 204);
    }
    if (path.endsWith(`/channels/${CONFIG.channelId}`)) return jsonResponse({name: "forum"});
    if (path.includes("/threads/active")) return jsonResponse({threads: []});
    return jsonResponse(archivedPages[archivedPagesSeen++] ?? {threads: [], has_more: false});
  };
  return {fetch, calls};
}

test("runCleanup pages through archived threads using before cursors", async () => {
  const deletes: string[] = [];
  const {fetch, calls} = cannedFetch(
    [
      {threads: [{...ARCHIVED_THREAD, message_count: 0}], has_more: true},
      {threads: [{...ARCHIVED_THREAD, message_count: 3}], has_more: false},
    ],
    deletes,
  );
  await runCleanup(CONFIG, 30, true, fetch);
  const archivedCalls = calls.filter((c) => c.method === "GET" && c.path.includes("/threads/archived"));
  expect(archivedCalls).toHaveLength(2);
  expect(archivedCalls[1].path).toContain("&before=");
});

test("runCleanup in dry run deletes nothing", async () => {
  const deletes: string[] = [];
  const {fetch} = cannedFetch([{threads: [{...ARCHIVED_THREAD, message_count: 0}], has_more: false}], deletes);
  await runCleanup(CONFIG, 30, true, fetch);
  expect(deletes).toEqual([]);
});

test("runCleanup deletes an old thread with no replies outside dry run", async () => {
  const deletes: string[] = [];
  const {fetch} = cannedFetch([{threads: [{...ARCHIVED_THREAD, message_count: 0}], has_more: false}], deletes);
  await runCleanup(CONFIG, 30, false, fetch);
  expect(deletes).toEqual([`/channels/${OLD_ID}`]);
});

test("runCleanup keeps an old thread that has replies outside dry run", async () => {
  const deletes: string[] = [];
  const {fetch} = cannedFetch([{threads: [{...ARCHIVED_THREAD, message_count: 3}], has_more: false}], deletes);
  await runCleanup(CONFIG, 30, false, fetch);
  expect(deletes).toEqual([]);
});
