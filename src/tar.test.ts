import { gzipSync } from 'node:zlib';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractTarGzToDir, parseTar } from './tar.js';

/** 测试用 ustar 构造器：512 字节头 + 内容按块对齐 */
function tarHeader(name: string, size: number, typeflag: '0' | '5'): Buffer {
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 100), 0, 100, 'utf8');
  header.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write(typeflag, 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  // 校验和：先清零再累加
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return header;
}

function buildTar(entries: Array<{ name: string; content?: string; type?: 'file' | 'dir' }>): Buffer {
  const chunks: Buffer[] = [Buffer.alloc(0)];
  for (const entry of entries) {
    const type = entry.type === 'dir' ? '5' : '0';
    const content = Buffer.from(entry.content ?? '', 'utf8');
    chunks.push(tarHeader(entry.name, type === '5' ? 0 : content.length, type as '0' | '5'));
    if (type === '0' && content.length > 0) {
      chunks.push(content);
      const padding = (512 - (content.length % 512)) % 512;
      if (padding > 0) chunks.push(Buffer.alloc(padding));
    }
  }
  chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}

let destDir: string;

beforeEach(async () => {
  destDir = await mkdtemp(path.join(os.tmpdir(), 'skills-sync-tar-'));
});

afterEach(async () => {
  await rm(destDir, { recursive: true, force: true });
});

describe('tar extraction', () => {
  it('parses files and directories with ustar entries', () => {
    const tar = buildTar([
      { name: 'repo-v1/', type: 'dir' },
      { name: 'repo-v1/SKILL.md', content: '# hello\n' },
      { name: 'repo-v1/scripts/', type: 'dir' },
      { name: 'repo-v1/scripts/run.mjs', content: 'console.log(1)\n' },
    ]);
    const entries = parseTar(tar, { stripComponents: 1 });
    expect(entries.map((entry) => entry.name).sort()).toEqual(['SKILL.md', 'scripts', 'scripts/run.mjs']);
    expect(entries.find((entry) => entry.name === 'scripts')?.type).toBe('dir');
  });

  it('extracts gzipped archives stripping the top-level folder', async () => {
    const archive = gzipSync(
      buildTar([
        { name: 'pro-tool-1.2.0/', type: 'dir' },
        { name: 'pro-tool-1.2.0/SKILL.md', content: '# skill\n' },
        { name: 'pro-tool-1.2.0/a/b/c.txt', content: 'nested' },
      ]),
    );

    const written = await extractTarGzToDir(archive, destDir, { stripComponents: 1 });
    expect(written.filter((entry) => entry.type === 'file').map((entry) => entry.name).sort()).toEqual([
      'SKILL.md',
      'a/b/c.txt',
    ]);
    await expect(readFile(path.join(destDir, 'SKILL.md'), 'utf8')).resolves.toBe('# skill\n');
    await expect(readFile(path.join(destDir, 'a/b/c.txt'), 'utf8')).resolves.toBe('nested');
  });

  it('rejects path traversal entries', async () => {
    const archive = gzipSync(
      buildTar([
        { name: 'root/', type: 'dir' },
        { name: 'root/../../evil.txt', content: 'nope' },
        { name: 'root/ok.txt', content: 'fine' },
      ]),
    );

    const written = await extractTarGzToDir(archive, destDir, { stripComponents: 1 });
    expect(written.map((entry) => entry.name)).toEqual(['ok.txt']);
    await expect(readFile(path.join(destDir, 'ok.txt'), 'utf8')).resolves.toBe('fine');
  });
});
