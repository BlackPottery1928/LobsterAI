import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';

import { i18nService } from '@/services/i18n';
import type { RootState } from '@/store';
import type { CoworkBackgroundJob, SubagentSessionSummary } from '@/types/cowork';

import { BackgroundJobStatus, isLiveBackgroundJobStatus } from '../../../shared/cowork/backgroundJobs';
import { SubagentPanelRow } from './SubagentPanelContent';

interface TaskPanelContentProps {
  sessionTitle: string;
  mainAgentRunning: boolean;
  subagents: SubagentSessionSummary[];
  subagentsLoading?: boolean;
  onSelectSubagent: (subagent: SubagentSessionSummary) => void;
  /** Open the full "Subagents" tab. */
  onOpenSubagents?: () => void;
  jobs: CoworkBackgroundJob[];
  jobsLoading?: boolean;
  onKillJob?: (job: CoworkBackgroundJob) => Promise<void> | void;
  onCopyJob?: (job: CoworkBackgroundJob) => void;
  onClearSettledJobs?: () => Promise<void> | void;
}

const JOB_STATUS_KEY: Record<CoworkBackgroundJob['status'], string> = {
  [BackgroundJobStatus.Running]: 'taskPanelJobStatusRunning',
  [BackgroundJobStatus.Stopping]: 'taskPanelJobStatusStopping',
  [BackgroundJobStatus.Completed]: 'taskPanelJobStatusCompleted',
  [BackgroundJobStatus.Killed]: 'taskPanelJobStatusKilled',
  [BackgroundJobStatus.Failed]: 'taskPanelJobStatusFailed',
  [BackgroundJobStatus.Interrupted]: 'taskPanelJobStatusInterrupted',
};

const JOB_DOT_CLASS: Record<CoworkBackgroundJob['status'], string> = {
  [BackgroundJobStatus.Running]: 'bg-emerald-500',
  [BackgroundJobStatus.Stopping]: 'bg-amber-500',
  [BackgroundJobStatus.Completed]: 'bg-emerald-500/60',
  [BackgroundJobStatus.Killed]: 'bg-amber-500/70',
  [BackgroundJobStatus.Failed]: 'bg-rose-500',
  [BackgroundJobStatus.Interrupted]: 'bg-neutral-400',
};

/** Elapsed time as `5h 20m` / `48m 43s` / `12s`. */
export const formatTaskPanelDuration = (startedAt: number, finishedAt: number | undefined, now: number): string => {
  const elapsed = Math.max(0, (finishedAt ?? now) - startedAt);
  const totalSeconds = Math.floor(elapsed / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return i18nService.t('taskPanelDurationHours')
      .replace('{hours}', String(hours))
      .replace('{minutes}', String(minutes));
  }
  if (minutes > 0) {
    return i18nService.t('taskPanelDurationMinutes')
      .replace('{minutes}', String(minutes))
      .replace('{seconds}', String(seconds));
  }
  return i18nService.t('taskPanelDurationSeconds').replace('{seconds}', String(seconds));
};

/** Live jobs first (oldest start first), then settled jobs (newest start first). */
export const sortTaskPanelJobs = (jobs: readonly CoworkBackgroundJob[]): CoworkBackgroundJob[] => {
  const live = jobs.filter(job => isLiveBackgroundJobStatus(job.status)).sort((a, b) => a.startedAt - b.startedAt);
  const settled = jobs.filter(job => !isLiveBackgroundJobStatus(job.status)).sort((a, b) => b.startedAt - a.startedAt);
  return [...live, ...settled];
};

const useNowTicker = (active: boolean): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
};

const SectionHeader: React.FC<{
  title: string;
  aside?: string;
  action?: { label: string; onClick: () => void };
}> = ({ title, aside, action }) => (
  <div className="sticky top-0 z-10 flex h-9 items-center justify-between gap-2 border-b border-border bg-background px-4">
    <h3 className="text-xs font-medium text-secondary">{title}</h3>
    <span className="flex min-w-0 items-center gap-2">
      {aside && <span className="truncate text-xs text-muted">{aside}</span>}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="shrink-0 rounded px-1.5 py-0.5 text-xs text-secondary transition-colors hover:bg-surface-raised hover:text-foreground"
        >
          {action.label}
        </button>
      )}
    </span>
  </div>
);

