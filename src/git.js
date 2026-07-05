const { execFileSync } = require('child_process');

function run(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function isGitRepo(cwd) {
  try {
    run(['rev-parse', '--is-inside-work-tree'], cwd);
    return true;
  } catch {
    return false;
  }
}

function getHeadSha(cwd) {
  return run(['rev-parse', 'HEAD'], cwd).trim();
}

function shaExists(sha, cwd) {
  try {
    run(['cat-file', '-e', sha], cwd);
    return true;
  } catch {
    return false;
  }
}

// All git-tracked files, used for a full/first deploy.
function listTrackedFiles(cwd) {
  const out = run(['ls-files', '-z'], cwd);
  return out.split('\0').filter(Boolean);
}

// Changed files between two commits. Returns [{ status: 'A'|'M'|'D', path, oldPath? }]
function diffFiles(fromSha, toSha, cwd) {
  const out = run(['diff', '--name-status', '-M', '-z', fromSha, toSha], cwd);
  const parts = out.split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (status.startsWith('R')) {
      const oldPath = parts[++i];
      const newPath = parts[++i];
      changes.push({ status: 'D', path: oldPath });
      changes.push({ status: 'A', path: newPath });
    } else {
      const filePath = parts[++i];
      changes.push({ status: status[0], path: filePath });
    }
  }
  return changes;
}

module.exports = { isGitRepo, getHeadSha, shaExists, listTrackedFiles, diffFiles };
