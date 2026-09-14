import { describe, expect, test } from 'vitest';

import { type AskUserRequest, McpBridgeServer } from './mcpBridgeServer';

const makeQuestions = (): AskUserRequest['questions'] => [{
  question: 'Continue?',
  options: [
    { label: 'Yes' },
    { label: 'No' },
  ],
}];

describe('McpBridgeServer AskUser session attribution', () => {
  test('passes sessionKey from HTTP AskUser callback requests', async () => {
    const secret = 'test-secret';
    const server = new McpBridgeServer(secret);
    const received: AskUserRequest[] = [];

    try {
      await server.start();
      const url = server.askUserCallbackUrl;
      expect(url).toBeTruthy();

      server.onAskUser(request => {
        received.push(request);
        server.resolveAskUser(request.requestId, { behavior: 'allow' });
      });

      const response = await fetch(url!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-ask-user-secret': secret,
        },
        body: JSON.stringify({
          sessionKey: 'agent:main:lobsterai:session-a',
          questions: makeQuestions(),
        }),
      });

      expect(response.ok).toBe(true);
      await expect(response.json()).resolves.toEqual({ behavior: 'allow' });
      expect(received).toHaveLength(1);
      expect(received[0].sessionKey).toBe('agent:main:lobsterai:session-a');
    } finally {
      await server.stop();
    }
  });

  test('passes sessionKey from internal AskUser requests', async () => {
    const server = new McpBridgeServer('test-secret');
    const received: AskUserRequest[] = [];

    server.onAskUser(request => {
      received.push(request);
      server.resolveAskUser(request.requestId, { behavior: 'deny' });
    });

    await expect(server.askUserInternal(
      makeQuestions(),
      1_000,
      { sessionKey: 'agent:main:lobsterai:session-b' },
    )).resolves.toEqual({ behavior: 'deny' });

    expect(received).toHaveLength(1);
    expect(received[0].sessionKey).toBe('agent:main:lobsterai:session-b');
  });
});

describe('McpBridgeServer browser bridge', () => {
  test('authenticates and forwards browser tool requests', async () => {
    const secret = 'browser-test-secret';
    const server = new McpBridgeServer(secret);

    try {
      await server.start();
      server.onBrowserTool(async request => ({
        content: [{ type: 'text', text: request.tool }],
        structuredContent: { args: request.args },
      }));

      const unauthorized = await fetch(server.browserCallbackUrl!, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tool: 'list_pages', args: {} }),
      });
      expect(unauthorized.status).toBe(401);

      const response = await fetch(server.browserCallbackUrl!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-mcp-bridge-secret': secret,
        },
        body: JSON.stringify({ tool: 'navigate_page', args: { pageId: 7 } }),
      });
      expect(response.ok).toBe(true);
      await expect(response.json()).resolves.toEqual({
        content: [{ type: 'text', text: 'navigate_page' }],
        structuredContent: { args: { pageId: 7 } },
      });
    } finally {
      await server.stop();
    }
  });
});
