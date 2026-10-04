import { createWriteStream } from 'node:fs';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  fetchDownloadGrant,
  fetchRegistry,
  type DownloadGrantPayload,
  type RegistryPayload,
} from './api.js';
import { detectSkillPlatforms } from './platforms.js';
import type { InstallProgressEvent } from './progress.js';
import { defaultSkillsDir, sanitizeAppKey } from './store.js';
import { extractTarGzToDir } from './tar.js';

/**
 * 技能包安装与更新。
 *
 * 仓库支持两种格式，安装时按解包结果探测：
 * - 单技能仓库：根目录直接有 SKILL.md；
 * - 多技能集合仓库：根目录有 skills/ 目录，其中每个含 SKILL.md 的子目录是一个技能
 *   （skills/<name>/SKILL.md），整仓安装到 <app>/<slug>/，内部各技能单独做软连接。
 *
 * 技能统一维护在全局唯一目录 ~/.tongid/skills-sync/skills/<app>/<slug>/
 * （与凭据同根，可用 --dir 覆盖根目录）。<slug>/ 保持仓库快照原样，不写入任何
 * 工具文件；安装元数据（版本清单，含仓库形态与集合仓内部技能名）放在平级隐藏目录
 * <app>/.skills-sync/<slug>.json，多平台软连接以安装目录为源。每个应用名下另维护
 * index.json 应用索引（应用信息 + 各技能版本/安装时间/形态），读取时与磁盘对账自愈
 * （磁盘事实 = 清单与同名安装目录配对存在，孤儿清单或缺清单的目录都不算已安装）。
 *
 * 跨应用同名约束：平台技能目录的软连接名只有技能名（集合仓为内部技能名），
 * 因此同一名字只允许出现在一个安装名下——单技能仓 install 前置校验拒绝；
 * 集合仓内部技能名下载解包后才能得知，落盘前校验拒绝。两种情况都不产生
 * 无法软连接的安装。
 *
 * 流程：校验（占用/registry/机器码）→ 领取下载凭据（真实 GitHub 地址 + 私有库令牌）
 * → 直连 GitHub 流式下载到临时文件（不经平台转发）→ 解压到统一目录
 * → 探测格式并校验软连接名占用 → 写入版本清单与应用索引 → 令牌即弃（只存在于函数栈内，不落盘）。
 *
 * update 自动清理失效软链：新版仓库删除（或换源，如单技能↔集合仓转换）的技能名，
 * 其在各平台目录中由本工具建立的软连接会在安装成功后一并移除；外来条目（真实目录/
 * 指向别处的链接）一律不动。新增内部技能在下一次 link 时自动出现。
 */

/** 安装元数据目录：应用目录内、与各安装目录平级的隐藏目录。 */
export const MANIFEST_DIRNAME = '.skills-sync';
/** ≤0.1.x 布局：清单写在安装目录内；仅更新时回读（失效软链清理），不再产生。 */
export const LEGACY_MANIFEST_FILENAME = '.skills-sync.json';
export const APP_INDEX_FILENAME = 'index.json';

/** 技能统一维护目录（全局唯一）：~/.tongid/skills-sync/skills */
export const DEFAULT_SKILLS_DIR = defaultSkillsDir();

/** 技能安装目录：<root>/<app>/<slug>（纯仓库快照）。 */
export function skillInstallDir(skillsRoot: string, app: string, slug: string): string {
  return path.join(path.resolve(skillsRoot), sanitizeAppKey(app), slug);
}

/** 安装元数据文件：<root>/<app>/.skills-sync/<slug>.json（仓库快照之外）。 */
export function manifestFile(skillsRoot: string, app: string, slug: string): string {
  return path.join(path.resolve(skillsRoot), sanitizeAppKey(app), MANIFEST_DIRNAME, `${slug}.json`);
}

/** 仓库形态：single=根 SKILL.md 单技能；collection=根 skills/ 目录多技能集合。 */
export type SkillRepoKind = 'single' | 'collection';

