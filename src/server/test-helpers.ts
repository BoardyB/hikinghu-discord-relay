// Shared fixtures and helpers for the Devvit test suites (relay.test.ts, removal.test.ts).
// cleanup.test.ts mocks the injectable Fetch transport instead — a different layer, so it
// deliberately does not use these.
import { reddit } from "@devvit/web/server"
import { vi } from "vitest"
import { app } from "./app"

export const TOKEN = "MTIzNDU2Nzg5.Gabcde.super-secret-token-value"
// Different values on purpose, so a test fails if the forum channel is used where the thread belongs.
export const CHANNEL_ID = "1100000000000000001"
export const THREAD_ID = "1200000000000000002"
export const CREATE_URL = `https://discord.com/api/v10/channels/${CHANNEL_ID}/threads`
export const DELETE_URL = `https://discord.com/api/v10/channels/${THREAD_ID}`

export const POST = {
  id: "t3_abc",
  title: "My trip to Dobogókő",
  permalink: "/r/hikingHungary/comments/abc/my_trip/",
}
export const SUBREDDIT = { id: "t5_test", name: "hikingHungary" }

export type Reply = { status: number; body?: unknown; headers?: Record<string, string> }
export type Call = { url: string; init: RequestInit }

export const CREATED: Reply = { status: 201, body: { id: THREAD_ID, parent_id: CHANNEL_ID } }
export const DELETED: Reply = { status: 200, body: { id: THREAD_ID } }

export const createEvent = (post: unknown = POST, subreddit = SUBREDDIT) =>
  ({ type: "PostCreate", post, subreddit }) as never

const replies = ({ status, body, headers }: Reply) =>
  new Response(body === undefined || status === 204 ? null : JSON.stringify(body), {
    status,
    headers,
  })

/** Mocks globalThis.fetch, records every call, and answers Discord from the handler. */
export function mockDiscord(handler: (call: Call) => Reply | Promise<Reply>): Call[] {
  const calls: Call[] = []
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const call = { url: String(input), init: init ?? {} }
    calls.push(call)
    return replies(await handler(call))
  })
  return calls
}

/** Relay and delete both succeed, unless `remove` says the delete call fails. */
export const discord = (remove: Reply = DELETED) =>
  mockDiscord(({ init }) => (init.method === "DELETE" ? remove : CREATED))

/** A fetch that always rejects, e.g. the network is down. */
export const fetchFails = () =>
  vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new TypeError("fetch failed", { cause: new Error("ECONNRESET") }))

export const deletes = (calls: Call[]) => calls.filter((call) => call.init.method === "DELETE")

export const route = (name: string, body: unknown) =>
  app.request(`/internal/triggers/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })

export const mockModmail = () =>
  vi.spyOn(reddit.modMail, "createModNotification").mockResolvedValue("conv_1")
