import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDotenv, guessEnvironment, parsePick, buildPlan } from '../env-to-eas.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'env-to-eas.mjs');
const ENV = `# comment
EXPO_PUBLIC_API_URL=https://api.example.com
export API_SECRET="s3cr3t"
EMPTY_ONE=
FAIL_ME=boom-value
`;

function run(args, { app = true, files = { '.env.production': ENV } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  if (app) writeFileSync(join(dir, 'app.json'), '{}');
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  const log = join(dir, 'eas.log');
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: dir, encoding: 'utf8', input: '',
    env: { ...process.env, NO_COLOR: '1', EAS_LOG: log, PATH: join(here, 'bin') + delimiter + process.env.PATH },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { code: r.status, out: r.stdout + r.stderr, calls };
}
const pushed = (calls, name) => calls.find((c) => c.includes(`--name ${name} `));

test('parses dotenv syntax', () => {
  const v = parseDotenv(`A=1\nexport B='two # not a comment'\nC="line\\nbreak"\nD=x # comment\n# E=no\nF="multi\nline"\nG=\n  H = spaced  \n`);
  assert.deepEqual(v, { A: '1', B: 'two # not a comment', C: 'line\nbreak', D: 'x', F: 'multi\nline', G: '', H: 'spaced' });
});

test('guesses the environment from the file name', () => {
  assert.equal(guessEnvironment('.env.production'), 'production');
  assert.equal(guessEnvironment('.env.staging'), 'preview');
  assert.equal(guessEnvironment('.env.development.local'), 'development');
  assert.equal(guessEnvironment('.env'), null);
});

test('dry run lists variables, pushes nothing, never prints values', () => {
  const r = run(['--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\.env\.production → EAS "production"/);
  assert.match(r.out, /EXPO_PUBLIC_API_URL \[plaintext\]/);
  assert.match(r.out, /API_SECRET \[secret\]/);
  assert.match(r.out, /Skipped \(empty\): EMPTY_ONE/);
  assert.doesNotMatch(r.out, /s3cr3t/);
  assert.equal(r.calls.length, 0);
});

test('pushes with the right visibility and environment', () => {
  const r = run(['.env.production', '--yes', '--exclude', 'FAIL_ME']);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.length, 2);
  assert.match(pushed(r.calls, 'API_SECRET'), /--value s3cr3t --environment production --visibility secret .*--force --non-interactive/);
  assert.match(pushed(r.calls, 'EXPO_PUBLIC_API_URL'), /--visibility plaintext/);
});

test('failures exit 1 and redact the value', () => {
  const r = run(['--yes']);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL_ME: Error: could not save ••••/);
  assert.doesNotMatch(r.out, /boom-value/);
});

test('--environment overrides the file name', () => {
  const r = run(['--yes', '-e', 'preview', '--only', 'API_SECRET']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.calls[0], /--environment preview/);
});

test('needs a choice when it cannot guess and there is no terminal', () => {
  assert.equal(run(['--yes'], { files: { '.env': ENV } }).code, 2);
  assert.equal(run(['--yes'], { files: { '.env.a': ENV, '.env.b': ENV } }).code, 2);
});

test('ignores example files and needs --yes without a terminal', () => {
  const r = run([], { files: { '.env.production': ENV, '.env.example': ENV } });
  assert.equal(r.code, 2);
  assert.equal(r.calls.length, 0);
});

test('refuses outside an Expo project', () => {
  assert.equal(run(['--dry-run'], { app: false }).code, 2);
});

// npx and installed bins start the CLI through a symlink in node_modules/.bin; it must still run.
test('runs when started through a symlinked bin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bin-'));
  const link = join(dir, 'env-to-eas');
  symlinkSync(CLI, link);
  const r = spawnSync(process.execPath, [link, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\d+\.\d+\.\d+/);
});

test('runs from a path with a space in it', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'sp-')), 'with space');
  mkdirSync(dir);
  const copy = join(dir, 'env-to-eas.mjs');
  copyFileSync(CLI, copy);
  const r = spawnSync(process.execPath, [copy, '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\d+\.\d+\.\d+/);
});