/** 某个已安装条目占用的平台软连接名：集合仓为内部技能名，单技能仓为 slug 本身。 */
export function linkNamesOfEntry(
  entry: { kind?: string; skills?: string[] },
  slug: string,
): string[] {
  return entry.kind === 'collection' && Array.isArray(entry.skills) && entry.skills.length > 0
    ? entry.skills
    : [slug];
}

export type AppIndexSkill = {
  version: string;
  ref: string;
  installedAt: string;
  kind?: SkillRepoKind;
  /** collection：仓库内技能名（skills/ 下子目录名，即平台软连接名） */
  skills?: string[];
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
 * - 索引缺失/损坏：遍历 <app>/.skills-sync/<slug>.json 清单重建；
 * - 索引与磁盘不一致（手工增删）：以磁盘为准修正并回写；
 * - 磁盘事实 = 清单与同名安装目录配对存在，二者缺一不算已安装
 *   （孤儿清单、缺清单的目录均忽略）。
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

  // 磁盘侧真实安装：元数据目录中的每个清单，配对的安装目录存在才算数
  const onDisk = new Map<string, AppIndexSkill>();
  const metaDir = path.join(appDir, MANIFEST_DIRNAME);
  let manifestFiles: Dirent[] | null = null;
  try {
    manifestFiles = await readdir(metaDir, { withFileTypes: true });
  } catch {
    // 元数据目录不存在（从未安装，或 ≤0.1.x 旧布局）：按无安装参与对账
  }
  if (manifestFiles === null && !index) {
    // 无索引且无可扫描清单：直接返回，不产生磁盘写入
    return emptyAppIndex(app);
  }
  for (const entry of manifestFiles ?? []) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const slug = entry.name.slice(0, -'.json'.length);
    try {
      const manifest = JSON.parse(
        await readFile(path.join(metaDir, entry.name), 'utf8'),
      ) as InstalledManifest;
      if (manifest?.slug !== slug || !manifest.version) continue;
      const installInfo = await stat(path.join(appDir, slug)).catch(() => null);
      if (!installInfo?.isDirectory()) continue;
      onDisk.set(slug, {
        version: manifest.version,
        ref: manifest.ref,
        installedAt: manifest.installedAt,
        ...(manifest.kind ? { kind: manifest.kind } : {}),
        ...(manifest.skills ? { skills: manifest.skills } : {}),
      });
    } catch {
      // 损坏的清单不纳入索引
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
      return (
        !indexed ||
        indexed.version !== disk.version ||
        indexed.ref !== disk.ref ||
        (indexed.kind ?? 'single') !== (disk.kind ?? 'single') ||
        JSON.stringify(indexed.skills ?? []) !== JSON.stringify(disk.skills ?? [])
      );
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
  kind?: SkillRepoKind;
  /** collection：仓库内技能名（skills/ 下子目录名） */
  skills?: string[];
};

export type InstallResult = {
  slug: string;
  version: string;
  files: number;
  kind: SkillRepoKind;
  /** collection：包含的技能名；single 为空数组 */
  skills: string[];
  /** update 后被清理的失效软链（`平台/技能名`，仅本工具建立的） */
  pruned: string[];
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

type RepoLayout = { kind: 'single' } | { kind: 'collection'; skills: string[] };

/**
 * 探测解包后的仓库形态：根 skills/ 目录存在则视为多技能集合仓
 * （其中每个含 SKILL.md 的子目录是一个技能），否则按单技能仓要求根 SKILL.md。
 */
async function probeRepoLayout(stagingDir: string, ref: string): Promise<RepoLayout> {
  const { readdir, stat: statFile } = await import('node:fs/promises');

  const formatError = new SkillsPayInstallError(
    `技能包格式错误：仓库根目录既没有 SKILL.md，也没有包含技能的 skills/ 目录` +
      `（支持两种格式：单技能仓库 SKILL.md 位于根目录；多技能集合仓库 skills/<name>/SKILL.md）。` +
      `请联系卖家调整仓库结构，ref=${ref}`,
  );

  let skillsEntries;
  try {
    const info = await statFile(path.join(stagingDir, 'skills'));
    if (!info.isDirectory()) throw new Error('not a directory');
    skillsEntries = await readdir(path.join(stagingDir, 'skills'), { withFileTypes: true });
  } catch {
    skillsEntries = null;
  }

  if (skillsEntries) {
    const inner: string[] = [];
    for (const entry of skillsEntries) {
      if (!entry.isDirectory()) continue;
      try {
        const skillFile = await statFile(path.join(stagingDir, 'skills', entry.name, 'SKILL.md'));
        if (skillFile.isFile()) inner.push(entry.name);
      } catch {
        // 无 SKILL.md 的子目录不算技能
      }
    }
    if (inner.length === 0) throw formatError;
    return { kind: 'collection', skills: inner.sort() };
  }

  try {
    const info = await statFile(path.join(stagingDir, 'SKILL.md'));
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    throw formatError;
  }
  return { kind: 'single' };
}

/**
 * 校验本次安装将占用的软连接名（集合仓为内部技能名）未被其他安装占用：
 * 其他应用、以及本应用名下其他技能（跨仓库内部名冲突同样无法软连接）。
 * 自身条目不算（覆盖更新时旧的内部技能名被整体替换）。
 */
async function assertLinkNamesAvailable(
  skillsRoot: string,
  app: string,
  slug: string,
  linkNames: string[],
): Promise<void> {
  const wanted = new Set(linkNames);
  const ownKey = sanitizeAppKey(app);
  let appDirs;
  try {
    appDirs = await readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of appDirs) {
    if (!entry.isDirectory()) continue;
    const isOwn = entry.name === ownKey;
    const index = await readAppIndex(skillsRoot, entry.name);
    for (const [otherSlug, otherEntry] of Object.entries(index.skills)) {
      if (isOwn && otherSlug === slug) continue;
      for (const name of linkNamesOfEntry(otherEntry, otherSlug)) {
        if (!wanted.has(name)) continue;
        const holderApp = isOwn ? null : entry.name;
        throw new SkillsPayInstallError(
          holderApp
            ? `技能 ${name} 已被应用「${holderApp}」的技能 ${otherSlug} 安装；跨应用同名技能无法软连接，` +
                `请先删除对应安装（rm -rf "${path.join(skillsRoot, holderApp, otherSlug)}"）`
            : `技能 ${name} 已被本应用的技能 ${otherSlug} 安装；同名技能无法软连接，` +
                `请让卖家调整技能名，或先删除该安装`,
        );
      }
    }
  }
}

/** 流式下载到临时文件，避免大包占满内存；经 onProgress 上报已下载字节（total 无 content-length 时为 null）。 */
async function downloadToFile(
  url: string,
  authorization: string | null,
  onProgress?: (event: InstallProgressEvent) => void,
): Promise<string> {
  const tmpFile = `${randomTmpDir()}.tgz`;
  const headers: Record<string, string> = { 'user-agent': 'tongid-skills-sync' };
  if (authorization) headers.authorization = authorization;

  const response = await fetch(url, { headers, redirect: 'follow' });
  if (!response.ok || !response.body) {
    throw new SkillsPayInstallError(`技能包下载失败：GitHub 返回 HTTP ${response.status}`);
  }
  const lengthHeader = Number(response.headers.get('content-length'));
  const total = Number.isFinite(lengthHeader) && lengthHeader > 0 ? lengthHeader : null;

  let received = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      received += chunk.length;
      onProgress?.({ phase: 'download', received, total });
      callback(null, chunk);
    },
  });
  const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  await pipeline(stream, counter, createWriteStream(tmpFile));
  return tmpFile;
}

