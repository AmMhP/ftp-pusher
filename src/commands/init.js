const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_CONFIG, CONFIG_FILE, ENV_FILE } = require('../config');

const ENV_EXAMPLE = `FTP_HOST=ftp.example.com
FTP_PORT=21
FTP_USER=
FTP_PASSWORD=
# Set to true to use FTPS (explicit TLS)
FTP_SECURE=false
`;

const LARAVEL_NOTES = [
  `Laravel project detected. ${CONFIG_FILE} was scaffolded assuming shared`,
  'hosting where only public_html is web-exposed:',
  '  - remoteRoot ("laravel_app" placeholder) is where the rest of the app goes,',
  '    outside the web root — rename it to match your actual host path.',
  '  - The "public" -> public_html mapping uploads public/* flattened into',
  '    public_html, which is what the webserver actually serves.',
  '  - public/index.php\'s `__DIR__.\'/../vendor/autoload.php\'` and',
  '    `.../bootstrap/app.php` requires are automatically rewritten on every',
  '    deploy to point at wherever remoteRoot ends up relative to public_html',
  '    (fixIndexPhp: true on that mapping) — no manual editing needed, and your',
  '    local file is never modified, only what gets uploaded.',
  '  - vendor/ deploys as a single zip instead of thousands of individual FTP',
  '    uploads: ftp-pusher zips it, uploads the zip plus a generated, self-',
  '    deleting PHP script next to it, then calls that script over HTTP to',
  '    extract it into place and clean up after itself. FTP alone cannot run',
  '    commands on the host, which is why this needs an HTTP-reachable URL.',
  '',
  'One-time manual steps this tool will NOT do for you:',
  '  1. Create Laravel\'s .env directly on the host inside remoteRoot (it is',
  '     intentionally excluded from deploys — never commit real secrets to git).',
  '     Your local Laravel .env was left untouched; FTP credentials for this',
  `     tool live in ${ENV_FILE} instead, kept separate on purpose.`,
  '  2. Make sure storage/ and bootstrap/cache/ are writable on the host.',
  `  3. Set zipDeploy[0].extractorUrl in ${CONFIG_FILE} to a real URL on`,
  '     your domain (e.g. https://your-domain.com/ftp-pusher-unzip.php) — this',
  '     cannot be guessed automatically. extractorRemotePath must point at the',
  '     same file, under whichever directory that URL is served from',
  '     (public_html here). A random secret was already generated for you.'
];

function detectLaravel(cwd) {
  const composerPath = path.join(cwd, 'composer.json');
  if (!fs.existsSync(composerPath)) return false;
  try {
    const composer = JSON.parse(fs.readFileSync(composerPath, 'utf8'));
    return Boolean(composer.require && composer.require['laravel/framework']);
  } catch {
    return false;
  }
}

function writeIfMissing(filePath, content) {
  if (fs.existsSync(filePath)) {
    return false;
  }
  fs.writeFileSync(filePath, content);
  return true;
}

function ensureGitignoreEntries(cwd, entries) {
  const gitignorePath = path.join(cwd, '.gitignore');
  let existing = '';
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, 'utf8');
  }
  const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
  const toAdd = entries.filter((e) => !existingLines.has(e));
  if (toAdd.length === 0) return;
  const separator = existing.length && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(
    gitignorePath,
    existing + separator + (existing.length ? '\n' : '') + toAdd.join('\n') + '\n'
  );
}

function init(cwd = process.cwd()) {
  const results = [];
  const isLaravel = detectLaravel(cwd);

  const configFile = path.join(cwd, CONFIG_FILE);
  const configBody = isLaravel
    ? {
        remoteRoot: '/home/USER/laravel_app',
        localRoot: '.',
        secure: false,
        mappings: [{ local: 'public', remote: '/home/USER/public_html', fixIndexPhp: true }],
        zipDeploy: [
          {
            local: 'vendor',
            remoteDir: 'vendor',
            extractorUrl: 'https://YOUR-DOMAIN/ftp-pusher-unzip.php',
            extractorRemotePath: '/home/USER/public_html/ftp-pusher-unzip.php',
            secret: crypto.randomBytes(24).toString('hex')
          }
        ],
        ignore: [...DEFAULT_CONFIG.ignore, 'tests/**', '.github/**', 'phpunit.xml']
      }
    : {
        remoteRoot: '/public_html',
        localRoot: '.',
        secure: false,
        ignore: DEFAULT_CONFIG.ignore
      };
  const configContent = JSON.stringify(configBody, null, 2) + '\n';
  results.push([CONFIG_FILE, writeIfMissing(configFile, configContent)]);

  const envExamplePath = path.join(cwd, `${ENV_FILE}.example`);
  results.push([`${ENV_FILE}.example`, writeIfMissing(envExamplePath, ENV_EXAMPLE)]);

  const envPath = path.join(cwd, ENV_FILE);
  results.push([ENV_FILE, writeIfMissing(envPath, ENV_EXAMPLE)]);

  ensureGitignoreEntries(cwd, [ENV_FILE, 'node_modules/']);

  return { results, notes: isLaravel ? LARAVEL_NOTES : [] };
}

module.exports = { init };
