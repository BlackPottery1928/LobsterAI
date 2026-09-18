import { describe, expect, test } from 'vitest';

import { SubagentToolName, SubagentYield } from '../../shared/cowork/subagent';
import { type CoworkMessage, SubagentSessionStatus, type SubagentSessionSummary } from '../types/cowork';
import { getSubagentWaitPhase, SubagentWaitPhase } from './subagentWaitState';
import { getTaskPanelMainAgentStatus, TaskPanelMainAgentStatus } from './taskPanelState';

const handoffMessages: CoworkMessage[] = [
  { id: 'request', type: 'user', content: 'Make a game', timestamp: 1 },
  { id: 'spawn', type: 'tool_use', content: '', timestamp: 2, metadata: { toolName: SubagentToolName.Spawn, toolUseId: 'child' } },
  { id: 'yield', type: 'tool_use', content: '', timestamp: 3, metadata: { toolName: SubagentToolName.Yield, toolUseId: 'handoff' } },
  { id: 'result', type: 'tool_result', content: JSON.stringify({ status: SubagentYield.ResultStatus }), timestamp: 4, metadata: { toolUseId: 'handoff' } },
];
const child: SubagentSessionSummary = {
  id: 'child', parentSessionId: 'parent', agentId: null, task: 'Make a game', label: null,
  sessionKey: 'agent:main:subagent:child', status: SubagentSessionStatus.Running, createdAt: 2, endedAt: null,
};

const statusFor = (messages: CoworkMessage[], children: SubagentSessionSummary[], isSessionBusy = true) => (
  getTaskPanelMainAgentStatus({
    isSessionBusy,
    isContextMaintenance: false,
    subagentWaitPhase: getSubagentWaitPhase(messages, children),
  })
);

describe('task panel main agent status', () => {
  test('keeps a delegated request active through child execution, summary waiting and parent continuation', () => {
    expect(statusFor(handoffMessages, [child])).toBe(TaskPanelMainAgentStatus.WaitingSubagents);
    const completedChild = { ...child, status: SubagentSessionStatus.Done, endedAt: 5 };
    expect(statusFor(handoffMessages, [completedChild])).toBe(TaskPanelMainAgentStatus.WaitingSummary);
    const resumedMessages: CoworkMessage[] = [
      ...handoffMessages,
      { id: 'answer', type: 'assistant', content: 'Here is the game', timestamp: 6 },
    ];
    expect(statusFor(resumedMessages, [completedChild])).toBe(TaskPanelMainAgentStatus.Running);
    expect(statusFor(resumedMessages, [completedChild], false)).toBe(TaskPanelMainAgentStatus.Idle);
  });

  test('does not keep a stopped request waiting or apply a previous handoff to a new request', () => {
    expect(statusFor(handoffMessages, [child], false)).toBe(TaskPanelMainAgentStatus.Idle);
    expect(statusFor(handoffMessages, [{ ...child, status: SubagentSessionStatus.Done }], false)).toBe(TaskPanelMainAgentStatus.Idle);
    expect(statusFor([
      ...handoffMessages,
      { id: 'new-request', type: 'user', content: 'Change the colors', timestamp: 6 },
    ], [child])).toBe(TaskPanelMainAgentStatus.Running);
  });

  test('shows active context maintenance as processing even with an earlier handoff', () => {
    expect(getTaskPanelMainAgentStatus({
      isSessionBusy: true,
      isContextMaintenance: true,
      subagentWaitPhase: SubagentWaitPhase.Children,
    })).toBe(TaskPanelMainAgentStatus.Running);
  });
});
