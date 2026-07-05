const pc = require('picocolors');

const STATUS_STYLE = {
  A: { label: 'upload', symbol: '+', color: pc.green },
  M: { label: 'update', symbol: '~', color: pc.yellow },
  D: { label: 'delete', symbol: '-', color: pc.red },
  Z: { label: 'zip', symbol: '⇒', color: pc.magenta }
};

function styleFor(status) {
  return STATUS_STYLE[status] || { label: status, symbol: '?', color: pc.white };
}

function changeLine(change) {
  const { label, symbol, color } = styleFor(change.status);
  return color(`  ${symbol} ${label.padEnd(6)} ${change.path}`);
}

function printPlan(changes, toSha) {
  if (changes.length === 0) return;
  const header = toSha
    ? `${pc.bold(pc.cyan(`Plan (${changes.length} change${changes.length === 1 ? '' : 's'})`))} ${pc.dim('->')} ${pc.dim(toSha.slice(0, 7))}`
    : pc.bold(pc.cyan(`Plan (${changes.length} change${changes.length === 1 ? '' : 's'})`));
  console.log(header);
  for (const change of changes) {
    console.log(changeLine(change));
  }
}

function printProgress({ status, path: filePath }, stats = null) {
  const { label, symbol, color } = styleFor(status);
  const suffix = stats
    ? pc.dim(`  (${formatBytes(stats.totalBytes)}, ${formatBytes(stats.avgSpeed)}/s)`)
    : '';
  console.log(color(`  ${pc.bold(symbol)} ${label.padEnd(6)} ${filePath}`) + suffix);
}

function success(message) {
  console.log(pc.green(`${pc.bold('✓')} ${message}`));
}

function info(message) {
  console.log(pc.dim(message));
}

function warn(message) {
  console.log(pc.yellow(`${pc.bold('!')} ${message}`));
}

function error(message) {
  console.error(pc.red(`${pc.bold('✗')} Error: ${message}`));
}

function heading(message) {
  console.log(pc.bold(pc.cyan(message)));
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return '0B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value.toFixed(i === 0 ? 0 : 1)}${units[i]}`;
}

function renderBar(fraction, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;
}

// Only worth a live bar for transfers big enough that it'll actually update
// more than once or twice — otherwise it's just flicker for small files.
const PROGRESS_MIN_BYTES = 32 * 1024;
const transferStarts = new Map();
let lastLineWasProgress = false;

function trackTransferProgress({ label, bytes, totalBytes }) {
  if (!totalBytes || totalBytes < PROGRESS_MIN_BYTES) return;
  let entry = transferStarts.get(label);
  if (!entry) {
    entry = { start: Date.now(), totalBytes };
    transferStarts.set(label, entry);
  }
  const elapsed = (Date.now() - entry.start) / 1000;
  const speed = elapsed > 0 ? bytes / elapsed : 0;
  const fraction = totalBytes ? bytes / totalBytes : 0;
  const pct = Math.round(fraction * 100);
  const shortLabel = label.length > 28 ? `…${label.slice(-27)}` : label.padEnd(28);
  const line =
    `  ${pc.dim(shortLabel)} [${renderBar(fraction)}] ${String(pct).padStart(3)}%  ` +
    `${formatBytes(bytes)}/${formatBytes(totalBytes)}  ${pc.dim(`${formatBytes(speed)}/s`)}`;
  process.stdout.write(`\r\x1b[2K${line}`);
  lastLineWasProgress = true;
}

// Call once a file is fully done (success or not) to clear any in-place
// progress line before printing a normal console.log line after it.
function clearTransferLine() {
  if (lastLineWasProgress) {
    process.stdout.write('\r\x1b[2K');
    lastLineWasProgress = false;
  }
}

// Returns { elapsedSec, totalBytes, avgSpeed } if this label had a tracked
// progress bar, or null if it was too small to have been tracked at all.
function finishTransfer(label) {
  const entry = transferStarts.get(label);
  transferStarts.delete(label);
  if (!entry) return null;
  const elapsedSec = (Date.now() - entry.start) / 1000;
  return {
    elapsedSec,
    totalBytes: entry.totalBytes,
    avgSpeed: elapsedSec > 0 ? entry.totalBytes / elapsedSec : entry.totalBytes
  };
}

module.exports = {
  printPlan,
  printProgress,
  success,
  info,
  warn,
  error,
  heading,
  formatBytes,
  trackTransferProgress,
  clearTransferLine,
  finishTransfer,
  pc
};
