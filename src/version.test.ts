import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cliVersion, compareVersions } from './version.js';

describe('cliVersion', () => {
  it('返回包根 package.json 的 version', async () => {
    const raw = await readFile(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
      'utf8',
    );
    const expected = (JSON.parse(raw) as { version: string }).version;
    expect(cliVersion()).toBe(expected);
  });
});

describe('compareVersions', () => {
  it.each([
    ['0.1.2', '0.1.3', -1],
    ['0.1.2', '0.1.2', 0],
    ['0.2.0', '0.1.9', 1],
    ['v0.1.2', '0.1.10', -1],
    ['1.0', '1.0.0', 0],
    ['0.1.2', '', 1],
  ] as const)('%s vs %s → %i', (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
  });
});
