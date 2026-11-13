// No Devvit imports on purpose: this file is meant to be reusable outside the Devvit runtime.

export const FETCH_TIMEOUT_MS = 10_000;

const API = "https://discord.com/api/v10";
// Discord asks bots to identify themselves: DiscordBot ($url, $versionNumber).
const USER_AGENT = "DiscordBot (https://github.com/BoardyB/hikinghu-discord-relay, 1.0)";

/** Retrying cannot help, so Reddit is not asked to. `hint` is advice for the mods. */
export class PermanentError extends Error {
  override name = "PermanentError";
  constructor(
    message: string,
    readonly hint = "Open the app settings and check the bot token and the forum channel ID.",
  ) {
    super(message);
  }
}

export type DiscordConfig = {
  /** Without the "Bot " prefix. Never log it or put it in a notice. */
  token: string;
  channelId: string;
};

/** Mods tend to paste the token with the "Bot " prefix Discord's docs show, or with stray spaces. */
function cleanToken(raw: string): string {
  return raw.trim().replace(/^Bot\s+/i, "");
}

export function botTokenProblem(raw: string): string | undefined {
  const token = cleanToken(raw);
  if (!token) return "The bot token is empty.";
  if (/\s/.test(token)) return "The bot token must not contain spaces or line breaks. Paste only the token.";
  return undefined;
}

export function channelIdProblem(raw: string): string | undefined {
  if (/^\d{17,20}$/.test(raw.trim())) return undefined;
  return (
    "The forum channel ID must be a number of 17 to 20 digits. In Discord, turn on Developer Mode " +
    "(User Settings, Advanced), right-click the forum channel and choose Copy Channel ID."
  );
}

// The error goes to Modmail, so it must never echo the token.
export function parseConfig(rawToken: string, rawChannelId: string): DiscordConfig {
  const tokenProblem = botTokenProblem(rawToken);
  if (tokenProblem) throw new PermanentError(tokenProblem, "Open the app settings and paste the bot token again.");
  const channelProblem = channelIdProblem(rawChannelId);
  if (channelProblem) throw new PermanentError(channelProblem, "Open the app settings and check the forum channel ID.");
  return { token: cleanToken(rawToken), channelId: rawChannelId.trim() };
}

// `path` must only ever contain validated ids.
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

const TOKEN_REJECTED =
  "Discord rejected the bot token. In the Discord developer portal reset the bot's token and paste the new one into the app settings.";

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

export function deleteRejectionHint(status: number): string | undefined {
  switch (status) {
    case 401:
      return TOKEN_REJECTED;
    case 403:
      return "The bot is not allowed to delete threads. On the forum channel give it the Manage Threads permission.";
    default:
      return undefined;
  }
}

// 429 and 5xx may clear up, so they stay retryable. Everything else is permanent.
export function discordError(response: Response, permanentMessage: string, hint?: string): Error {
  if (response.status === 429 || response.status >= 500) {
    const retryAfter = response.headers?.get("retry-after");
    return new Error(`Discord returned ${response.status}${retryAfter ? ` (retry-after ${retryAfter}s)` : ""}`);
  }
  return new PermanentError(permanentMessage, hint);
}
