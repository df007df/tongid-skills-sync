import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  linkSkillsToPlatform,
  listManagedSkills,
  unlinkSkillsFromPlatform,
} from './link.js';

let skillsDir: string;
let platformDir: string;

function writeManifest(app: string, slug: string, version = '1.0.0') {
  return writeFile(
    path.join(skillsDir, app, slug, '.skills-sync.json'),
    JSON.stringify({ slug, version, ref: `v${version}`, installedAt: '2026-10-04T00:00:00Z' }),
  );
}

beforeEach(async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'skills-sync-link-'));
  skillsDir = path.join(base, 'skills');
  platformDir = path.join(base, 'platform-skills');
  await mkdir(path.join(skillsDir, 'app-one', 'pro-tool'), { recursive: true });
  await writeManifest('app-one', 'pro-tool');
  // 未带清单的目录：不受管理
  await mkdir(path.join(skillsDir, 'app-one', 'manual-tool'), { recursive: true });
  await mkdir(platformDir, { recursive: true });
});

afterEach(async () => {
  await rm(path.dirname(skillsDir), { recursive: true, force: true });
});

describe('listManagedSkills', () => {
  it('discovers installed skills across apps via the two-level layout', async () => {
    await mkdir(path.join(skillsDir, 'app-two', 'other-tool'), { recursive: true });
    await writeManifest('app-two', 'other-tool');

    const managed = await listManagedSkills(skillsDir);
    expect(managed.map((skill) => `${skill.app}/${skill.slug}`)).toEqual([
      'app-two/other-tool',
      'app-one/pro-tool',
    ]);
    expect(managed[1]?.dir).toBe(path.join(skillsDir, 'app-one', 'pro-tool'));
    await expect(listManagedSkills('/nonexistent-dir')).resolves.toEqual([]);
  });
});

describe('linkSkillsToPlatform', () => {
  it('creates a symlink named by slug pointing at the app skill dir', async () => {
    const outcomes = await linkSkillsToPlatform({ platformSkillsDir: platformDir, skillsDir });
    expect(outcomes).toEqual([{ slug: 'pro-tool', status: 'linked' }]);

    const info = await lstat(path.join(platformDir, 'pro-tool'));
    expect(info.isSymbolicLink()).toBe(true);
    const entries = await readdir(path.join(platformDir, 'pro-tool'));
    expect(entries).toContain('.skills-sync.json');
  });

  it('refreshes our own symlink but never touches foreign entries', async () => {
    await linkSkillsToPlatform({ platformSkillsDir: platformDir, skillsDir });

    // 再次连接：指向同一技能 → refreshed
    const again = await linkSkillsToPlatform({ platformSkillsDir: platformDir, skillsDir });
    expect(again).toEqual([{ slug: 'pro-tool', status: 'refreshed' }]);

    // 指向别处的软连接与真实目录：跳过不覆盖
    await rm(path.join(platformDir, 'pro-tool'), { force: true });
    await symlink('/tmp/elsewhere', path.join(platformDir, 'pro-tool'));
    const foreignLink = await linkSkillsToPlatform({ platformSkillsDir: platformDir, skillsDir });
    expect(foreignLink[0]).toMatchObject({ slug: 'pro-tool', status: 'skipped-exists' });

    // 平台目录里已有同名真实目录：不覆盖；manual-tool 无清单（非托管）不产生任何条目
    await mkdir(path.join(platformDir, 'manual-tool'));
    const withReal = await linkSkillsToPlatform({
      platformSkillsDir: platformDir,
      skillsDir,
      slugs: ['manual-tool', 'pro-tool'],
    });
    expect(withReal.map((item) => item.slug)).toEqual(['pro-tool']);
    expect(withReal[0]).toMatchObject({ status: 'skipped-exists' });
  });

  it('marks cross-app slug conflicts as skipped instead of linking', async () => {
    await mkdir(path.join(skillsDir, 'app-two', 'pro-tool'), { recursive: true });
    await writeManifest('app-two', 'pro-tool');

    const outcomes = await linkSkillsToPlatform({ platformSkillsDir: platformDir, skillsDir });
    expect(outcomes).toEqual([
      {
        slug: 'pro-tool',
        status: 'skipped-conflict',
        note: expect.stringContaining('app-one'),
      },
    ]);
    await expect(lstat(path.join(platformDir, 'pro-tool'))).rejects.toThrow();
  });
});

describe('unlinkSkillsFromPlatform', () => {
  it('removes only symlinks created by tongid-skills-sync', async () => {
    await linkSkillsToPlatform({ platformSkillsDir: platformDir, skillsDir });
    // 一个外部链接 + 一个真实目录不应被动
    await symlink('/tmp/elsewhere', path.join(platformDir, 'foreign'));
    await mkdir(path.join(platformDir, 'manual-dir'));

    const outcomes = await unlinkSkillsFromPlatform({
      platformSkillsDir: platformDir,
      skillsDir,
      slugs: ['pro-tool', 'foreign', 'manual-dir'],
    });
    // 只有托管技能产出条目；外来链接/目录保持原样
    expect(outcomes).toEqual([{ slug: 'pro-tool', status: 'removed' }]);

    await expect(lstat(path.join(platformDir, 'pro-tool'))).rejects.toThrow();
    await expect(lstat(path.join(platformDir, 'foreign'))).resolves.toBeTruthy();
    await expect(lstat(path.join(platformDir, 'manual-dir'))).resolves.toBeTruthy();
  });

  it('reports not-linked for absent entries', async () => {
    const outcomes = await unlinkSkillsFromPlatform({ platformSkillsDir: platformDir, skillsDir });
    expect(outcomes).toEqual([{ slug: 'pro-tool', status: 'not-linked' }]);
  });
});
