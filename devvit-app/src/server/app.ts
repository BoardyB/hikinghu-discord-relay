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
    return c.json({ error: "invalid JSON body" }, 400);
  }

  try {
    await handleOnPostCreate(input);
    return c.json<TriggerResponse>({});
  } catch (error) {
    if (error instanceof PermanentError) {
      // 2xx on purpose: a retry cannot fix this, so don't have Reddit hammer it.
      console.error(`onPostCreate permanent failure: ${error.message}`);
      await alertMods(input.subreddit?.id, failureNotice(error, input.post?.permalink));
      return c.json<TriggerResponse>({});
    }
    console.error(`onPostCreate failed, asking for retry: ${String(error)}`);
    return c.json({ error: "relay failed" }, 503);
  }
});

// Called by Reddit when a mod saves the setting, so typos fail in the form
// instead of silently at the next post.
app.post("/internal/settings/webhook-url", async (c) => {
  const { value } = await c.req.json<SettingsValidationRequest<string>>();
  if (!value) return c.json<SettingsValidationResponse>({ success: true }); // empty = paused
  try {
    parseWebhookUrl(value);
    return c.json<SettingsValidationResponse>({ success: true });
  } catch (error) {
    return c.json<SettingsValidationResponse>({ success: false, error: (error as Error).message });
  }
});
