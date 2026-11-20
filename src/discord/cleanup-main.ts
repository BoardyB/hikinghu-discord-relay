// Entry point for the bundled cleanup script: dist/cleanup/index.cjs.
// The logic lives in cleanup.ts so tests can import it without side effects.

import { type DiscordConfig, parseConfig } from "./client"
import { fail, runCleanup } from "./cleanup"

async function main(): Promise<void> {
  const rawInactiveDays = process.env.INACTIVE_DAYS ?? "14"
  const inactiveDays = Number.parseInt(rawInactiveDays, 10)
  // Without this, NaN would make every cutoff comparison false and the run would
  // treat every empty thread as old enough to delete.
  if (!Number.isFinite(inactiveDays) || inactiveDays <= 0) {
    fail(`INACTIVE_DAYS must be a positive number of days, got "${rawInactiveDays}"`)
  }
  // Fail-safe parsing: only an explicit opt-out turns real deletion on, so a
  // typo in DRY_RUN leaves the run in dry-run mode.
  const rawDryRun = (process.env.DRY_RUN ?? "").trim().toLowerCase()
  const dryRun = !["false", "0", "no"].includes(rawDryRun)
  let config: DiscordConfig
  try {
    config = parseConfig(process.env.DISCORD_BOT_TOKEN ?? "", process.env.DISCORD_CHANNEL_ID ?? "")
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
  await runCleanup(config, inactiveDays, dryRun)
}

main().catch((error) =>
  fail(`Error running cleanup: ${error instanceof Error ? error.message : String(error)}`),
)
