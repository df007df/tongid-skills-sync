import http from 'node:http';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { generatePkcePair } from './pkce.js';
import type { MachineCredential } from './store.js';

/**
 * 本机登录引导：起本地回调服务 → 打开平台登录页（PKCE + state）→
 * 兑换授权码得到签名会话 → 用会话绑定一台机器（机器授权码）→ 会话即弃。
 *
 * 回调端口默认 43175（与 tongid-board 的 43173 互不占用），平台仅对
 * 开启技能售卖的应用放行该 loopback 回调。
 *
 * 注意：CALLBACK_PATH 与 SKILLS_PAY_CLIENT_TYPE 是与 TongID 平台的 OAuth 协议契约
 * （tongid 仓 lib/auth/skills-pay-oauth.ts），标识「技能售卖机器授权」流程，
 * 与 npm 包名（tongid-skills-sync）无关，勿随包改名。
 */

export const DEFAULT_CALLBACK_PORT = 43175;
export const CALLBACK_PATH = '/skills-pay/callback';
export const SKILLS_PAY_CLIENT_TYPE = 'tongid-skills-pay';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export type LoginMachineOptions = {
  baseUrl: string;
  /** 目标应用（applicationId 或 slug） */
  app: string;
  /** 机器备注名，默认取 hostname */
  label?: string;
  /** 回调端口（默认 43175；测试可覆盖） */
  callbackPort?: number;
  /** 打开浏览器的回调；默认按平台自动调用系统打开命令，传入后由调用方接管 */
  openBrowser?: (url: string) => void | Promise<void>;
  /** 兑换后绑定机器的 fetch 实现（默认 globalThis.fetch；测试可注入） */
  fetchImpl?: typeof fetch;
};

export class SkillsPayLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkillsPayLoginError';
  }
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const { spawn } = await import('node:child_process');
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { stdio: 'ignore', detached: true });
  child.unref();
}

type TokenEnvelope = {
  data: { access_token?: string } | null;
  error: { code: string; message: string } | null;
};

async function exchangeCodeForSession(options: {
  baseUrl: string;
  app: string;
  code: string;
  codeVerifier: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code: options.code,
    code_verifier: options.codeVerifier,
    client_type: SKILLS_PAY_CLIENT_TYPE,
    application_id: options.app,
  });
  const response = await options.fetchImpl(new URL('/api/v1/oauth/token', options.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-tongid-application-id': options.app,
    },
    body: form.toString(),
  });
  const body = (await response.json().catch(() => null)) as TokenEnvelope | null;
  const accessToken = body?.data?.access_token;
  if (!response.ok || !accessToken) {
    throw new SkillsPayLoginError(
      `授权码兑换失败：${body?.error?.message ?? `HTTP ${response.status}`}`,
    );
  }
  return accessToken;
}

async function bindMachine(options: {
  baseUrl: string;
  app: string;
  accessToken: string;
  label: string | null;
  fetchImpl: typeof fetch;
}): Promise<MachineCredential> {
  const response = await options.fetchImpl(new URL('/api/v1/skills/machines', options.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${options.accessToken}`,
      'x-tongid-application-id': options.app,
    },
    body: JSON.stringify({ applicationId: options.app, label: options.label }),
  });
  const body = (await response.json().catch(() => null)) as {
    data: {
      machineToken?: string;
      machine?: { id?: string; createdAt?: string };
      machineLimit?: number;
    } | null;
    error: { code: string; message: string } | null;
  } | null;
  const data = body?.data;
  const machineToken = data?.machineToken;
  if (!response.ok || !machineToken) {
    throw new SkillsPayLoginError(
      `机器绑定失败：${body?.error?.message ?? `HTTP ${response.status}`}`,
    );
  }
  return {
    baseUrl: options.baseUrl,
    app: options.app,
    machineToken,
    label: options.label,
    machineId: data.machine?.id ?? '',
    createdAt: data.machine?.createdAt ?? new Date().toISOString(),
  };
}

/** 完整登录引导流程；resolve 后即已绑定机器（凭据由调用方决定是否落盘）。 */
export async function loginMachine(options: LoginMachineOptions): Promise<MachineCredential> {
  const port = options.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const fetchImpl = options.fetchImpl ?? fetch;
  const label = options.label?.trim() || hostname() || null;

  const { codeVerifier, codeChallenge } = await generatePkcePair();
  const state = randomBytes(16).toString('base64url');

  const callbackUrl = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
  const loginUrl = new URL('/auth/login', options.baseUrl);
  loginUrl.searchParams.set('applicationId', options.app);
  loginUrl.searchParams.set('redirect', callbackUrl);
  loginUrl.searchParams.set('state', state);
  loginUrl.searchParams.set('code_challenge', codeChallenge);

  return new Promise<MachineCredential>((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end('not found');
        return;
      }

      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      if (!code) {
        response.writeHead(400).end('missing code');
        settle(Promise.reject(new SkillsPayLoginError('回调缺少授权码')));
        return;
      }
      if (returnedState !== state) {
        response.writeHead(400).end('state mismatch');
        settle(Promise.reject(new SkillsPayLoginError('回调 state 校验失败')));
        return;
      }

      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><body><p>登录成功，请回到终端继续。</p></body>');

      settle(
        (async () => {
          const accessToken = await exchangeCodeForSession({
            baseUrl: options.baseUrl,
            app: options.app,
            code,
            codeVerifier,
            fetchImpl,
          });
          return bindMachine({
            baseUrl: options.baseUrl,
            app: options.app,
            accessToken,
            label,
            fetchImpl,
          });
        })(),
      );
    });

    const timer = setTimeout(() => {
      settle(Promise.reject(new SkillsPayLoginError('等待浏览器登录超时（5 分钟），请重试 login')));
    }, CALLBACK_TIMEOUT_MS);

    let settled = false;
    function settle(promise: Promise<MachineCredential>) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      promise.then(resolve, reject);
    }

    server.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        settle(
          Promise.reject(
            new SkillsPayLoginError(`本机回调端口 ${port} 已被占用；请关闭占用进程后重试 login`),
          ),
        );
        return;
      }
      settle(Promise.reject(error));
    });

    server.listen(port, '127.0.0.1', () => {
      const opener = options.openBrowser ?? defaultOpenBrowser;
      void Promise.resolve(opener(loginUrl.toString())).catch(() => {
        // 打不开浏览器时仍打印地址，用户可手动复制
        process.stdout.write(`无法自动打开浏览器，请手动访问：\n${loginUrl.toString()}\n`);
      });
    });
  });
}
