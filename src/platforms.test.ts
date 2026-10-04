import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  detectSkillPlatforms,
  findSkillPlatform,
  KNOWN_SKILL_PLATFORMS,
  platformSkillsDir,
} from './platforms.js';

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'skills-sync-platforms-'));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

describe('skill platform detection', () => {
  it('ships a curated default platform list', () => {
    const ids = KNOWN_SKILL_PLATFORMS.map((platform) => platform.id);
    expect(ids).toEqual(['claude', 'cursor', 'codex', 'gemini', 'agents', 'zcode', 'opencode']);
  });

  it('detects only platforms whose skill dir exists and never creates dirs', async () => {
    await mkdir(path.join(home, '.claude', 'skills'), { recursive: true });
    await mkdir(path.join(home, '.zcode', 'skills'), { recursive: true });
    // .cursor 目录存在但 skills 子目录不存在 → 不算
    await mkdir(path.join(home, '.cursor'), { recursive: true });
    // .gemini/skills 是文件不是目录 → 也不算
    await mkdir(path.join(home, '.gemini'), { recursive: true });
    await writeFile(path.join(home, '.gemini', 'skills'), 'a file, not a dir');

    const detected = detectSkillPlatforms(home);
    expect(detected.map((platform) => platform.id)).toEqual(['claude', 'zcode']);
    // 重复探测结果一致：未创建任何新目录
    expect(detectSkillPlatforms(home)).toHaveLength(2);
  });

  it('resolves platforms by id (case-insensitive) and rejects unknown ids', () => {
    expect(findSkillPlatform('claude')?.dir).toBe(path.join('.claude', 'skills'));
    expect(findSkillPlatform(' Zcode ')?.id).toBe('zcode');
    expect(findSkillPlatform('vscode')).toBeNull();
    expect(findSkillPlatform('')).toBeNull();

    const platform = findSkillPlatform('opencode')!;
    expect(platformSkillsDir(platform, home)).toBe(
      path.join(home, '.config', 'opencode', 'skills'),
    );
  });
});
