# tongid-skills-sync

TongID 技能同步 CLI：买家在本地绑定机器授权码，按角色权限安装与更新技能包，并软连接到各 Agent 平台的技能目录。**零运行时依赖**，Node.js ≥ 18.20。

- 登录引导走平台 Hosted OAuth（PKCE + state），本机回调端口 `127.0.0.1:43175`；
- 授权码兑换为签名会话后**只做一件事**——绑定机器授权码（`t-` 前缀，仅返回一次），会话随即丢弃；
- 技能清单与版本号以平台中心配置为准；版本变化时重新走「校验 → 领取下载凭据 → 拉取」；
- 下载**直连 GitHub**（`api.github.com/.../tarball/{ref}`），不经平台转发；私有库令牌仅在安装函数栈内瞬时存在，不落盘、不进日志。

## 安装

```bash
npm install -g tongid-skills-sync
# 或直接运行
npx tongid-skills-sync login --app <applicationId 或 slug>
```

## 应用绑定（必填）

三种来源，优先级：命令行参数 > 项目配置文件 > 环境变量。

1. 命令行：`--app <id|slug>`、`--base-url <url>`（默认 `https://tongid.dev`）
2. `skills-sync.config.json`（项目根，可提交进仓库供团队共用）：

   ```json
   { "baseUrl": "https://tongid.dev", "app": "my-skill-app" }
   ```

3. 环境变量：`TONGID_SKILLS_APP`、`TONGID_BASE_URL`

登录成功后凭据写入 `~/.tongid/skills-sync/<app>.json`（每应用一个文件，多应用并存）。

## CLI

```bash
tongid-skills-sync login                # 打开平台登录并绑定本机机器授权码
tongid-skills-sync list                 # 可安装技能与最新版本（含已装版本比对）
tongid-skills-sync install <slug>       # 安装到 ~/.tongid/skills-sync/skills/<app>/<slug>/
tongid-skills-sync update [slug]        # 按版本比对更新（不带 slug 更新全部）
tongid-skills-sync link [--platform x]  # 软连接已安装技能到平台技能目录（默认全部已检测平台）
tongid-skills-sync unlink [--platform x] # 移除平台技能目录中由本工具建立的软连接
tongid-skills-sync logout               # 解绑本机机器并删除本地凭据
```

## 技能统一目录、应用索引与多平台软连接

技能统一维护在**全局唯一目录** `~/.tongid/skills-sync/skills/<app>/<slug>/`（`--dir` 可覆盖根目录）。每个技能带 `.skills-sync.json` 版本清单；每个应用名下另有 `index.json` **应用索引**，记录应用信息（app、baseUrl、updatedAt）与各技能的版本/ref/安装时间——读取时与磁盘自动对账（手工增删技能目录会被索引感知并修正），`list` 据此显示「已装版本 → 可用版本」，`update` 按索引比对版本。

**跨应用同名约束**：平台技能目录的软连接名只有 `<slug>`，因此同一 slug 只允许属于一个应用——`install` 前置校验，其他应用已占用同名 slug 时直接报错拒绝（提示占用方与删除方法），不产生无法软连接的安装。

`link` 把已安装技能以 slug 为名软连接到各平台的用户级技能目录，链接指向 `<app>/<slug>` 的绝对路径，更新技能后软连接自动跟随新版本：

- 主动探测的平台目录：`~/.claude/skills`、`~/.cursor/skills`、`~/.codex/skills`、`~/.gemini/skills`、`~/.agents/skills`、`~/.zcode/skills`、`~/.config/opencode/skills`
- **只对目录已存在的平台做连接，绝不主动创建平台技能目录**
- `--platform <id>` 只处理指定平台；平台目录不存在时报错提示而不是创建
- 安全策略：同名条目若是本工具建立的链接则刷新；真实目录/文件或指向别处的链接一律跳过不覆盖；`unlink` 只移除本工具建立的链接

## 编程 API

```ts
import { loginMachine, saveCredential, fetchRegistry, installSkill, updateSkills } from 'tongid-skills-sync';

const credential = await loginMachine({ baseUrl: 'https://tongid.dev', app: 'my-skill-app' });
await saveCredential(credential);

const registry = await fetchRegistry({ baseUrl: credential.baseUrl, machineToken: credential.machineToken });
await updateSkills({ baseUrl: credential.baseUrl, machineToken: credential.machineToken, app: 'my-skill-app' });
```

## 安全说明

- 机器授权码明文只出现在 `loginMachine` 的返回值与本地凭据文件（0600）中；
- 私有库下载令牌由平台瞬时下发、CLI 下载完成即弃（存在于函数栈内，绝不写盘）；令牌在下载瞬间会出现在本机内存中，这是「直连 GitHub」方案的已知取舍；
- 卖家可在平台后台「用户详情 → 机器授权码」随时解绑机器，解绑即时生效。

## 与平台协议的关系

`client_type=tongid-skills-sync`、回调路径 `/skills-sync/callback`、端口 43175 是与 TongID 平台的 OAuth 协议契约（标识「技能售卖机器授权」流程），两侧取值一致；平台侧对应实现在 tongid 仓 `lib/auth/skills-sync-oauth.ts`。
