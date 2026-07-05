# ftp-pusher

A CLI that deploys a git-tracked project to a host over FTP/FTPS. It figures
out what changed by diffing your current commit against a marker file it
maintains **on the server itself**, then uploads only the files that changed
and deletes the ones that were removed — no full re-upload every time, and no
SSH required.

## How it works

1. On deploy, it downloads a small `.ftp-pusher-state` file from the server
   (if one exists) containing the SHA of the last commit that was deployed.
2. It runs `git diff --name-status` between that SHA and your current `HEAD`.
3. It uploads added/modified files and deletes removed ones over FTP.
4. On success, it uploads a fresh `.ftp-pusher-state` with the new SHA.

Because the marker lives on the server (not on your machine), deploying from
a different laptop or a CI runner works correctly — it always compares
against whatever was *actually* last deployed, not whatever your local
machine remembers.

If there's no marker yet (first deploy) or you pass `--full`, it uploads
every git-tracked file instead of diffing.

Only files tracked by git are ever considered. Anything in `.gitignore`
(`node_modules/`, `.env`, build artifacts, etc.) is automatically excluded,
on top of whatever you list in the config's own `ignore` patterns.

## Requirements

- Node.js >= 18 (uses the built-in `fetch`, needed for the zip-deploy feature below)
- The project you're deploying must be a git repository

## Install

**From npm (recommended):**

```sh
npm install -g ftp-pusher
```

This puts the `ftp-pusher` command on your `PATH` globally. If you'd rather
not install it globally, run it per-project instead:

```sh
npm install --save-dev ftp-pusher
npx ftp-pusher init
```

**From source** (for contributing or trying unreleased changes):

```sh
git clone https://github.com/AmMhP/ftp-pusher.git
cd ftp-pusher
npm install
npm link   # optional: makes the `ftp-pusher` command available globally
```

Without `npm link`, run it as `node /path/to/ftp-pusher/bin/ftp-pusher.js <command>`.

## Quick start

```sh
cd /path/to/your/project
ftp-pusher init
```

This creates:
- `ftp-pusher.config.json` — deploy paths and rules (safe to commit)
- `.env.ftp-pusher` — FTP credentials (added to `.gitignore` automatically, never commit this)
- `.env.ftp-pusher.example` — template for teammates

Edit both files, then:

```sh
ftp-pusher status        # see what would change, without touching the server
ftp-pusher deploy         # upload it (asks for confirmation first)
```

## Commands

| Command | What it does |
|---|---|
| `ftp-pusher init` | Scaffolds `ftp-pusher.config.json` and `.env.ftp-pusher`. Detects Laravel (via `composer.json`) and pre-fills a config suited to shared hosting. Never overwrites existing files. |
| `ftp-pusher status [--full]` | Shows the upload/delete plan without connecting to do any writes. |
| `ftp-pusher deploy [--full] [--dry-run] [-y/--yes]` | Runs the deploy. `--full` forces a complete re-upload. `--dry-run` shows the plan and stops. `-y` skips the confirmation prompt (useful in CI). |

## Configuration — `ftp-pusher.config.json`

```json
{
  "remoteRoot": "/public_html",
  "localRoot": ".",
  "secure": false,
  "mappings": [],
  "zipDeploy": [],
  "ignore": [".git/**", ".env", ".env.*", "ftp-pusher.config.json", "node_modules/**"]
}
```

