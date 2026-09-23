import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import type { CoworkMessage } from '../../types/cowork';
import { ActivityEntryVariant } from './constants';
import ThinkingBlock from './ThinkingBlock';

const thinkingMessage = (content: string, isStreaming: boolean): CoworkMessage => ({
  id: 'think-1',
  type: 'assistant',
  content,
  timestamp: 0,
  metadata: { isThinking: true, isStreaming },
});

test('a lone thought opens straight onto its reasoning text, without a nested header', () => {
  const html = renderToStaticMarkup(React.createElement(ThinkingBlock, {
    message: thinkingMessage('Let me check the Node version first.', false),
    variant: ActivityEntryVariant.Detail,
  }));
  expect(html).toContain('Let me check the Node version first.');
  expect(html).not.toContain('<button');
  expect(html).not.toContain('思考过程');
  expect(html).not.toContain('data-reasoning-follow-tail');
});

test('a thought that is still streaming follows its newest line', () => {
  const html = renderToStaticMarkup(React.createElement(ThinkingBlock, {
    message: thinkingMessage('Working through the options', true),
    variant: ActivityEntryVariant.Detail,
  }));
  expect(html).toContain('data-reasoning-follow-tail="true"');
});

test('a thought among other steps stays a collapsed, expandable row', () => {
  const html = renderToStaticMarkup(React.createElement(ThinkingBlock, {
    message: thinkingMessage('Hidden until expanded', false),
    variant: ActivityEntryVariant.Row,
  }));
  expect(html).toContain('<button');
  expect(html).toContain('思考过程');
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain('Hidden until expanded');
});
