---
name: shiplog-sync
description: Run a shiplog sync now instead of waiting for the nightly job - useful right before a standup, a one-on-one, or a review.
argument-hint: "[--dry-run] [--source github|azure_devops] [--since YYYY-MM-DD] [--no-enrich]"
allowed-tools: [Bash]
---

# Sync now

Run the sync with whatever arguments the user passed:

```bash
node $CLAUDE_PLUGIN_ROOT/bin/sync.mjs $ARGUMENTS
```

## What the flags do

- `--dry-run` fetches and normalizes but writes nothing. Use it to check credentials without
  touching the database.
- `--source <name>` limits the run to one source.
- `--since YYYY-MM-DD` overrides the window start. Useful for backfilling further than the usual
  incremental window.
- `--no-enrich` skips the date-attribution stage, so the run makes no model call at all. Slightly
  faster, and the skipped comments stay queued for the next run.

## Reading the result

Exit codes: `0` every source succeeded, `2` some succeeded and some failed, `1` all failed.

Report what was written per source. If a source failed, quote the error rather than paraphrasing
it, and note that its watermark did not move, so the window it missed will be retried on the next
run and nothing was lost.

A run also snapshots the database to `~/.shiplog/backups/` before making changes, and prunes
snapshots past the retention window.

If the user is about to walk into a standup or review, offer to summarize what the sync just picked
up.
