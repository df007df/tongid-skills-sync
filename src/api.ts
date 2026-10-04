/**
 * 平台技能接口客户端（机器授权码认证）。
 * 下载流量直连 GitHub，不经平台转发。
 */

export type RegistryEntry = {
  slug: string;
  name: string;
  description: string | null;
  version: string;
  isPrivate: boolean;
  repoUrl: string;
  updatedAt: string;
};

export type RegistryPayload = {
  applicationId: string;
  skills: RegistryEntry[];
  roles: string[];
  machineLimit: number;
};

export type DownloadGrantPayload = {
  slug: string;
  name: string;
  version: string;
  ref: string;
  /** 直连 GitHub 的 tarball 地址 */
  url: string;
  /** 私有库下载令牌（仅本次响应存在；用完即弃，绝不落盘） */
  token: string | null;
  tokenHint: string | null;
  authorization: string | null;
};

export type SkillsPayApiErrorCode =
  | 'UNAUTHORIZED'
  | 'MACHINE_REVOKED'
  | 'SKILLS_DISABLED'
  | 'SKILL_NOT_FOUND'
  | 'NO_SKILL_PERMISSION'
  | 'MACHINE_LIMIT_REACHED'
  | 'RATE_LIMITED'
  | (string & {});

export class SkillsPayApiError extends Error {
  code: SkillsPayApiErrorCode;
  status: number;
  /** MACHINE_REVOKED 等场景下建议引导用户重新 login */
  readonly reloginRequired: boolean;

  constructor(code: SkillsPayApiErrorCode, message: string, status: number) {
    super(`[${code}] ${message}`);
    this.name = 'SkillsPayApiError';
    this.code = code;
    this.status = status;
    this.reloginRequired = status === 401;
  }
}

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null };

async function request<T>(
  baseUrl: string,
  pathName: string,
  machineToken: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(new URL(pathName, baseUrl), {
    ...init,
    headers: {
      authorization: `Bearer ${machineToken}`,
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (!response.ok || !body || body.error) {
    const error = body?.error;
    throw new SkillsPayApiError(
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? `请求失败（HTTP ${response.status}）`,
      response.status,
    );
  }
  return body.data as T;
}

export async function fetchRegistry(options: {
  baseUrl: string;
  machineToken: string;
}): Promise<RegistryPayload> {
  return request<RegistryPayload>(options.baseUrl, '/api/v1/skills/registry', options.machineToken);
}

export async function fetchDownloadGrant(options: {
  baseUrl: string;
  machineToken: string;
  slug: string;
}): Promise<DownloadGrantPayload> {
  return request<DownloadGrantPayload>(
    options.baseUrl,
    `/api/v1/skills/${encodeURIComponent(options.slug)}/download-grant`,
    options.machineToken,
    { method: 'POST' },
  );
}

export async function revokeCurrentMachine(options: {
  baseUrl: string;
  machineToken: string;
}): Promise<{ revoked: boolean }> {
  return request<{ revoked: boolean }>(
    options.baseUrl,
    '/api/v1/skills/machines/current',
    options.machineToken,
    { method: 'DELETE' },
  );
}
