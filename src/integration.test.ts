import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loginMachine, SkillsPayLoginError } from './auth.js';
import { installSkill, planUpdate, readInstalledManifest } from './install.js';
import type { MachineCredential } from './store.js';

/**
 * 用本地 http 服务器模拟平台（oauth/token + machines + registry + grant）
 * 与 GitHub tarball 下载，跑通 login → install → update 全链路。
 */

const registryBody = {
  data: {
    applicationId: 'app_1',
    skills: [
      { slug: 'pro-tool', name: 'Pro Tool', description: null, version: '1.4.0', isPrivate: true, repoUrl: 'https://github.com/acme/pro-tool', updatedAt: '2026-10-04T00:00:00Z' },
    ],
    roles: ['pro'],
    machineLimit: 3,
  },
  error: null,
};

const grantBody = (version: string, token: string | null) => ({
  data: {
    slug: 'pro-tool',
    name: 'Pro Tool',
    version,
    ref: `v${version}`,
    url: `${githubUrl}/repos/acme/pro-tool/tarball/v${version}`,
    token,
    tokenHint: token ? '****abcd' : null,
    authorization: token ? `Bearer ${token}` : null,
  },
  error: null,
});

function tarGz(version: string): Buffer {
  const header = Buffer.alloc(512);
  header.write(`pro-tool-${version}/SKILL.md`, 0, 100, 'utf8');
  const content = Buffer.from(`# pro-tool ${version}\n`, 'utf8');
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return gzipSync(Buffer.concat([header, content, padding, Buffer.alloc(1024)]));
}

