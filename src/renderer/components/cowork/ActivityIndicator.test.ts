import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';

import { ActivityIndicator } from './AssistantTurnBlock';

test('a silent model shows the first thinking phase and no step cue', () => {
  const html = renderToStaticMarkup(React.createElement(ActivityIndicator, {
    fingerprint: 'turn:0', startTimestamp: null,
  }));
  expect(html).toContain('正在思考');
  expect(html).not.toContain('data-cowork-activity-steps');
});

test('a running step names itself and finished steps are counted next to it', () => {
  const html = renderToStaticMarkup(React.createElement(ActivityIndicator, {
    fingerprint: 'turn:3', startTimestamp: null, completedSteps: 3, liveStatusText: '正在执行命令',
  }));
  expect(html).toContain('正在执行命令');
  expect(html).not.toContain('正在思考');
  expect(html).toContain('data-cowork-activity-steps="3"');
  expect(html).toContain('已完成 3 步');
});

test('an explicit status override wins over the phase rotation', () => {
  const html = renderToStaticMarkup(React.createElement(ActivityIndicator, {
    fingerprint: 'turn:1', startTimestamp: null, statusTextOverride: '等待你的回答',
  }));
  expect(html).toContain('等待你的回答');
  expect(html).not.toContain('正在思考');
});
