// What the relay needs to know about talking to Discord with a bot token. Deliberately free of Devvit
// imports (it only needs `fetch`), so the same code can be reused outside the Devvit runtime.

export const FETCH_TIMEOUT_MS = 10_000;

const API = "https://discord.com/api/v10";
// Discord asks bots to say who they are. Format: DiscordBot ($url, $versionNumber).
const USER_AGENT = "DiscordBot (https://github.com/BoardyB/hikinghu-discord-relay, 1.0)";

/** Retrying cannot help (bad token, wrong channel, 4xx from Discord). `hint` is mod-facing advice. */
export class PermanentError extends Error {
  override name = "PermanentError";
  constructor(
    message: string,
    readonly hint = "Open the app settings and check the bot token and the forum channel ID.",
  ) {
    super(message);
  }
}

// --- configuration ------------------------------------------------------------------

export type DiscordConfig = {
  /** The bot token, without any "Bot " prefix. Never log it, never put it in a notice. */
  token: string;
  /** The forum channel the posts are created in. */
  channelId: string;
};

/** Mods tend to paste the token with the "Bot " prefix Discord's docs show, or with stray spaces. */
function cleanToken(raw: string): string {
  return raw.trim().replace(/^Bot\s+/i, "");
}

/** A readable complaint about a bot token setting, or undefined if it looks usable. */
export function botTokenProblem(raw: string): string | undefined {
  const token = cleanToken(raw);
  if (!token) return "The bot token is empty.";
  if (/\s/.test(token)) return "The bot token must not contain spaces or line breaks. Paste only the token.";
  return undefined;
}

/** A readable complaint about a forum channel id setting, or undefined if it looks usable. */
export function channelIdProblem(raw: string): string | undefined {
  if (/^\d{17,20}$/.test(raw.trim())) return undefined;
  return (
    "The forum channel ID must be a number of 17 to 20 digits. In Discord, turn on Developer Mode " +
    "(User Settings, Advanced), right-click the forum channel and choose Copy Channel ID."
  );
}

/** Throws a PermanentError (without echoing the token) when either setting is unusable. */
export function parseConfig(rawToken: string, rawChannelId: string): DiscordConfig {
  const tokenProblem = botTokenProblem(rawToken);
  if (tokenProblem) throw new PermanentError(tokenProblem, "Open the app settings and paste the bot token again.");
  const channelProblem = channelIdProblem(rawChannelId);
  if (channelProblem) throw new PermanentError(channelProblem, "Open the app settings and check the forum channel ID.");
  return { token: cleanToken(rawToken), channelId: rawChannelId.trim() };
}

// --- requests -----------------------------------------------------------------------

/**
 * One call to Discord's REST API as the bot. `path` is built from validated ids only, never from
 * free text. Rejects on network failure and timeout, resolves with any HTTP answer.
 */
export function discordRequest(config: DiscordConfig, method: "POST" | "DELETE", path: string, body?: unknown): Promise<Response> {
  return fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${config.token}`,
      "User-Agent": USER_AGENT,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

// --- answers ------------------------------------------------------------------------

const TOKEN_REJECTED =
  "Discord rejected the bot token. In the Discord developer portal reset the bot's token and paste the new one into the app settings.";

/** Advice for a failed attempt to create a post. */
export function createRejectionHint(status: number): string {
  switch (status) {
    case 400:
      return (
        "Discord refused the post. Most often the channel is not a Forum channel, or the forum requires a tag on " +
        "every post (turn that requirement off in the channel's settings)."
      );
    case 401:
      return TOKEN_REJECTED;
    case 403:
      return "The bot is not allowed to create posts there. On the forum channel give it View Channel, Create Posts and Send Messages in Posts.";
    case 404:
      return "Discord cannot find that channel for the bot. Check the forum channel ID, and that the bot was invited to the server.";
    default:
      return "Check the bot token and the forum channel ID in the app settings.";
  }
}

/** Advice for a failed attempt to delete a thread. A 404 is not a failure there (it is already gone). */
export function deleteRejectionHint(status: number): string | undefined {
  switch (status) {
    case 401:
      return TOKEN_REJECTED;
    case 403:
      return "The bot is not allowed to delete threads. On the forum channel give it the Manage Threads permission.";
    default:
      return undefined; // PermanentError's general advice
  }
}

/**
 * The error for a Discord answer that was not a success. A rate limit or a server error may clear up,
 * so it is a plain Error and Reddit retries. Anything else is a PermanentError with the given
 * message and advice for the mods.
 */
export function discordError(response: Response, permanentMessage: string, hint?: string): Error {
  if (response.status === 429 || response.status >= 500) {
    const retryAfter = response.headers?.get("retry-after");
    return new Error(`Discord returned ${response.status}${retryAfter ? ` (retry-after ${retryAfter}s)` : ""}`);
  }
  return new PermanentError(permanentMessage, hint);
}
