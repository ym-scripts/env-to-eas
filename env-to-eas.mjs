#!/usr/bin/env node
/**
 * env-to-eas: copy the variables in a local .env file into an EAS (Expo Application
 * Services) environment, so cloud builds get the same values you use locally.
 * https://github.com/ym-scripts/env-to-eas
 *
 * Values are never printed. Variables starting with a public prefix (EXPO_PUBLIC_ by
 * default) ship inside the app anyway, so they're stored as plaintext; everything else
 * is stored as an EAS secret, which only builds can read.
 *
 * Copyright (c) 2026 Aghogho Meyoron. MIT License.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.1';
const EAS_ENVIRONMENTS = ['development', 'preview', 'production'];
/** File-name hints: .env.<hint> → EAS environment. */
const HINTS = {
  development: 'development', dev: 'development', local: 'development',
  preview: 'preview', staging: 'preview', stg: 'preview', test: 'preview',
  production: 'production', prod: 'production', prd: 'production',
};

const HELP = `env-to-eas ${VERSION}: copy a local .env file into an EAS environment.

Usage: env-to-eas [file] [options]

  file                      The .env file to push. Leave it out to pick one from
                            the .env* files in this folder.
  -e, --environment ENV     EAS environment: development, preview or production
                            (default: guessed from the file name, e.g. .env.production,
                            otherwise you're asked)
      --public-prefix P     Prefix stored as plaintext (repeatable)  default: EXPO_PUBLIC_
      --visibility V        Visibility for everything else: secret or sensitive  default: secret
      --only K1,K2          Only these variables
      --exclude K1,K2       Skip these variables
  -n, --dry-run             Show what would be pushed, push nothing
  -y, --yes                 Don't ask for confirmation
  -v, --version             Print the version
  -h, --help                Show this help

Run it from your Expo project folder (where app.json / app.config.* lives).

Exit codes: 0 success, 1 a variable failed to push or you cancelled, 2 usage or setup error.`;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (color ? `\x1b[${c}m${s}\x1b[0m` : s);
const red = (s) => paint(31, s), green = (s) => paint(32, s), dim = (s) => paint(2, s), bold = (s) => paint(1, s);

function usageError(message) {
  console.error(`${red('✖')} ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = {
    file: null, environment: null, publicPrefixes: [], visibility: 'secret',
    only: null, exclude: [], dryRun: false, yes: false,
  };
  const value = (i, name) => {
    if (i >= argv.length || argv[i].startsWith('-')) usageError(`${name} needs a value`);
    return argv[i];
  };
  const csv = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg.startsWith('--') && arg.includes('=')) {
      argv.splice(i + 1, 0, arg.slice(arg.indexOf('=') + 1));
      arg = arg.slice(0, arg.indexOf('='));
    }
    switch (arg) {
      case '-e': case '--environment': args.environment = value(++i, arg); break;
      case '--public-prefix': args.publicPrefixes.push(value(++i, arg)); break;
      case '--visibility': args.visibility = value(++i, arg); break;
      case '--only': args.only = csv(value(++i, arg)); break;
      case '--exclude': args.exclude.push(...csv(value(++i, arg))); break;
      case '-n': case '--dry-run': args.dryRun = true; break;
      case '-y': case '--yes': args.yes = true; break;
      case '-v': case '--version': console.log(VERSION); process.exit(0);
      case '-h': case '--help': console.log(HELP); process.exit(0);
      default:
        if (arg.startsWith('-') || args.file) usageError(`Unknown argument: ${arg}`);
        args.file = arg;
    }
  }
  if (!args.publicPrefixes.length) args.publicPrefixes = ['EXPO_PUBLIC_'];
  if (!['secret', 'sensitive'].includes(args.visibility)) usageError('--visibility must be secret or sensitive');
  if (args.environment && !EAS_ENVIRONMENTS.includes(args.environment)) usageError(`--environment must be one of: ${EAS_ENVIRONMENTS.join(', ')}`);
  return args;
}

/**
 * Parses dotenv syntax: KEY=value, optional `export`, # comments, single quotes (literal),
 * double quotes (\n \t \" \\ escapes, may span lines), backticks, and inline comments
 * after unquoted values. ${VAR} references are left as written.
 */
export function parseDotenv(text) {
  const out = {};
  const src = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const re = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*[=:][ \t]*/;
  let i = 0;
  while (i < src.length) {
    const end = src.indexOf('\n', i) === -1 ? src.length : src.indexOf('\n', i);
    const line = src.slice(i, end);
    const m = line.match(re);
    if (!m) { i = end + 1; continue; }
    const key = m[1];
    let pos = i + m[0].length;
    const q = src[pos];
    if (q === '"' || q === "'" || q === '`') {
      let j = pos + 1, raw = '';
      while (j < src.length && src[j] !== q) {
        if (q === '"' && src[j] === '\\' && j + 1 < src.length) { raw += src[j] + src[j + 1]; j += 2; continue; }
        raw += src[j++];
      }
      if (j >= src.length) { // unterminated: treat the rest of the line as the value
        out[key] = line.slice(m[0].length).trim();
        i = end + 1;
        continue;
      }
      out[key] = q === '"'
        ? raw.replace(/\\(.)/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' }[c] ?? c))
        : raw;
      const next = src.indexOf('\n', j);
      i = next === -1 ? src.length : next + 1;
    } else {
      out[key] = line.slice(m[0].length).replace(/[ \t]+#.*$/, '').trim();
      i = end + 1;
    }
  }
  return out;
}

const isEnvFile = (name) => /^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist)$/.test(name);

