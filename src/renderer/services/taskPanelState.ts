import { SubagentWaitPhase } from './subagentWaitState';

export const TaskPanelMainAgentStatus = {
  Running: 'running',
  WaitingSubagents: 'waiting-subagents',
  WaitingSummary: 'waiting-summary',
  Idle: 'idle',
} as const;
export type TaskPanelMainAgentStatus = typeof TaskPanelMainAgentStatus[keyof typeof TaskPanelMainAgentStatus];

export function getTaskPanelMainAgentStatus({
  isSessionBusy,
  isContextMaintenance,
  subagentWaitPhase,
}: {
  isSessionBusy: boolean;
  isContextMaintenance: boolean;
  subagentWaitPhase: SubagentWaitPhase | null;
}): TaskPanelMainAgentStatus {
  // A stopped or finished request can still contain a successful historical yield.
  if (!isSessionBusy) return TaskPanelMainAgentStatus.Idle;
  if (isContextMaintenance) return TaskPanelMainAgentStatus.Running;
  if (subagentWaitPhase === SubagentWaitPhase.Children) return TaskPanelMainAgentStatus.WaitingSubagents;
  if (subagentWaitPhase === SubagentWaitPhase.Summary) return TaskPanelMainAgentStatus.WaitingSummary;
  return TaskPanelMainAgentStatus.Running;
}
