import './workspaceChrome.css';

import { type CSSProperties, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { isTextLikeWorkspaceChange, type WorkspaceChangesSummary } from '../../../shared/artifactPreview/workspace';
import { i18nService } from '../../services/i18n';
import AnimatedNumber from './AnimatedNumber';

export default function CoworkChangesBadge({ snapshot, onReview }: {
  snapshot: WorkspaceChangesSummary | null;
  onReview: (path?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({});
  const id = useId();
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const margin = 12, gap = 8;
      const width = Math.min(360, window.innerWidth - margin * 2);
      const above = Math.max(0, rect.top - gap - margin);
      const below = Math.max(0, window.innerHeight - rect.bottom - gap - margin);
      const upward = above >= Math.min(370, popover.current?.scrollHeight || 370) || above >= below;
      setPosition({
        width, left: Math.max(margin, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - margin)),
        ...(upward ? { bottom: Math.max(margin, window.innerHeight - rect.top + gap) } : { top: Math.max(margin, rect.bottom + gap) }),
        maxHeight: Math.min(370, upward ? above : below),
      });
    };
    place();
    window.addEventListener('resize', place);
    document.addEventListener('scroll', place, true);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(place);
    if (root.current?.parentElement) observer?.observe(root.current.parentElement);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); observer?.disconnect(); };
  }, [open, snapshot]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent | FocusEvent) => { if (!root.current?.contains(event.target as Node) && !popover.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', outside); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', key, true); };
  }, [open]);
  // Only code/text edits count here; image and other binary changes stay in the review view.
  const files = snapshot?.files.filter(isTextLikeWorkspaceChange) ?? [];
  if (!snapshot || files.length === 0) return null;
  const excluded = snapshot.files.length - files.length;
  const count = Math.max(files.length, (snapshot.totalChangedFiles ?? snapshot.files.length) - excluded);
  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0);
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0);
  const label = i18nService.t('coworkFilesChanged').replace('{count}', String(count));
  const [labelPrefix, labelSuffix] = i18nService.t('coworkFilesChanged').split('{count}');
  return (
    <div ref={root} className="cowork-changes-popover-root">
      {open && createPortal(<div ref={popover} id={id} style={position} className="cowork-changes-popover" role="region" aria-label={label} onKeyDown={event => {
        if (event.key === 'Tab') {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
          if (document.activeElement === (event.shiftKey ? items[0] : items[items.length - 1])) {
            event.preventDefault(); setOpen(false); trigger.current?.focus();
          }
          return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        event.preventDefault(); items[next]?.focus();
      }}>
        {files.map(file => <button type="button" key={file.path} className="cowork-changes-file" title={file.path} onClick={() => { setOpen(false); onReview(file.path); }}><span>{file.path.split(/[\\/]/).pop()}</span><span className="cowork-changes-stat"><span className="cowork-changes-added">{file.added === null ? '—' : `+${file.added}`}</span><span className="cowork-changes-removed">{file.removed === null ? '—' : `-${file.removed}`}</span></span></button>)}
        {snapshot.truncated && <button type="button" className="cowork-changes-file" onClick={() => { setOpen(false); onReview(); }}>{i18nService.t('coworkTurnChangesTitle')}…</button>}
        {snapshot.statsIncomplete && <p className="cowork-changes-hint">{i18nService.t('coworkChangeStatsIncomplete')}</p>}
      </div>, document.body)}
      <button ref={trigger} type="button" data-cowork-changes-badge aria-expanded={open} aria-controls={id}
        onClick={() => setOpen(value => !value)}
        onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || (open && event.key === 'Tab' && !event.shiftKey)) { event.preventDefault(); setOpen(true); requestAnimationFrame(() => popover.current?.querySelector<HTMLButtonElement>('.cowork-changes-file')?.focus()); } }}
        title={i18nService.t(snapshot.statsIncomplete ? 'coworkChangeStatsIncomplete' : 'coworkTurnChangesTitle')}
        aria-label={`${label}, +${added} -${removed}${snapshot.statsIncomplete ? `, ${i18nService.t('coworkChangeStatsIncomplete')}` : ''}`}
        className="pointer-events-auto inline-flex h-9 min-w-0 max-w-full items-center justify-center gap-1 rounded-full border border-black/[0.06] bg-background px-3 text-[13px] font-normal leading-5 text-muted shadow-[0_1px_3px_rgba(0,0,0,0.025)] transition-colors hover:bg-surface-raised focus-visible:outline focus-visible:outline-2 focus-visible:outline-secondary dark:border-white/10">
        <AnimatedNumber value={count} prefix={labelPrefix ?? ''} suffix={labelSuffix ?? ''} className="min-w-0 tabular-nums" />
        <AnimatedNumber value={added} prefix="+" className="shrink-0 tabular-nums text-[#28a745] dark:text-green-400" />
        <AnimatedNumber value={removed} prefix="-" className="shrink-0 tabular-nums text-[#e5484d] dark:text-red-400" />
        {snapshot.statsIncomplete && <span className="shrink-0">*</span>}
      </button>
    </div>
  );
}
