import { syntaxTree } from '@codemirror/language';
import { type EditorState, type Extension, type Range, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import type { MarkdownConfig } from '@lezer/markdown';
import katex from 'katex';
import { createRoot, type Root } from 'react-dom/client';

import MarkdownContent, { safeUrlTransform } from '@/components/MarkdownContent';
import { i18nService } from '@/services/i18n';

import { markdownPreviewReferences, withMarkdownReferenceDefinitions } from './markdownPreviewReferences';

const Syntax = {
  Paragraph: 'Paragraph', Strong: 'StrongEmphasis', Emphasis: 'Emphasis', Strike: 'Strikethrough',
  InlineCode: 'InlineCode', HeaderMark: 'HeaderMark', EmphasisMark: 'EmphasisMark',
  StrikeMark: 'StrikethroughMark', CodeMark: 'CodeMark', Link: 'Link', LinkMark: 'LinkMark',
  Url: 'URL', LinkTitle: 'LinkTitle', LinkLabel: 'LinkLabel', Image: 'Image', Quote: 'Blockquote', QuoteMark: 'QuoteMark',
  ListMark: 'ListMark', TaskMarker: 'TaskMarker', Table: 'Table', FencedCode: 'FencedCode',
  CodeBlock: 'CodeBlock', Rule: 'HorizontalRule', Math: 'InlineMath',
} as const;

export const markdownMathSyntax: MarkdownConfig = {
  defineNodes: [Syntax.Math],
  parseInline: [{
    name: Syntax.Math,
    parse(context, next, position) {
      if (next !== 36 || context.char(position + 1) === 36 || /\s/.test(context.slice(position + 1, position + 2))) return -1;
      for (let end = position + 1; end < context.end; end++) {
        if (context.char(end) === 10) break;
        if (context.char(end) === 92) { end++; continue; }
        if (context.char(end) === 36) return context.addElement(context.elt(Syntax.Math, position, end + 1));
      }
      return -1;
    },
  }],
};

export interface MarkdownPreviewOptions {
  resolveLocalFilePath?: (href: string, text: string) => string | null;
}

const focusChanged = StateEffect.define<boolean>();

class PreviewBlock extends WidgetType {
  private roots = new Map<HTMLElement, { root: Root; observer: ResizeObserver }>();

  constructor(readonly source: string, readonly from: number, readonly options: MarkdownPreviewOptions) {
    super();
  }

  eq(other: PreviewBlock): boolean {
    return this.source === other.source && this.from === other.from;
  }

  toDOM(view: EditorView): HTMLElement {
    const element = document.createElement('div');
    element.className = 'md-preview-block';
    element.tabIndex = 0;
    element.setAttribute('aria-label', i18nService.t('markdownEditorEditBlock'));
    const edit = () => {
      view.dispatch({ selection: { anchor: this.from }, effects: focusChanged.of(true) });
      view.focus();
    };
    element.addEventListener('mousedown', event => {
      if ((event.target as Element).closest('a, button, input')) return;
      event.preventDefault();
      event.stopPropagation();
      edit();
    }, { capture: true });
    element.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.target !== element) return;
      event.preventDefault();
      edit();
    });
    const root = createRoot(element);
    const observer = new ResizeObserver(() => view.requestMeasure());
    observer.observe(element);
    this.roots.set(element, { root, observer });
    root.render(<MarkdownContent content={this.source} resolveLocalFilePath={this.options.resolveLocalFilePath} enableLargePreview={false} />);
    return element;
  }

  destroy(element: HTMLElement): void {
    const mounted = this.roots.get(element);
    if (!mounted) return;
    mounted.observer.disconnect();
    this.roots.delete(element);
    // The parent editor may be unmounting in a React commit.
    queueMicrotask(() => mounted.root.unmount());
  }

  ignoreEvent(): boolean { return true; }
}

