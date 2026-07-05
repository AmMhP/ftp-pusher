const fs = require('fs');
const os = require('os');
const path = require('path');
const posix = require('path').posix;
const readline = require('readline');
const micromatch = require('micromatch');
const git = require('./git');
const { loadConfig } = require('./config');
const { FtpDeployer, STATE_FILE_NAME } = require('./ftp-client');
const { createZip, triggerExtraction } = require('./zip-deploy');

function filterIgnored(changes, ignorePatterns) {
  return changes.filter((c) => !micromatch.isMatch(c.path, ignorePatterns));
}

function computeChanges({ cwd, fromSha, toSha, full, ignore }) {
  if (full || !fromSha) {
    return filterIgnored(
      git.listTrackedFiles(cwd).map((p) => ({ status: 'A', path: p })),
      ignore
    );
  }
  if (!git.shaExists(fromSha, cwd)) {
    // Remote points at a commit we no longer have locally (e.g. rebased history) — fall back to full.
    return filterIgnored(
      git.listTrackedFiles(cwd).map((p) => ({ status: 'A', path: p })),
      ignore
    );
  }
  return filterIgnored(git.diffFiles(fromSha, toSha, cwd), ignore);
}

// Pulls out changes that fall under a configured zipDeploy directory (deployed
// atomically as one zip, so per-file diffing inside it is pointless) and
// returns which zipDeploy entries actually have pending changes to ship.
function partitionZipChanges(changes, zipDeploy) {
  if (!zipDeploy || zipDeploy.length === 0) {
    return { remaining: changes, zipEntriesToRun: [] };
  }
  const remaining = [];
  const matchedEntries = new Set();
  for (const change of changes) {
    const entry = zipDeploy.find((e) => {
      const local = e.local.replace(/\/+$/, '');
      return change.path === local || change.path.startsWith(local + '/');
    });
    if (entry) {
      matchedEntries.add(entry);
    } else {
      remaining.push(change);
    }
  }
  return { remaining, zipEntriesToRun: zipDeploy.filter((e) => matchedEntries.has(e)) };
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

async function planChanges({ cwd, full }) {
  if (!git.isGitRepo(cwd)) {
    throw new Error('Not a git repository.');
  }
  const config = loadConfig(cwd);
  const toSha = git.getHeadSha(cwd);

  const deployer = new FtpDeployer(config);
  await deployer.connect();
  let fromSha = null;
  try {
    fromSha = full ? null : await deployer.downloadState();
    const changes = computeChanges({ cwd, fromSha, toSha, full, ignore: config.ignore });
    const { remaining, zipEntriesToRun } = partitionZipChanges(changes, config.zipDeploy);
    const displayChanges = [
      ...zipEntriesToRun.map((e) => ({ status: 'Z', path: e.local })),
      ...remaining
    ];
    return { config, deployer, fromSha, toSha, changes, remaining, zipEntriesToRun, displayChanges };
  } catch (err) {
    deployer.close();
    throw err;
  }
}

async function status({ cwd = process.cwd(), full = false } = {}) {
  const { deployer, fromSha, toSha, displayChanges } = await planChanges({ cwd, full });
  deployer.close();
  return { fromSha, toSha, changes: displayChanges };
}

async function runZipDeploy(entry, config, deployer) {
  if (!entry.extractorUrl || /YOUR-DOMAIN/i.test(entry.extractorUrl)) {
    throw new Error(
      `zipDeploy entry "${entry.local}" has no real extractorUrl configured in ftp-pusher.config.json.`
    );
  }

  const localDir = path.join(config.localRoot, entry.local);
  const tmpZip = path.join(
    os.tmpdir(),
    `ftp-pusher-${entry.local.replace(/[^a-z0-9_-]/gi, '_')}-${Date.now()}.zip`
  );
  try {
    await createZip(localDir, tmpZip);
    await deployer.uploadZipBundle({
      localZipPath: tmpZip,
      extractorRemotePath: entry.extractorRemotePath,
      targetRemoteDir: posix.join(config.remoteRoot, entry.remoteDir || entry.local),
      secret: entry.secret,
      label: entry.local
    });
    await triggerExtraction(entry.extractorUrl, entry.secret);
  } finally {
    if (fs.existsSync(tmpZip)) fs.unlinkSync(tmpZip);
  }
}

async function deploy({
  cwd = process.cwd(),
  full = false,
  dryRun = false,
  yes = false,
  onPlan = null,
  onProgress = null,
  onTransferProgress = null
} = {}) {
  const { config, deployer, fromSha, toSha, remaining, zipEntriesToRun, displayChanges } =
    await planChanges({ cwd, full });

  if (onPlan) onPlan({ changes: displayChanges, fromSha, toSha });

  if (displayChanges.length === 0) {
    deployer.close();
    return { changes: displayChanges, toSha, uploaded: 0, deleted: 0, zipped: 0, skipped: true };
  }

  if (dryRun) {
    deployer.close();
    return { changes: displayChanges, toSha, uploaded: 0, deleted: 0, zipped: 0, dryRun: true };
  }

  if (!yes) {
    const proceed = await confirm(
      `\nDeploy ${displayChanges.length} change(s) from ${fromSha ? fromSha.slice(0, 7) : '(none)'} to ${toSha.slice(0, 7)}? [y/N] `
    );
    if (!proceed) {
      deployer.close();
      return { changes: displayChanges, toSha, uploaded: 0, deleted: 0, zipped: 0, cancelled: true };
    }
  }

  if (onTransferProgress) deployer.onTransferProgress = onTransferProgress;

  let uploaded = 0;
  let deleted = 0;
  let zipped = 0;
  try {
    for (const entry of zipEntriesToRun) {
      await runZipDeploy(entry, config, deployer);
      zipped++;
      if (onProgress) onProgress({ status: 'Z', path: entry.local });
    }
    for (const change of remaining) {
      if (change.status === 'D') {
        await deployer.removeFile(change.path);
        deleted++;
      } else {
        const localFullPath = path.join(config.localRoot, change.path);
        await deployer.uploadFile(localFullPath, change.path);
        uploaded++;
      }
      if (onProgress) onProgress(change);
    }
    await deployer.uploadState(toSha);
  } finally {
    deployer.close();
  }

  return { changes: displayChanges, uploaded, deleted, zipped, toSha };
}

module.exports = { deploy, status, computeChanges, partitionZipChanges, STATE_FILE_NAME };
