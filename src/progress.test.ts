import { describe, expect, it } from 'vitest';
import { createInstallProgressReporter, formatBytes } from './progress.js';

describe('formatBytes', () => {
  it('formats byte counts in human units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });
});

describe('createInstallProgressReporter', () => {
  it('TTY 模式：下载阶段单行刷新进度条，extract 时定格 100% 并换行', () => {
    const writes: string[] = [];
    const report = createInstallProgressReporter({ write: (t) => writes.push(t), isTty: true });

    report({ phase: 'grant' });
    report({ phase: 'download', received: 50, total: 100 });
    report({ phase: 'download', received: 60, total: 100 }); // 节流窗口内，不重复绘制
    report({ phase: 'extract' });

    const text = writes.join('');
    expect(text).toContain('领取下载凭据');
    expect(text).toContain('50%');
    expect(text).not.toContain('60%'); // 节流生效
    expect(text).toContain('100%'); // extract 定格收尾
    expect(text).toContain('解压安装');
    // 进度条以 \r 开头单行刷新，extract 后换行
    expect(writes.some((w) => w.startsWith('\r⬇'))).toBe(true);
    expect(text).toContain('\n');
  });

  it('TTY 模式：无总长（chunked）时只显示已下载字节', () => {
    const writes: string[] = [];
    const report = createInstallProgressReporter({ write: (t) => writes.push(t), isTty: true });

    report({ phase: 'download', received: 4096, total: null });
    const text = writes.join('');
    expect(text).toContain('4.0 KB');
    expect(text).not.toContain('%');
  });

  it('非 TTY 模式：只打印阶段行，不输出下载进度条', () => {
    const writes: string[] = [];
    const report = createInstallProgressReporter({ write: (t) => writes.push(t), isTty: false });

    report({ phase: 'grant' });
    report({ phase: 'download', received: 1024, total: 2048 });
    report({ phase: 'extract' });

    const text = writes.join('');
    expect(text).toContain('领取下载凭据');
    expect(text).toContain('解压安装');
    expect(text).not.toContain('下载中');
  });
});
