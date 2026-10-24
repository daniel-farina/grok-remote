// Desktop details panel: a right-hand column next to the thread that shows a
// tool run's thoughts and calls in full, or the agent's files. Closed until
// the user opens a run (or the Files button).

import { el } from './render.js';

export interface DetailsPanelOpts {
  /** Mount the Files browser into this element. */
  mountFiles: (into: HTMLElement) => void;
  /** Called when the panel closes or leaves the Files tab (to unmount Files). */
  onFilesHidden?: () => void;
  onClose?: () => void;
}

type Tab = 'run' | 'files';

export class DetailsPanel {
  readonly el: HTMLElement;
  private opts: DetailsPanelOpts;
  private titleEl: HTMLElement;
  private runBody: HTMLElement;
  private filesBody: HTMLElement;
  private tabBtns: Record<Tab, HTMLElement>;
  private tab: Tab = 'run';
  private filesShown = false;

  constructor(opts: DetailsPanelOpts) {
    this.opts = opts;
    this.titleEl = el('div', { class: 'details-panel__title' });
    this.runBody = el('div', { class: 'details-panel__body details-panel__body--run' });
    this.filesBody = el('div', { class: 'details-panel__body details-panel__body--files', hidden: true });
    const tabBtn = (key: Tab, label: string) => el('button', {
      type: 'button', class: 'details-panel__tab',
      onclick: () => (key === 'files' ? this.showFiles() : this.setTab('run')),
    }, label);
    this.tabBtns = { run: tabBtn('run', 'Tool run'), files: tabBtn('files', 'Files') };
    const close = el('button', {
      type: 'button', class: 'details-panel__close', title: 'Close panel', 'aria-label': 'Close panel',
      onclick: () => this.close(),
    }, '×');
    this.el = el('aside', { class: 'details-panel', hidden: true, 'aria-label': 'Details' },
      el('div', { class: 'details-panel__head' }, this.tabBtns.run, this.tabBtns.files, el('span', { class: 'details-panel__spacer' }), close),
      this.titleEl,
      this.runBody,
      this.filesBody,
    );
  }

  showRun(title: string, content: HTMLElement): void {
    this.titleEl.textContent = title;
    if (content.parentNode !== this.runBody) this.runBody.replaceChildren(content);
    this.setTab('run');
    this.open();
  }

  setRunTitle(title: string): void { this.titleEl.textContent = title; }

  showFiles(): void {
    if (!this.filesShown) {
      this.opts.mountFiles(this.filesBody);
      this.filesShown = true;
    }
    this.setTab('files');
    this.open();
  }

  /** The Files browser was taken over elsewhere (it is a singleton). */
  filesTakenElsewhere(): void {
    this.filesShown = false;
    this.filesBody.replaceChildren();
    if (this.tab === 'files') this.close();
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    this.releaseFiles();
    if (this.opts.onClose) this.opts.onClose();
  }

  isOpen(): boolean { return !this.el.hidden; }
  currentTab(): Tab { return this.tab; }

  private open(): void { this.el.hidden = false; }

  private setTab(tab: Tab): void {
    if (this.tab === 'files' && tab !== 'files') this.releaseFiles();
    this.tab = tab;
    this.runBody.hidden = tab !== 'run';
    this.titleEl.hidden = tab !== 'run';
    this.filesBody.hidden = tab !== 'files';
    this.tabBtns.run.classList.toggle('details-panel__tab--active', tab === 'run');
    this.tabBtns.files.classList.toggle('details-panel__tab--active', tab === 'files');
  }

  private releaseFiles(): void {
    if (!this.filesShown) return;
    this.filesShown = false;
    this.filesBody.replaceChildren();
    if (this.opts.onFilesHidden) this.opts.onFilesHidden();
  }
}