/** 集合仓形态：根目录有 skills/ 目录，技能在子目录里（按传入名单生成） */
function tarGzCollectionRepoWith(names: string[]): Buffer {
  const chunks: Buffer[] = [];
  const entry = (name: string, content: Buffer) => {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    chunks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  };
  entry('repo-x/README.md', Buffer.from('# collection\n'));
  for (const name of names) {
    entry(`repo-x/skills/${name}/SKILL.md`, Buffer.from(`# ${name}\n`));
  }
  entry('repo-x/skills/not-a-skill/notes.txt', Buffer.from('skip me\n'));
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

function tarGzCollectionRepo(): Buffer {
  return tarGzCollectionRepoWith(['inner-tool', 'second-tool']);
}

/** 完全不合规形态：根目录既没有 SKILL.md 也没有 skills/ 目录 */
function tarGzBadRepo(): Buffer {
  const chunks: Buffer[] = [];
  const entry = (name: string, content: Buffer) => {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
    header.write('0', 156, 1, 'ascii');
    header.write('ustar\0', 257, 6, 'ascii');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    chunks.push(header, content, Buffer.alloc((512 - (content.length % 512)) % 512));
  };
  entry('repo-x/README.md', Buffer.from('# nothing here\n'));
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
}

type PlatformState = {
  skillVersion: string;
  grantToken: string | null;
  exchangedAuthorizationHeader: string | null;
  machineAuthorizationHeader: string | null;
  sawGithubToken: string | null;
};

let state: PlatformState;
let platform: http.Server;
let platformUrl: string;
let github: http.Server;
let githubUrl: string;
let skillsDir: string;

beforeAll(async () => {
  platform = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://platform.local');
    if (request.method === 'POST' && url.pathname === '/api/v1/oauth/token') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: { access_token: 'signed-session-1' }, error: null }));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/v1/skills/machines') {
      state.machineAuthorizationHeader = request.headers.authorization ?? null;
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: {
            machineToken: 't-mock-machine-token',
            machine: { id: 'm_1', createdAt: '2026-10-04T00:00:00.000Z' },
            machineLimit: 3,
            activeCount: 1,
          },
          error: null,
        }),
      );
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/v1/skills/registry') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(registryBody));
      return;
    }
    const grantMatch = url.pathname.match(/^\/api\/v1\/skills\/([^/]+)\/download-grant$/);
    if (request.method === 'POST' && grantMatch) {
      state.exchangedAuthorizationHeader = request.headers.authorization ?? null;
      const slug = decodeURIComponent(grantMatch[1] ?? 'pro-tool');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: { ...grantBody(state.skillVersion, state.grantToken).data, slug },
          error: null,
        }),
      );
      return;
    }
    response.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => platform.listen(0, '127.0.0.1', resolve));
  platformUrl = `http://127.0.0.1:${(platform.address() as AddressInfo).port}`;

  github = http.createServer((request, response) => {
    state.sawGithubToken = (request.headers.authorization as string | undefined) ?? null;
    response.writeHead(200, { 'content-type': 'application/gzip' });
    response.end(tarGz(state.skillVersion));
  });
  await new Promise<void>((resolve) => github.listen(0, '127.0.0.1', resolve));
  githubUrl = `http://127.0.0.1:${(github.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => platform.close(() => resolve()));
  await new Promise<void>((resolve) => github.close(() => resolve()));
});

beforeEach(async () => {
  state = {
    skillVersion: '1.4.0',
    grantToken: 'github_pat_secret',
    exchangedAuthorizationHeader: null,
    machineAuthorizationHeader: null,
    sawGithubToken: null,
  };
  skillsDir = await mkdtemp(path.join(os.tmpdir(), 'skills-sync-install-'));
});

afterEach(async () => {
  await rm(skillsDir, { recursive: true, force: true });
});

function loginOptions(openBrowser?: (url: string) => void) {
  return {
    baseUrl: platformUrl,
    app: 'app_1',
    callbackPort: 43175 + Math.floor(Math.random() * 200),
    openBrowser,
    fetchImpl: fetch,
  };
}

describe('loginMachine', () => {
  it('walks the full login → exchange → machine-bind flow', async () => {
    let loginUrl = '';
    const credentialPromise = loginMachine({
      ...loginOptions((url) => {
        loginUrl = url;
      }),
    });

    // 等回调服务就绪后，模拟浏览器回跳
    await vi.waitFor(() => {
      if (!loginUrl) throw new Error('login url not opened yet');
    });

    const parsed = new URL(loginUrl);
    expect(parsed.pathname).toBe('/auth/login');
    expect(parsed.searchParams.get('applicationId')).toBe('app_1');
    const redirect = parsed.searchParams.get('redirect') ?? '';
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/skills-sync\/callback$/);
    expect(parsed.searchParams.get('code_challenge')).toBeTruthy();

    const callbackResponse = await fetch(
      `${redirect}?code=handoff-code-1&state=${encodeURIComponent(parsed.searchParams.get('state') ?? '')}`,
    );
    expect(callbackResponse.status).toBe(200);

    const credential: MachineCredential = await credentialPromise;
    expect(credential.machineToken).toBe('t-mock-machine-token');
    expect(credential.app).toBe('app_1');
    expect(credential.label).toBeTruthy();
    expect(state.machineAuthorizationHeader).toBe('Bearer signed-session-1');
  }, 15_000);

  it('rejects state mismatches from the callback', async () => {
    let loginUrl = '';
    const credentialPromise = loginMachine({
      ...loginOptions((url) => {
        loginUrl = url;
      }),
      label: 'test-laptop',
    });

    await vi.waitFor(() => {
      if (!loginUrl) throw new Error('login url not opened yet');
    });
    const parsed = new URL(loginUrl);
    const redirect = parsed.searchParams.get('redirect') ?? '';

    // 先挂好 rejection 断言再触发回调，避免 unhandled rejection
    const rejection = expect(credentialPromise).rejects.toBeInstanceOf(SkillsPayLoginError);
    const response = await fetch(`${redirect}?code=handoff-code-1&state=tampered`);
    expect(response.status).toBe(400);
    await rejection;
  }, 15_000);
});

describe('installSkill / planUpdate', () => {
  it('installs via grant, downloads direct from github with the transient token, and writes a manifest', async () => {
    // grant 由 mock 平台签发（url 指向 mock github）；fetchImpl 充当 GitHub，记录直连请求头
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(githubUrl)) {
        const headers = init?.headers as Record<string, string> | undefined;
        state.sawGithubToken = headers?.authorization ?? null;
        return new Response(new Uint8Array(tarGz('1.4.0')), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await installSkill({
      baseUrl: platformUrl,
      machineToken: 't-mock-machine-token',
      app: 'app_1',
      slug: 'pro-tool',
      skillsDir,
      fetchImpl,
    });

    expect(result).toEqual({
      slug: 'pro-tool',
      version: '1.4.0',
      files: expect.any(Number),
      kind: 'single',
      skills: [],
      pruned: [],
    });
    // 两层布局：<root>/<app>/<slug>，且应用索引登记了版本
    const manifest = await readInstalledManifest('app_1', 'pro-tool', skillsDir);
    expect(manifest).toMatchObject({ slug: 'pro-tool', version: '1.4.0', ref: 'v1.4.0' });
    await expect(
      readFile(path.join(skillsDir, 'app_1', 'pro-tool', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('pro-tool 1.4.0');
    // 安装目录保持仓库快照原样（无任何工具文件）；元数据在平级隐藏目录
    await expect(readdir(path.join(skillsDir, 'app_1', 'pro-tool'))).resolves.toEqual(['SKILL.md']);
    await expect(
      readFile(path.join(skillsDir, 'app_1', '.skills-sync', 'pro-tool.json'), 'utf8'),
    ).resolves.toContain('"version": "1.4.0"');
    const { readAppIndex } = await import('./install.js');
    const index = await readAppIndex(skillsDir, 'app_1');
    expect(index.skills['pro-tool']).toMatchObject({ version: '1.4.0' });
    expect(index.app).toBe('app_1');
    // GitHub 直连请求确实携带了瞬时令牌
    expect(state.sawGithubToken).toBe('Bearer github_pat_secret');
  }, 15_000);

  it('emits install progress events: grant → download bytes → extract', async () => {
    const archive = tarGz('1.4.0');
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(githubUrl)) {
        return new Response(new Uint8Array(archive), {
          status: 200,
          headers: { 'content-length': String(archive.byteLength) },
        });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const events: Array<{ phase: string; received?: number; total?: number | null }> = [];
    await installSkill({
      baseUrl: platformUrl,
      machineToken: 't-mock-machine-token',
      app: 'app_1',
      slug: 'pro-tool',
      skillsDir,
      fetchImpl,
      onProgress: (event) => events.push(event),
    });

    expect(events[0]?.phase).toBe('grant');
    const downloads = events.filter((e) => e.phase === 'download');
    expect(downloads.length).toBeGreaterThan(0);
    expect(downloads[downloads.length - 1]?.received).toBe(archive.byteLength);
    expect(downloads.every((e) => e.total === archive.byteLength)).toBe(true);
    expect(events[events.length - 1]?.phase).toBe('extract');
  }, 15_000);

  it('installs collection repos (root skills/ dir) with per-skill layout and manifest kind', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(githubUrl)) {
        return new Response(new Uint8Array(tarGzCollectionRepo()), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const result = await installSkill({
      baseUrl: platformUrl,
      machineToken: 't-mock-machine-token',
      app: 'app_1',
      slug: 'pro-tool',
      skillsDir,
      fetchImpl,
    });

    // 集合仓：kind=collection，内部技能名即软连接名（无 SKILL.md 的子目录不算技能）
    expect(result).toEqual({
      slug: 'pro-tool',
      version: '1.4.0',
      files: expect.any(Number),
      kind: 'collection',
      skills: ['inner-tool', 'second-tool'],
      pruned: [],
    });

    const manifest = await readInstalledManifest('app_1', 'pro-tool', skillsDir);
    expect(manifest).toMatchObject({
      slug: 'pro-tool',
      version: '1.4.0',
      ref: 'v1.4.0',
      kind: 'collection',
      skills: ['inner-tool', 'second-tool'],
    });
    await expect(
      readFile(path.join(skillsDir, 'app_1', 'pro-tool', 'skills', 'inner-tool', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('# inner');
    await expect(
      readFile(path.join(skillsDir, 'app_1', 'pro-tool', 'skills', 'second-tool', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('# second');
    const { readAppIndex } = await import('./install.js');
    const index = await readAppIndex(skillsDir, 'app_1');
    expect(index.skills['pro-tool']).toMatchObject({ version: '1.4.0', kind: 'collection', skills: ['inner-tool', 'second-tool'] });
  }, 15_000);

  it('rejects repos with neither a root SKILL.md nor a usable skills/ directory', async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(githubUrl)) {
        return new Response(new Uint8Array(tarGzBadRepo()), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      installSkill({
        baseUrl: platformUrl,
        machineToken: 't-mock-machine-token',
        app: 'app_1',
        slug: 'pro-tool',
        skillsDir,
        fetchImpl,
      }),
    ).rejects.toThrow(/既没有 SKILL\.md，也没有包含技能的 skills\/ 目录/);

    // 报错后不落任何安装目录，索引也不登记
    const { stat } = await import('node:fs/promises');
    await expect(stat(path.join(skillsDir, 'app_1', 'pro-tool'))).rejects.toThrow();
    const { readAppIndex } = await import('./install.js');
    const index = await readAppIndex(skillsDir, 'app_1');
    expect(index.skills['pro-tool']).toBeUndefined();
  }, 15_000);

  it('prunes platform links for inner skills removed by a collection update, keeping foreign entries', async () => {
    const { mkdir, rm: rmPath, symlink, lstat, readlink } = await import('node:fs/promises');
    // 临时 home + 假 zcode 平台目录，平台探测与软链清理都不碰真实机器
    const home = await mkdtemp(path.join(os.tmpdir(), 'skills-sync-home-'));
    const platformDir = path.join(home, '.zcode', 'skills');
    await mkdir(platformDir, { recursive: true });

    try {
      let tar = tarGzCollectionRepoWith(['inner-tool', 'second-tool', 'third-tool']);
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(githubUrl)) {
          return new Response(new Uint8Array(tar), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }) as unknown as typeof fetch;

      const install = () =>
        installSkill({
          baseUrl: platformUrl,
          machineToken: 't-mock-machine-token',
          app: 'app_1',
          slug: 'pro-tool',
          skillsDir,
          homeDir: home,
          fetchImpl,
        });

      const first = await install();
      expect(first.skills).toEqual(['inner-tool', 'second-tool', 'third-tool']);
      expect(first.pruned).toEqual([]);

      // 建好本工具链接，再把 second-tool 的链接换成外来的（指向别处）
      const { linkSkillsToPlatform } = await import('./link.js');
      await linkSkillsToPlatform({ platformSkillsDir: platformDir, skillsDir });
      await rmPath(path.join(platformDir, 'second-tool'), { force: true });
      await symlink('/tmp/elsewhere', path.join(platformDir, 'second-tool'));

      // 更新：新版只保留 second-tool → inner-tool/third-tool 的本工具链接应被清理
      tar = tarGzCollectionRepoWith(['second-tool']);
      const updated = await install();
      expect(updated.skills).toEqual(['second-tool']);
      expect(updated.pruned).toEqual(['zcode/inner-tool', 'zcode/third-tool']);

      await expect(lstat(path.join(platformDir, 'inner-tool'))).rejects.toThrow();
      await expect(lstat(path.join(platformDir, 'third-tool'))).rejects.toThrow();
      // 保留的技能链接不动；外来链接（即使名字已从新版移除）也不动
      const kept = await lstat(path.join(platformDir, 'second-tool'));
      expect(kept.isSymbolicLink()).toBe(true);
      await expect(readlink(path.join(platformDir, 'second-tool'))).resolves.toBe('/tmp/elsewhere');
    } finally {
      await rmPath(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('migrates legacy in-dir manifests on update: prunes stale links and relocates metadata', async () => {
    const { rm: rmPath, symlink, lstat, stat } = await import('node:fs/promises');
    const home = await mkdtemp(path.join(os.tmpdir(), 'skills-sync-home-'));
    const platformDir = path.join(home, '.zcode', 'skills');
    await mkdir(platformDir, { recursive: true });

    try {
      // ≤0.1.x 布局：清单在安装目录内（kind=collection，含 inner-tool/third-tool）
      const legacyDir = path.join(skillsDir, 'app_1', 'pro-tool');
      await mkdir(path.join(legacyDir, 'skills', 'inner-tool'), { recursive: true });
      await mkdir(path.join(legacyDir, 'skills', 'third-tool'), { recursive: true });
      await writeFile(
        path.join(legacyDir, '.skills-sync.json'),
        JSON.stringify({
          slug: 'pro-tool',
          version: '0.9.0',
          ref: 'v0.9.0',
          installedAt: '2026-10-04T00:00:00Z',
          kind: 'collection',
          skills: ['inner-tool', 'third-tool'],
        }),
      );

      // 旧布局时代建好的软链（新版本索引已不识别旧清单，软链是手工存在物）
      await symlink(path.join(legacyDir, 'skills', 'inner-tool'), path.join(platformDir, 'inner-tool'));
      await symlink(path.join(legacyDir, 'skills', 'third-tool'), path.join(platformDir, 'third-tool'));

      let tar = tarGzCollectionRepoWith(['inner-tool']);
      const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith(githubUrl)) {
          return new Response(new Uint8Array(tar), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      }) as unknown as typeof fetch;

      // update：经 legacy 清单回读得知旧软链单元，third-tool 已不在新版中 → 清理
      const updated = await installSkill({
        baseUrl: platformUrl,
        machineToken: 't-mock-machine-token',
        app: 'app_1',
        slug: 'pro-tool',
        skillsDir,
        homeDir: home,
        fetchImpl,
      });
      expect(updated.skills).toEqual(['inner-tool']);
      expect(updated.pruned).toEqual(['zcode/third-tool']);

      // 保留技能的链接指向路径不变，仍然可用
      const kept = await lstat(path.join(platformDir, 'inner-tool'));
      expect(kept.isSymbolicLink()).toBe(true);
      await expect(lstat(path.join(platformDir, 'third-tool'))).rejects.toThrow();

      // 旧清单随目录替换消失；新清单落在元数据目录
      await expect(stat(path.join(legacyDir, '.skills-sync.json'))).rejects.toThrow();
      const manifest = await readInstalledManifest('app_1', 'pro-tool', skillsDir);
      expect(manifest).toMatchObject({ slug: 'pro-tool', version: '1.4.0', kind: 'collection' });
    } finally {
      await rmPath(home, { recursive: true, force: true });
    }
  }, 15_000);

  it('rejects collection inner skill names already installed by another app, before writing anything', async () => {
    // other-app 已安装单技能 inner-tool（与集合仓内部技能同名）
    await mkdir(path.join(skillsDir, 'other-app', 'inner-tool'), { recursive: true });
    await mkdir(path.join(skillsDir, 'other-app', '.skills-sync'), { recursive: true });
    await writeFile(
      path.join(skillsDir, 'other-app', '.skills-sync', 'inner-tool.json'),
      JSON.stringify({ slug: 'inner-tool', version: '0.1.0', ref: 'v0.1.0', installedAt: '2026-10-04T00:00:00Z' }),
    );

    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith(githubUrl)) {
        return new Response(new Uint8Array(tarGzCollectionRepo()), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    // 内部技能名解包后才可知：占用校验发生在落盘前
    await expect(
      installSkill({
        baseUrl: platformUrl,
        machineToken: 't-mock-machine-token',
        app: 'app_1',
        slug: 'pro-tool',
        skillsDir,
        fetchImpl,
      }),
    ).rejects.toThrow(/inner-tool[\s\S]*other-app[\s\S]*无法软连接/);

    const { stat } = await import('node:fs/promises');
    await expect(stat(path.join(skillsDir, 'app_1', 'pro-tool'))).rejects.toThrow();
    const { readAppIndex } = await import('./install.js');
    const index = await readAppIndex(skillsDir, 'app_1');
    expect(index.skills['pro-tool']).toBeUndefined();
  }, 15_000);

  it('rejects cross-app slug collisions before fetching any grant', async () => {
    await mkdir(path.join(skillsDir, 'other-app', 'pro-tool'), { recursive: true });
    await mkdir(path.join(skillsDir, 'other-app', '.skills-sync'), { recursive: true });
    await writeFile(
      path.join(skillsDir, 'other-app', '.skills-sync', 'pro-tool.json'),
      JSON.stringify({ slug: 'pro-tool', version: '0.1.0', ref: 'v0.1.0', installedAt: '2026-10-04T00:00:00Z' }),
    );

    let grantFetched = false;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/download-grant')) grantFetched = true;
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    await expect(
      installSkill({
        baseUrl: platformUrl,
        machineToken: 't-mock-machine-token',
        app: 'app_1',
        slug: 'pro-tool',
        skillsDir,
        fetchImpl,
      }),
    ).rejects.toThrow(/other-app[\s\S]*无法软连接/);
    // 提前报错：未发生任何网络请求
    expect(grantFetched).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  }, 15_000);

  it('plans updates by comparing registry versions with the app index', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify(registryBody), { status: 200 }),
    ) as unknown as typeof fetch;

    const withFetch = async <T>(fn: () => Promise<T>): Promise<T> => {
      const previous = globalThis.fetch;
      (globalThis as { fetch: typeof fetch }).fetch = fetchImpl;
      try {
        return await fn();
      } finally {
        (globalThis as { fetch: typeof fetch }).fetch = previous;
      }
    };

    // 未安装：全部待安装
    const fresh = await withFetch(() => planUpdate({ baseUrl: platformUrl, machineToken: 't-x', app: 'app_1', skillsDir }));
    expect(fresh.outdated).toEqual([{ slug: 'pro-tool', from: null, to: '1.4.0' }]);
    expect(fresh.upToDate).toEqual([]);

    // 已安装同版本：无更新（索引经磁盘对账自愈）
    await mkdir(path.join(skillsDir, 'app_1', 'pro-tool'), { recursive: true });
    await mkdir(path.join(skillsDir, 'app_1', '.skills-sync'), { recursive: true });
    await writeFile(
      path.join(skillsDir, 'app_1', '.skills-sync', 'pro-tool.json'),
      JSON.stringify({ slug: 'pro-tool', version: '1.4.0', ref: 'v1.4.0', installedAt: '2026-10-04T00:00:00Z' }),
    );
    const upToDatePlan = await withFetch(() => planUpdate({ baseUrl: platformUrl, machineToken: 't-x', app: 'app_1', skillsDir }));
    expect(upToDatePlan.outdated).toEqual([]);
    expect(upToDatePlan.upToDate).toEqual([{ slug: 'pro-tool', version: '1.4.0' }]);
  }, 15_000);
});
