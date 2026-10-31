import type {OnPostCreateRequest, TriggerResponse} from "@devvit/web/shared";
import {Hono} from "hono";
import {handleOnPostCreate, PermanentError} from "./relay";

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
      return c.json<TriggerResponse>({});
    }
    console.error(`onPostCreate failed, asking for retry: ${String(error)}`);
    return c.json({ error: "relay failed" }, 503);
  }
});
