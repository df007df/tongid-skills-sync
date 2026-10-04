#!/usr/bin/env node
import { clearDefaultApp, resolveSkillsPayConfig, writeGlobalConfig, SkillsPayConfigError } from './config.js';
import { loginMachine, SkillsPayLoginError } from './auth.js';
import { fetchRegistry, revokeCurrentMachine, SkillsPayApiError } from './api.js';
import { DEFAULT_SKILLS_DIR, installSkill, planUpdate, readAppIndex, skillInstallDir, updateSkills, type InstallResult } from './install.js';
import { deleteCredential, loadCredential, saveCredential } from './store.js';
import { detectSkillPlatforms, findSkillPlatform, platformSkillsDir } from './platforms.js';
import { linkSkillsToPlatform, unlinkSkillsFromPlatform } from './link.js';
import os from 'node:os';

/** 手写参数解析（零依赖）：tongid-skills-sync <command> [args] [--app x] [--base-url x] [--dir x] [--label x] [--platform x] */

type ParsedArgs = {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const valueFlags = new Set(['app', 'base-url', 'dir', 'label', 'platform']);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (valueFlags.has(key)) {
        const value = rest[i + 1];
        if (!value || value.startsWith('--')) {
          fail(`--${key} 需要一个值`);
        }
        flags[key] = value;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function flagValue(flags: Record<string, string | boolean>, key: string): string | null {
  const value = flags[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function requireCredential(options: {
  app?: string | null;
  baseUrl?: string | null;
}): Promise<{ baseUrl: string; app: string; machineToken: string }> {
  const config = await resolveSkillsPayConfig({
    cliApp: options.app,
    cliBaseUrl: options.baseUrl,
  });
  const credential = await loadCredential(config.app);
  if (!credential) {
    fail(`应用 ${config.app} 尚未登录，请先执行：tongid-skills-sync login --app ${config.app}`);
  }
  return {
    baseUrl: options.baseUrl?.trim() || credential.baseUrl,
    app: config.app,
    machineToken: credential.machineToken,
  };
}

function printApiError(error: unknown): void {
  if (error instanceof SkillsPayApiError) {
    const hint = error.reloginRequired ? '\n机器授权已失效，请重新执行 tongid-skills-sync login。' : '';
    fail(`${error.message}${hint}`);
  }
  throw error;
}

/** update 后打印被清理的失效软链（新版已不包含的技能）。 */
function printPrunedLinks(result: InstallResult): void {
  if (result.pruned.length > 0) {
    process.stdout.write(`  已移除失效软链（新版已不包含）：${result.pruned.join('、')}\n`);
  }
}

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  switch (command) {
    case 'login': {
      const config = await resolveSkillsPayConfig({
        cliApp: flagValue(flags, 'app'),
        cliBaseUrl: flagValue(flags, 'base-url'),
      });
      const credential = await loginMachine({
        baseUrl: config.baseUrl,
        app: config.app,
        label: flagValue(flags, 'label') ?? undefined,
      });
      const file = await saveCredential(credential);
      const configFile = await writeGlobalConfig({ app: config.app, baseUrl: config.baseUrl });
      process.stdout.write(
        `已绑定机器：${credential.label ?? '本机'}（${credential.machineToken.slice(0, 8)}…）\n` +
          `凭据已保存：${file}\n` +
          `默认应用已记录（${configFile}），后续命令可省略 --app\n`,
      );
      break;
    }

    case 'list': {
      const ctx = await requireCredential({
        app: flagValue(flags, 'app'),
        baseUrl: flagValue(flags, 'base-url'),
      });
      try {
        const registry = await fetchRegistry({ baseUrl: ctx.baseUrl, machineToken: ctx.machineToken });
        const skillsDir = flagValue(flags, 'dir') ?? DEFAULT_SKILLS_DIR;
        const index = await readAppIndex(skillsDir, ctx.app);
        process.stdout.write(`应用 ${ctx.app} · 角色：${registry.roles.join(', ') || '—'}\n`);
        if (registry.skills.length === 0) {
          process.stdout.write('暂无可用技能（购买对应套餐后自动获得）\n');
          break;
        }
        for (const skill of registry.skills) {
          const installed = index.skills[skill.slug];
          const versionLabel = installed
            ? installed.version === skill.version
              ? `v${skill.version}（已装）`
              : `v${installed.version} → v${skill.version}`
            : `v${skill.version}（未安装）`;
          process.stdout.write(
            `  ${skill.slug.padEnd(24)} ${versionLabel.padEnd(26)} ${skill.isPrivate ? '[私有]' : '[公开]'} ${skill.name}\n`,
          );
        }
      } catch (error) {
        printApiError(error);
      }
      break;
    }

    case 'install': {
      const slug = positional[0];
      if (!slug) fail('用法：tongid-skills-sync install <slug>');
      const ctx = await requireCredential({
        app: flagValue(flags, 'app'),
        baseUrl: flagValue(flags, 'base-url'),
      });
      try {
        const result = await installSkill({
          baseUrl: ctx.baseUrl,
          machineToken: ctx.machineToken,
          app: ctx.app,
          slug,
          skillsDir: flagValue(flags, 'dir') ?? DEFAULT_SKILLS_DIR,
        });
        const detail =
          result.kind === 'collection'
            ? `${result.files} 个文件，集合仓含 ${result.skills.length} 个技能：${result.skills.join('、')}`
            : `${result.files} 个文件`;
        process.stdout.write(
          `已安装 ${result.slug} v${result.version}（${detail}）→ ${skillInstallDir(flagValue(flags, 'dir') ?? DEFAULT_SKILLS_DIR, ctx.app, result.slug)}\n`,
        );
        printPrunedLinks(result);
      } catch (error) {
        printApiError(error);
      }
      break;
    }

    case 'update': {
      const ctx = await requireCredential({
        app: flagValue(flags, 'app'),
        baseUrl: flagValue(flags, 'base-url'),
      });
      const skillsDir = flagValue(flags, 'dir') ?? DEFAULT_SKILLS_DIR;
      const only = positional[0] ?? null;
      try {
        if (only) {
          const plan = await planUpdate({ baseUrl: ctx.baseUrl, machineToken: ctx.machineToken, app: ctx.app, skillsDir });
          const target = plan.registry.skills.find((skill) => skill.slug === only);
          if (!target) fail(`技能 ${only} 不在你的可用清单中`);
          const outdatedEntry = plan.outdated.find((item) => item.slug === only);
          if (!outdatedEntry) {
            process.stdout.write(`${only} 已是最新版本 v${target.version}\n`);
            break;
          }
          const result = await installSkill({
            baseUrl: ctx.baseUrl,
            machineToken: ctx.machineToken,
            app: ctx.app,
            slug: only,
            skillsDir,
          });
          process.stdout.write(
            `${result.slug} ${outdatedEntry.from ? `v${outdatedEntry.from} → ` : ''}v${result.version} 更新完成\n`,
          );
          printPrunedLinks(result);
          break;
        }

        const results = await updateSkills({ baseUrl: ctx.baseUrl, machineToken: ctx.machineToken, app: ctx.app, skillsDir });
        if (results.length === 0) {
          process.stdout.write('全部技能均为最新版本\n');
        } else {
          for (const result of results) {
            process.stdout.write(`${result.slug} → v${result.version}（${result.files} 个文件）\n`);
            printPrunedLinks(result);
          }
        }
      } catch (error) {
        printApiError(error);
      }
      break;
    }

    case 'logout': {
      const config = await resolveSkillsPayConfig({
        cliApp: flagValue(flags, 'app'),
        cliBaseUrl: flagValue(flags, 'base-url'),
      });
      const credential = await loadCredential(config.app);
      if (!credential) {
        process.stdout.write(`应用 ${config.app} 本机未登录\n`);
        break;
      }
      try {
        await revokeCurrentMachine({ baseUrl: credential.baseUrl, machineToken: credential.machineToken });
      } catch (error) {
        // 已撤销/失效的机器码同样删除本地凭据
        if (!(error instanceof SkillsPayApiError) || !error.reloginRequired) {
          printApiError(error);
        }
      }
      await deleteCredential(config.app);
      await clearDefaultApp(config.app);
      process.stdout.write(`应用 ${config.app} 已解绑本机机器并删除本地凭据\n`);
      break;
    }

    case 'link':
    case 'unlink': {
      const linking = command === 'link';
      const skillsDir = flagValue(flags, 'dir') ?? DEFAULT_SKILLS_DIR;
      const home = os.homedir();
      const detected = detectSkillPlatforms(home);

      const requested = flagValue(flags, 'platform');
      let targets: typeof detected;
      if (requested) {
        const platform = findSkillPlatform(requested);
        if (!platform) {
          fail(`未知平台 ${requested}；支持：${detected.map((item) => item.id).join(', ') || '（未检测到任何平台技能目录）'}`);
        }
        const skillsDirAbs = platformSkillsDir(platform, home);
        if (!detected.some((item) => item.id === platform.id)) {
          fail(`未检测到 ${platform.label} 的技能目录（${skillsDirAbs}）；不会主动创建，请先安装对应平台或手动建目录`);
        }
        targets = detected.filter((item) => item.id === platform.id);
      } else {
        targets = detected;
      }

      if (targets.length === 0) {
        process.stdout.write('未检测到任何平台的技能目录（~/.claude/skills 等），无可连接目标；不会主动创建平台目录\n');
        break;
      }

      for (const platform of targets) {
        if (linking) {
          const outcomes = await linkSkillsToPlatform({ platformSkillsDir: platform.skillsDir, skillsDir });
          if (outcomes.length === 0) {
            process.stdout.write(`${platform.label}（~/${platform.dir}）：统一目录中暂无已安装技能，先执行 install\n`);
            continue;
          }
          process.stdout.write(`${platform.label}（~/${platform.dir}）：\n`);
          for (const item of outcomes) {
            const label =
              item.status === 'linked' ? '已连接'
              : item.status === 'refreshed' ? '已刷新'
              : item.status === 'skipped-exists' ? `跳过（${item.note ?? '同名条目已存在'}，不覆盖）`
              : `跳过（${item.note ?? '未安装'}）`;
            process.stdout.write(`  ${item.slug.padEnd(24)} ${label}\n`);
          }
        } else {
          const outcomes = await unlinkSkillsFromPlatform({ platformSkillsDir: platform.skillsDir, skillsDir });
          if (outcomes.length === 0) {
            process.stdout.write(`${platform.label}（~/${platform.dir}）：统一目录中暂无已安装技能\n`);
            continue;
          }
          const removed = outcomes.filter((item) => item.status === 'removed');
          if (removed.length === 0) {
            process.stdout.write(`${platform.label}（~/${platform.dir}）：无本工具建立的连接\n`);
            continue;
          }
          process.stdout.write(`${platform.label}（~/${platform.dir}）：\n`);
          for (const item of outcomes) {
            if (item.status === 'removed') {
              process.stdout.write(`  ${item.slug.padEnd(24)} 已移除连接\n`);
            } else if (item.status === 'kept-foreign') {
              process.stdout.write(`  ${item.slug.padEnd(24)} 保留（非本工具建立的链接）\n`);
            }
          }
        }
      }
      break;
    }

    default:
      process.stdout.write(
        [
          'TongID 技能同步 CLI（tongid-skills-sync）',
          '',
          '用法：tongid-skills-sync <command> [options]',
          '',
          '命令：',
          '  login                打开平台登录并绑定本机机器授权码',
          '  list                 列出当前可安装的技能与最新版本',
          '  install <slug>       安装技能包（根 SKILL.md 单技能仓，或根 skills/ 目录的多技能集合仓）',
          '  update [slug]        更新技能包（不带 slug 更新全部）',
          '  link [--platform x]  软连接已安装技能到平台技能目录（集合仓按内部技能逐个连接；默认全部已检测平台）',
          '  unlink [--platform x] 移除平台技能目录中由本工具建立的软连接',
          '  logout               解绑本机机器授权码并删除本地凭据',
          '',
          '选项：',
          '  --app <id|slug>      目标应用（第一次 login 必传；之后默认取上次登录的应用，或用 TONGID_SKILLS_APP）',
          '  --base-url <url>     平台地址（本地开发如 http://localhost:3000；默认 https://tongid.dev）',
          '  --dir <path>         技能统一目录（默认 ~/.tongid/skills-sync/skills/<app>/<slug>，全局唯一；跨应用同名技能——含集合仓内部技能名——安装会被拒绝）',
          '  --label <name>       机器备注名（默认 hostname）',
          '  --platform <id>      平台：claude/cursor/codex/gemini/agents/zcode/opencode；只连接目录已存在的平台，不主动创建',
        ].join('\n'),
      );
      process.stdout.write('\n');
      break;
  }
}

main().catch((error: unknown) => {
  if (error instanceof SkillsPayConfigError) {
    fail(error.message);
  }
  if (error instanceof SkillsPayLoginError) {
    fail(error.message);
  }
  if (error instanceof SkillsPayApiError) {
    fail(error.message);
  }
  fail(error instanceof Error ? error.message : String(error));
});