/**
 * 移除平台技能目录中因更新而失效的软连接：只删「指向被替换安装目录」的本工具链接，
 * 同名的外来条目（真实目录/文件/指向别处的链接）一律保留。返回 `平台/技能名` 列表。
 */
async function pruneStaleSkillLinks(
  homeDir: string,
  stale: Array<{ name: string; dir: string }>,
): Promise<string[]> {
  if (stale.length === 0) return [];
  const { lstat, readlink, rm } = await import('node:fs/promises');
  const pruned: string[] = [];
  for (const platform of detectSkillPlatforms(homeDir)) {
    for (const unit of stale) {
      const linkPath = path.join(platform.skillsDir, unit.name);
      try {
        const info = await lstat(linkPath);
        if (!info.isSymbolicLink()) continue;
        const linked = await readlink(linkPath);
        if (path.resolve(path.dirname(linkPath), linked) !== path.resolve(unit.dir)) continue;
        await rm(linkPath, { force: true });
        pruned.push(`${platform.id}/${unit.name}`);
      } catch {
        // 平台目录无此条目或读取失败：跳过（清理是尽力而为）
      }
    }
  }
  return pruned;
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
  /** home 目录（平台软链探测/清理用；默认 os.homedir()，测试可注入） */
  homeDir?: string;
  fetchImpl?: typeof fetch;
  /** 安装进度回调（领取凭据/下载字节/解压），CLI 渲染进度条用 */
  onProgress?: (event: InstallProgressEvent) => void;
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

  options.onProgress?.({ phase: 'grant' });
  const grant: DownloadGrantPayload = await fetchDownloadGrant({
    baseUrl: options.baseUrl,
    machineToken: options.machineToken,
    slug: options.slug,
  });

  const previousFetch = globalThis.fetch;
  const fetchImpl = options.fetchImpl ?? previousFetch;
  // downloadToFile 内部 fetch 需要直连 GitHub；允许注入便于测试
  const tmpFile = await downloadWithFetch(grant, fetchImpl, options.onProgress);

  const targetDir = skillInstallDir(skillsRoot, app, grant.slug);
  const stagingDir = randomTmpDir();

  let files = 0;
  let installed: { kind: SkillRepoKind; skills: string[] } | null = null;
  let pruned: string[] = [];
  try {
    options.onProgress?.({ phase: 'extract' });
    const archive = await readFile(tmpFile);
    const entries = await extractTarGzToDir(archive, stagingDir, { stripComponents: 1 });
    files = entries.filter((entry) => entry.type === 'file').length;

    // 格式探测：根 skills/ 目录（多技能集合仓）或根 SKILL.md（单技能仓）
    const layout = await probeRepoLayout(stagingDir, grant.ref);
    installed =
      layout.kind === 'collection' ? { kind: 'collection', skills: layout.skills } : { kind: 'single', skills: [] };
    const linkNames = layout.kind === 'collection' ? layout.skills : [grant.slug];

    // 软连接名占用校验（集合仓内部技能名解包后才可知，落盘前拦截）
    await assertLinkNamesAvailable(skillsRoot, app, grant.slug, linkNames);

    // 旧安装的软链单元（update 场景）：目录被替换前读取，安装成功后据此清理失效软链。
    // 新位置无清单时回读安装目录内的 ≤0.1.x 旧清单（该目录随后被整体替换，旧文件随之消失）。
    let previousUnits: Array<{ name: string; dir: string }> = [];
    let oldManifest: InstalledManifest | null = null;
    try {
      oldManifest = JSON.parse(await readFile(manifestFile(skillsRoot, app, grant.slug), 'utf8')) as InstalledManifest;
    } catch {
      try {
        oldManifest = JSON.parse(
          await readFile(path.join(targetDir, LEGACY_MANIFEST_FILENAME), 'utf8'),
        ) as InstalledManifest;
      } catch {
        oldManifest = null;
      }
    }
    if (oldManifest?.slug) {
      previousUnits = linkNamesOfEntry(oldManifest, oldManifest.slug).map((name) => ({
        name,
        dir: oldManifest.kind === 'collection' ? path.join(targetDir, 'skills', name) : targetDir,
      }));
    }

    await mkdir(path.dirname(targetDir), { recursive: true });
    await rm(targetDir, { recursive: true, force: true });
    await import('node:fs/promises').then((fs) => fs.rename(stagingDir, targetDir));

    const manifest: InstalledManifest = {
      slug: grant.slug,
      version: grant.version,
      ref: grant.ref,
      installedAt: new Date().toISOString(),
      kind: layout.kind,
      ...(layout.kind === 'collection' ? { skills: layout.skills } : {}),
    };
    const metaFile = manifestFile(skillsRoot, app, grant.slug);
    await mkdir(path.dirname(metaFile), { recursive: true });
    await writeFile(metaFile, `${JSON.stringify(manifest, null, 2)}\n`);

    // 应用索引：安装成功后登记版本与基础信息
    const index = await readAppIndex(skillsRoot, app);
    index.app = app;
    index.baseUrl = options.baseUrl;
    index.updatedAt = new Date().toISOString();
    index.skills[grant.slug] = {
      version: grant.version,
      ref: grant.ref,
      installedAt: manifest.installedAt,
      kind: layout.kind,
      ...(layout.kind === 'collection' ? { skills: layout.skills } : {}),
    };
    await writeAppIndex(skillsRoot, app, index);

    // 清理失效软链：新版已不含（或换源，如单技能↔集合仓转换）的技能名，
    // 只移除各平台目录中指向本安装目录的本工具链接
    const nextDirs = new Map(
      linkNames.map((name) => [
        name,
        layout.kind === 'collection' ? path.join(targetDir, 'skills', name) : targetDir,
      ]),
    );
    const stale = previousUnits.filter((unit) => nextDirs.get(unit.name) !== unit.dir);
    pruned = await pruneStaleSkillLinks(options.homeDir ?? os.homedir(), stale);
  } finally {
    await rm(tmpFile, { force: true });
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    slug: grant.slug,
    version: grant.version,
    files,
    kind: installed!.kind,
    skills: installed!.skills,
    pruned,
  };
}