class TaskCheckbox extends WidgetType {
  constructor(readonly from: number, readonly checked: boolean) { super(); }
  eq(other: TaskCheckbox): boolean { return this.from === other.from && this.checked === other.checked; }
  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'md-task-checkbox';
    input.checked = this.checked;
    input.setAttribute('aria-label', i18nService.t('markdownEditorToggleTask'));
    input.addEventListener('mousedown', event => event.preventDefault());
    input.addEventListener('change', () => {
      view.dispatch({ changes: { from: this.from + 1, to: this.from + 2, insert: input.checked ? 'x' : ' ' } });
    });
    return input;
  }
  ignoreEvent(): boolean { return true; }
}

class Bullet extends WidgetType {
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.textContent = '•';
    span.className = 'md-list-mark';
    return span;
  }
}

class InlineMath extends WidgetType {
  constructor(readonly source: string, readonly from: number) { super(); }
  eq(other: InlineMath): boolean { return this.source === other.source && this.from === other.from; }
  toDOM(view: EditorView): HTMLElement {
    const span = document.createElement('span');
    katex.render(this.source.slice(1, -1), span, { throwOnError: false, trust: false });
    span.addEventListener('mousedown', event => {
      event.preventDefault();
      view.dispatch({ selection: { anchor: this.from + 1 }, effects: focusChanged.of(true) });
      view.focus();
    });
    return span;
  }
}

function decorate(state: EditorState, focused: boolean, options: MarkdownPreviewOptions): DecorationSet {
  const references = state.field(markdownPreviewReferences);
  const decorations: Range<Decoration>[] = [];
  const selectionLines = state.selection.ranges.map(range => ({
    from: state.doc.lineAt(range.from).from, to: state.doc.lineAt(range.to).to,
  }));
  const active = (from: number, to: number) => focused
    && selectionLines.some(selection => selection.from <= to && selection.to >= from);
  const mark = (from: number, to: number, className: string, attributes?: Record<string, string>) => {
    if (from < to) decorations.push(Decoration.mark({ class: className, attributes }).range(from, to));
  };
  const hide = (from: number, to: number) => {
    if (from < to) decorations.push(Decoration.replace({}).range(from, to));
  };
  const lines = (from: number, to: number, className: string) => {
    for (let number = state.doc.lineAt(from).number; number <= state.doc.lineAt(to).number; number++) {
      decorations.push(Decoration.line({ class: className }).range(state.doc.line(number).from));
    }
  };
  const text = state.doc.toString();
  const metadataEnd = text.match(/^\uFEFF?---\n[\s\S]*?\n(?:---|\.\.\.)(?:\n|$)/)?.[0].length ?? 0;
  if (metadataEnd) lines(0, metadataEnd - 1, 'md-metadata');

  syntaxTree(state).iterate({
    enter(node) {
      const { from, to, name } = node;
      if (to <= metadataEnd) return false;
      const editing = active(from, to);
      const source = text.slice(from, to);
      const heading = /^(?:ATX|Setext)Heading([1-6])$/.exec(name);
      if (heading) lines(from, to, `md-heading md-heading-${heading[1]}`);
      const block = name === Syntax.Table || name === Syntax.FencedCode || name === Syntax.CodeBlock
        || name === Syntax.Rule || (name === Syntax.Paragraph && (
          /^\$\$[\s\S]*\$\$$/.test(source.trim())
          || (node.node.firstChild?.name === Syntax.Image && node.node.firstChild.to === to)
        ));
      if (block && !editing && state.doc.lineAt(from).from === from) {
        const previewSource = name === Syntax.Table || name === Syntax.Paragraph
          ? withMarkdownReferenceDefinitions(source, references) : source;
        decorations.push(Decoration.replace({
          widget: new PreviewBlock(previewSource, from, options), block: true,
        }).range(from, to));
        return false;
      }
      switch (name) {
        case Syntax.Strong: mark(from, to, 'md-strong'); break;
        case Syntax.Emphasis: mark(from, to, 'md-emphasis'); break;
        case Syntax.Strike: mark(from, to, 'md-strike'); break;
        case Syntax.InlineCode: mark(from, to, 'md-inline-code'); break;
        case Syntax.Quote: lines(from, to, 'md-quote'); break;
        case Syntax.Table: lines(from, to, 'md-source-block'); break;
        case Syntax.FencedCode:
        case Syntax.CodeBlock: lines(from, to, 'md-code-line'); break;
        case Syntax.HeaderMark:
        case Syntax.QuoteMark:
          if (!editing) hide(from, text[to] === ' ' ? to + 1 : to);
          else mark(from, to, 'md-syntax');
          break;
        case Syntax.EmphasisMark:
        case Syntax.StrikeMark:
        case Syntax.CodeMark:
          if (!editing) hide(from, to);
          else mark(from, to, 'md-syntax');
          break;
        case Syntax.ListMark:
          if (!editing && /^[*+-]$/.test(source)) decorations.push(Decoration.replace({ widget: new Bullet() }).range(from, to));
          else mark(from, to, 'md-list-mark');
          break;
        case Syntax.Math:
          if (!editing) decorations.push(Decoration.replace({ widget: new InlineMath(source, from) }).range(from, to));
          break;
        case Syntax.TaskMarker:
          if (!editing) decorations.push(Decoration.replace({ widget: new TaskCheckbox(from, /[xX]/.test(source)) }).range(from, to));
          break;
        case Syntax.Link: {
          const url = node.node.getChild(Syntax.Url);
          const link = references.links.get(from);
          if (url || link?.to === to) {
            const href = safeUrlTransform(link ? link.url : text.slice(url!.from, url!.to));
            mark(from, to, 'md-link', {
              'data-md-href': href,
              ...(link?.title ? { title: link.title } : {}),
            });
          }
          break;
        }
        case Syntax.LinkMark:
        case Syntax.Url:
        case Syntax.LinkTitle:
        case Syntax.LinkLabel: {
          const parent = node.node.parent;
          if (parent?.name === Syntax.Link && !active(parent.from, parent.to)
            && (parent.getChild(Syntax.Url) || references.links.get(parent.from)?.to === parent.to)) hide(from, to);
          break;
        }
      }
    },
  });
  return Decoration.set(decorations, true);
}

