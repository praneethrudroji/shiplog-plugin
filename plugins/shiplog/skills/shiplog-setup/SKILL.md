---
name: shiplog-setup
description: Configure shiplog - connect Azure DevOps and GitHub, set your fiscal year and timezone, choose a nightly sync time, and optionally turn on the daily standup summary.
argument-hint: "[--reconfigure]"
allowed-tools: [Bash, Read, Write, Edit, AskUserQuestion]
---

# Setting up shiplog

Walk the user through setup conversationally. Do not dump every question at once, and do not
write any file until you have confirmed the values with them.

Config lives at `~/.shiplog/config.json` (mode 0600). Secrets go in a separate
`~/.shiplog/secrets.env` (mode 0600) and are never written into `config.json`.

## 1. Check what already exists

Read `~/.shiplog/config.json` if it is there. If the user passed `--reconfigure`, treat existing
values as defaults to confirm rather than starting from scratch. If a config already exists and no
`--reconfigure` was passed, tell them what is configured and ask what they want to change.

## 2. Pick sources

Ask which sources to enable: Azure DevOps, GitHub, or both. Jira is not supported yet.

## 3. Collect credentials, one source at a time

For each enabled source, tell the user exactly what to create and with which scopes, then ask them
to paste the token. Never echo a token back, never write it to `config.json`, and never put it in a
message you send later in the conversation.

**GitHub.** If `gh auth status` succeeds, offer to reuse `gh auth token` so they do not need a new
token at all. Otherwise ask for a fine-grained or classic PAT with read access to the repositories
they work in. Store as `SHIPLOG_GITHUB_TOKEN`.

**Azure DevOps.** Ask for a PAT from `https://dev.azure.com/{org}/_usersSettings/tokens` with these
read scopes: Code (read), Work Items (read), Release (read). Store as `SHIPLOG_ADO_PAT`. Also ask
for the organization (a name or the full `https://dev.azure.com/org` URL) and which projects to
track.

Write secrets with `Write` to `~/.shiplog/secrets.env` in `KEY=value` form, then
`chmod 600 ~/.shiplog/secrets.env`.

## 4. Resolve identity automatically

Do not ask the user to type a user id. Run the whoami helper so the id comes from the API itself:

```bash
node -e "
import('$CLAUDE_PLUGIN_ROOT/lib/sources/github.mjs').then(async (m) => {
  const { createHttpClient } = await import('$CLAUDE_PLUGIN_ROOT/lib/http.mjs');
  console.log(JSON.stringify(await m.whoami({ token: process.env.SHIPLOG_GITHUB_TOKEN, http: createHttpClient({}) })));
})"
```

Use the equivalent `whoami` from `lib/sources/azure-devops.mjs` for Azure DevOps. Store the results
in `identity.githubLogin` and `identity.adoUserId`. If a whoami call fails, the token is wrong or
under-scoped: say so plainly and let them retry rather than saving a guess.

## 5. Calendar settings

Propose detected values and ask them to confirm rather than making them think from scratch:

- **Timezone**: default to the system timezone.
- **Date format**: propose based on their locale (day-first for most of the world, month-first for
  the US). This is context for reading dates like `05/01/2026` inside comments.
- **Fiscal year start month**: 4 for an April to March year, 1 for calendar year, and so on.
- **Fiscal year naming**: whether April 2026 to March 2027 is called FY2026 or FY2027.

## 6. Standup summary (optional)

Ask whether they want a short summary the first time they open a terminal each day, and if so over
what range: `since_last_working_day` (the default, last working day through now, in per-day
sections), `last_working_day`, `last_week`, or `last_month`. Set `standup.enabled` and
`standup.range`.

## 7. Validate before scheduling

Run a dry run for each source and show the result. This catches a bad token or a project the PAT
cannot see, before anything is scheduled:

```bash
node $CLAUDE_PLUGIN_ROOT/bin/sync.mjs --dry-run
```

If a source fails here, fix it before continuing.

## 8. Install the scheduler, with consent

This writes outside the project, so show the exact files first and ask before loading anything:

```bash
node $CLAUDE_PLUGIN_ROOT/bin/install-scheduler.mjs --print
```

Show the user the wrapper script and the plist, confirm the time, then install:

```bash
node $CLAUDE_PLUGIN_ROOT/bin/install-scheduler.mjs --install
```

If launchctl refuses to register the job, do not report success. On a managed Mac this often needs
approval under System Settings > General > Login Items. Pass along the retry command the script
prints.

Scheduling is macOS only right now. On Linux, tell the user the cron line the script suggests and
let them add it themselves.

## 9. First backfill

Offer to run the first real sync now, so there is data to query immediately:

```bash
node $CLAUDE_PLUGIN_ROOT/bin/sync.mjs
```

Then summarize what was configured, where the data lives, and that they can now just ask questions
like "what did I ship last week".
