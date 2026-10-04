import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultCertificateDir, defaultSkillsDir, defaultStoreDir, deleteCredential, listCredentials, loadCredential, saveCredential } from './store.js';
import type { MachineCredential } from './store.js';

let storeDir: string;

beforeEach(async () => {
  storeDir = await mkdtemp(path.join(os.tmpdir(), 'skills-sync-store-'));
});

afterEach(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

function credential(app: string, overrides: Partial<MachineCredential> = {}): MachineCredential {
  return {
    baseUrl: 'https://tongid.dev',
    app,
    machineToken: 't-test-token',
    label: 'laptop',
    machineId: 'm1',
    createdAt: '2026-10-04T00:00:00.000Z',
    ...overrides,
  };
}

describe('credential store', () => {
  it('round-trips credentials per app and sanitizes file names', async () => {
    await saveCredential(credential('app_one'), storeDir);
    await saveCredential(credential('app two'), storeDir);

    await expect(loadCredential('app_one', storeDir)).resolves.toMatchObject({ app: 'app_one' });
    await expect(loadCredential('app two', storeDir)).resolves.toMatchObject({
      machineToken: 't-test-token',
    });
    await expect(loadCredential('missing', storeDir)).resolves.toBeNull();

    const all = await listCredentials(storeDir);
    expect(all).toHaveLength(2);
  });

  it('deletes credentials and ignores corrupt files', async () => {
    await saveCredential(credential('app_x'), storeDir);
    expect(await deleteCredential('app_x', storeDir)).toBe(true);
    await expect(loadCredential('app_x', storeDir)).resolves.toBeNull();

    expect(await deleteCredential('app_x', storeDir)).toBe(true);
  });

  it('keeps the default store dir under ~/.tongid/skills-sync', () => {
    expect(defaultStoreDir('/home/alice')).toBe(
      path.join('/home/alice', '.tongid', 'skills-sync'),
    );
    // 技能统一目录是全局唯一的，与凭据同根
    expect(defaultSkillsDir('/home/alice')).toBe(
      path.join('/home/alice', '.tongid', 'skills-sync', 'skills'),
    );
    // 凭据在 certificate/ 子目录下
    expect(defaultCertificateDir('/home/alice')).toBe(
      path.join('/home/alice', '.tongid', 'skills-sync', 'certificate'),
    );
  });
});
