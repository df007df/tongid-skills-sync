import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchDownloadGrant, fetchRegistry, revokeCurrentMachine, SkillsPayApiError } from './api.js';

const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('skills api client', () => {
  it('unwraps the envelope for registry requests', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        data: { applicationId: 'app_1', skills: [{ slug: 'pro', version: '1.0.0' }], roles: ['pro'], machineLimit: 3 },
        error: null,
      }),
    );

    const payload = await fetchRegistry({ baseUrl: 'https://tongid.dev', machineToken: 't-abc' });
    expect(payload.skills[0]?.slug).toBe('pro');
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe('https://tongid.dev/api/v1/skills/registry');
    expect(init.headers).toMatchObject({ authorization: 'Bearer t-abc' });
  });

  it('encodes skill slugs in grant requests and posts', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { data: { slug: 'a b', version: '1', url: 'u', token: null }, error: null }),
    );
    await fetchDownloadGrant({ baseUrl: 'https://tongid.dev', machineToken: 't-abc', slug: 'a b' });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/api/v1/skills/a%20b/download-grant');
    expect(init.method).toBe('POST');
  });

  it('maps error envelopes to SkillsPayApiError with relogin hints', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(401, { data: null, error: { code: 'MACHINE_REVOKED', message: '已撤销' } }),
    );

    const error = await revokeCurrentMachine({ baseUrl: 'https://tongid.dev', machineToken: 't-x' }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SkillsPayApiError);
    const apiError = error as SkillsPayApiError;
    expect(apiError.code).toBe('MACHINE_REVOKED');
    expect(apiError.status).toBe(401);
    expect(apiError.reloginRequired).toBe(true);
    expect(apiError.message).toContain('MACHINE_REVOKED');
  });

  it('fails clearly on non-json responses', async () => {
    fetchMock.mockResolvedValue(new Response('bad gateway', { status: 502 }));
    await expect(
      fetchRegistry({ baseUrl: 'https://tongid.dev', machineToken: 't-abc' }),
    ).rejects.toMatchObject({ code: 'REQUEST_FAILED', status: 502 });
  });
});

vi.stubGlobal('fetch', fetchMock);
