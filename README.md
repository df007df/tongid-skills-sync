# tongid-skills-sync

TongID 技能同步 CLI：买家在本地绑定机器授权码，按角色权限安装与更新技能包，并软连接到各 Agent 平台的技能目录。**零运行时依赖**，Node.js ≥ 18.20。

- 登录引导走平台 Hosted OAuth（PKCE + state），本机回调端口 `127.0.0.1:43175`；
- 授权完成后仅绑定本机机器授权码，登录会话随即丢弃；
- 技能清单与版本号以平台中心配置为准；版本变化时重新走「校验 → 领取下载凭据 → 拉取」；
- 下载**直连 GitHub**（`api.github.com/.../tarball/{ref}`），不经平台转发；
- **仓库格式**：支持两种格式——根目录 `SKILL.md`（单技能仓库），或根目录 `skills/` 目录（多技能集合仓库，`skills/<name>/SKILL.md` 每个子目录一个技能，安装后逐技能软连接）；两种都不满足（或 skills/ 下没有任何含 SKILL.md 的子目录）立即报错，不落任何安装。

## 安装

```bash
npm install -g tongid-skills-sync
# 或直接运行
npx tongid-skills-sync login --app <applicationId 或 slug>
```

## 应用绑定

目标应用（applicationId 或 slug）**只能在第一次登录时显式指定**，不传即报错：

```bash
tongid-skills-sync login --app <applicationId 或 slug>
```

登录成功后，默认应用与平台地址自动写入全局配置 `~/.tongid/skills-sync/config.json`（由本工具生成，不要手工创建、也不属于任何项目仓库），之后 `list` / `install` / `update` / `logout` 均可省略 `--app`；登出默认应用后该默认即被清除，下次登录需重新传入。

- 临时覆盖：命令行 `--app <id|slug>`、`--base-url <url>`（默认 `https://tongid.dev`；本地开发如 `--base-url http://localhost:3000`）
- 环境变量：`TONGID_SKILLS_APP`、`TONGID_BASE_URL`
- 优先级：命令行参数 > 环境变量 > 全局配置文件

登录成功后凭据写入 `~/.tongid/skills-sync/certificate/<app>.json`（每应用一个文件，多应用并存）。

## CLI

```bash
tongid-skills-sync login                # 打开平台登录并绑定本机机器授权码
tongid-skills-sync list                 # 可安装技能与最新版本（含已装版本比对）
tongid-skills-sync install <slug>       # 安装到 ~/.tongid/skills-sync/skills/<app>/<slug>/，并自动软链到本机已检测的平台技能目录
tongid-skills-sync update [slug]        # 按版本比对更新（不带 slug 更新全部；更新后自动软链）
tongid-skills-sync uninstall <slug>     # 删除已安装技能（安装目录、元数据与各平台软链）
tongid-skills-sync link [--platform x]  # 软连接已安装技能到平台技能目录（默认全部已检测平台）
tongid-skills-sync unlink [--platform x] # 移除平台技能目录中由本工具建立的软连接
tongid-skills-sync logout               # 解绑本机机器并删除本地凭据
```

## 技能统一目录、应用索引与多平台软连接

技能统一维护在**全局唯一目录** `~/.tongid/skills-sync/skills/<app>/<slug>/`（`--dir` 可覆盖根目录）。`<slug>/` 保持仓库快照原样，不写入任何工具文件；安装元数据（版本清单，含仓库形态与集合仓内部技能名）放在平级隐藏目录 `<app>/.skills-sync/<slug>.json`。每个应用名下另有 `index.json` **应用索引**，记录应用信息（app、baseUrl、updatedAt）与各技能的版本/ref/安装时间——读取时与磁盘自动对账（清单须与同名安装目录配对存在，手工增删会被索引感知并修正），`list` 据此显示「已装版本 → 可用版本」，`update` 按索引比对版本。

