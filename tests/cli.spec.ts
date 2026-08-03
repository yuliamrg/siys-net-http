import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { expect, test } from '@playwright/test';

function run(args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  delete env.FORCE_COLOR;
  return spawnSync(process.execPath, ['--import', 'tsx', path.join(process.cwd(), 'src', 'cli.ts'), ...args], {
    cwd: process.cwd(), encoding: 'utf8', env,
  });
}

test('prints help without a stack trace', () => {
  const result = run(['--help']);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Usage: siys');
  expect(result.stderr).toBe('');
});

test('returns a clean JSON usage error on stderr', () => {
  const result = run(['download', '--module', 'invalid', '--json']);
  expect(result.status).toBe(2);
  expect(result.stdout).toBe('');
  const payload = JSON.parse(result.stderr);
  expect(payload).toEqual(expect.objectContaining({ category: 'usage', code: 'invalid_input', retryable: false }));
  expect(result.stderr).not.toContain('at runDownload');
});

test('maps missing local files to exit code 5 and only shows stacks with debug', () => {
  const normal = run(['order', 'create', 'missing-request.json', '--no-auto-login']);
  expect(normal.status).toBe(5);
  expect(normal.stderr).not.toContain('at ');
  const debug = run(['--debug', 'order', 'create', 'missing-request.json', '--no-auto-login']);
  expect(debug.status).toBe(5);
  expect(debug.stderr).toContain('at ');
});
