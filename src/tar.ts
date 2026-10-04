import { gunzipSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 极简 tar.gz 解包（ustar + GNU 兼容），零第三方依赖。
 * GitHub 归档为标准 ustar（含 prefix 字段）；实现覆盖：
 * - 文件/目录条目，octal size
 * - ustar prefix 拼接
 * - GNU 'L'（长文件名）与 pax 'x'/'g'（扩展头，跳过其数据块）
 * - 路径穿越防护（拒绝绝对路径与 `..`）
 */

const BLOCK = 512;

export type TarEntry = {
  name: string;
  type: 'file' | 'dir';
  data: Buffer | null;
};

function readString(block: Buffer, offset: number, length: number): string {
  return block.subarray(offset, offset + length).toString('utf8').split('\0')[0] ?? '';
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const raw = readString(block, offset, length).trim();
  if (!raw) return 0;
  return parseInt(raw, 8) || 0;
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

function safeJoin(destDir: string, entryName: string): string | null {
  const normalized = path.posix.normalize(entryName).replace(/^\/+/, '');
  if (!normalized || normalized === '.' || normalized.startsWith('..')) return null;
  const target = path.join(destDir, ...normalized.split('/'));
  const resolvedTarget = path.resolve(target);
  const resolvedDest = path.resolve(destDir);
  if (resolvedTarget !== resolvedDest && !resolvedTarget.startsWith(`${resolvedDest}${path.sep}`)) {
    return null;
  }
  return target;
}

/** 解析 tar Buffer（未解压）为条目列表。 */
export function parseTar(tar: Buffer, options: { stripComponents?: number } = {}): TarEntry[] {
  const stripComponents = options.stripComponents ?? 0;
  const entries: TarEntry[] = [];

  let offset = 0;
  let pendingLongName: string | null = null;

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (isZeroBlock(header)) break;

    const fromLongName = pendingLongName !== null;
    let name = pendingLongName ?? readString(header, 0, 100);
    pendingLongName = null;
    const size = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156] || 0x30);
    const prefix = fromLongName ? '' : readString(header, 345, 155);
    if (prefix) name = `${prefix}/${name}`;

    const dataStart = offset + BLOCK;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (typeFlag === 'L') {
      // GNU 长文件名：内容是下一个条目的真实名称
      pendingLongName = data.toString('utf8').split('\0')[0] ?? '';
      continue;
    }
    if (typeFlag === 'x' || typeFlag === 'g' || typeFlag === 'Z') {
      // pax / 扩展头：跳过
      continue;
    }

    const segments = name.split('/').filter((segment) => segment !== '' && segment !== '.');
    if (stripComponents > 0) {
      if (segments.length <= stripComponents) continue;
      segments.splice(0, stripComponents);
    }
    const relativeName = segments.join('/');
    if (!relativeName) continue;

    const type: 'file' | 'dir' = typeFlag === '5' ? 'dir' : 'file';
    entries.push({ name: relativeName, type, data: type === 'file' ? Buffer.from(data) : null });
  }

  return entries;
}

export type ExtractedEntry = { name: string; type: 'file' | 'dir' };

/** 解压并落盘 tar.gz；stripComponents 去掉顶层目录（GitHub 归档自带 repo-ref/ 前缀）。拒绝路径穿越条目。 */
export async function extractTarGzToDir(
  archive: Buffer,
  destDir: string,
  options: { stripComponents?: number } = {},
): Promise<ExtractedEntry[]> {
  const entries = parseTar(gunzipSync(archive), options);
  const written: ExtractedEntry[] = [];

  // 目录条目优先创建，随后写文件（文件的父目录兜底 mkdir）
  for (const entry of entries) {
    if (entry.type !== 'dir') continue;
    const target = safeJoin(destDir, entry.name);
    if (!target) continue;
    await mkdir(target, { recursive: true });
    written.push({ name: entry.name, type: 'dir' });
  }
  for (const entry of entries) {
    if (entry.type !== 'file' || !entry.data) continue;
    const target = safeJoin(destDir, entry.name);
    if (!target) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.data);
    written.push({ name: entry.name, type: 'file' });
  }

  return written;
}
