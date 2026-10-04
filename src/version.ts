import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/**
 * CLI 自身版本，读包根 package.json 的 version 字段
 * （npm 包 files 必须包含 package.json；dist 与 src 下相对路径都在包根一层）。
 */
export function cliVersion(): string {
  return (require('../package.json') as { version: string }).version;
}

/**
 * 比较两个语义版本（x.y.z，容忍前导 v 与缺失段）：返回 -1/0/1。
 * 非数字段按 0 处理，足够覆盖 npm 发布的纯数字版本。
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const parse = (value: string) =>
    value
      .trim()
      .replace(/^v/, '')
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const da = left[index] ?? 0;
    const db = right[index] ?? 0;
    if (da < db) return -1;
    if (da > db) return 1;
  }
  return 0;
}
