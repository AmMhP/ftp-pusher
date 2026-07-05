#!/usr/bin/env node
const { Command } = require('commander');
const { init } = require('../src/commands/init');
const { deploy, status } = require('../src/deploy');
const { CONFIG_FILE, ENV_FILE } = require('../src/config');
const ui = require('../src/ui');

const program = new Command();

program
  .name('ftp-pusher')
  .description('Deploy git-tracked changes to a remote host over FTP/FTPS')
  .version('1.0.0');

program
  .command('init')
  .description(`Scaffold ${CONFIG_FILE} and ${ENV_FILE} in the current directory`)
  .action(() => {
    const { results, notes } = init(process.cwd());
    for (const [file, created] of results) {
      if (created) ui.success(`Created ${file}`);
      else ui.info(`Skipped ${file} (already exists)`);
    }
    if (notes.length) {
      console.log('');
      notes.forEach((line) => console.log(ui.pc.dim(line)));
    }
    console.log(
      `\n${ui.pc.bold('Next:')} edit ${ui.pc.cyan(CONFIG_FILE)} (remoteRoot) and ${ui.pc.cyan(ENV_FILE)} (FTP credentials).`
    );
  });

program
  .command('status')
  .description('Show what would be uploaded/deleted without deploying')
  .option('--full', 'Compare against a full re-upload instead of the remote marker')
  .action(async (opts) => {
    try {
      const { toSha, changes } = await status({ full: !!opts.full });
      ui.printPlan(changes, toSha);
      if (changes.length === 0) ui.success('Nothing to deploy — up to date.');
    } catch (err) {
      fail(err);
    }
  });

program
  .command('deploy')
  .description('Upload changed files and delete removed ones on the remote host')
  .option('--full', 'Force a full re-upload of all git-tracked files')
  .option('--dry-run', 'Show the plan without uploading anything')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(async (opts) => {
    try {
      const dryRun = !!opts.dryRun;
      const result = await deploy({
        full: !!opts.full,
        dryRun,
        yes: !!opts.yes,
        onPlan: ({ changes, toSha }) => ui.printPlan(changes, toSha),
        onTransferProgress: dryRun ? null : (info) => ui.trackTransferProgress(info),
        onProgress: dryRun
          ? null
          : (change) => {
              const label = change.status === 'Z' ? `${change.path} (zip)` : change.path;
              const stats = ui.finishTransfer(label);
              ui.clearTransferLine();
              ui.printProgress(change, stats);
            }
      });

      if (result.skipped) {
        ui.success('Nothing to deploy — up to date.');
      } else if (result.dryRun) {
        console.log(ui.pc.dim(`\n(dry run — ${result.changes.length} change(s) shown above, nothing uploaded)`));
      } else if (result.cancelled) {
        ui.warn('Cancelled.');
      } else {
        console.log('');
        const zippedPart = result.zipped ? `${ui.pc.magenta(`${result.zipped} zipped`)}, ` : '';
        ui.success(
          `Done: ${zippedPart}${ui.pc.green(`${result.uploaded} uploaded`)}, ${ui.pc.red(`${result.deleted} deleted`)}. Deployed ${ui.pc.bold(result.toSha.slice(0, 7))}.`
        );
      }
    } catch (err) {
      fail(err);
    }
  });

function fail(err) {
  ui.error(err.message);
  process.exitCode = 1;
}

program.parseAsync(process.argv);
