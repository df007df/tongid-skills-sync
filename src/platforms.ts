import { statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 已知平台的用户级技能目录（相对 home）。
 *
 * 软连接只做「主动探测」：目录存在才视为可用平台；绝不主动创建平台技能目录。
 * 新平台接入只需在此追加条目。
 */

export type SkillPlatform = {
  id: string;
  label: string;
  /** 相对 home 的技能目录路径 */
  dir: string;
};

export const KNOWN_SKILL_PLATFORMS: SkillPlatform[] = [
  { id: 'claude', label: 'Claude Code', dir: path.join('.claude', 'skills') },
  { id: 'cursor', label: 'Cursor', dir: path.join('.cursor', 'skills') },
  { id: 'codex', label: 'Codex CLI', dir: path.join('.codex', 'skills') },
  { id: 'gemini', label: 'Gemini CLI', dir: path.join('.gemini', 'skills') },
  { id: 'agents', label: '通用 agents 约定', dir: path.join('.agents', 'skills') },
  { id: 'zcode', label: 'ZCode', dir: path.join('.zcode', 'skills') },
  { id: 'opencode', label: 'OpenCode', dir: path.join('.config', 'opencode', 'skills') },
];

export function platformSkillsDir(platform: SkillPlatform, home: string = os.homedir()): string {
  return path.join(home, platform.dir);
}

/** 探测本机存在的平台技能目录（仅目录算数；不创建任何目录）。 */
export function detectSkillPlatforms(home: string = os.homedir()): Array<SkillPlatform & { skillsDir: string }> {
  return KNOWN_SKILL_PLATFORMS.filter((platform) => {
    try {
      return statSync(platformSkillsDir(platform, home)).isDirectory();
    } catch {
      return false;
    }
  }).map((platform) => ({ ...platform, skillsDir: platformSkillsDir(platform, home) }));
}

/** 按 id 精确解析平台；存在性由调用方按「目录是否存在」判断。未知 id 返回 null。 */
export function findSkillPlatform(id: string): SkillPlatform | null {
  const key = id.trim().toLowerCase();
  if (!key) return null;
  return KNOWN_SKILL_PLATFORMS.find((platform) => platform.id === key) ?? null;
}
