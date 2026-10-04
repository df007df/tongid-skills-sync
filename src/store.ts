import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 机器授权凭据的本地存储：~/.tongid/skills-sync/certificate/<app>.json，
 * 每个应用一个文件，支持多应用并存。文件包含机器码明文，权限应保持 0600。
 */

export const STORE_DIR_NAME = path.join('.tongid', 'skills-sync');

export type MachineCredential = {
  baseUrl: string;
  /** 用户提供的应用标识（id 或 slug） */
  app: string;
  /** 机器授权码明文（t- 前缀） */
  machineToken: string;
  label: string | null;
  /** 平台返回的机器 id 与创建时间 */
  machineId: string;
  createdAt: string;
};

export function defaultStoreDir(home: string = os.homedir()): string {
  return path.join(home, STORE_DIR_NAME);
}

/** 凭据目录：~/.tongid/skills-sync/certificate（与 skills/ 安装目录、全局配置同根）。 */
export function defaultCertificateDir(home: string = os.homedir()): string {
  return path.join(defaultStoreDir(home), 'certificate');
}

/**
 * 技能包统一维护目录（全局唯一）：~/.tongid/skills-sync/skills。
 * 所有经 tongid-skills-sync 安装的技能集中于此，多平台软连接以此为源；--dir 可覆盖。
 */
export function defaultSkillsDir(home: string = os.homedir()): string {
  return path.join(defaultStoreDir(home), 'skills');
}

function safeFileName(app: string): string {
  return `${sanitizeAppKey(app)}.json`;
}

/** 应用标识 → 目录名段：去掉路径不安全字符，空值回退 app。 */
export function sanitizeAppKey(app: string): string {
  const cleaned = app.trim().replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned || 'app';
}

export async function saveCredential(
  credential: MachineCredential,
  storeDir: string = defaultCertificateDir(),
): Promise<string> {
  await mkdir(storeDir, { recursive: true });
  const file = path.join(storeDir, safeFileName(credential.app));
  await writeFile(file, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export async function loadCredential(
  app: string,
  storeDir: string = defaultCertificateDir(),
): Promise<MachineCredential | null> {
  const file = path.join(storeDir, safeFileName(app));
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as MachineCredential;
    if (!parsed || typeof parsed.machineToken !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function deleteCredential(
  app: string,
  storeDir: string = defaultCertificateDir(),
): Promise<boolean> {
  const file = path.join(storeDir, safeFileName(app));
  try {
    await rm(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

export async function listCredentials(
  storeDir: string = defaultCertificateDir(),
): Promise<MachineCredential[]> {
  let files: string[];
  try {
    files = await readdir(storeDir);
  } catch {
    return [];
  }
  const credentials: MachineCredential[] = [];
  for (const name of files) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await readFile(path.join(storeDir, name), 'utf8')) as MachineCredential;
      if (parsed && typeof parsed.machineToken === 'string') credentials.push(parsed);
    } catch {
      // 单个损坏文件不影响其余凭据
    }
  }
  return credentials;
}
