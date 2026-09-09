import { beforeEach, describe, expect, test, vi } from 'vitest';

const { updateServerModelMetadata } = vi.hoisted(() => ({
  updateServerModelMetadata: vi.fn(),
}));

vi.mock('./claudeSettings', () => ({
  updateServerModelMetadata,
}));

import {
  buildServerModelCapabilityHeaders,
  runStartupCacheWarmup,
} from './startupCacheWarmup';

beforeEach(() => {
  updateServerModelMetadata.mockReset();
});

describe('startup server model warmup', () => {
  test('sends the fixed K3 capability and client version', () => {
    expect(buildServerModelCapabilityHeaders('2026.7.23')).toEqual({
      Accept: 'application/json',
      'X-LobsterAI-Client-Capabilities': 'kimi-k3-agentic-v1,thinking-level-control-v1',
      'X-LobsterAI-Client-Version': '2026.7.23',
    });
  });

  test('does not prefetch or cache server models while disabled', async () => {
    const fetchWithAuth = vi.fn(async (url: string) => {
      if (url.includes('/api/user/quota')) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            subscriptionStatus: 'free',
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: [] }), { status: 200 });
    });

    await runStartupCacheWarmup({
      serverBaseUrl: 'https://lobster.test',
      fetchWithAuth,
      appendKeyfromQuery: url => url,
      cachedSubscriptionStatus: 'free',
      clientVersion: '2026.7.23',
      t: key => key,
    });

    // The quota branch still runs …
    const urls = fetchWithAuth.mock.calls.map(call => String(call[0]));
    expect(urls.some(url => url.includes('/api/user/quota'))).toBe(true);
    // … but the server model branch is skipped.
    expect(urls.some(url => url.includes('/api/models/available'))).toBe(false);
    expect(updateServerModelMetadata).not.toHaveBeenCalled();
  });
});