test('reads a pick of one or more options', () => {
  const o = ['.env', '.env.preview', '.env.production'];
  assert.deepEqual(parsePick('2', o), ['.env.preview']);
  assert.deepEqual(parsePick('3,1', o), ['.env', '.env.production']);
  assert.deepEqual(parsePick('1-2', o), ['.env', '.env.preview']);
  assert.deepEqual(parsePick('3-2', o), ['.env.preview', '.env.production']);
  assert.deepEqual(parsePick('1 3', o), ['.env', '.env.production']);
  assert.deepEqual(parsePick('all', o), o);
  assert.deepEqual(parsePick('.env.preview', o), ['.env.preview']);
  assert.equal(parsePick('4', o), null);
  assert.equal(parsePick('0-2', o), null);
  assert.equal(parsePick('nope', o), null);
  assert.equal(parsePick('', o), null);
});

test('plans per environment; a later file wins, an empty value never erases', () => {
  const plan = buildPlan([
    { file: '.env', vars: { A: '1', B: 'base', C: 'keep', EXPO_PUBLIC_X: 'x' }, environments: ['preview', 'production'] },
    { file: '.env.production', vars: { B: 'prod', C: '' }, environments: ['production'] },
  ]);
  assert.deepEqual(plan.map((p) => p.environment), ['preview', 'production']);
  const prod = Object.fromEntries(plan[1].push.map((v) => [v.name, v]));
  assert.equal(prod.B.value, 'prod');
  assert.equal(prod.B.file, '.env.production');
  assert.equal(prod.C.value, 'keep');
  assert.equal(prod.EXPO_PUBLIC_X.visibility, 'plaintext');
  assert.equal(prod.A.visibility, 'secret');
  assert.deepEqual(plan[1].overridden, [{ name: 'B', from: '.env', by: '.env.production' }]);
  assert.equal(Object.fromEntries(plan[0].push.map((v) => [v.name, v.value])).B, 'base');
});

const PREVIEW = 'API_SECRET=preview-secret\nEXPO_PUBLIC_API_URL=https://staging.example.com\n';

test('several files go to the environments their names suggest', () => {
  const r = run(['.env.production', '.env.preview', '--yes', '--exclude', 'FAIL_ME'], { files: { '.env.production': ENV, '.env.preview': PREVIEW } });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.calls.length, 4);
  assert.ok(r.calls.some((c) => /--name API_SECRET --value preview-secret --environment preview /.test(c)));
  assert.ok(r.calls.some((c) => /--name API_SECRET --value s3cr3t --environment production /.test(c)));
  assert.match(r.out, /Pushed 4 variable\(s\) to 2 environment\(s\)/);
});

test('-e takes a list, repeats and all; every file goes to every environment', () => {
  const list = run(['.env.production', '--yes', '--only', 'API_SECRET', '-e', 'preview,production'], {});
  assert.equal(list.code, 0, list.out);
  assert.deepEqual(list.calls.map((c) => c.match(/--environment (\w+)/)[1]), ['preview', 'production']);
  const repeat = run(['.env.production', '--yes', '--only', 'API_SECRET', '-e', 'development', '-e', 'production'], {});
  assert.deepEqual(repeat.calls.map((c) => c.match(/--environment (\w+)/)[1]), ['development', 'production']);
  const all = run(['.env.production', '--dry-run', '-e', 'all'], {});
  assert.equal(all.code, 0, all.out);
  assert.match(all.out, /EAS "development"[\s\S]*EAS "preview"[\s\S]*EAS "production"/);
  assert.equal(run(['.env.production', '--dry-run', '-e', 'staging'], {}).code, 2);
});

test('files merged into one environment show which one wins', () => {
  const r = run(['.env', '.env.production', '--dry-run', '-e', 'production'], { files: { '.env': 'API_SECRET=base\nSHARED=1\n', '.env.production': ENV } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\.env \+ \.env\.production → EAS "production"/);
  assert.match(r.out, /API_SECRET: \.env\.production overrides \.env/);
  assert.match(r.out, /SHARED \[secret\] from \.env/);
  assert.doesNotMatch(r.out, /s3cr3t|base/);
});
