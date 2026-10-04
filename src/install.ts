import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  fetchDownloadGrant,
  fetchRegistry,
  type DownloadGrantPayload,
  type RegistryPayload,
} from './api.js';
import { defaultSkillsDir, sanitizeAppKey } from './store.js';
import { extractTarGzToDir } from './tar.js';

/**
 * 技能包安装与更新。
 *
 * 技能统一维护在全局唯一目录 ~/.tongid/skills-sync/skills/<app>/<slug>/
 * （与凭据同根，可用 --dir 覆盖根目录）；每包带 .skills-sync.json 版本清单，
 * 多平台软连接以此为源。每个应用名下另维护 index.json 应用索引
 * （应用信息 + 各技能版本/安装时间），读取时与磁盘对账自愈。
 *
 * 跨应用同名约束：平台技能目录的软连接名只有 <slug>，因此同一 slug 只允许
 * 出现在一个应用名下——install 前置校验，其他应用已占用时直接报错拒绝，
 * 不产生无法软连接的安装。
 *
 * 流程：校验（占用/registry/机器码）→ 领取下载凭据（真实 GitHub 地址 + 私有库令牌）
 * → 直连 GitHub 流式下载到临时文件（不经平台转发）→ 解压到统一目录
 * → 写入版本清单与应用索引 → 令牌即弃（只存在于函数栈内，不落盘）。
 */

export const MANIFEST_FILENAME = '.skills-sync.json';
export const APP_INDEX_FILENAME = 'index.json';

/** 技能统一维护目录（全局唯一）：~/.tongid/skills-sync/skills */
export const DEFAULT_SKILLS_DIR = defaultSkillsDir();

/** 技能安装目录：<root>/<app>/<slug>。 */
export function skillInstallDir(skillsRoot: string, app: string, slug: string): string {
  return path.join(path.resolve(skillsRoot), sanitizeAppKey(app), slug);
}

export type AppIndexSkill = {
  version: string;
  ref: string;
  installedAt: string;
};

/** 应用索引：skills/<app>/index.json，记录应用安装状态与各技能版本。 */
export type AppIndex = {
  /** 用户使用的应用标识 */
  app: string;
  baseUrl?: string;
  updatedAt: string;
  skills: Record<string, AppIndexSkill>;
};

function emptyAppIndex(app: string): AppIndex {
  return { app, updatedAt: new Date().toISOString(), skills: {} };
}

function appIndexFile(skillsRoot: string, app: string): string {
  return path.join(path.resolve(skillsRoot), sanitizeAppKey(app), APP_INDEX_FILENAME);
}

/**
 * 读取应用索引，并与磁盘对账自愈：
 * - 索引缺失/损坏：遍历 <app>/<slug>/.skills-sync.json 重建；
 * - 索引与磁盘不一致（手工增删）：以磁盘为准修正并回写。
 */
export async function readAppIndex(skillsRoot: string, app: string): Promise<AppIndex> {
  const root = path.resolve(skillsRoot);
  const appDir = path.join(root, sanitizeAppKey(app));

  let index: AppIndex | null = null;
  try {
    const parsed = JSON.parse(await readFile(appIndexFile(root, app), 'utf8')) as AppIndex;
    if (parsed && typeof parsed === 'object' && parsed.skills && typeof parsed.skills === 'object') {
      index = {
        app: typeof parsed.app === 'string' && parsed.app ? parsed.app : app,
        ...(typeof parsed.baseUrl === 'string' ? { baseUrl: parsed.baseUrl } : {}),
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
        skills: parsed.skills,
      };
    }
  } catch {
    // 索引不存在或损坏：走重建
  }

  // 磁盘侧真实安装（带清单的技能目录）
  const onDisk = new Map<string, AppIndexSkill>();
  let entries;
  try {
    entries = await readdir(appDir, { withFileTypes: true });
  } catch {
    return index ?? emptyAppIndex(app);
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        await readFile(path.join(appDir, entry.name, MANIFEST_FILENAME), 'utf8'),
      ) as InstalledManifest;
      if (manifest?.slug === entry.name && manifest.version) {
        onDisk.set(entry.name, {
          version: manifest.version,
          ref: manifest.ref,
          installedAt: manifest.installedAt,
        });
      }
    } catch {
      // 无清单/损坏的目录不纳入索引
    }
  }

  // 对账：以磁盘为准（保留索引里的 app 级元信息）
  const merged: AppIndex = {
    app: index?.app ?? app,
    ...(index?.baseUrl ? { baseUrl: index.baseUrl } : {}),
    updatedAt: index?.updatedAt ?? new Date().toISOString(),
    skills: Object.fromEntries(onDisk),
  };

  const drifted =
    !index ||
    Object.keys(index.skills).length !== onDisk.size ||
    [...onDisk.keys()].some((slug) => {
      const indexed = index!.skills[slug];
      const disk = onDisk.get(slug)!;
      return !indexed || indexed.version !== disk.version || indexed.ref !== disk.ref;
    });

  if (drifted) {
    merged.updatedAt = new Date().toISOString();
    try {
      await writeAppIndex(root, app, merged);
    } catch {
      // 只读场景（如目录被删）忽略回写失败
    }
  }
  return merged;
}

