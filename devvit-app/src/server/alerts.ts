import { reddit, redis } from "@devvit/web/server";
import type { PermanentError } from "./relay";

const ALERT_KEY = "alert:relay-failure";
const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export function failureNotice(error: PermanentError, permalink?: string) {
  const post = permalink ? `\n\nPost that was not relayed: https://www.reddit.com${permalink}` : "";
  return {
    subject: "Discord relay is not working",
    bodyMarkdown:
      `New posts are not reaching Discord.\n\n**Problem:** ${error.message}\n\n**What to do:** ${error.hint}` +
      `${post}\n\n_This notice is sent at most once a day._`,
  };
}

// Tells the mod team via Modmail when the relay is broken in a way retries cannot fix.
// Rate limited so a dead webhook does not produce one message per post. Never throws.
export async function alertMods(
  subredditId: string | undefined,
  notice: { subject: string; bodyMarkdown: string },
): Promise<void> {
  if (!subredditId) return;
  try {
    const first = await redis.set(ALERT_KEY, "1", {
      nx: true,
      expiration: new Date(Date.now() + ALERT_COOLDOWN_MS),
    });
    if (!first) {
      console.log("modmail: failure notice already sent in the last 24h, not sending another");
      return;
    }
    console.log("modmail: sending failure notice to the mod team");
    try {
      await reddit.modMail.createModNotification({ ...notice, subredditId: subredditId as `t5_${string}` });
      console.log("modmail: failure notice sent");
    } catch (error) {
      await redis.del(ALERT_KEY); // let the next failure try again
      throw error;
    }
  } catch (error) {
    console.error(`could not notify mods: ${String(error)}`);
  }
}
