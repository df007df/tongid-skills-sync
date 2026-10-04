import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizeBaseUrl,
  resolveSkillsPayConfig,
  SkillsPayConfigError,
} from './config.js';

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(path.join(os.tmpdir(), 'skills-sync-config-'));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe('resolveSkillsPayConfig', () => {
  it('prefers cli > project file > env and errors when app is missing', async () => {
    await expect(
      resolveSkillsPayConfig({ cliApp: null, cwd, env: {} }),
    ).rejects.toBeInstanceOf(SkillsPayConfigError);

    // env
    const fromEnv = await resolveSkillsPayConfig({
      cwd,
      env: { TONGID_SKILLS_APP: 'my-skill-app', TONGID_BASE_URL: 'https://example.com/' },
    });
    expect(fromEnv).toEqual({ baseUrl: 'https://example.com', app: 'my-skill-app' });

    // project file beats env
    await writeFile(
      path.join(cwd, 'skills-sync.config.json'),
      JSON.stringify({ app: 'from-file', baseUrl: 'https://file.example.com' }),
    );
    const fromFile = await resolveSkillsPayConfig({
      cwd,
      env: { TONGID_SKILLS_APP: 'from-env' },
    });
    expect(fromFile).toEqual({ baseUrl: 'https://file.example.com', app: 'from-file' });

    // cli beats file
    const fromCli = await resolveSkillsPayConfig({
      cliApp: 'from-cli',
      cliBaseUrl: 'https://cli.example.com//',
      cwd,
      env: {},
    });
    expect(fromCli).toEqual({ baseUrl: 'https://cli.example.com', app: 'from-cli' });
  });

  it('defaults the base url to tongid.dev and throws on broken project config', async () => {
    const config = await resolveSkillsPayConfig({ cliApp: 'app1', cwd, env: {} });
    expect(config.baseUrl).toBe('https://tongid.dev');

    await writeFile(path.join(cwd, 'skills-sync.config.json'), '{broken');
    await expect(resolveSkillsPayConfig({ cliApp: 'app1', cwd, env: {} })).rejects.toThrow(/JSON/);
  });

  it('normalizes base urls', () => {
    expect(normalizeBaseUrl('https://a.com/')).toBe('https://a.com');
    expect(normalizeBaseUrl('  https://a.com/// ')).toBe('https://a.com');
    expect(normalizeBaseUrl('')).toBe('https://tongid.dev');
  });
});