async function downloadWithFetch(
  grant: DownloadGrantPayload,
  fetchImpl: typeof fetch,
  onProgress?: (event: InstallProgressEvent) => void,
): Promise<string> {
  if (!fetchImpl || fetchImpl === globalThis.fetch) {
    return downloadToFile(grant.url, grant.authorization, onProgress);
  }
  const previous = globalThis.fetch;
  try {
    (globalThis as { fetch: typeof fetch }).fetch = fetchImpl;
    return await downloadToFile(grant.url, grant.authorization, onProgress);
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
    const raw = await readFile(manifestFile(skillsDir, app, slug), 'utf8');
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
  onProgress?: (event: InstallProgressEvent) => void;
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
        onProgress: options.onProgress,
      }),
    );
  }
  return results;
}

export type UninstallResult = {
  slug: string;
  kind: SkillRepoKind;
  /** 一并移除的平台软链（`平台/技能名`，仅本工具建立的） */
  pruned: string[];
};

/**
 * 删除一个已安装技能：先按清单清理各平台目录中指向本安装的软链
 * （外来条目一律不动），再删除安装目录与元数据清单，最后更新应用索引。
 * 纯本地操作，不访问平台；未安装时报错。
 */
export async function uninstallSkill(options: {
  app: string;
  slug: string;
  skillsDir?: string;
  /** home 目录（平台软链探测用；默认 os.homedir()，测试可注入） */
  homeDir?: string;
}): Promise<UninstallResult> {
  const app = options.app.trim();
  if (!app) {
    throw new SkillsPayInstallError('缺少应用标识（--app / 配置文件 / 环境变量），无法定位安装目录');
  }
  const skillsRoot = path.resolve(options.skillsDir ?? DEFAULT_SKILLS_DIR);

  const manifest = await readInstalledManifest(app, options.slug, skillsRoot);
  if (!manifest) {
    throw new SkillsPayInstallError(`技能 ${options.slug} 未安装（应用 ${app}）`);
  }

  const targetDir = skillInstallDir(skillsRoot, app, options.slug);
  const units = linkNamesOfEntry(manifest, options.slug).map((name) => ({
    name,
    dir: manifest.kind === 'collection' ? path.join(targetDir, 'skills', name) : targetDir,
  }));
  const pruned = await pruneStaleSkillLinks(options.homeDir ?? os.homedir(), units);

  await rm(targetDir, { recursive: true, force: true });
  await rm(manifestFile(skillsRoot, app, options.slug), { force: true });

  const index = await readAppIndex(skillsRoot, app);
  delete index.skills[options.slug];
  index.updatedAt = new Date().toISOString();
  await writeAppIndex(skillsRoot, app, index);

  return { slug: options.slug, kind: manifest.kind ?? 'single', pruned };
}