**跨应用同名约束**：软连接名是**技能名**（单技能仓 = `<slug>`，集合仓 = 内部技能名），同一技能名只允许属于一个应用——`install` 前置校验，其他应用已占用同名技能时直接报错拒绝（提示占用方与删除方法），不产生无法软连接的安装。

`link` 把已安装技能软连接到各平台的用户级技能目录：单技能仓链接名 = `<slug>`，集合仓按 `skills/<name>/` 逐技能展开（链接名 = 内部技能名，指向 `<app>/<slug>/skills/<name>`）。更新替换目录内容时路径不变，软连接自动跟随新版本；新版本中已不存在的技能名，其失效软链会在 `install`/`update` 成功后一并清理（外来条目一律不动）：

- 主动探测的平台目录：`~/.claude/skills`、`~/.cursor/skills`、`~/.codex/skills`、`~/.gemini/skills`、`~/.agents/skills`、`~/.zcode/skills`、`~/.config/opencode/skills`
- **只对目录已存在的平台做连接，绝不主动创建平台技能目录**
- `--platform <id>` 只处理指定平台；平台目录不存在时报错提示而不是创建
- 安全策略：同名条目若是本工具建立的链接则刷新；真实目录/文件或指向别处的链接一律跳过不覆盖；`unlink` 只移除本工具建立的链接

## 给 Agent 的提示词（可复制）

把下面整段发给你的 AI 编程助手（Claude Code / Codex / Cursor 等），它即可自行安装本 CLI 并完成后续同步。`<app>` 用你的应用 slug 或 applicationId 替换；也可以不替换，直接在对话里告诉它。

```text
请安装并配置 TongID 技能同步 CLI（tongid-skills-sync），按以下步骤执行；需要我在浏览器操作的步骤请先提醒我：

1. 确认 Node.js ≥ 18.20（node -v），不满足请先告诉我。
2. 检查 CLI 是否已安装（command -v tongid-skills-sync），未安装则执行：npm install -g tongid-skills-sync。
3. 执行 tongid-skills-sync login --app <app> 绑定本机（<app> 用我提供的应用 slug 或 applicationId 替换，必须显式传入，否则报错）：会自动打开平台登录页（打不开时把终端打印的链接发我），我在浏览器完成登录后 CLI 自动保存凭据并记录默认应用，需在 5 分钟内完成；之后所有命令都不用再传 --app。
4. 执行 tongid-skills-sync list，向我汇报可安装的技能、版本与已装状态。
5. 我指定技能后执行 tongid-skills-sync install <slug>。安装成功后自动软连接到本机已检测到的平台技能目录（只处理目录已存在的平台，不会创建目录；如需补链或指定平台可再执行 tongid-skills-sync link）。
6. 之后我要求更新技能时执行 tongid-skills-sync update（可带 slug 只更新一个），软连接自动跟随新版本，无需重新 link。
7. 我要求退出或换机时执行 tongid-skills-sync logout（解绑本机机器并删除本地凭据；默认应用同时被清除，下次登录需重新传 --app）。
```

本地联调时把 `baseUrl` 换成 `http://localhost:3000`，或用 `--base-url` 参数临时覆盖。

## 编程 API

```ts
import { loginMachine, saveCredential, fetchRegistry, installSkill, updateSkills } from 'tongid-skills-sync';

const credential = await loginMachine({ baseUrl: 'https://tongid.dev', app: 'my-skill-app' });
await saveCredential(credential);

const registry = await fetchRegistry({ baseUrl: credential.baseUrl, machineToken: credential.machineToken });
await updateSkills({ baseUrl: credential.baseUrl, machineToken: credential.machineToken, app: 'my-skill-app' });
```

## 机器授权

卖家可在平台后台「用户详情 → 机器授权码」随时解绑机器，解绑即时生效。

## 与平台协议的关系

`client_type=tongid-skills-sync`、回调路径 `/skills-sync/callback`、端口 43175 是与 TongID 平台的 OAuth 协议契约（标识「技能售卖机器授权」流程），两侧取值一致；平台侧对应实现在 tongid 仓 `lib/auth/skills-sync-oauth.ts`。
