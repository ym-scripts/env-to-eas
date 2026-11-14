# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org).

## [0.3.0] - 2026-11-14

### Changed
- Variables without the public prefix are now stored as **sensitive** instead of secret. Sensitive values are masked in logs and the dashboard but can be read by builds that run outside EAS's servers (local builds, GitHub runners), which can't read secrets. `--visibility secret` keeps the old behaviour.

### Added
- Choose what happens to empty variables. EAS can't store an empty value, so they're skipped by default; `--empty delete` (or `d` at the new prompt) deletes the same-named EAS variable so the environment matches the file. A variable EAS shares with other environments is kept, with a note, because deleting it would remove it everywhere.

## [0.2.0] - 2026-11-14

### Added
- Push several `.env` files in one run: pass them (`env-to-eas .env.preview .env.production`), or pick several at the prompt with numbers (`1,3`), a range (`1-3`), names or `all`.
- Push to several EAS environments: `-e` is repeatable and takes a comma list or `all`. With `-e`, every file goes to every listed environment; without it, each file goes to the environment its name suggests, and you can pick several for a file with no hint.
- Files sent to the same environment are merged in order; the plan shows when a later file overrides a variable, and an empty value never erases one from an earlier file.
- One plan and one confirmation for everything; the summary counts variables and environments.

## [0.1.1] - 2026-11-14

### Fixed
- Running with `npx` (or any installed bin) did nothing: the CLI is started through a symlink in `node_modules/.bin`, so the "am I the main module?" check never matched and it exited silently. It now compares real paths.
- The same check also failed for a path with a space in it (`%20` in the module URL).

## [0.1.0] - 2026-11-10

### Added
- Copy a local `.env` file into an EAS environment with `eas env:create`.
- Pick the file interactively from the `.env*` files in the folder, or pass it.
- EAS environment guessed from the file name, asked for, or set with `--environment`.
- `EXPO_PUBLIC_*` variables stored as plaintext, everything else as secret (`--public-prefix`, `--visibility`).
- `--only`, `--exclude`, `--dry-run`, and a confirmation prompt (`--yes` to skip it).
- Values are never printed; EAS error output is redacted.
