/**
 * 安装进度提示（纯输出渲染，不含业务逻辑）：
 * - TTY：下载阶段在单行内刷新进度条（百分比 + 已下载/总字节；无总长时只显示已下载字节）；
 * - 非 TTY（管道/重定向）：只打印阶段提示行，不逐块刷屏。
 */

export type InstallProgressEvent =
  | { phase: 'grant' }
  | { phase: 'download'; received: number; total: number | null }
  | { phase: 'extract' };

export type ProgressWriter = (text: string) => void;

const BAR_WIDTH = 24;
/** 进度条刷新最小间隔：避免高频小包把终端刷爆 */
const THROTTLE_MS = 120;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '? B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** 清除当前行（进度条收尾用） */
function clearLine(): string {
  return '\r\x1b[2K';
}

export function createInstallProgressReporter(options: {
  write?: ProgressWriter;
  isTty?: boolean;
} = {}): (event: InstallProgressEvent) => void {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const isTty = options.isTty ?? Boolean(process.stdout.isTTY);
  let barDrawn = false;
  let lastDrawAt = 0;
  let lastReceived = 0;
  let lastTotal: number | null = null;

  const renderDownload = (event: { received: number; total: number | null }, force: boolean) => {
    const now = Date.now();
    if (!force && now - lastDrawAt < THROTTLE_MS) return;
    lastDrawAt = now;
    lastReceived = event.received;
    lastTotal = event.total;
    barDrawn = true;
    if (event.total && event.total > 0) {
      const ratio = Math.min(1, event.received / event.total);
      const filled = Math.round(ratio * BAR_WIDTH);
      const bar = `${'#'.repeat(filled)}${'-'.repeat(BAR_WIDTH - filled)}`;
      write(
        `\r⬇ 下载中 ${Math.floor(ratio * 100)}% [${bar}] ${formatBytes(event.received)} / ${formatBytes(event.total)}`,
      );
    } else {
      write(`\r⬇ 下载中 ${formatBytes(event.received)}`);
    }
  };

  return (event) => {
    switch (event.phase) {
      case 'grant':
        write('→ 领取下载凭据…\n');
        break;
      case 'download':
        if (isTty) renderDownload(event, false);
        break;
      case 'extract':
        if (barDrawn) {
          // 下载完成后把进度条定格到 100% 再换行，避免残留半截条
          renderDownload({ received: lastTotal ?? lastReceived, total: lastTotal }, true);
          write('\n');
          barDrawn = false;
        }
        write('→ 解压安装…\n');
        break;
    }
  };
}
