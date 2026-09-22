import { ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useMemo, useState } from 'react';

import { bucketCount, reportConversationBlockAction } from './conversationAnalytics';
import {
  type ActivityChunkEntry,
  type ConsolidatedItem,
  getActivityCurrentActionText,
  getActivityGroupHeaderLabel,
  getActivityGroupSummary,
  getActivityLiveDetail,
  isActivityItemLive,
} from './messageDisplayUtils';
import { type DiffStats, DiffStatsBadge, getToolGroupDiffStats } from './toolDiffStats';

// Aggregate +N/-N line stats across the group's edit/write steps, shown in
// the collapsed header like the Claude Code app. Null when no step changed
// file content.
const getActivityGroupDiffStats = (items: ConsolidatedItem[]): DiffStats | null => {
  let added = 0;
  let removed = 0;
  let hasStats = false;
  for (const item of items) {
    if (item.type !== 'tool_group') continue;
    const stats = getToolGroupDiffStats(item.group);
    if (!stats) continue;
    added += stats.added;
    removed += stats.removed;
    hasStats = true;
  }
  return hasStats && (added > 0 || removed > 0) ? { added, removed } : null;
};

/**
 * Collapses a run of consecutive agent work items (tool calls, thinking,
 * media polling) behind a single summary line, following the Codex /
 * Claude Code app pattern: while streaming the header mirrors the latest
 * step and a muted line beneath it shows what that step is doing right now
 * (reasoning tail, latest command output, live +N/-M while a file is being
 * generated); once done it becomes a natural-language summary ("Ran 3
 * commands, read 2 files"). Expanding reveals a card with one row per step, and each
 * row can be expanded again for full detail. Tool errors stay on their own
 * step row (Codex app behavior); they do not color or expand this header.
 */
const ActivityGroupBlock: React.FC<{
  entries: ActivityChunkEntry[];
  isStreamingTail?: boolean;
  renderEntry: (
    entry: ActivityChunkEntry,
    options?: { initiallyExpanded?: boolean },
  ) => React.ReactNode;
}> = ({ entries, isStreamingTail = false, renderEntry }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const items = useMemo(() => entries.map((entry) => entry.item), [entries]);
  const summary = useMemo(() => getActivityGroupSummary(items), [items]);
  const diffStats = useMemo(() => getActivityGroupDiffStats(items), [items]);

  const lastItem = items[items.length - 1];
  const showLiveAction = isStreamingTail && isActivityItemLive(lastItem);
  const headerLabel = showLiveAction
    ? getActivityCurrentActionText(lastItem)
    : getActivityGroupHeaderLabel(items);
  const liveDetail = showLiveAction ? getActivityLiveDetail(lastItem) : null;

  const handleToggle = () => {
    const nextExpanded = !isExpanded;
    reportConversationBlockAction({
      actionType: nextExpanded ? 'activity_group_expand' : 'activity_group_collapse',
      blockType: 'activity_group',
      params: {
        stepCount: summary.stepCount,
        stepCountBucket: bucketCount(summary.stepCount),
        itemCount: entries.length,
        isStreaming: isStreamingTail,
      },
    });
    setIsExpanded(nextExpanded);
  };

  return (
    <div className="py-1">
      <button
        onClick={handleToggle}
        className="flex max-w-full items-center gap-1.5 text-left group"
        aria-expanded={isExpanded}
      >
        {/* Live and settled labels are separate elements. Toggling the shimmer
            class on one span made its text color transition from transparent,
            so every step that finished blinked for 150ms. */}
        {showLiveAction ? (
          <span key="live" data-activity-label="live" className="shimmer-text min-w-0 truncate text-sm text-secondary">
            {headerLabel}
          </span>
        ) : (
          <span
            key="settled"
            data-activity-label="settled"
            className="min-w-0 truncate text-sm text-secondary transition-colors group-hover:text-foreground"
          >
            {headerLabel}
          </span>
        )}
        {diffStats && <DiffStatsBadge stats={diffStats} className="text-sm" />}
        <ChevronRightIcon
          className={`h-3.5 w-3.5 text-muted group-hover:text-secondary flex-shrink-0 transition-transform duration-200 ${
            isExpanded ? 'rotate-90' : ''
          }`}
        />
      </button>
      {liveDetail && (
        <div
          className={`mt-0.5 max-w-full text-xs leading-5 text-muted ${
            liveDetail.kind === 'reasoning' ? 'line-clamp-2 italic' : 'truncate font-mono'
          }`}
          aria-live="polite"
          data-activity-live-detail={liveDetail.kind}
        >
          {liveDetail.text}
        </div>
      )}
      {isExpanded && (
        <div className="mt-2 w-full overflow-hidden rounded-lg border border-border divide-y divide-border">
          {entries.map((entry) => renderEntry(entry, { initiallyExpanded: entries.length === 1 }))}
        </div>
      )}
    </div>
  );
};

export default ActivityGroupBlock;
