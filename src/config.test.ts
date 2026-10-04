import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearDefaultApp,
  globalConfigPath,
  normalizeBaseUrl,
  resolveSkillsPayConfig,
  writeGlobalConfig,
  SkillsPayConfigError,
} from './config.js';

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(path.join(os.tmpdir(), 'skills-sync-config-'));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe('resolveSkillsPayConfig', () => {
  it('errors before first login and resolves cli > env > saved global config', async () => {
    // 首次使用：无任何来源时报错，引导在 login 时显式传入
    await expect(
      resolveSkillsPayConfig({ cliApp: null, storeDir, env: {} }),
    ).rejects.toBeInstanceOf(SkillsPayConfigError);

    // env
    const fromEnv = await resolveSkillsPayConfig({
      storeDir,
      env: { TONGID_SKILLS_APP: 'my-skill-app', TONGID_BASE_URL: 'https://example.com/' },
    });
    expect(fromEnv).toEqual({ baseUrl: 'https://example.com', app: 'my-skill-app' });

    // login 写入的全局配置作为默认应用
    await writeGlobalConfig({ app: 'saved-app', baseUrl: 'https://saved.example.com' }, storeDir);
    const fromSaved = await resolveSkillsPayConfig({ storeDir, env: {} });
    expect(fromSaved).toEqual({ baseUrl: 'https://saved.example.com', app: 'saved-app' });

    // env 覆盖全局配置
    const envBeatsSaved = await resolveSkillsPayConfig({
      storeDir,
      env: { TONGID_SKILLS_APP: 'from-env' },
    });
    expect(envBeatsSaved).toEqual({ baseUrl: 'https://saved.example.com', app: 'from-env' });

    // cli 覆盖一切
    const fromCli = await resolveSkillsPayConfig({
      cliApp: 'from-cli',
      cliBaseUrl: 'https://cli.example.com//',
      storeDir,
      env: {},
    });
    expect(fromCli).toEqual({ baseUrl: 'https://cli.example.com', app: 'from-cli' });
  });

  it('defaults the base url to tongid.dev and throws on broken global config', async () => {
    const config = await resolveSkillsPayConfig({ cliApp: 'app1', storeDir, env: {} });
    expect(config.baseUrl).toBe('https://tongid.dev');

    await writeFile(globalConfigPath(storeDir), '{broken');
    await expect(resolveSkillsPayConfig({ cliApp: 'app1', storeDir, env: {} })).rejects.toThrow(/JSON/);
  });

  it('normalizes base urls', () => {
    expect(normalizeBaseUrl('https://a.com/')).toBe('https://a.com');
    expect(normalizeBaseUrl('  https://a.com/// ')).toBe('https://a.com');
    expect(normalizeBaseUrl('')).toBe('https://tongid.dev');
  });
});

describe('clearDefaultApp', () => {
  it('keeps other apps untouched, clears the default keeping baseUrl, and removes the file when empty', async () => {
    await writeGlobalConfig({ app: 'app-a', baseUrl: 'https://a.example.com' }, storeDir);

    // 登出的不是默认应用：配置不动
    await clearDefaultApp('app-b', storeDir);
    await expect(readFile(globalConfigPath(storeDir), 'utf8')).resolves.toContain('app-a');

    // 登出默认应用：清除 app、保留 baseUrl，之后未显式指定应用时回到报错
    await clearDefaultApp('app-a', storeDir);
    const after = JSON.parse(await readFile(globalConfigPath(storeDir), 'utf8'));
    expect(after).toEqual({ baseUrl: 'https://a.example.com' });
    await expect(resolveSkillsPayConfig({ storeDir, env: {} })).rejects.toBeInstanceOf(SkillsPayConfigError);

    // 配置只剩 app（手写文件无 baseUrl）：清除后整文件删除
    await writeFile(globalConfigPath(storeDir), JSON.stringify({ app: 'app-c' }));
    await clearDefaultApp('app-c', storeDir);
    await expect(readFile(globalConfigPath(storeDir), 'utf8')).rejects.toThrow();
  });
});
