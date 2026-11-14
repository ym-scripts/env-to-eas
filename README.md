# env-to-eas

[![CI](https://github.com/ym-scripts/env-to-eas/actions/workflows/ci.yml/badge.svg)](https://github.com/ym-scripts/env-to-eas/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Keep your Expo cloud builds in sync with your local `.env` files.** Pick one or more `.env` files and this copies their variables into one or more [EAS environments](https://docs.expo.dev/eas/environment-variables/), so `eas build` uses the same values you run locally. Sister of [doppler-to-eas](https://github.com/ym-scripts/doppler-to-eas), for projects that keep secrets in files instead of Doppler.

```bash
npx github:ym-scripts/env-to-eas --dry-run
```

```text
Which .env file(s)?
  1) .env
  2) .env.preview
  3) .env.production
Choose one or more (e.g. 1,3 or 1-3 or all): 2,3
.env.preview → EAS "preview"
  · API_SECRET [sensitive]
  · EXPO_PUBLIC_API_URL [plaintext]

.env.production → EAS "production"
  · API_SECRET [sensitive]
  · EXPO_PUBLIC_API_URL [plaintext]
  Empty: FEATURE_FLAG_X

1 empty variable(s). EAS can't store empty values. Skip them, or delete them from EAS so it matches your files? [S/d] s
Empty variables are skipped (pass --empty delete to remove them from EAS instead).
Push 4 variable(s) in preview, production? Existing EAS variables with the same name are overwritten. [y/N]
```

- **You choose the files.** Pass one or more, or pick from the `.env*` files in the folder: numbers (`1,3`), a range (`1-3`), names or `all` (`.env.example`, `.sample`, `.template` and `.dist` are ignored).
- **Environments are guessed from each file's name**: `.env.production`/`.prod` → production, `.env.staging`/`.preview`/`.test` → preview, `.env.development`/`.dev`/`.local` → development. For a file with no hint you're asked, and can pick several. Or pass `--environment` (repeatable, a comma list, or `all`): then every file goes to every listed environment.
- **Files sent to the same environment are merged** in the order given. A later file wins when both define a variable, and the plan says so (`API_URL: .env.production overrides .env`). An empty value never erases one set by an earlier file, so a shared `.env` plus a per-environment file works.
- **Visibility is set for you.** `EXPO_PUBLIC_*` variables ship inside the app anyway, so they're `plaintext`; everything else is `sensitive`: masked in logs and the EAS dashboard, but still readable by builds that run outside EAS's servers (local builds, GitHub runners), which can't read `secret` variables. Pass `--visibility secret` if every build runs on EAS.
- **You choose what happens to empty variables.** EAS can't store an empty value, so an empty variable is either **skipped** (the default) or, with `--empty delete` or `d` at the prompt, the same-named variable is **deleted from EAS** so the environment matches your file. A variable that EAS shares with another environment is never deleted (deleting it would remove it from all of them); the tool says so instead.
- **Values are never printed.** EAS error messages are redacted too.
- **Asks first.** `--dry-run` changes nothing.

## Requirements

- Node.js 18+
- EAS CLI, logged in (`npx eas-cli login`). A global `eas` is used if you have one; otherwise `npx eas-cli@latest`.
- Run it from your Expo project folder (where `app.json` or `app.config.*` lives).

## Usage

```bash
env-to-eas                                  # pick file(s), environments guessed or asked
env-to-eas .env.production                  # → "production"
env-to-eas .env.preview .env.production     # each to its own environment
env-to-eas .env -e preview,production       # one file to two environments
env-to-eas .env .env.production -e production   # shared values, then production overrides
env-to-eas .env.shared -e all               # development, preview and production
env-to-eas .env --environment development
env-to-eas .env.staging --only API_URL,SENTRY_DSN
env-to-eas .env.production --exclude LOCAL_ONLY --dry-run
env-to-eas .env.production --empty delete   # empties remove stale values from EAS
```

### Options

| Option              | Default            |                                             |
| ------------------- | ------------------ | ------------------------------------------- |
| `-e, --environment` | from each file name | `development`, `preview`, `production` or `all`. Repeatable or comma-separated |
| `--public-prefix P` | `EXPO_PUBLIC_`     | Stored as plaintext. Repeatable.            |
| `--visibility V`    | `sensitive`        | `sensitive` or `secret` for everything else |
| `--empty MODE`      | asked, else `skip` | `skip` or `delete` for empty variables (see above) |
| `--only K1,K2`      |                    | Only these variables                        |
| `--exclude K1,K2`   |                    | Skip these. Repeatable.                     |
| `-n, --dry-run`     |                    | Show the plan, push nothing                 |
| `-y, --yes`         |                    | Skip the confirmation                       |

### .env syntax

`KEY=value`, `export KEY=value`, `# comments`, inline comments after unquoted values, `'single'` (literal), `"double"` (with `\n`, `\t`, `\"` escapes, may span lines) and `` `backtick` `` quotes. `${VAR}` references are pushed as written, not expanded. Empty values are skipped or deleted (`--empty`).

### Exit codes

`0` success · `1` a variable failed or you cancelled · `2` usage or setup error.

## In CI

```bash
npx github:ym-scripts/env-to-eas .env.production --yes
npx github:ym-scripts/env-to-eas .env.preview .env.production --yes
```

Set `EXPO_TOKEN` so EAS is logged in. Without a terminal there's no prompt: empty variables are skipped unless you pass `--empty delete`.

## Development

```bash
npm test
```

The tests use a fake `eas` in `test/bin`, so nothing is sent to Expo.

## License

MIT © Aghogho Meyoron
