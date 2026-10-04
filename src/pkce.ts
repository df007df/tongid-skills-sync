import { createHash, randomBytes } from 'node:crypto';

/**
 * PKCE（S256）本地实现——与 @tongid/sdk 的 generatePkcePair 同一算法，
 * 使本包零运行时依赖、可独立安装（npm i -g tongid-skills-sync）。
 * 平台侧仅校验 base64url(SHA-256(verifier)) === challenge，算法一致即可互通。
 */

const PKCE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const VERIFIER_LENGTH = 64; // 43-128 之间取 64

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** 生成 PKCE pair：code_verifier（64 位随机）+ S256 code_challenge。 */
export async function generatePkcePair(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const bytes = randomBytes(VERIFIER_LENGTH);
  let codeVerifier = '';
  for (const byte of bytes) codeVerifier += PKCE_CHARSET[byte % PKCE_CHARSET.length];
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier, 'utf8').digest());
  return { codeVerifier, codeChallenge };
}

/** S256 校验：base64url(SHA-256(verifier)) === challenge */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  if (!codeVerifier || codeVerifier.length < 43) return false;
  return base64url(createHash('sha256').update(codeVerifier, 'utf8').digest()) === codeChallenge;
}