export async function writeAppIndex(skillsRoot: string, app: string, index: AppIndex): Promise<void> {
  const file = appIndexFile(skillsRoot, app);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * 查询 slug 是否已被「其他应用」安装。
 * 走各应用索引（索引读取自带磁盘对账）；返回占用方的应用目录名，未占用返回 null。
 */
export async function findCrossAppSlugHolder(
  skillsRoot: string,
  app: string,
  slug: string,
): Promise<string | null> {
  const root = path.resolve(skillsRoot);
  let appDirs;
  try {
    appDirs = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  const ownKey = sanitizeAppKey(app);
  for (const entry of appDirs) {
    if (!entry.isDirectory() || entry.name === ownKey) continue;
    const index = await readAppIndex(root, entry.name);
    if (index.skills[slug]) return entry.name;
  }
  return null;
}

export type InstalledManifest = {
  slug: string;
  version: string;
  ref: string;
  installedAt: string;
};

export type InstallResult = {
  slug: string;
  version: string;
  files: number;
};

export class SkillsPayInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillsPayInstallError';
  }
}


function randomTmpDir(): string {
  return path.join(os.tmpdir(), `skills-sync-${Math.random().toString(36).slice(2)}-${Date.now()}`);
}

/** 流式下载到临时文件，避免大包占满内存。 */
async function downloadToFile(url: string, authorization: string | null): Promise<string> {
  const tmpFile = `${randomTmpDir()}.tgz`;
  const headers: Record<string, string> = { 'user-agent': 'tongid-skills-sync' };
  if (authorization) headers.authorization = authorization;

  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new SkillsPayInstallError(`技能包下载失败：GitHub 返回 HTTP ${response.status}`);
  }
  const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(stream, createWriteStream(tmpFile));
  return tmpFile;
}

