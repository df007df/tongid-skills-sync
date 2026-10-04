/**
 * tongid-skills-sync — TongID 技能同步 CLI 与编程 API
 *
 * 买家在本地绑定机器授权码并安装角色绑定的技能包：
 * - loginMachine：打开平台登录（PKCE）→ 兑换授权码 → 绑定机器，返回机器码（明文仅此一次）
 * - fetchRegistry / installSkill / updateSkills：技能清单、安装与按版本比对更新
 * - linkSkillsToPlatform / unlinkSkillsFromPlatform：多平台技能目录软连接
 * - revokeCurrentMachine：解绑当前机器
 *
 * 下载流量直连 GitHub（平台只发放地址+瞬时令牌）；私有库令牌仅在安装函数栈内存在，
 * 不落盘、不进日志。零运行时依赖，可全局安装独立使用。
 */

export {
  DEFAULT_BASE_URL,
  PROJECT_CONFIG_FILENAME,
  ENV_APP,
  ENV_BASE_URL,
  resolveSkillsPayConfig,
  readProjectConfig,
  normalizeBaseUrl,
  SkillsPayConfigError,
  type SkillsPayConfig,
} from './config.js';

export {
  loginMachine,
  DEFAULT_CALLBACK_PORT,
  CALLBACK_PATH,
  SKILLS_SYNC_CLIENT_TYPE,
  SkillsPayLoginError,
  type LoginMachineOptions,
} from './auth.js';

export {
  fetchRegistry,
  fetchDownloadGrant,
  revokeCurrentMachine,
  SkillsPayApiError,
  type RegistryEntry,
  type RegistryPayload,
  type DownloadGrantPayload,
} from './api.js';

export {
  installSkill,
  updateSkills,
  planUpdate,
  readInstalledManifest,
  readAppIndex,
  writeAppIndex,
  findCrossAppSlugHolder,
  skillInstallDir,
  DEFAULT_SKILLS_DIR,
  MANIFEST_FILENAME,
  APP_INDEX_FILENAME,
  SkillsPayInstallError,
  type InstallResult,
  type InstalledManifest,
  type AppIndex,
  type AppIndexSkill,
  type UpdatePlan,
} from './install.js';

export {
  KNOWN_SKILL_PLATFORMS,
  detectSkillPlatforms,
  findSkillPlatform,
  platformSkillsDir,
  type SkillPlatform,
} from './platforms.js';

export {
  linkSkillsToPlatform,
  unlinkSkillsFromPlatform,
  listManagedSkills,
  type LinkOutcome,
  type LinkStatus,
  type UnlinkOutcome,
  type ManagedSkill,
} from './link.js';

export {
  saveCredential,
  loadCredential,
  deleteCredential,
  listCredentials,
  defaultStoreDir,
  defaultSkillsDir,
  type MachineCredential,
} from './store.js';