const EmptyHint: React.FC<{ title: string; hint: string }> = ({ title, hint }) => (
  <div className="px-4 py-6 text-center">
    <div className="text-sm text-secondary">{title}</div>
    <div className="mt-1 text-xs text-muted">{hint}</div>
  </div>
);

const KIND_LABEL: Record<string, string> = { exec: 'shell', bash: 'bash', pwsh: 'pwsh', subagent: 'agent' };

const RowActionButton: React.FC<{
  label: string;
  onClick: () => void;
  tone?: 'default' | 'danger';
  emphasized?: boolean;
  children: React.ReactNode;
}> = ({ label, onClick, tone = 'default', emphasized = false, children }) => (
  <button
    type="button"
    onClick={event => { event.stopPropagation(); onClick(); }}
    title={label}
    aria-label={label}
    className={`inline-flex h-6 shrink-0 items-center justify-center gap-1 rounded-md px-1.5 text-[11px] leading-none transition-colors ${
      tone === 'danger'
        ? emphasized
          ? 'bg-rose-500/15 text-rose-600 hover:bg-rose-500/25 dark:text-rose-400'
          : 'text-secondary hover:bg-rose-500/10 hover:text-rose-600 dark:hover:text-rose-400'
        : 'text-secondary hover:bg-surface-raised hover:text-foreground'
    }`}
  >
    {children}
  </button>
);

