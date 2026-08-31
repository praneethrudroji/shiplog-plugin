#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, paths, worklogHome } from '../lib/config.mjs';
import { installScheduler, uninstallScheduler, agentStatus, LABEL } from '../lib/scheduler.mjs';

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || join(dirname(fileURLToPath(import.meta.url)), '..');

const USAGE = `worklog scheduler

  --install        install and load the nightly launchd job
  --uninstall      unload and remove it
  --status         report whether it is registered and when it next runs
  --print          show the exact files that would be written, without writing them
  --hour <0-23>    override the scheduled hour (default: config schedule.hour)
  --minute <0-59>  override the scheduled minute
  -h, --help       show this message`;

export function parseArgs(argv) {
  const args = { action: null, hour: null, minute: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--install' || a === '--uninstall' || a === '--status' || a === '--print') args.action = a.slice(2);
    else if (a === '--hour') args.hour = Number(argv[++i]);
    else if (a === '--minute') args.minute = Number(argv[++i]);
    else if (a === '--help' || a === '-h') args.action = 'help';
    else throw new Error(`unknown flag: ${a}`);
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.action || args.action === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  if (args.action === 'status') {
    const status = agentStatus();
    process.stdout.write(status.installed
      ? `${LABEL}: registered${status.nextRun ? `, next run ${status.nextRun}` : ''}\n`
      : `${LABEL}: not installed\n`);
    return status.installed ? 0 : 1;
  }

  const home = worklogHome();
  if (args.action === 'uninstall') {
    const { removed } = uninstallScheduler({ worklogHome: home });
    process.stdout.write(`removed ${removed}\n`);
    return 0;
  }

  const cfg = loadConfig();
  const hour = args.hour ?? cfg.schedule?.hour ?? 2;
  const minute = args.minute ?? cfg.schedule?.minute ?? 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`invalid hour: ${hour}`);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error(`invalid minute: ${minute}`);

  const result = installScheduler({
    worklogHome: home, pluginRoot: PLUGIN_ROOT, hour, minute, dryRun: args.action === 'print',
  });

  if (args.action === 'print') {
    process.stdout.write(`# ${result.wrapperPath}\n${result.wrapper}\n# ${result.plistPath}\n${result.plist}\n`);
    return 0;
  }

  process.stdout.write(`wrote ${result.wrapperPath}\nwrote ${result.plistPath}\n`);
  if (result.loaded) {
    process.stdout.write(`${LABEL} registered; it will run daily at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}\n`);
    process.stdout.write(`logs: ${join(paths(home).logs, 'sync.log')}\n`);
    return 0;
  }

  process.stderr.write(
    `the job was written but launchctl did not register it: ${result.detail}\n`
    + 'On a managed Mac this can require approval under System Settings > General > Login Items.\n'
    + `You can retry with: launchctl bootstrap gui/$(id -u) ${result.plistPath}\n`,
  );
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}
