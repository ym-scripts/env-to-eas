# Changelog

All notable changes to this project are documented here. This project follows [Semantic Versioning](https://semver.org).

## [0.1.0] - 2026-11-10

### Added
- Copy a local `.env` file into an EAS environment with `eas env:create`.
- Pick the file interactively from the `.env*` files in the folder, or pass it.
- EAS environment guessed from the file name, asked for, or set with `--environment`.
- `EXPO_PUBLIC_*` variables stored as plaintext, everything else as secret (`--public-prefix`, `--visibility`).
- `--only`, `--exclude`, `--dry-run`, and a confirmation prompt (`--yes` to skip it).
- Values are never printed; EAS error output is redacted.