const BackgroundJobRow: React.FC<{
  job: CoworkBackgroundJob;
  now: number;
  onKill?: (job: CoworkBackgroundJob) => Promise<void> | void;
  onCopy?: (job: CoworkBackgroundJob) => void;
}> = ({ job, now, onKill, onCopy }) => {
  const live = isLiveBackgroundJobStatus(job.status);
  const statusLabel = i18nService.t(JOB_STATUS_KEY[job.status]);
  const duration = formatTaskPanelDuration(job.startedAt, job.finishedAt, now);
  const summary = [statusLabel, job.detail, duration].filter(Boolean).join(' · ');
  const [confirmingKill, setConfirmingKill] = useState(false);
  const [killing, setKilling] = useState(false);
  // Two-step kill: the first click switches to "confirm", and it reverts after
  // 3 seconds without a second click to avoid accidental kills.
  useEffect(() => {
    if (!confirmingKill) return undefined;
    const timer = window.setTimeout(() => setConfirmingKill(false), 3_000);
    return () => window.clearTimeout(timer);
  }, [confirmingKill]);
  useEffect(() => { if (!live) { setConfirmingKill(false); setKilling(false); } }, [live]);
  const handleKill = useCallback(async () => {
    if (!onKill || killing) return;
    if (!confirmingKill) { setConfirmingKill(true); return; }
    setConfirmingKill(false);
    setKilling(true);
    try { await onKill(job); } finally { setKilling(false); }
  }, [confirmingKill, job, killing, onKill]);
  const kindLabel = KIND_LABEL[job.kind.toLowerCase()] ?? job.kind.toLowerCase();

  return (
    <div
      className="group flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface/60"
      data-task-panel-job-status={job.status}
      data-task-panel-job-id={job.id}
      title={job.label}
    >
      <span
        className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${JOB_DOT_CLASS[job.status]} ${live ? 'animate-pulse' : ''}`}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 rounded border border-border bg-surface px-1.5 py-0.5 font-mono text-[10px] leading-none text-secondary">
            {kindLabel}
          </span>
          <span className="truncate font-mono text-xs text-foreground">{job.label || job.kind}</span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-xs text-muted">{killing ? i18nService.t('taskPanelJobStatusStopping') : summary}</span>
          <span className={`flex shrink-0 items-center gap-0.5 ${confirmingKill ? '' : 'opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100'}`}>
            {onCopy && job.label && (
              <RowActionButton label={i18nService.t('taskPanelCopy')} onClick={() => onCopy(job)}>
                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="7" y="7" width="9" height="9" rx="1.5" /><path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4h-6A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" /></svg>
              </RowActionButton>
            )}
            {onKill && live && (
              <RowActionButton
                label={i18nService.t(confirmingKill ? 'taskPanelKillConfirm' : 'taskPanelKill')}
                onClick={() => { void handleKill(); }}
                tone="danger"
                emphasized={confirmingKill}
              >
                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="5" width="10" height="10" rx="1.5" /></svg>
                {confirmingKill && <span>{i18nService.t('taskPanelKillConfirm')}</span>}
              </RowActionButton>
            )}
          </span>
        </div>
      </div>
    </div>
  );
};

const TaskPanelContent: React.FC<TaskPanelContentProps> = ({
  sessionTitle,
  mainAgentRunning,
  subagents,
  subagentsLoading = false,
  onSelectSubagent,
  onOpenSubagents,
  jobs,
  jobsLoading = false,
  onKillJob,
  onCopyJob,
  onClearSettledJobs,
}) => {
  const agents = useSelector((state: RootState) => state.agent.agents);
  const orderedJobs = useMemo(() => sortTaskPanelJobs(jobs), [jobs]);
  const liveCount = orderedJobs.filter(job => isLiveBackgroundJobStatus(job.status)).length;
  const settledCount = orderedJobs.length - liveCount;
  const now = useNowTicker(liveCount > 0);
  const jobCountLabel = (liveCount > 0
    ? i18nService.t('taskPanelJobCountRunning').replace('{running}', String(liveCount))
    : i18nService.t('taskPanelJobCount')
  ).replace('{total}', String(orderedJobs.length));

  return (
    <div className="flex h-full flex-col overflow-hidden" data-task-panel>
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border px-4">
        <h2 className="shrink-0 text-sm font-medium text-foreground">{i18nService.t('taskPanelTitle')}</h2>
        {sessionTitle && (
          <>
            <span className="text-secondary">·</span>
            <span className="truncate text-sm text-secondary" title={sessionTitle}>{sessionTitle}</span>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <section>
          <div className="flex items-center gap-3 px-4 py-3">
            <span
              className={`inline-block h-2 w-2 shrink-0 rounded-full ${mainAgentRunning ? 'bg-emerald-500 animate-pulse' : 'bg-emerald-500/60'}`}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">{sessionTitle || i18nService.t('taskPanelMainAgent')}</div>
              <div className="text-xs text-muted" data-task-panel-main-agent-status={mainAgentRunning ? 'running' : 'idle'}>
                {i18nService.t('taskPanelMainAgent')} · {i18nService.t(mainAgentRunning ? 'taskPanelMainAgentRunning' : 'taskPanelMainAgentIdle')}
              </div>
            </div>
          </div>
        </section>

        <section>
          <SectionHeader
            title={i18nService.t('taskPanelSubagents')}
            aside={subagents.length > 0 ? String(subagents.length) : undefined}
            action={onOpenSubagents && subagents.length > 0 ? { label: i18nService.t('taskPanelViewAllSubagents'), onClick: onOpenSubagents } : undefined}
          />
          {subagents.length === 0 ? (
            <EmptyHint
              title={subagentsLoading ? i18nService.t('loading') : i18nService.t('taskPanelSubagentsEmpty')}
              hint={i18nService.t('taskPanelSubagentsHint')}
            />
          ) : (
            <div className="divide-y divide-border">
              {subagents.map(subagent => (
                <SubagentPanelRow
                  key={subagent.id}
                  subagent={subagent}
                  agents={agents}
                  onSelectSubagent={onSelectSubagent}
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <SectionHeader
            title={i18nService.t('taskPanelBackgroundJobs')}
            aside={orderedJobs.length > 0 ? jobCountLabel : undefined}
            action={onClearSettledJobs && settledCount > 0 ? { label: i18nService.t('taskPanelClearSettled'), onClick: () => { void onClearSettledJobs(); } } : undefined}
          />
          {orderedJobs.length === 0 ? (
            <EmptyHint
              title={jobsLoading ? i18nService.t('loading') : i18nService.t('taskPanelBackgroundJobsEmpty')}
              hint={i18nService.t('taskPanelBackgroundJobsHint')}
            />
          ) : (
            <div className="divide-y divide-border">
              {orderedJobs.map(job => (
                <BackgroundJobRow key={job.id} job={job} now={now} onKill={onKillJob} onCopy={onCopyJob} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default TaskPanelContent;
