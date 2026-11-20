// Deletes forum threads that are older than INACTIVE_DAYS and have no messages
// besides the starter post. Node port of cleanup_threads.py, same env vars.
// Reuses the Discord API plumbing from discord.ts, so it bundles like the
// server does: `npm run build:cleanup`, then `node dist/cleanup/index.cjs`.
// The entry point that parses env and calls runCleanup is cleanup-main.ts.

import {type DiscordConfig, discordRequest} from "./client";

const DISCORD_EPOCH_MS = 1_420_070_400_000; // First second of 2015, Discord's snowflake epoch.

export type CleanupThread = {
  id: string;
  name?: string;
  /** Excludes the starter post, so 0 means no replies. */
  message_count?: number;
  thread_metadata?: {archive_timestamp?: string};
};

type ThreadList = {threads?: CleanupThread[]; has_more?: boolean};

export type Classification = {
  action: "skip" | "keep" | "delete";
  created: Date;
  count?: number;
};

export function snowflakeToDate(id: string): Date {
  return new Date(Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS);
}

export function classify(thread: CleanupThread, cutoffDate: Date): Classification {
  const created = snowflakeToDate(thread.id);
  if (created >= cutoffDate) return {action: "skip", created};
  const count = thread.message_count;
  if (typeof count !== "number") return {action: "keep", created};
  return {action: count === 0 ? "delete" : "keep", created, count};
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function messageInfo(count: number | undefined): string {
  return count === undefined ? "unknown message count" : `${count} message(s)`;
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

type Method = "GET" | "DELETE";

const MAX_RATE_LIMIT_RETRIES = 5;

/** Transport used by `runCleanup`; injectable so tests can supply canned responses. */
export type Fetch = (config: DiscordConfig, method: Method, path: string) => Promise<Response>;

async function request(config: DiscordConfig, method: Method, path: string, attempt = 0): Promise<Response> {
  const response = await discordRequest(config, method, path);
  if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
    // Discord rate limits: wait out the backoff (with growth per retry) and try again.
    const retryAfter = Number(response.headers.get("retry-after") ?? "1");
    await new Promise((resolve) => setTimeout(resolve, (retryAfter + 1) * 2 ** attempt * 1000));
    return request(config, method, path, attempt + 1);
  }
  return response;
}

export async function runCleanup(config: DiscordConfig, inactiveDays: number, dryRun: boolean, doFetch: Fetch = request): Promise<void> {
  console.log("Starting thread cleanup job...");
  if (dryRun) console.log("DRY RUN MODE ENABLED - No threads will be deleted");

  const channelResponse = await doFetch(config, "GET", `/channels/${config.channelId}`);
  if (!channelResponse.ok) {
    fail(`Channel ${config.channelId} not found (Discord answered ${channelResponse.status})`);
  }
  const channel = (await channelResponse.json()) as {name?: string};
  console.log(`Found channel: ${channel.name ?? "(unnamed)"}`);

  const cutoffDate = new Date(Date.now() - inactiveDays * 86_400_000);
  console.log(`Looking for threads older than ${cutoffDate.toISOString().replace("T", " ").slice(0, 19)} UTC`);

  // Active threads come in one page; archived ones are paginated by archive timestamp.
  const threads: Array<{thread: CleanupThread; archived: boolean}> = [];
  const activeResponse = await doFetch(config, "GET", `/channels/${config.channelId}/threads/active`);
  if (activeResponse.ok) {
    const active = (await activeResponse.json()) as ThreadList;
    for (const thread of active.threads ?? []) threads.push({thread, archived: false});
  } else {
    console.warn(`Could not list active threads (Discord answered ${activeResponse.status})`);
  }

  console.log("\n=== Checking archived threads ===");
  let before = "";
  for (;;) {
    const query = before ? `&before=${before}` : "";
    const archivedResponse = await doFetch(config, "GET", `/channels/${config.channelId}/threads/archived?limit=100${query}`);
    if (!archivedResponse.ok) {
      console.warn(`Could not list archived threads (Discord answered ${archivedResponse.status})`);
      break;
    }
    const archived = (await archivedResponse.json()) as ThreadList;
    const page = archived.threads ?? [];
    for (const thread of page) threads.push({thread, archived: true});
    if (!archived.has_more || page.length === 0) break;
    before = new Date(page.at(-1)!.thread_metadata!.archive_timestamp!).toISOString();
  }

  let deletedCount = 0;
  let checkedCount = 0;
  for (const {thread, archived} of threads) {
    checkedCount++;
    const {action, created, count} = classify(thread, cutoffDate);
    const label = archived ? "archived" : "active";
    if (action === "skip") {
      console.log(`Skipping ${label} thread '${thread.name}' (too recent: ${formatDate(created)})`);
      continue;
    }
    if (action === "keep") {
      console.log(`Keeping active thread: '${thread.name}' (${messageInfo(count)})`);
      continue;
    }
    if (dryRun) {
      deletedCount++;
      console.log(`[DRY RUN] Would delete inactive ${label} thread: '${thread.name}' (created ${formatDate(created)}, ${messageInfo(count)})`);
      continue;
    }
    const deleteResponse = await doFetch(config, "DELETE", `/channels/${thread.id}`);
    if (deleteResponse.ok || deleteResponse.status === 404) {
      deletedCount++;
      console.log(`Deleting inactive ${label} thread: '${thread.name}' (created ${formatDate(created)}, ${messageInfo(count)})`);
    } else if (deleteResponse.status === 403) {
      console.log(`Permission denied to access thread: '${thread.name}'`);
    } else {
      console.log(`Error processing thread '${thread.name}': Discord answered ${deleteResponse.status}`);
    }
  }

  console.log("\n=== Summary ===");
  console.log(`Threads checked: ${checkedCount}`);
  console.log(`Threads deleted: ${deletedCount}`);
}
