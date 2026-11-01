import type { OnPostCreateRequest, SettingsValidationRequest, SettingsValidationResponse, TriggerResponse } from "@devvit/web/shared";
import {Hono} from "hono";
import { alertMods, failureNotice } from "./alerts";
import { handleOnPostCreate, parseWebhookUrl, PermanentError } from "./relay";

export const app = new Hono();

app.post("/internal/triggers/post-create", async (c) => {
  let input: OnPostCreateRequest;
  try {
    input = await c.req.json<OnPostCreateRequest>();
  } catch {
    console.warn("post-create: request body is not valid JSON, responding 400");
    return c.json({ error: "invalid JSON body" }, 400);
  }
  const postId = input.post?.id ?? "(no post)";
  console.log(`post-create: received ${postId} from r/${input.subreddit?.name ?? "?"}`);

  try {
    await handleOnPostCreate(input);
    console.log(`post-create: finished ${postId}`);
    return c.json<TriggerResponse>({});
  } catch (error) {
    if (error instanceof PermanentError) {
      // 2xx on purpose: a retry cannot fix this, so don't have Reddit hammer it.
      console.error(`post-create: ${postId} failed permanently, not retrying: ${error.message}`);
      await alertMods(input.subreddit?.id, failureNotice(error, input.post?.permalink));
      return c.json<TriggerResponse>({});
    }
    console.error(`post-create: ${postId} failed, responding 503 so Reddit retries: ${String(error)}`);
    return c.json({ error: "relay failed" }, 503);
  }
});

// Called by Reddit when a mod saves the setting, so typos fail in the form
// instead of silently at the next post.
app.post("/internal/settings/webhook-url", async (c) => {
  const { value } = await c.req.json<SettingsValidationRequest<string>>();
  if (!value) {
    console.log("webhook setting: cleared, relay is paused");
    return c.json<SettingsValidationResponse>({ success: true }); // empty = paused
  }
  try {
    parseWebhookUrl(value);
    console.log("webhook setting: new webhook URL accepted");
    return c.json<SettingsValidationResponse>({ success: true });
  } catch (error) {
    console.warn(`webhook setting: new webhook URL rejected: ${(error as Error).message}`);
    return c.json<SettingsValidationResponse>({ success: false, error: (error as Error).message });
  }
});
