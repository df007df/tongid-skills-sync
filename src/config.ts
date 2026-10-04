import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultStoreDir } from './store.js';

/**
 * 应用绑定配置解析。
 *
 * 默认应用无法凭空得知：第一次 login 必须由用户显式传入（--app 或环境变量），
 * 登录成功后写入全局配置 ~/.tongid/skills-sync/config.json，
 * 之后所有命令可省略 --app。
 * 优先级：命令行参数 > 环境变量 > 全局配置文件。
 */

export const DEFAULT_BASE_URL = 'https://tongid.dev';
export const GLOBAL_CONFIG_FILENAME = 'config.json';
export const ENV_BASE_URL = 'TONGID_BASE_URL';
export const ENV_APP = 'TONGID_SKILLS_APP';

export type SkillsPayConfig = {
  /** 平台地址，如 https://tongid.dev */
  baseUrl: string;
  /** 目标应用（applicationId 或 slug） */
  app: string;
};

export class SkillsPayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillsPayConfigError';
  }
}

export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_BASE_URL;
  return trimmed;
}

export function globalConfigPath(storeDir: string = defaultStoreDir()): string {
  return path.join(storeDir, GLOBAL_CONFIG_FILENAME);
}

/** 读取全局配置；不存在返回 null，损坏时抛错（避免静默忽略用户的错误配置）。 */
export async function readGlobalConfig(
  storeDir: string = defaultStoreDir(),
): Promise<Partial<SkillsPayConfig> | null> {
  const file = globalConfigPath(storeDir);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkillsPayConfigError(`${GLOBAL_CONFIG_FILENAME} 不是合法 JSON（${file}）`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillsPayConfigError(`${GLOBAL_CONFIG_FILENAME} 格式无效（${file}）`);
  }
  const record = parsed as Record<string, unknown>;
  const config: Partial<SkillsPayConfig> = {};
  if (typeof record.baseUrl === 'string' && record.baseUrl.trim()) {
    config.baseUrl = normalizeBaseUrl(record.baseUrl);
  }
  if (typeof record.app === 'string' && record.app.trim()) {
    config.app = record.app.trim();
  }
  return config;
}

/** 登录成功后写入默认应用与平台地址（全局配置，由本工具自动生成）。 */
export async function writeGlobalConfig(
  config: SkillsPayConfig,
  storeDir: string = defaultStoreDir(),
): Promise<string> {
  await mkdir(storeDir, { recursive: true });
  const file = globalConfigPath(storeDir);
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

/** 登出的应用是默认应用时清除默认；baseUrl 保留，两者皆空则删除文件。 */
export async function clearDefaultApp(
  app: string,
  storeDir: string = defaultStoreDir(),
): Promise<void> {
  const config = await readGlobalConfig(storeDir);
  if (!config || config.app !== app) return;
  const file = globalConfigPath(storeDir);
  if (config.baseUrl) {
    await writeFile(file, `${JSON.stringify({ baseUrl: config.baseUrl }, null, 2)}\n`);
  } else {
    await rm(file, { force: true });
  }
}

export async function resolveSkillsPayConfig(input: {
  cliApp?: string | null;
  cliBaseUrl?: string | null;
  /** 环境变量集合（默认 process.env；测试可注入） */
  env?: Record<string, string | undefined>;
  /** 全局配置目录（默认 ~/.tongid/skills-sync；测试可注入） */
  storeDir?: string;
}): Promise<SkillsPayConfig> {
  const env = input.env ?? process.env;
  const saved = await readGlobalConfig(input.storeDir);

  const app =
    input.cliApp?.trim() ||
    env[ENV_APP]?.trim() ||
    saved?.app?.trim() ||
    '';
  if (!app) {
    throw new SkillsPayConfigError(
      `未指定目标应用。默认应用需在第一次登录时显式传入：\n` +
        `  1. 命令行参数：tongid-skills-sync login --app <applicationId 或 slug>\n` +
        `  2. 环境变量：${ENV_APP}`,
    );
  }

  const baseUrl = normalizeBaseUrl(
    input.cliBaseUrl?.trim() || env[ENV_BASE_URL]?.trim() || saved?.baseUrl || DEFAULT_BASE_URL,
  );

  return { baseUrl, app };
}
