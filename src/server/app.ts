import type { OnModActionRequest, OnPostCreateRequest, OnPostDeleteRequest, SettingsValidationRequest, SettingsValidationResponse, TriggerResponse } from "@devvit/web/shared";
import {type Context, Hono} from "hono";
import { alertMods, failureNotice, REMOVAL_ALERT_KEY, removalFailureNotice } from "./alerts";
import { botTokenProblem, channelIdProblem, PermanentError } from "./discord";
import { handleOnPostCreate, handleRemoval } from "./relay";

export const app = new Hono();

const REMOVAL_ACTIONS = new Set(["removelink", "spamlink"]);

function triggerRoute<T>(name: string, handle: (c: Context, input: T) => Promise<Response>) {
  return async (c: Context) => {
    let input: T;
    try {
      input = await c.req.json<T>();
    } catch {
      console.warn(`${name}: request body is not valid JSON, responding 400`);
      return c.json({ error: "invalid JSON body" }, 400);
    }
    return handle(c, input);
  };
}

async function answerTrigger(
  c: Context,
  name: string,
  id: string,
  run: () => Promise<void>,
  alertPermanent: (error: PermanentError) => Promise<void>,
) {
  try {
    await run();
    console.log(`${name}: finished ${id}`);
    return c.json<TriggerResponse>({});
  } catch (error) {
    if (error instanceof PermanentError) {
      // 2xx on purpose: Reddit retries anything else, and a retry cannot fix this.
      console.error(`${name}: ${id} failed permanently, not retrying: ${error.message}`);
      await alertPermanent(error);
      return c.json<TriggerResponse>({});
    }
    console.error(`${name}: ${id} failed, responding 503 so Reddit retries: ${String(error)}`);
    return c.json({ error: "relay failed" }, 503);
  }
}

app.post("/internal/triggers/post-create", triggerRoute<OnPostCreateRequest>("post-create", async (c, input) => {
  const postId = input.post?.id ?? "(no post)";
  console.log(`post-create: received ${postId} from r/${input.subreddit?.name ?? "?"}`);
  return answerTrigger(
    c,
    "post-create",
    postId,
    () => handleOnPostCreate(input),
    (error) => alertMods(input.subreddit?.id, failureNotice(error, input.post?.permalink)),
  );
}));

app.post("/internal/triggers/mod-action", triggerRoute<OnModActionRequest>("mod-action", async (c, input) => {
  if (!input.action || !REMOVAL_ACTIONS.has(input.action)) {
    return c.json<TriggerResponse>({});
  }
  const postId = input.targetPost?.id;
  if (!postId) {
    console.warn(`mod-action: ${input.action} without a target post, skipping`);
    return c.json<TriggerResponse>({});
  }
  console.log(`mod-action: ${input.action} on ${postId} in r/${input.subreddit?.name ?? "?"}`);
  return answerTrigger(
    c,
    "mod-action",
    postId,
    () => handleRemoval(postId),
    (error) => alertMods(input.subreddit?.id, removalFailureNotice(error, input.targetPost?.permalink), REMOVAL_ALERT_KEY),
  );
}));

app.post("/internal/triggers/post-delete", triggerRoute<OnPostDeleteRequest>("post-delete", async (c, input) => {
  const postId = input.postId;
  if (!postId) {
    console.warn("post-delete: no post id in the payload, skipping");
    return c.json<TriggerResponse>({});
  }
  console.log(`post-delete: received ${postId} from r/${input.subreddit?.name ?? "?"}`);
  return answerTrigger(
    c,
    "post-delete",
    postId,
    () => handleRemoval(postId),
    (error) => alertMods(input.subreddit?.id, removalFailureNotice(error), REMOVAL_ALERT_KEY),
  );
}));

// Never log `value`: for the bot token it is a credential.
function validationRoute(setting: string, problemWith: (value: string) => string | undefined) {
  return async (c: Context) => {
    const { value } = await c.req.json<SettingsValidationRequest<string>>();
    if (!value) {
      console.log(`${setting} setting: cleared, relay is paused`);
      return c.json<SettingsValidationResponse>({ success: true });
    }
    const problem = problemWith(value);
    if (problem) {
      console.warn(`${setting} setting: new value rejected: ${problem}`);
      return c.json<SettingsValidationResponse>({ success: false, error: problem });
    }
    console.log(`${setting} setting: new value accepted`);
    return c.json<SettingsValidationResponse>({ success: true });
  };
}

app.post("/internal/settings/bot-token", validationRoute("botToken", botTokenProblem));
app.post("/internal/settings/forum-channel-id", validationRoute("forumChannelId", channelIdProblem));
