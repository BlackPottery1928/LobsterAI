import { ChevronRightIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useMemo, useRef, useState } from 'react';

import { ActivityEntryVariant } from './constants';
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
 * commands, read 2 files"). Expanding a multi-step group reveals a card with
 * one row per step, each expandable again for full detail; a single-step
 * group opens straight onto that step's content (the reasoning text, the
 * command and its output). Tool errors stay on their own step row (Codex app
 * behavior); they do not color or expand this header.
 */
const ActivityGroupBlock: React.FC<{
  entries: ActivityChunkEntry[];
  isStreamingTail?: boolean;
  renderEntry: (entry: ActivityChunkEntry, variant: ActivityEntryVariant) => React.ReactNode;
}> = ({ entries, isStreamingTail = false, renderEntry }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  const items = useMemo(() => entries.map((entry) => entry.item), [entries]);
  const summary = useMemo(() => getActivityGroupSummary(items), [items]);
  const diffStats = useMemo(() => getActivityGroupDiffStats(items), [items]);

  const lastItem = items[items.length - 1];
  const isLastItemLive = isActivityItemLive(lastItem);
  const showLiveAction = isStreamingTail && isLastItemLive;
  const headerLabel = showLiveAction
    ? getActivityCurrentActionText(lastItem)
    : getActivityGroupHeaderLabel(items);
  // The preview line only stands in for content that is folded away.
  const liveDetail = showLiveAction && !isExpanded ? getActivityLiveDetail(lastItem) : null;

  // A lone thought folds itself away once the model stops thinking, so an
  // opened reasoning stream does not linger above the work that follows.
  const isThinkingLive = entries.length === 1
    && lastItem.type === 'assistant'
    && lastItem.message.metadata?.isThinking === true
    && isLastItemLive;
  const wasThinkingLiveRef = useRef(isThinkingLive);
  useEffect(() => {
    if (wasThinkingLiveRef.current && !isThinkingLive) {
      setIsExpanded(false);
    }
    wasThinkingLiveRef.current = isThinkingLive;
  }, [isThinkingLive]);

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
      {isExpanded && (entries.length === 1 ? (
        <div className="mt-2 w-full" data-activity-group-detail="single">
          {renderEntry(entries[0], ActivityEntryVariant.Detail)}
        </div>
      ) : (
        <div className="mt-2 w-full overflow-hidden rounded-lg border border-border divide-y divide-border">
          {entries.map((entry) => renderEntry(entry, ActivityEntryVariant.Row))}
        </div>
      ))}
    </div>
  );
};

export default ActivityGroupBlock;
