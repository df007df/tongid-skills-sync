import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

/** 集合仓形态：根目录有 skills/ 目录，技能在子目录里 */
function tarGzCollectionRepo(): Buffer {
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
  entry('repo-x/skills/inner-tool/SKILL.md', Buffer.from('# inner\n'));
  entry('repo-x/skills/second-tool/SKILL.md', Buffer.from('# second\n'));
  entry('repo-x/skills/not-a-skill/notes.txt', Buffer.from('skip me\n'));
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks));
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
    });
    // 两层布局：<root>/<app>/<slug>，且应用索引登记了版本
    const manifest = await readInstalledManifest('app_1', 'pro-tool', skillsDir);
    expect(manifest).toMatchObject({ slug: 'pro-tool', version: '1.4.0', ref: 'v1.4.0' });
    await expect(
      readFile(path.join(skillsDir, 'app_1', 'pro-tool', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('pro-tool 1.4.0');
    const { readAppIndex } = await import('./install.js');
    const index = await readAppIndex(skillsDir, 'app_1');
    expect(index.skills['pro-tool']).toMatchObject({ version: '1.4.0' });
    expect(index.app).toBe('app_1');
    // GitHub 直连请求确实携带了瞬时令牌
    expect(state.sawGithubToken).toBe('Bearer github_pat_secret');
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

  it('rejects collection inner skill names already installed by another app, before writing anything', async () => {
    const { mkdir } = await import('node:fs/promises');
    // other-app 已安装单技能 inner-tool（与集合仓内部技能同名）
    await mkdir(path.join(skillsDir, 'other-app', 'inner-tool'), { recursive: true });
    await writeFile(
      path.join(skillsDir, 'other-app', 'inner-tool', '.skills-sync.json'),
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
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(skillsDir, 'other-app', 'pro-tool'), { recursive: true });
    await writeFile(
      path.join(skillsDir, 'other-app', 'pro-tool', '.skills-sync.json'),
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
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(skillsDir, 'app_1', 'pro-tool'), { recursive: true });
    await writeFile(
      path.join(skillsDir, 'app_1', 'pro-tool', '.skills-sync.json'),
      JSON.stringify({ slug: 'pro-tool', version: '1.4.0', ref: 'v1.4.0', installedAt: '2026-10-04T00:00:00Z' }),
    );
    const upToDatePlan = await withFetch(() => planUpdate({ baseUrl: platformUrl, machineToken: 't-x', app: 'app_1', skillsDir }));
    expect(upToDatePlan.outdated).toEqual([]);
    expect(upToDatePlan.upToDate).toEqual([{ slug: 'pro-tool', version: '1.4.0' }]);
  }, 15_000);
});
