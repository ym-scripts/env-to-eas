#!/usr/bin/env node
/**
 * env-to-eas: copy the variables in local .env files into EAS (Expo Application
 * Services) environments, so cloud builds get the same values you use locally.
 * https://github.com/ym-scripts/env-to-eas
 *
 * Values are never printed. Variables starting with a public prefix (EXPO_PUBLIC_ by
 * default) ship inside the app anyway, so they're stored as plaintext; everything else
 * is stored as sensitive: hidden in logs and masked in the dashboard, yet still readable by
 * builds that run outside EAS (local or GitHub builds), which can't read EAS secrets.
 *
 * Copyright (c) 2026 Aghogho Meyoron. MIT License.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.3.0';
const EAS_ENVIRONMENTS = ['development', 'preview', 'production'];
/** File-name hints: .env.<hint> → EAS environment. */
const HINTS = {
  development: 'development', dev: 'development', local: 'development',
  preview: 'preview', staging: 'preview', stg: 'preview', test: 'preview',
  production: 'production', prod: 'production', prd: 'production',
};

const HELP = `env-to-eas ${VERSION}: copy local .env files into EAS environments.

Usage: env-to-eas [files...] [options]

  files                     The .env file(s) to push. Leave them out to pick one or
                            more from the .env* files in this folder.
  -e, --environment ENV     EAS environment(s): development, preview, production or all.
                            Repeat it or use a comma list (-e preview,production).
                            With -e, every file goes to every listed environment.
                            Without it, each file goes to the environment its name
                            suggests (.env.production → production), and you're asked
                            (one or more) for files with no hint.
      --public-prefix P     Prefix stored as plaintext (repeatable)  default: EXPO_PUBLIC_
      --visibility V        Visibility for everything else: sensitive or secret  default: sensitive
      --empty MODE          Empty variables: skip, or delete (remove the same-named
                            variable from EAS so it matches the file; never one EAS
                            shares with another environment). Asked when there are
                            empty variables; skip with --yes or no terminal.
      --only K1,K2          Only these variables
      --exclude K1,K2       Skip these variables
  -n, --dry-run             Show what would be pushed, push nothing
  -y, --yes                 Don't ask for confirmation
  -v, --version             Print the version
  -h, --help                Show this help

Files sent to the same environment are merged in the order given; a later file wins
when both define a variable (the plan shows which).

When asked to pick, type numbers (1,3), a range (1-3), names, or "all".

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
    files: [], environments: [], publicPrefixes: [], visibility: 'sensitive',
    only: null, exclude: [], dryRun: false, yes: false, empty: null,
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
      case '-e': case '--environment': args.environments.push(...csv(value(++i, arg)).map((x) => x.toLowerCase())); break;
      case '--public-prefix': args.publicPrefixes.push(value(++i, arg)); break;
      case '--visibility': args.visibility = value(++i, arg); break;
      case '--empty': args.empty = value(++i, arg).toLowerCase(); break;
      case '--only': args.only = csv(value(++i, arg)); break;
      case '--exclude': args.exclude.push(...csv(value(++i, arg))); break;
      case '-n': case '--dry-run': args.dryRun = true; break;
      case '-y': case '--yes': args.yes = true; break;
      case '-v': case '--version': console.log(VERSION); process.exit(0);
      case '-h': case '--help': console.log(HELP); process.exit(0);
      default:
        if (arg.startsWith('-')) usageError(`Unknown argument: ${arg}`);
        if (!args.files.includes(arg)) args.files.push(arg);
    }
  }
  if (!args.publicPrefixes.length) args.publicPrefixes = ['EXPO_PUBLIC_'];
  if (args.empty && !['skip', 'delete'].includes(args.empty)) usageError('--empty must be skip or delete');
  if (!['secret', 'sensitive'].includes(args.visibility)) usageError('--visibility must be sensitive or secret');
  if (args.environments.includes('all')) args.environments = [...EAS_ENVIRONMENTS];
  const bad = args.environments.filter((e) => !EAS_ENVIRONMENTS.includes(e));
  if (bad.length) usageError(`--environment must be ${EAS_ENVIRONMENTS.join(', ')} or all (got: ${bad.join(', ')})`);
  args.environments = EAS_ENVIRONMENTS.filter((e) => args.environments.includes(e));
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

/**
 * Reads `eas env:list --format long` output into { NAME: ['preview', 'production'] }: which
 * environments each project variable is attached to. One EAS variable can serve several
 * environments, and deleting it removes it from all of them.
 */
export function parseEasList(text) {
  const out = {};
  let name = null;
  for (const raw of String(text).replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const line = raw.trim();
    const n = line.match(/^Name\s{2,}(.+)$/);
    if (n) { name = n[1].trim(); continue; }
    const e = line.match(/^Environments\s{2,}(.+)$/);
    if (e && name) {
      out[name] = e[1].trim() === '-' ? [] : e[1].split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
      name = null;
    }
  }
  return out;
}

const redact = (text, value) => (value ? text.split(value).join('••••') : text);

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); resolve(a.trim()); });
  });
}

/**
 * Reads a pick of one or more options: numbers (1,3), ranges (1-3), option names, or "all",
 * separated by commas or spaces. Returns the picked options in list order, or null if invalid.
 */
export function parsePick(answer, options) {
  const tokens = String(answer ?? '').split(/[\s,]+/).filter(Boolean);
  if (!tokens.length) return null;
  const picked = new Set();
  for (const t of tokens) {
    if (t.toLowerCase() === 'all') { options.forEach((o) => picked.add(o)); continue; }
    const range = t.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])].sort((x, y) => x - y);
      if (a < 1 || b > options.length) return null;
      for (let n = a; n <= b; n++) picked.add(options[n - 1]);
      continue;
    }
    const n = Number(t);
    if (Number.isInteger(n) && n >= 1 && n <= options.length) { picked.add(options[n - 1]); continue; }
    if (options.includes(t)) { picked.add(t); continue; }
    return null;
  }
  return options.filter((o) => picked.has(o));
}

async function chooseMany(title, options, noTty) {
  if (!process.stdin.isTTY) usageError(noTty);
  console.log(bold(title));
  options.forEach((o, n) => console.log(`  ${n + 1}) ${o}`));
  for (;;) {
    const hit = parsePick(await ask(`Choose one or more (e.g. 1,3 or 1-${options.length} or all): `), options);
    if (hit?.length) return hit;
  }
}

/**
 * Turns files and their environments into one push list per environment. Files are merged in
 * order; a later file wins for a variable both define. `targets` is [{ file, vars, environments }].
 */
export function buildPlan(targets, { only = null, exclude = [], publicPrefixes = ['EXPO_PUBLIC_'], visibility = 'sensitive' } = {}) {
  const plan = [];
  for (const environment of EAS_ENVIRONMENTS) {
    const sources = targets.filter((t) => t.environments.includes(environment));
    if (!sources.length) continue;
    const merged = new Map();
    const overridden = [];
    for (const { file, vars } of sources) {
      for (const [name, value] of Object.entries(vars)) {
        if ((only && !only.includes(name)) || exclude.includes(name)) continue;
        const prev = merged.get(name);
        if (prev && prev.value !== '' && value !== '' && prev.file !== file) overridden.push({ name, from: prev.file, by: file });
        if (prev && value === '') continue; // an empty value never erases one set by an earlier file
        merged.set(name, { name, value, file });
      }
    }
    const all = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
    plan.push({
      environment,
      files: sources.map((t) => t.file),
      push: all.filter((v) => v.value !== '').map((v) => ({ ...v, visibility: publicPrefixes.some((p) => v.name.startsWith(p)) ? 'plaintext' : visibility })),
      empty: all.filter((v) => v.value === '').map((v) => v.name),
      overridden,
    });
  }
  return plan;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  if (!['app.json', 'app.config.js', 'app.config.ts', 'app.config.mjs', 'app.config.cjs'].some((f) => existsSync(path.join(cwd, f)))) {
    usageError('No app.json or app.config.* here. Run this from your Expo project folder.');
  }

  let files = args.files;
  if (!files.length) {
    const found = readdirSync(cwd).filter((n) => isEnvFile(n) && statSync(path.join(cwd, n)).isFile()).sort();
    if (!found.length) usageError('No .env files in this folder. Pass the file(s) to push, e.g. env-to-eas .env.production');
    files = found.length === 1 ? found : await chooseMany('Which .env file(s)?', found, 'Several .env files here and no terminal to choose on. Pass the file names.');
  }
  for (const f of files) if (!existsSync(path.resolve(cwd, f))) usageError(`No such file: ${f}`);

  const targets = [];
  for (const file of files) {
    const guessed = guessEnvironment(file);
    const environments = args.environments.length
      ? args.environments
      : guessed
        ? [guessed]
        : await chooseMany(`Which EAS environment(s) should ${file} go to?`, EAS_ENVIRONMENTS, `Can’t tell the EAS environment from "${file}". Pass --environment.`);
    targets.push({ file, vars: parseDotenv(readFileSync(path.resolve(cwd, file), 'utf8')), environments });
  }

  if (args.only) {
    const missing = args.only.filter((k) => !targets.some((t) => k in t.vars));
    if (missing.length) usageError(`Not in ${files.join(', ')}: ${missing.join(', ')}`);
  }
  const plan = buildPlan(targets, { only: args.only, exclude: args.exclude, publicPrefixes: args.publicPrefixes, visibility: args.visibility });
  const total = plan.reduce((n, p) => n + p.push.length, 0);

  for (const p of plan) {
    console.log(`${bold(p.files.join(' + '))} → ${bold(`EAS "${p.environment}"`)}${args.dryRun ? dim(' (dry run)') : ''}`);
    for (const v of p.push) console.log(`  · ${v.name} ${dim(`[${v.visibility}]${p.files.length > 1 ? ` from ${v.file}` : ''}`)}`);
    if (p.empty.length) console.log(dim(`  Empty: ${p.empty.join(', ')}`));
    for (const o of p.overridden) console.log(dim(`  ${o.name}: ${o.by} overrides ${o.from}`));
    console.log('');
  }

  const empties = plan.reduce((n, p) => n + p.empty.length, 0);
  let emptyMode = args.empty ?? 'skip';
  if (empties && !args.empty && !args.yes && !args.dryRun && process.stdin.isTTY) {
    const a = await ask(`${empties} empty variable(s). EAS can't store empty values. Skip them, or delete them from EAS so it matches your files? [S/d] `);
    emptyMode = /^d(elete)?$/i.test(a ?? '') ? 'delete' : 'skip';
  }
  if (empties) {
    console.log(emptyMode === 'delete'
      ? `Empty variables will be deleted from EAS where they exist for that environment only.`
      : dim(`Empty variables are skipped${args.empty ? '' : ' (pass --empty delete to remove them from EAS instead)'}.`));
  }
  const deletes = emptyMode === 'delete' ? empties : 0;

  if (args.dryRun) {
    console.log(`Dry run: ${total} variable(s) would be pushed${deletes ? ` and up to ${deletes} deleted` : ''} in ${plan.length} environment(s). Nothing was changed.`);
    return 0;
  }
  if (!total && !deletes) {
    console.log('Nothing to push.');
    return 0;
  }
  if (!args.yes) {
    if (!process.stdin.isTTY) usageError('No terminal to confirm on. Pass --yes to push without a prompt.');
    const where = plan.map((p) => p.environment).join(', ');
    const a = await ask(`Push ${total} variable(s)${deletes ? ` and delete up to ${deletes}` : ''} in ${where}? Existing EAS variables with the same name are overwritten. [y/N] `);
    if (!/^y(es)?$/i.test(a ?? '')) {
      console.log('Cancelled. Nothing was pushed.');
      return 1;
    }
  }

  const [eas, easPrefix] = easCommand();
  let failures = 0;
  let deleted = 0;
  for (const { environment, push, empty } of plan) {
    if (plan.length > 1) console.log(bold(`EAS "${environment}"`));
    if (emptyMode === 'delete' && empty.length) {
      const listed = run(eas, [...easPrefix, 'env:list', '--environment', environment, '--format', 'long', '--scope', 'project']);
      if (listed.status !== 0) {
        failures++;
        console.log(`  ${red('✖')} Couldn’t list EAS variables for "${environment}", so nothing was deleted there.`);
      } else {
        const inEas = parseEasList(listed.stdout);
        for (const name of empty) {
          const envs = inEas[name];
          if (!envs) { console.log(dim(`  · ${name}: not in EAS, nothing to delete`)); continue; }
          const others = envs.filter((e) => e !== environment);
          if (others.length) {
            console.log(`  ${dim('!')} ${name}: kept, EAS shares it with ${others.join(', ')}. Delete it in the dashboard if you mean to.`);
            continue;
          }
          const del = run(eas, [...easPrefix, 'env:delete', '--variable-name', name, '--variable-environment', environment, '--scope', 'project', '--non-interactive']);
          if (del.status === 0) {
            deleted++;
            console.log(`  ${green('✓')} ${name} ${dim('[deleted]')}`);
          } else {
            failures++;
            console.log(`  ${red('✖')} ${name}: ${`${del.stderr ?? ''}${del.stdout ?? ''}`.trim().split('\n').slice(-2).join(' ')}`);
          }
        }
      }
    }
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
  }

  if (failures) {
    console.error(`\n${red('✖')} ${failures} step(s) failed. Are you logged in? Run: npx eas-cli login`);
    return 1;
  }
  console.log(green(`\n✔ Pushed ${total} variable(s)${deleted ? `, deleted ${deleted},` : ''} in ${plan.length} environment(s).`) + dim(` Check with: ${plan.map((p) => `npx eas-cli env:list ${p.environment}`).join(' · ')}`));
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
