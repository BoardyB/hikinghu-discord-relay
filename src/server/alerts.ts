import { reddit, redis } from "@devvit/web/server";
import type { PermanentError } from "./discord";

const ALERT_KEY = "alert:relay-failure";
// Separate from ALERT_KEY on purpose: a failing delete must not hide the more serious
// "new posts are not reaching Discord" notice.
export const REMOVAL_ALERT_KEY = "alert:removal-failure";
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

export function removalFailureNotice(error: PermanentError, permalink?: string) {
  const post = permalink ? `\n\nPost that was removed: https://www.reddit.com${permalink}` : "";
  return {
    subject: "Discord relay could not delete a thread",
    bodyMarkdown:
      `A post was removed on Reddit, but its Discord thread could not be deleted and is still visible in Discord.\n\n` +
      `**Problem:** ${error.message}\n\n**What to do:** ${error.hint}` +
      `${post}\n\n_This notice is sent at most once a day._`,
  };
}

// Never throws: a failed notice must not fail the trigger.
export async function alertMods(
  subredditId: string | undefined,
  notice: { subject: string; bodyMarkdown: string },
  cooldownKey = ALERT_KEY,
): Promise<void> {
  if (!subredditId) return;
  try {
    const first = await redis.set(cooldownKey, "1", {
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
      await redis.del(cooldownKey); // let the next failure try again
      throw error;
    }
  } catch (error) {
    console.error(`could not notify mods: ${String(error)}`);
  }
}
