import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_INDEX_FILENAME,
  findCrossAppSlugHolder,
  linkNamesOfEntry,
  readAppIndex,
  skillInstallDir,
  writeAppIndex,
  type AppIndex,
} from './install.js';

let skillsDir: string;

function writeManifest(app: string, slug: string, version: string, ref = `v${version}`) {
  return writeFile(
    path.join(skillsDir, app, slug, '.skills-sync.json'),
    JSON.stringify({ slug, version, ref, installedAt: '2026-10-04T00:00:00Z' }),
  );
}

beforeEach(async () => {
  skillsDir = await mkdtemp(path.join(os.tmpdir(), 'skills-sync-index-'));
});

afterEach(async () => {
  await rm(skillsDir, { recursive: true, force: true });
});

describe('readAppIndex', () => {
  it('returns an empty index when nothing is installed', async () => {
    const index = await readAppIndex(skillsDir, 'app-one');
    expect(index).toMatchObject({ app: 'app-one', skills: {} });
  });

  it('rebuilds the index from skill manifests when missing or stale', async () => {
    await mkdir(path.join(skillsDir, 'app-one', 'pro-tool'), { recursive: true });
    await writeManifest('app-one', 'pro-tool', '1.4.0');

    // 无索引：从清单重建并回写
    const rebuilt = await readAppIndex(skillsDir, 'app-one');
    expect(rebuilt.skills['pro-tool']).toMatchObject({ version: '1.4.0', ref: 'v1.4.0' });
    const persisted = JSON.parse(
      await readFile(path.join(skillsDir, 'app-one', APP_INDEX_FILENAME), 'utf8'),
    ) as AppIndex;
    expect(persisted.skills['pro-tool']?.version).toBe('1.4.0');

    // 手工删掉技能目录：索引对账剔除陈旧条目
    await rm(path.join(skillsDir, 'app-one', 'pro-tool'), { recursive: true });
    const healed = await readAppIndex(skillsDir, 'app-one');
    expect(healed.skills).toEqual({});
  });

  it('carries collection kind and inner skill names through reconciliation', async () => {
    await mkdir(path.join(skillsDir, 'app-one', 'tool-pack', 'skills', 'alpha'), { recursive: true });
    await writeFile(
      path.join(skillsDir, 'app-one', 'tool-pack', '.skills-sync.json'),
      JSON.stringify({
        slug: 'tool-pack',
        version: '1.0.0',
        ref: 'v1.0.0',
        installedAt: '2026-10-04T00:00:00Z',
        kind: 'collection',
        skills: ['alpha', 'beta'],
      }),
    );

    const rebuilt = await readAppIndex(skillsDir, 'app-one');
    expect(rebuilt.skills['tool-pack']).toMatchObject({
      version: '1.0.0',
      kind: 'collection',
      skills: ['alpha', 'beta'],
    });

    // 内部技能名单变化（磁盘清单为准）：索引对账更新
    await writeFile(
      path.join(skillsDir, 'app-one', 'tool-pack', '.skills-sync.json'),
      JSON.stringify({
        slug: 'tool-pack',
        version: '1.1.0',
        ref: 'v1.1.0',
        installedAt: '2026-10-04T00:00:00Z',
        kind: 'collection',
        skills: ['alpha'],
      }),
    );
    const healed = await readAppIndex(skillsDir, 'app-one');
    expect(healed.skills['tool-pack']).toMatchObject({ version: '1.1.0', skills: ['alpha'] });
  });

  it('keeps app metadata and repairs corrupt index files', async () => {
    await mkdir(path.join(skillsDir, 'app-one'), { recursive: true });
    await writeAppIndex(skillsDir, 'app-one', {
      app: 'app-one',
      baseUrl: 'https://tongid.dev',
      updatedAt: '2026-10-04T00:00:00Z',
      skills: { ghost: { version: '0.9.0', ref: 'v0.9.0', installedAt: '2026-10-04T00:00:00Z' } },
    });

    // 索引里的 ghost 无对应目录：对账剔除
    const healed = await readAppIndex(skillsDir, 'app-one');
    expect(healed.skills).toEqual({});
    expect(healed.baseUrl).toBe('https://tongid.dev');
    expect(healed.app).toBe('app-one');

    // 损坏的 JSON：重建不抛错
    await writeFile(path.join(skillsDir, 'app-one', APP_INDEX_FILENAME), '{broken');
    const afterCorruption = await readAppIndex(skillsDir, 'app-one');
    expect(afterCorruption.skills).toEqual({});
  });
});

describe('linkNamesOfEntry', () => {
  it('uses inner skill names for collections and the slug otherwise', () => {
    expect(linkNamesOfEntry({ kind: 'collection', skills: ['alpha', 'beta'] }, 'tool-pack')).toEqual([
      'alpha',
      'beta',
    ]);
    // 空名单/缺失名单/旧版清单（无 kind）：回退为 slug 本身
    expect(linkNamesOfEntry({ kind: 'collection', skills: [] }, 'tool-pack')).toEqual(['tool-pack']);
    expect(linkNamesOfEntry({ kind: 'collection' }, 'tool-pack')).toEqual(['tool-pack']);
    expect(linkNamesOfEntry({}, 'pro-tool')).toEqual(['pro-tool']);
  });
});

describe('findCrossAppSlugHolder', () => {
  it('reports the occupying app across apps and ignores own installs', async () => {
    await mkdir(path.join(skillsDir, 'app-one', 'pro-tool'), { recursive: true });
    await writeManifest('app-one', 'pro-tool', '1.4.0');

    await expect(findCrossAppSlugHolder(skillsDir, 'app-two', 'pro-tool')).resolves.toBe('app-one');
    // 同应用自身已安装：不冲突（覆盖更新）
    await expect(findCrossAppSlugHolder(skillsDir, 'app-one', 'pro-tool')).resolves.toBeNull();
    await expect(findCrossAppSlugHolder(skillsDir, 'app-two', 'free-slug')).resolves.toBeNull();
  });
});

describe('skillInstallDir', () => {
  it('builds <root>/<app>/<slug> paths with sanitized app segments', () => {
    expect(skillInstallDir('/tmp/skills', 'my app', 'pro')).toBe(
      path.join('/tmp/skills', 'my_app', 'pro'),
    );
    expect(skillInstallDir('/tmp/skills', 'app-one', 'pro')).toBe(
      path.join('/tmp/skills', 'app-one', 'pro'),
    );
  });
});
