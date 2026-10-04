import { lstat, readlink, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { linkNamesOfEntry, readAppIndex, skillInstallDir } from './install.js';

/**
 * 把统一维护目录（默认全局 ~/.tongid/skills-sync/skills/<app>/<slug>）里已安装的技能
 * 软连接到平台技能目录。
 *
 * - 软连接单元：单技能仓 = <slug> 本身；多技能集合仓（kind=collection）按仓库内
 *   skills/<name>/ 逐个展开，每个内部技能一条链接（链接名 = 内部技能名，指向
 *   <app>/<slug>/skills/<name> 的绝对路径：update 替换目录内容时路径不变，软连接自动跟随新版本）；
 * - 技能发现走各应用索引（index.json，读取自带磁盘对账）；
 * - install 已前置拒绝跨应用同名技能；此处对同名冲突（如手工拷贝产生的）防御性跳过；
 * - 只覆盖「指向本统一目录」的既有软连接；真实目录/文件/指向别处的软连接一律跳过并提示，
 *   不覆盖用户自己的内容；
 * - 平台技能目录由调用方保证存在（探测到才做连接），本模块绝不创建平台目录。
 */

export type LinkStatus = 'linked' | 'refreshed' | 'skipped-exists' | 'skipped-conflict' | 'skipped-unmanaged';

export type LinkOutcome = {
  slug: string;
  status: LinkStatus;
  note?: string;
};

export type UnlinkOutcome = {
  slug: string;
  status: 'removed' | 'kept-foreign' | 'not-linked';
};

/** 统一目录下已安装的技能：所属应用 + slug + 绝对路径。 */
export type ManagedSkill = {
  app: string;
  slug: string;
  dir: string;
};

/** 列出统一目录下所有应用已安装技能的软连接单元（集合仓按内部技能展开）。 */
export async function listManagedSkills(skillsDir: string): Promise<ManagedSkill[]> {
  const { readdir } = await import('node:fs/promises');
  const root = path.resolve(skillsDir);
  let appDirs;
  try {
    appDirs = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const managed: ManagedSkill[] = [];
  for (const entry of appDirs) {
    if (!entry.isDirectory()) continue;
    const index = await readAppIndex(root, entry.name);
    for (const repoSlug of Object.keys(index.skills)) {
      const indexEntry = index.skills[repoSlug]!;
      const isCollection = indexEntry.kind === 'collection';
      const repoDir = skillInstallDir(root, entry.name, repoSlug);
      const names = isCollection
        ? linkNamesOfEntry(indexEntry, repoSlug)
        : [repoSlug];
      for (const name of names) {
        managed.push({
          app: index.app || entry.name,
          slug: name,
          dir: isCollection ? path.join(repoDir, 'skills', name) : repoDir,
        });
      }
    }
  }
  return managed.sort((a, b) => a.slug.localeCompare(b.slug) || a.app.localeCompare(b.app));
}

function symlinkType(): 'dir' | 'junction' {
  return process.platform === 'win32' ? 'junction' : 'dir';
}

async function pointsAt(linkPath: string, targetDir: string): Promise<boolean> {
  try {
    const linked = await readlink(linkPath);
    return path.resolve(path.dirname(linkPath), linked) === targetDir;
  } catch {
    return false;
  }
}

/** 把统一目录中的已安装技能软连接到一个平台技能目录。 */
export async function linkSkillsToPlatform(options: {
  /** 平台技能目录（必须已存在） */
  platformSkillsDir: string;
  /** skills-sync 统一维护目录 */
  skillsDir: string;
  /** 只连接指定 slug（默认全部已安装技能） */
  slugs?: string[];
}): Promise<LinkOutcome[]> {
  const root = path.resolve(options.skillsDir);
  const managed = await listManagedSkills(root);

  // 跨应用同名 slug：无法用单一软连接表达，整体跳过并说明占用方
  const bySlug = new Map<string, ManagedSkill[]>();
  for (const skill of managed) {
    const list = bySlug.get(skill.slug) ?? [];
    list.push(skill);
    bySlug.set(skill.slug, list);
  }

  const wanted = options.slugs ? new Set(options.slugs) : null;
  const outcomes: LinkOutcome[] = [];

  for (const [slug, holders] of bySlug) {
    if (wanted && !wanted.has(slug)) continue;

    if (holders.length > 1) {
      outcomes.push({
        slug,
        status: 'skipped-conflict',
        note: `多应用同名（${holders.map((holder) => holder.app).join('、')}），无法软连接`,
      });
      continue;
    }

    const skillDir = holders[0]!.dir;
    const linkPath = path.join(options.platformSkillsDir, slug);

    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      await lstat(skillDir);
    } catch {
      outcomes.push({ slug, status: 'skipped-unmanaged', note: '目录缺失（先 install）' });
      continue;
    }

    try {
      current = await lstat(linkPath);
    } catch {
      await symlink(skillDir, linkPath, symlinkType());
      outcomes.push({ slug, status: 'linked' });
      continue;
    }

    if (current.isSymbolicLink() && (await pointsAt(linkPath, skillDir))) {
      // 已指向本技能：重挂一次，确保 update 后立即生效
      await rm(linkPath, { force: true });
      await symlink(skillDir, linkPath, symlinkType());
      outcomes.push({ slug, status: 'refreshed' });
      continue;
    }

    outcomes.push({
      slug,
      status: 'skipped-exists',
      note: current.isSymbolicLink() ? '同名软连接指向别处' : '同名目录/文件已存在',
    });
  }

  return outcomes;
}

/** 移除平台目录中由 tongid-skills-sync 建立的软连接；非本工具建立的链接一律保留。 */
export async function unlinkSkillsFromPlatform(options: {
  platformSkillsDir: string;
  skillsDir: string;
  slugs?: string[];
}): Promise<UnlinkOutcome[]> {
  const root = path.resolve(options.skillsDir);
  const managed = await listManagedSkills(root);
  const wanted = options.slugs ? new Set(options.slugs) : null;

  const seen = new Set<string>();
  const outcomes: UnlinkOutcome[] = [];
  for (const skill of managed) {
    if (seen.has(skill.slug)) continue;
    seen.add(skill.slug);
    if (wanted && !wanted.has(skill.slug)) continue;

    const linkPath = path.join(options.platformSkillsDir, skill.slug);
    let current: Awaited<ReturnType<typeof lstat>>;
    try {
      current = await lstat(linkPath);
    } catch {
      outcomes.push({ slug: skill.slug, status: 'not-linked' });
      continue;
    }

    if (current.isSymbolicLink() && (await pointsAt(linkPath, skill.dir))) {
      await rm(linkPath, { force: true });
      outcomes.push({ slug: skill.slug, status: 'removed' });
    } else {
      outcomes.push({ slug: skill.slug, status: 'kept-foreign' });
    }
  }

  return outcomes;
}