| Field | Meaning |
|---|---|
| `remoteRoot` | Base directory on the server everything deploys into (unless overridden by a mapping). |
| `localRoot` | Local directory to deploy from, relative to the config file. Usually `.`. |
| `secure` | `true` to use FTPS (explicit TLS). Can also be set via `FTP_SECURE` in the env file. |
| `mappings` | Route specific local subfolders to a *different* remote root — see below. |
| `zipDeploy` | Deploy specific large/many-file directories as a single zip instead of file-by-file — see below. |
| `ignore` | Glob patterns (via [micromatch](https://github.com/micromatch/micromatch)) excluded from every deploy, even though they're git-tracked. |

## Credentials — `.env.ftp-pusher`

```
FTP_HOST=ftp.example.com
FTP_PORT=21
FTP_USER=
FTP_PASSWORD=
FTP_SECURE=false
```

This is deliberately **not** `.env` — many frameworks (Laravel included) already
ship their own `.env` for application secrets. Keeping FTP credentials in a
separate file means `ftp-pusher init` never touches or overwrites a `.env`
that's already there, and avoids any variable-name collisions (e.g. Laravel's
`filesystems.php` `ftp` disk driver also reads `FTP_HOST`/`FTP_PASSWORD`).

## Split hosting layouts (`mappings`)

Some shared hosts only expose one directory to the web (commonly
`public_html`) and give you no control over the document root. For frameworks
like Laravel, that means the app itself has to live *outside* the web root,
with only the contents of `public/` actually reachable by visitors.

```json
{
  "remoteRoot": "/home/user/laravel_app",
  "mappings": [
    { "local": "public", "remote": "/home/user/public_html", "fixIndexPhp": true }
  ]
}
```

Any file under `public/` gets uploaded (flattened) to `public_html` instead
of `remoteRoot`; everything else goes to `remoteRoot` as usual.

`fixIndexPhp: true` additionally rewrites `public/index.php`'s
`__DIR__.'/../vendor/autoload.php'` and `__DIR__.'/../bootstrap/app.php'`
requires on upload, computed from the real relative path between the two
remote directories. **Your local `index.php` is never modified** — only the
copy that gets uploaded is patched, so this stays correct even if you rename
directories on the host later.

## Large directories (`zipDeploy`)

Uploading `vendor/` (or any directory with thousands of small files)
file-by-file over FTP is slow. `zipDeploy` instead:

1. Zips the directory locally.
2. Uploads the zip plus a small, auto-generated PHP script into the same
   remote directory.
3. Calls that script over HTTP, which extracts the zip into the real target
   directory (wiping whatever was there first) and then **deletes both
   itself and the zip**.

FTP has no way to run commands on the server, which is why this step needs an
HTTP-reachable URL — plain FTP can move files but can't unzip them remotely.

```json
{
  "zipDeploy": [
    {
      "local": "vendor",
      "remoteDir": "vendor",
      "extractorUrl": "https://your-domain.com/ftp-pusher-unzip.php",
      "extractorRemotePath": "/home/user/public_html/ftp-pusher-unzip.php",
      "secret": "a-long-random-string"
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `local` | Local directory (relative to the repo) to deploy as a zip. Any change under it triggers a full re-zip of the whole directory — not a per-file diff. |
| `remoteDir` | Where it lands, relative to `remoteRoot`. |
| `extractorUrl` | Public HTTPS URL where the extractor script will be reachable once uploaded. **You must fill this in** — it can't be inferred, since it depends on your domain. |
| `extractorRemotePath` | Where to FTP-upload the extractor script. Must be the same physical file the URL above serves — i.e. under whichever directory is web-exposed (e.g. `public_html`). |
| `secret` | Random token the script checks (timing-safe comparison) before extracting anything. `ftp-pusher init` generates one automatically for Laravel projects. |

Security notes:
- The extraction target directory is baked into the generated script at
  upload time, not taken from the HTTP request — so even a leaked secret can
  only re-trigger extraction of *that exact zip* into *that exact,
  predetermined path*, not an arbitrary one.
- The script deletes itself (and the zip) immediately after running,
  regardless of whether extraction succeeded — so it only exists on the
  server for the few seconds between upload and the trigger call.
- Your host's PHP needs the `zip` extension (`ZipArchive`) enabled — standard
  on most shared hosting, but worth confirming beforehand.

## Laravel-specific behavior

Running `ftp-pusher init` in a project with `laravel/framework` in
`composer.json` pre-fills:
- `mappings` for the `public_html` split described above, with `fixIndexPhp: true`
- `zipDeploy` for `vendor/` with a freshly generated secret
- extra `ignore` entries (`tests/**`, `.github/**`, `phpunit.xml`)

You still need to:
1. Fill in the real `extractorUrl` for your domain.
2. Create Laravel's own `.env` directly on the host (it's excluded from
   deploys on purpose — real secrets should never go through git or FTP).
3. Make sure `storage/` and `bootstrap/cache/` are writable on the host.

If `vendor/` isn't already committed to git, `zipDeploy` won't see it — on
hosts with no SSH/composer access, you need to commit `vendor/` (build it
locally with `composer install --no-dev --optimize-autoloader` first).

## Output

`status` and `deploy` print a colored plan (`+` upload, `~` update, `-`
delete, `⇒` zip-and-extract), and `deploy` shows a live progress bar with
transfer speed for any file over 32KB — most noticeably the zip bundle above.
