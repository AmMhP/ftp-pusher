const fs = require('fs');
const path = require('path');

const CONFIG_FILE = 'ftp-pusher.config.json';
// Deliberately not ".env" — many frameworks (Laravel included) already ship
// their own .env for app secrets. Keeping FTP creds in a separate file avoids
// overwriting that file and avoids any FTP_* env var collisions with it
// (e.g. Laravel's filesystems.php "ftp" disk driver reads FTP_HOST/FTP_PASSWORD too).
const ENV_FILE = '.env.ftp-pusher';

const DEFAULT_CONFIG = {
  remoteRoot: '/',
  localRoot: '.',
  secure: false,
  // Route specific local subpaths to a different remote root than remoteRoot.
  // e.g. [{ "local": "public", "remote": "/home/user/public_html" }] for hosts
  // where the app must live outside the web-exposed directory.
  mappings: [],
  // Directories too large/numerous to deploy file-by-file over FTP (e.g.
  // vendor/). Zipped locally, uploaded as one file, then extracted on the
  // host by a small self-deleting PHP script triggered over HTTP — FTP alone
  // can't run commands remotely, so this needs an HTTP-reachable endpoint.
  // Each entry: { local, remoteDir, extractorUrl, extractorRemotePath, secret }
  zipDeploy: [],
  ignore: [
    '.git/**',
    '.env',
    '.env.*',
    'ftp-pusher.config.json',
    'node_modules/**'
  ]
};

function configPath(cwd) {
  return path.join(cwd, CONFIG_FILE);
}

function loadFileConfig(cwd) {
  const file = configPath(cwd);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No ${CONFIG_FILE} found. Run "ftp-pusher init" first.`
    );
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    ...DEFAULT_CONFIG,
    ...parsed,
    ignore: parsed.ignore || DEFAULT_CONFIG.ignore,
    mappings: parsed.mappings || DEFAULT_CONFIG.mappings,
    zipDeploy: parsed.zipDeploy || DEFAULT_CONFIG.zipDeploy
  };
}

function loadConfig(cwd = process.cwd()) {
  const fileConfig = loadFileConfig(cwd);

  const envFile = path.join(cwd, ENV_FILE);
  const env = { ...process.env };
  if (fs.existsSync(envFile)) {
    Object.assign(env, require('dotenv').parse(fs.readFileSync(envFile)));
  }

  const host = env.FTP_HOST;
  const user = env.FTP_USER;
  const password = env.FTP_PASSWORD;
  const port = env.FTP_PORT ? Number(env.FTP_PORT) : 21;
  const secure =
    env.FTP_SECURE !== undefined ? env.FTP_SECURE === 'true' : fileConfig.secure;

  const missing = ['FTP_HOST', 'FTP_USER', 'FTP_PASSWORD'].filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(
      `Missing required var(s): ${missing.join(', ')}. Check your ${ENV_FILE} file (see ${ENV_FILE}.example).`
    );
  }

  return {
    ...fileConfig,
    localRoot: path.resolve(cwd, fileConfig.localRoot),
    host,
    user,
    password,
    port,
    secure
  };
}

module.exports = { loadConfig, configPath, DEFAULT_CONFIG, CONFIG_FILE, ENV_FILE };
