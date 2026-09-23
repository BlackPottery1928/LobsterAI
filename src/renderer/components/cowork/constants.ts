export const CoworkUiEvent = {
  OpenShareOptions: 'cowork:open-share-options',
  SelectSubagent: 'cowork:select-subagent',
  FocusInput: 'cowork:focus-input',
  ShortcutSearch: 'cowork:shortcut:search',
  ShortcutConversationSearch: 'cowork:shortcut:conversation-search',
  ShortcutNewSession: 'cowork:shortcut:new-session',
  ShortcutStopSession: 'cowork:shortcut:stop-session',
  ShortcutToggleArtifacts: 'cowork:shortcut:toggle-artifacts',
  ShortcutSwitchAgent: 'cowork:shortcut:switch-agent',
  ShortcutShowCurrentAgentTasks: 'cowork:shortcut:show-current-agent-tasks',
  ShortcutCollapseCurrentAgentTasks: 'cowork:shortcut:collapse-current-agent-tasks',
  ShortcutOpenAgentTaskSlot: 'cowork:shortcut:open-agent-task-slot',
} as const;

export type CoworkUiEvent = typeof CoworkUiEvent[keyof typeof CoworkUiEvent];

export const CoworkTaskSearchRequestSource = {
  SidebarHeader: 'sidebar_header',
  WindowsTitleBar: 'windows_title_bar',
  KeyboardShortcut: 'keyboard_shortcut',
  UiEvent: 'ui_event',
} as const;

export type CoworkTaskSearchRequestSource =
  typeof CoworkTaskSearchRequestSource[keyof typeof CoworkTaskSearchRequestSource];

export interface CoworkTaskSearchRequestEventDetail {
  source?: CoworkTaskSearchRequestSource;
}

export const CoworkShortcutDirection = {
  Previous: 'previous',
  Next: 'next',
} as const;

export type CoworkShortcutDirection =
  typeof CoworkShortcutDirection[keyof typeof CoworkShortcutDirection];

/** How one step renders inside an expanded activity group. */
export const ActivityEntryVariant = {
  /** A compact row among the group's steps, expandable on its own. */
  Row: 'row',
  /** The step's content alone, for a group holding just that step. */
  Detail: 'detail',
} as const;

export type ActivityEntryVariant = typeof ActivityEntryVariant[keyof typeof ActivityEntryVariant];

export interface CoworkOpenShareOptionsEventDetail {
  sessionId: string;
}

export type CoworkSwitchAgentEventDetail = {
  direction: CoworkShortcutDirection;
};

export type CoworkOpenAgentTaskSlotEventDetail = {
  slot: number;
};
