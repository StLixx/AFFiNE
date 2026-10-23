import type { NoteBlockModel } from '@blocksuite/affine-model';
import { almostEqual, Bound } from '@blocksuite/global/gfx';
import { SignalWatcher, WithDisposable } from '@blocksuite/global/lit';
import { type EditorHost, ShadowlessElement } from '@blocksuite/std';
import { html } from 'lit';
import { property } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';

import { ACTIVE_NOTE_EXTRA_PADDING } from '../note-edgeless-block.css';

export class EdgelessNoteMask extends SignalWatcher(
  WithDisposable(ShadowlessElement)
) {
  protected override firstUpdated() {
    const maskDOM = this.renderRoot!.querySelector('.affine-note-mask');
    const observer = new ResizeObserver(entries => {
      if (this.model.store.readonly) return;
      for (const entry of entries) {
        if (!this.model.props.edgeless.collapse) {
          const bound = Bound.deserialize(this.model.xywh);
          const scale = this.model.props.edgeless.scale ?? 1;
          // The mask includes the editing hit-area outside the note. contentRect
          // is already in CSS coordinates (viewport zoom must not be applied).
          const extra = this.editing ? ACTIVE_NOTE_EXTRA_PADDING * 2 : 0;
          const height = (entry.contentRect.height - extra) * scale;

          if (
            !Number.isFinite(height) ||
            height <= 0 ||
            almostEqual(bound.h, height)
          ) {
            return;
          }

          bound.h = height;
          this.model.stash('xywh');
          this.model.xywh = bound.serialize();
          this.model.pop('xywh');
        }
      }
    });

    observer.observe(maskDOM!);

    this._disposables.add(() => {
      observer.disconnect();
    });
  }

  override render() {
    const extra = this.editing ? ACTIVE_NOTE_EXTRA_PADDING : 0;
    return html`
      <div
        class="affine-note-mask"
        style=${styleMap({
          position: 'absolute',
          top: `${-extra}px`,
          left: `${-extra}px`,
          bottom: `${-extra}px`,
          right: `${-extra}px`,
          zIndex: '1',
          pointerEvents: this.editing || this.disableMask ? 'none' : 'auto',
          borderRadius: `${
            this.model.props.edgeless.style.borderRadius * this.zoom
          }px`,
        })}
      ></div>
    `;
  }

  @property({ attribute: false })
  accessor disableMask!: boolean;

  @property({ attribute: false })
  accessor editing!: boolean;

  @property({ attribute: false })
  accessor host!: EditorHost;

  @property({ attribute: false })
  accessor model!: NoteBlockModel;

  @property({ attribute: false })
  accessor zoom!: number;
}

declare global {
  interface HTMLElementTagNameMap {
    'edgeless-note-mask': EdgelessNoteMask;
  }
}
