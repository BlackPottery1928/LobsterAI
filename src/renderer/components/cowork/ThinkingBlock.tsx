import { ChevronRightIcon, LightBulbIcon } from '@heroicons/react/24/outline';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';
import { ActivityEntryVariant } from './constants';
import {
  bucketLength,
  getMessageLineCount,
  reportConversationBlockAction,
} from './conversationAnalytics';

// Within this distance of the bottom, streaming reasoning keeps following
// new text; scrolling further up pauses the follow until the user returns.
const REASONING_FOLLOW_THRESHOLD_PX = 24;

/**
 * Scrollable reasoning text. While the model is still thinking it stays
 * pinned to the newest line, so opening a live thought lands on what is
 * being written right now instead of its beginning.
 */
const ReasoningContent: React.FC<{
  content: string;
  followTail: boolean;
  className: string;
}> = ({ content, followTail, className }) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || !followTail || !pinnedToBottomRef.current) return;
    element.scrollTop = element.scrollHeight;
  }, [content, followTail]);

  const handleScroll = () => {
    const element = scrollRef.current;
    if (!element) return;
    pinnedToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight
      <= REASONING_FOLLOW_THRESHOLD_PX;
  };

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      className={className}
      data-reasoning-follow-tail={followTail ? 'true' : undefined}
    >
      {content}
    </div>
  );
};

const ThinkingBlock: React.FC<{
  message: CoworkMessage;
  mapDisplayText?: (value: string) => string;
  /**
   * 'default' renders the standalone card; 'row' a compact expandable row
   * among other steps; 'detail' just the reasoning text, for an activity
   * group whose only step is this thought.
   */
  variant?: 'default' | ActivityEntryVariant;
}> = ({ message, mapDisplayText, variant = 'default' }) => {
  const isCurrentlyStreaming = Boolean(message.metadata?.isStreaming);
  const isRowVariant = variant === ActivityEntryVariant.Row;
  const [isExpanded, setIsExpanded] = useState(
    isRowVariant ? false : isCurrentlyStreaming,
  );
  const displayContent = mapDisplayText ? mapDisplayText(message.content) : message.content;
  const handleToggleExpanded = () => {
    const nextExpanded = !isExpanded;
    reportConversationBlockAction({
      actionType: nextExpanded ? 'thinking_expand' : 'thinking_collapse',
      blockType: 'thinking',
      params: {
        isStreaming: isCurrentlyStreaming,
        thinkingLength: displayContent.length,
        thinkingLengthBucket: bucketLength(displayContent.length),
        thinkingLineCount: getMessageLineCount(displayContent),
      },
    });
    setIsExpanded(nextExpanded);
  };

  useEffect(() => {
    if (variant !== 'default') return;
    if (isCurrentlyStreaming) {
      setIsExpanded(true);
    } else {
      setIsExpanded(false);
    }
  }, [isCurrentlyStreaming, variant]);

  if (variant === ActivityEntryVariant.Detail) {
    return (
      <ReasoningContent
        content={displayContent}
        followTail={isCurrentlyStreaming}
        className="activity-row-detail max-h-[300px] overflow-y-auto rounded-lg border border-border px-4 py-3 leading-relaxed text-muted whitespace-pre-wrap break-words"
      />
    );
  }

  if (isRowVariant) {
    return (
      <div>
        <button
          onClick={handleToggleExpanded}
          className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-surface-raised/40 transition-colors"
          aria-expanded={isExpanded}
        >
          <LightBulbIcon className="h-3 w-3 text-secondary flex-shrink-0" />
          <span className="text-xs text-secondary">
            {i18nService.t('reasoning')}
          </span>
          {isCurrentlyStreaming && (
            <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse flex-shrink-0" />
          )}
          <ChevronRightIcon
            className={`h-3 w-3 text-muted flex-shrink-0 transition-transform duration-200 ${
              isExpanded ? 'rotate-90' : ''
            }`}
          />
        </button>
        {isExpanded && (
          <ReasoningContent
            content={displayContent}
            followTail={isCurrentlyStreaming}
            className="activity-row-detail px-4 pb-3 max-h-[300px] overflow-y-auto leading-relaxed text-muted whitespace-pre-wrap"
          />
        )}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-surface-sunken/50 overflow-hidden">
      <button
        onClick={handleToggleExpanded}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-raised/50 transition-colors"
      >
        <LightBulbIcon className="h-3.5 w-3.5 text-secondary flex-shrink-0" />
        <span className="text-xs font-medium text-secondary">
          {i18nService.t('reasoning')}
        </span>
        {isCurrentlyStreaming && (
          <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
        )}
        <ChevronRightIcon
          className={`h-3 w-3 text-secondary/60 flex-shrink-0 ml-auto transition-transform duration-200 ${
            isExpanded ? 'rotate-90' : ''
          }`}
        />
      </button>
      {isExpanded && (
        <div className="px-3 pb-3 max-h-[300px] overflow-y-auto border-t border-border/50">
          <div className="text-xs leading-relaxed text-muted whitespace-pre-wrap pt-2">
            {displayContent}
          </div>
        </div>
      )}
    </div>
  );
};

export default ThinkingBlock;
