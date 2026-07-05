const ftp = require('basic-ftp');
const fs = require('fs');
const os = require('os');
const path = require('path');
const posix = require('path').posix;
const { Readable } = require('stream');
const { patchIndexPhpPaths } = require('./laravel');
const { renderExtractorScript } = require('./zip-deploy');

const STATE_FILE_NAME = '.ftp-pusher-state';

// Given a repo-relative path, find the most specific mapping whose `local`
// prefix matches it (e.g. local:"public" catches "public/index.php"), and
// return the remote root to use plus the path relative to that root.
// Falls back to the deploy's default remoteRoot when nothing matches.
function resolveDestination(relPath, config) {
  const mappings = config.mappings || [];
  let best = null;
  for (const mapping of mappings) {
    const local = mapping.local.replace(/\/+$/, '');
    if (relPath === local || relPath.startsWith(local + '/')) {
      if (!best || local.length > best.local.length) {
        best = mapping;
      }
    }
  }
  if (best) {
    const local = best.local.replace(/\/+$/, '');
    const mappedRelPath = relPath.slice(local.length).replace(/^\/+/, '');
    return { remoteRoot: best.remote, relPath: mappedRelPath, mapping: best };
  }
  return { remoteRoot: config.remoteRoot, relPath, mapping: null };
}

class FtpDeployer {
  constructor(config) {
    this.config = config;
    this.client = new ftp.Client();
    this.rootAbsCache = new Map(); // configured remoteRoot string -> resolved absolute path
    this.primaryRootAbs = null;
    // Optional (label, bytes, totalBytes) => void, called repeatedly during a transfer.
    this.onTransferProgress = null;
  }

  async connect() {
    await this.client.access({
      host: this.config.host,
      port: this.config.port,
      user: this.config.user,
      password: this.config.password,
      secure: this.config.secure
    });
    this.primaryRootAbs = await this._resolveRoot(this.config.remoteRoot);
  }

  close() {
    this.client.close();
  }

  async _resolveRoot(remoteRoot) {
    if (this.rootAbsCache.has(remoteRoot)) {
      return this.rootAbsCache.get(remoteRoot);
    }
    await this.client.ensureDir(remoteRoot);
    const abs = await this.client.pwd();
    this.rootAbsCache.set(remoteRoot, abs);
    return abs;
  }

  // dirAbs must already be an absolute, existing remote directory (see _resolveRoot).
  async _uploadFileTo(dirAbs, remoteName, source, sizeBytes, label) {
    await this.client.cd(dirAbs);
    if (this.onTransferProgress) {
      this.client.trackProgress((info) => {
        this.onTransferProgress({ label, bytes: info.bytes, totalBytes: sizeBytes });
      });
    }
    try {
      await this.client.uploadFrom(source, remoteName);
    } finally {
      if (this.onTransferProgress) this.client.trackProgress();
    }
  }

  async uploadFile(localFullPath, relPath) {
    const { remoteRoot, relPath: mappedRelPath, mapping } = resolveDestination(relPath, this.config);
    const rootAbs = await this._resolveRoot(remoteRoot);
    const dir = posix.dirname(mappedRelPath);
    const target = dir === '.' ? rootAbs : posix.join(rootAbs, dir);
    await this.client.ensureDir(target);
    const remoteName = posix.basename(mappedRelPath);

    if (mapping && mapping.fixIndexPhp && mappedRelPath === 'index.php') {
      const relToAppRoot = posix.relative(rootAbs, this.primaryRootAbs) || '.';
      const content = fs.readFileSync(localFullPath, 'utf8');
      const patched = patchIndexPhpPaths(content, relToAppRoot);
      const sizeBytes = Buffer.byteLength(patched);
      await this._uploadFileTo(target, remoteName, Readable.from(patched), sizeBytes, relPath);
    } else {
      const sizeBytes = fs.statSync(localFullPath).size;
      await this._uploadFileTo(target, remoteName, localFullPath, sizeBytes, relPath);
    }
  }

  // Uploads a zip + its generated extractor PHP script into the same remote
  // directory (so the script can find the zip via a plain relative filename),
  // computing the extractor's relative path to the actual target directory.
  async uploadZipBundle({ localZipPath, extractorRemotePath, targetRemoteDir, secret, label }) {
    const extractorDirConfigPath = posix.dirname(extractorRemotePath);
    const extractorFileName = posix.basename(extractorRemotePath);
    const extractorDirAbs = await this._resolveRoot(extractorDirConfigPath);
    const targetDirAbs = await this._resolveRoot(targetRemoteDir);
    const relTarget = posix.relative(extractorDirAbs, targetDirAbs) || '.';

    const zipName = `${label.replace(/[^a-z0-9_-]/gi, '_')}-${Date.now()}.zip`;
    const zipSize = fs.statSync(localZipPath).size;
    await this._uploadFileTo(extractorDirAbs, zipName, localZipPath, zipSize, `${label} (zip)`);

    const script = renderExtractorScript({ secret, targetRelative: relTarget, zipName });
    await this._uploadFileTo(
      extractorDirAbs,
      extractorFileName,
      Readable.from(script),
      Buffer.byteLength(script),
      `${label} (extractor)`
    );
  }

  async removeFile(relPath) {
    const { remoteRoot, relPath: mappedRelPath } = resolveDestination(relPath, this.config);
    const rootAbs = await this._resolveRoot(remoteRoot);
    const dir = posix.dirname(mappedRelPath);
    const target = dir === '.' ? rootAbs : posix.join(rootAbs, dir);
    try {
      await this.client.cd(target);
      await this.client.remove(posix.basename(mappedRelPath));
    } catch (err) {
      // Already gone on the server — fine, nothing to clean up.
      if (!/no such file|550/i.test(err.message || '')) {
        throw err;
      }
    }
  }

  // State always lives under the primary remoteRoot, never under a mapping
  // target — on split layouts the mapping target (e.g. public_html) is web-exposed.
  async downloadState() {
    const tmpFile = path.join(os.tmpdir(), `ftp-pusher-state-${Date.now()}.json`);
    try {
      await this.client.cd(this.primaryRootAbs);
      await this.client.downloadTo(tmpFile, STATE_FILE_NAME);
      const content = fs.readFileSync(tmpFile, 'utf8');
      return JSON.parse(content).sha;
    } catch {
      return null;
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  }

  async uploadState(sha) {
    const tmpFile = path.join(os.tmpdir(), `ftp-pusher-state-${Date.now()}.json`);
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({ sha, deployedAt: new Date().toISOString() }, null, 2)
    );
    try {
      await this.client.cd(this.primaryRootAbs);
      await this.client.uploadFrom(tmpFile, STATE_FILE_NAME);
    } finally {
      fs.unlinkSync(tmpFile);
    }
  }
}

module.exports = { FtpDeployer, STATE_FILE_NAME, resolveDestination };