/** Rendering is a view over the original Markdown. Decorations never rewrite the document. */
export function markdownLivePreview(options: MarkdownPreviewOptions): Extension {
  const field = StateField.define<{ focused: boolean; decorations: DecorationSet }>({
    create: state => ({ focused: false, decorations: decorate(state, false, options) }),
    update(value, transaction) {
      // Reveal syntax only after CodeMirror has placed the selection. Reflowing
      // on the DOM focus event can move the text between mousedown and mouseup.
      let focused = transaction.docChanged || transaction.selection ? true : value.focused;
      for (const effect of transaction.effects) if (effect.is(focusChanged)) focused = effect.value;
      return transaction.docChanged || transaction.selection || focused !== value.focused
        || syntaxTree(transaction.state) !== syntaxTree(transaction.startState)
        ? { focused, decorations: decorate(transaction.state, focused, options) } : value;
    },
    provide: extension => EditorView.decorations.from(extension, value => value.decorations),
  });
  return [markdownPreviewReferences, field, EditorView.domEventHandlers({
    blur: (_event, view) => { view.dispatch({ effects: focusChanged.of(false) }); },
    click: (event, view) => {
      const href = (event.target as Element).closest('[data-md-href]')?.getAttribute('data-md-href');
      if (!href || (!event.metaKey && !event.ctrlKey)) return false;
      event.preventDefault();
      if (/^https?:\/\//i.test(href)) void window.electron.shell.openExternal(href);
      else {
        const path = options.resolveLocalFilePath?.(href, '');
        if (path) void window.electron.shell.openPath(path);
      }
      view.focus();
      return true;
    },
  })];
}