/** 安装单个技能：占用校验 → 领取凭据 → 下载 → 解压 → 更新应用索引。下载令牌仅在栈内瞬时存在。 */
export async function installSkill(options: {
  baseUrl: string;
  machineToken: string;
  /** 应用标识（目录段与索引归属） */
  app: string;
  slug: string;
  /** 技能统一目录（默认全局 ~/.tongid/skills-sync/skills） */
  skillsDir?: string;
  fetchImpl?: typeof fetch;
}): Promise<InstallResult> {
  const app = options.app.trim();
  if (!app) {
    throw new SkillsPayInstallError('缺少应用标识（--app / 配置文件 / 环境变量），无法定位安装目录');
  }

  const skillsRoot = path.resolve(options.skillsDir ?? DEFAULT_SKILLS_DIR);

  // 跨应用同名 slug：提前报错（平台软连接名只有 slug，同名无法软连接）
  const holder = await findCrossAppSlugHolder(skillsRoot, app, options.slug);
  if (holder) {
    throw new SkillsPayInstallError(
      `技能 ${options.slug} 已被应用「${holder}」安装；跨应用同名 slug 无法软连接，` +
        `请让卖家更换 slug，或先删除该应用下的安装（rm -rf "${path.join(skillsRoot, holder, options.slug)}"）`,
    );
  }

  const grant: DownloadGrantPayload = await fetchDownloadGrant({
    baseUrl: options.baseUrl,
    machineToken: options.machineToken,
    slug: options.slug,
  });

  const previousFetch = globalThis.fetch;
  const fetchImpl = options.fetchImpl ?? previousFetch;
  // downloadToFile 内部 fetch 需要直连 GitHub；允许注入便于测试
  const tmpFile = await downloadWithFetch(grant, fetchImpl);

  const targetDir = skillInstallDir(skillsRoot, app, grant.slug);
  const stagingDir = randomTmpDir();

  let files = 0;
  try {
    const archive = await readFile(tmpFile);
    const entries = await extractTarGzToDir(archive, stagingDir, { stripComponents: 1 });
    files = entries.filter((entry) => entry.type === 'file').length;

    await mkdir(path.dirname(targetDir), { recursive: true });
    await rm(targetDir, { recursive: true, force: true });
    await import('node:fs/promises').then((fs) => fs.rename(stagingDir, targetDir));

    const manifest: InstalledManifest = {
      slug: grant.slug,
      version: grant.version,
      ref: grant.ref,
      installedAt: new Date().toISOString(),
    };
    await writeFile(path.join(targetDir, MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`);

    // 应用索引：安装成功后登记版本与基础信息
    const index = await readAppIndex(skillsRoot, app);
    index.app = app;
    index.baseUrl = options.baseUrl;
    index.updatedAt = new Date().toISOString();
    index.skills[grant.slug] = {
      version: grant.version,
      ref: grant.ref,
      installedAt: manifest.installedAt,
    };
    await writeAppIndex(skillsRoot, app, index);
  } finally {
    await rm(tmpFile, { force: true });
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return { slug: grant.slug, version: grant.version, files };
}

async function downloadWithFetch(grant: DownloadGrantPayload, fetchImpl: typeof fetch): Promise<string> {
  if (!fetchImpl || fetchImpl === globalThis.fetch) return downloadToFile(grant.url, grant.authorization);
  const previous = globalThis.fetch;
  try {
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl;
    return await downloadToFile(grant.url, grant.authorization);
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = previous;
  }
}

/** 读取本地已安装版本；未安装返回 null。 */
export async function readInstalledManifest(
  app: string,
  slug: string,
  skillsDir: string = DEFAULT_SKILLS_DIR,
): Promise<InstalledManifest | null> {
  try {
    const raw = await readFile(
      path.join(skillInstallDir(skillsDir, app, slug), MANIFEST_FILENAME),
      'utf8',
    );
    const parsed = JSON.parse(raw) as InstalledManifest;
    return parsed?.slug === slug ? parsed : null;
  } catch {
    return null;
  }
}

export type UpdatePlan = {
  registry: RegistryPayload;
  /** 需要更新（含新安装）的技能 */
  outdated: Array<{ slug: string; from: string | null; to: string }>;
  upToDate: Array<{ slug: string; version: string }>;
};

/** 比对 registry 与应用索引中的已安装版本。 */
export async function planUpdate(options: {
  baseUrl: string;
  machineToken: string;
  app: string;
  skillsDir?: string;
}): Promise<UpdatePlan> {
  const registry = await fetchRegistry({
    baseUrl: options.baseUrl,
    machineToken: options.machineToken,
  });
  const skillsDir = options.skillsDir ?? DEFAULT_SKILLS_DIR;
  const index = await readAppIndex(skillsDir, options.app);

  const outdated: UpdatePlan['outdated'] = [];
  const upToDate: UpdatePlan['upToDate'] = [];
  for (const entry of registry.skills) {
    const installed = index.skills[entry.slug];
    if (!installed || installed.version !== entry.version) {
      outdated.push({ slug: entry.slug, from: installed?.version ?? null, to: entry.version });
    } else {
      upToDate.push({ slug: entry.slug, version: entry.version });
    }
  }
  return { registry, outdated, upToDate };
}

/** 更新全部可更新技能；返回安装结果列表。 */
export async function updateSkills(options: {
  baseUrl: string;
  machineToken: string;
  app: string;
  skillsDir?: string;
  fetchImpl?: typeof fetch;
}): Promise<InstallResult[]> {
  const plan = await planUpdate(options);
  const results: InstallResult[] = [];
  for (const item of plan.outdated) {
    results.push(
      await installSkill({
        baseUrl: options.baseUrl,
        machineToken: options.machineToken,
        app: options.app,
        slug: item.slug,
        skillsDir: options.skillsDir,
        fetchImpl: options.fetchImpl,
      }),
    );
  }
  return results;
}
