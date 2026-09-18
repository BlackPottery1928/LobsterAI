import React from 'react';

// Task panel entry icon: a queue list, drawn with the same 1.5 stroke as the other header icons.
const TaskPanelIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3.5 5.5h13" />
    <rect x="3.5" y="9" width="13" height="7.5" rx="1.5" />
    <path d="M6.5 12.75h4" />
  </svg>
);

export default TaskPanelIcon;