export function guessEnvironment(file) {
  const parts = path.basename(file).toLowerCase().split('.').filter(Boolean).slice(1); // drop "env"
  for (const p of parts.reverse()) if (HINTS[p]) return HINTS[p];
  return null;
}

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function easCommand() {
  const probe = run('eas', ['--version']);
  return probe.status === 0 ? ['eas', []] : ['npx', ['-y', 'eas-cli@latest']];
}

const redact = (text, value) => (value ? text.split(value).join('••••') : text);

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

async function choose(title, options, noTty) {
  if (!process.stdin.isTTY) usageError(noTty);
  console.log(bold(title));
  options.forEach((o, n) => console.log(`  ${n + 1}) ${o}`));
  for (;;) {
    const a = await ask(`Choose 1-${options.length}: `);
    const n = Number(a);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
    if (options.includes(a)) return a;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  if (!['app.json', 'app.config.js', 'app.config.ts', 'app.config.mjs', 'app.config.cjs'].some((f) => existsSync(path.join(cwd, f)))) {
    usageError('No app.json or app.config.* here. Run this from your Expo project folder.');
  }

  let file = args.file;
  if (!file) {
    const found = readdirSync(cwd).filter((n) => isEnvFile(n) && statSync(path.join(cwd, n)).isFile()).sort();
    if (!found.length) usageError('No .env files in this folder. Pass the file to push, e.g. env-to-eas .env.production');
    file = found.length === 1 ? found[0] : await choose('Which .env file?', found, 'Several .env files here and no terminal to choose on. Pass the file name.');
  }
  const filePath = path.resolve(cwd, file);
  if (!existsSync(filePath)) usageError(`No such file: ${file}`);

  const environment = args.environment ?? guessEnvironment(file)
    ?? await choose(`Which EAS environment should ${file} go to?`, EAS_ENVIRONMENTS, `Can’t tell the EAS environment from "${file}". Pass --environment.`);

  const vars = parseDotenv(readFileSync(filePath, 'utf8'));
  if (args.only) {
    const missing = args.only.filter((k) => !(k in vars));
    if (missing.length) usageError(`Not in ${file}: ${missing.join(', ')}`);
  }
  const entries = Object.entries(vars)
    .filter(([k]) => (!args.only || args.only.includes(k)) && !args.exclude.includes(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const empty = entries.filter(([, v]) => v === '').map(([k]) => k);
  const push = entries.filter(([, v]) => v !== '').map(([name, value]) => ({
    name, value,
    visibility: args.publicPrefixes.some((p) => name.startsWith(p)) ? 'plaintext' : args.visibility,
  }));

  console.log(`${bold(file)} → ${bold(`EAS "${environment}"`)}${args.dryRun ? dim(' (dry run)') : ''}`);
  for (const v of push) console.log(`  · ${v.name} ${dim(`[${v.visibility}]`)}`);
  if (empty.length) console.log(dim(`  Skipped (empty): ${empty.join(', ')}`));
  console.log('');

  if (args.dryRun) {
    console.log(`Dry run: ${push.length} variable(s) would be pushed. Nothing was changed.`);
    return 0;
  }
  if (!push.length) {
    console.log('Nothing to push.');
    return 0;
  }
  if (!args.yes) {
    if (!process.stdin.isTTY) usageError('No terminal to confirm on. Pass --yes to push without a prompt.');
    const a = await ask(`Push ${push.length} variable(s)? Existing EAS variables with the same name are overwritten. [y/N] `);
    if (!/^y(es)?$/i.test(a ?? '')) {
      console.log('Cancelled. Nothing was pushed.');
      return 1;
    }
  }

  const [eas, easPrefix] = easCommand();
  let failures = 0;
  for (const { name, value, visibility } of push) {
    const result = run(eas, [
      ...easPrefix, 'env:create',
      '--name', name, '--value', value,
      '--environment', environment, '--visibility', visibility,
      '--type', 'string', '--scope', 'project', '--force', '--non-interactive',
    ]);
    if (result.status === 0) {
      console.log(`  ${green('✓')} ${name} ${dim(`[${visibility}]`)}`);
    } else {
      failures++;
      const output = redact(`${result.stderr ?? ''}${result.stdout ?? ''}`.trim() || String(result.error ?? ''), value);
      console.log(`  ${red('✖')} ${name}: ${output.split('\n').slice(-3).join(' ')}`);
    }
  }

  if (failures) {
    console.error(`\n${red('✖')} ${failures} variable(s) failed. Are you logged in? Run: npx eas-cli login`);
    return 1;
  }
  console.log(green(`\n✔ Pushed ${push.length} variable(s).`) + dim(` Check with: npx eas-cli env:list ${environment}`));
  return 0;
}

/**
 * Run only when started as a command, not when imported (the tests import it). Compare real paths:
 * npx and installed bins start us through a symlink in node_modules/.bin, and a URL pathname keeps
 * %20 for spaces, so a plain string comparison would silently skip main().
 */
function startedAsCommand() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
const isMain = startedAsCommand();
if (isMain) {
  main().then((code) => process.exit(code), (e) => {
    console.error(red(e.stack || e.message));
    process.exit(1);
  });
}
