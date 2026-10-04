import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 应用绑定配置解析。
 *
 * 优先级：命令行参数 > 项目配置文件（cwd/skills-sync.config.json）> 环境变量。
 * 未指定应用时报错并列出三种配置方式。
 */

export const DEFAULT_BASE_URL = 'https://tongid.dev';
export const PROJECT_CONFIG_FILENAME = 'skills-sync.config.json';
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

/** 读取项目配置文件；不存在返回 null，损坏时抛错（避免静默忽略用户的错误配置）。 */
export async function readProjectConfig(
  cwd: string = process.cwd(),
): Promise<Partial<SkillsPayConfig> | null> {
  const file = path.join(cwd, PROJECT_CONFIG_FILENAME);
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
    throw new SkillsPayConfigError(`${PROJECT_CONFIG_FILENAME} 不是合法 JSON`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillsPayConfigError(`${PROJECT_CONFIG_FILENAME} 格式无效`);
  }
  const record = parsed as Record<string, unknown>;
  const config: Partial<SkillsPayConfig> = {};
  // host 是 baseUrl 的别名：本地开发/自建平台可用更短的写法
  const hostRaw =
    (typeof record.baseUrl === 'string' && record.baseUrl.trim()) ||
    (typeof record.host === 'string' && record.host.trim());
  if (hostRaw) {
    config.baseUrl = normalizeBaseUrl(hostRaw as string);
  }
  if (typeof record.app === 'string' && record.app.trim()) {
    config.app = record.app.trim();
  }
  return config;
}

export async function resolveSkillsPayConfig(input: {
  cliApp?: string | null;
  cliBaseUrl?: string | null;
  cwd?: string;
  /** 环境变量集合（默认 process.env；测试可注入） */
  env?: Record<string, string | undefined>;
}): Promise<SkillsPayConfig> {
  const env = input.env ?? process.env;
  const project = await readProjectConfig(input.cwd);

  const app =
    input.cliApp?.trim() ||
    project?.app ||
    env[ENV_APP]?.trim() ||
    '';
  if (!app) {
    throw new SkillsPayConfigError(
      `未指定目标应用。请通过以下任一方式配置：\n` +
        `  1. 命令行参数：tongid-skills-sync login --app <applicationId 或 slug>\n` +
        `  2. 项目配置文件：${PROJECT_CONFIG_FILENAME}（{ "baseUrl": "...", "app": "..." }）\n` +
        `  3. 环境变量：${ENV_APP}`,
    );
  }

  const baseUrl = normalizeBaseUrl(
    input.cliBaseUrl?.trim() || project?.baseUrl || env[ENV_BASE_URL]?.trim() || DEFAULT_BASE_URL,
  );

  return { baseUrl, app };
}

export type CliHostInput = {
  /** --host 与 --base-url 等价（host 是面向本地开发/自建平台的别名） */
  host?: string | null;
  baseUrl?: string | null;
};

/** CLI 侧把 --host / --base-url 合并成一个 base-url 值；--host 优先（更近的显式指定）。 */
export function mergeCliHost(input: CliHostInput): string | null {
  return input.host?.trim() || input.baseUrl?.trim() || null;
}
