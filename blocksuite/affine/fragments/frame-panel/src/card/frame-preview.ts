import { ViewExtensionManagerIdentifier } from '@blocksuite/affine-ext-loader';
import type { FrameBlockModel } from '@blocksuite/affine-model';
import {
  DocModeExtension,
  DocModeProvider,
  ViewportElementExtension,
} from '@blocksuite/affine-shared/services';
import { DisposableGroup } from '@blocksuite/global/disposable';
import { Bound, deserializeXYWH } from '@blocksuite/global/gfx';
import { WithDisposable } from '@blocksuite/global/lit';
import {
  BlockStdScope,
  type EditorHost,
  LifeCycleWatcher,
  ShadowlessElement,
} from '@blocksuite/std';
import { GfxControllerIdentifier } from '@blocksuite/std/gfx';
import { type ExtensionType, type Query, type Store } from '@blocksuite/store';
import { css, html, nothing, type PropertyValues } from 'lit';
import { property, query, state } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import debounce from 'lodash-es/debounce';

import { getPreviewQueue } from './preview-queue.js';
// A single native readonly Store per original editor Store. Its fixed model/
// Yjs listeners are an explicitly retained cache; preview scopes are not cached.
const previewStores = new WeakMap<Store, Store>();
const connectedPreviews = new Set<FramePreview>();

const DEFAULT_PREVIEW_CONTAINER_WIDTH = 280;
const DEFAULT_PREVIEW_CONTAINER_HEIGHT = 166;

const styles = css`
  .frame-preview-container {
    display: block;
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    position: relative;
  }

  .frame-preview-surface-container {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    overflow: hidden;
  }

  .frame-preview-viewport {
    max-width: 100%;
    box-sizing: border-box;
    margin: 0 auto;
    position: relative;
    overflow: hidden;
    pointer-events: none;
    user-select: none;
  }

  .frame-preview-viewport
    > editor-host
    > affine-edgeless-root-preview
    > .edgeless-background {
    background-color: transparent;
    background-image: none;
  }
`;

export const AFFINE_FRAME_PREVIEW = 'frame-preview';

// A preview scope is disposable, never parked for reuse. Native host disconnect
// and an early cancellation before first connection share one release owner.
export class FramePreviewScope extends BlockStdScope {
  private released = false;

  override unmount() {
    if (this.released) return;
    this.released = true;
    super.unmount();
  }
}

export class FramePreview extends WithDisposable(ShadowlessElement) {
  static override styles = styles;

  private readonly _clearFrameDisposables = () => {
    this._frameDisposables?.dispose();
    this._frameDisposables = null;
  };

  private readonly _docFilter: Query = {
    mode: 'loose',
    match: [
      {
        flavour: 'affine:frame',
        viewType: 'hidden',
      },
    ],
  };

  private _frameDisposables: DisposableGroup | null = null;

  private _previewDoc: Store | null = null;

  private _previewScope: FramePreviewScope | null = null;

  private _previewHost: EditorHost | null = null;

  private _visibilityObserver: IntersectionObserver | null = null;

  private _visible = false;

  private _cancelPreview: (() => void) | null = null;

  private _watcherListeners = 0;

  static getDiagnostics(std: BlockStdScope) {
    const cards = [...connectedPreviews].filter(card => card.std === std);
    const store = previewStores.get(std.store);
    const surface = store?.getBlocksByFlavour('affine:surface')[0]?.model as
      | { localElementModels: Iterable<unknown> }
      | undefined;
    return {
      cachedLocalElements: surface
        ? Array.from(surface.localElementModels).length
        : 0,
      connectedCards: cards.length,
      scopes: cards.filter(card => card._previewScope).length,
      jobs: getPreviewQueue(std).size,
      scopedListeners: cards.reduce(
        (count, card) =>
          count +
          Number(!!card._visibilityObserver) +
          Number(!!card._frameDisposables) +
          card._watcherListeners,
        0
      ),
      cachedStores: Number(!!store),
      cachedBlocks: store?.blockSize ?? 0,
    };
  }

  private _runtimePreviewExt: ExtensionType[] = [];

  private get _viewExtensionManager() {
    return this.std.get(ViewExtensionManagerIdentifier);
  }

  private get _previewSpec() {
    return this._viewExtensionManager.get('preview-edgeless');
  }

  private readonly _updateFrameViewportWH = () => {
    const [, , w, h] = deserializeXYWH(this.frame.xywh);

    let scale = 1;
    if (this.fillScreen) {
      scale = Math.max(this.surfaceWidth / w, this.surfaceHeight / h);
    } else {
      scale = Math.min(this.surfaceWidth / w, this.surfaceHeight / h);
    }

    this.frameViewportWH = {
      width: w * scale,
      height: h * scale,
    };
  };

  get _originalDoc() {
    return this.frame.store;
  }

  private _initPreviewDoc() {
    const original = this._originalDoc;
    let store = previewStores.get(original);
    if (!store) {
      const doc = original.workspace.getDoc(original.id);
      store = doc?.getStore({ readonly: true, query: this._docFilter });
      if (store) previewStores.set(original, store);
    }
    this._previewDoc = store ?? null;
  }

  private _initSpec() {
    const refreshViewport = this._refreshViewport.bind(this);
    const updateListenerCount = (delta: number) => {
      this._watcherListeners += delta;
    };
    class FramePreviewWatcher extends LifeCycleWatcher {
      static override key = 'frame-preview-watcher';

      private readonly cleanup = new DisposableGroup();

      private watch<
        T extends { unsubscribe(): void; readonly closed: boolean },
      >(subscription: T) {
        updateListenerCount(1);
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          subscription.unsubscribe();
          updateListenerCount(-1);
        };
        this.cleanup.add(release);
        return release;
      }

      override unmounted() {
        this.cleanup.dispose();
      }

      override mounted() {
        const std = this.std;
        const { view } = std;
        this.watch(
          view.viewUpdated.subscribe(payload => {
            if (
              payload.type !== 'block' ||
              payload.method !== 'add' ||
              payload.view.model.flavour !== 'affine:page'
            ) {
              return;
            }
            const viewport = std.get(GfxControllerIdentifier).viewport;
            const subscription = viewport.sizeUpdated.subscribe(() => {
              release();
              refreshViewport();
            });
            const release = this.watch(subscription);
          })
        );
      }
    }

    const docModeService = this.std.get(DocModeProvider);
    this._runtimePreviewExt = [
      ViewportElementExtension('.frame-preview-viewport'),
      FramePreviewWatcher,
      DocModeExtension(docModeService),
    ];
  }

  private _refreshViewport() {
    const previewEditorHost = this.previewEditor;

    if (!previewEditorHost) return;

    const { viewport } = previewEditorHost.std.get(GfxControllerIdentifier);
    const frameBound = Bound.deserialize(this.frame.xywh);
    viewport.setViewportByBound(frameBound);
  }

  private _renderSurfaceContent() {
    const { width, height } = this.frameViewportWH;

    return html`<div
      class="frame-preview-surface-container"
      style=${styleMap({
        width: `${this.surfaceWidth}px`,
        height: `${this.surfaceHeight}px`,
      })}
    >
      <div
        class="frame-preview-viewport"
        style=${styleMap({
          width: `${width}px`,
          height: `${height}px`,
        })}
      >
        ${this._previewHost ?? nothing}
      </div>
    </div>`;
  }

  private _setFrameDisposables(frame: FrameBlockModel) {
    this._clearFrameDisposables();
    this._frameDisposables = new DisposableGroup();
    const update = debounce(this._updateFrameViewportWH, 10, { leading: true });
    this._frameDisposables.add(frame.propsUpdated.subscribe(update));
    this._frameDisposables.add(() => update.cancel());
  }

  private _releasePreview() {
    this._cancelPreview?.();
    this._cancelPreview = null;
    // Pending image requests otherwise retain detached bookmark DOM, its std
    // scope and the old panel through native browser pending-activity roots.
    // This host is permanently discarded; active or parked editors are untouched.
    for (const image of this._previewHost?.querySelectorAll('img') ?? []) {
      image.removeAttribute('srcset');
      image.removeAttribute('src');
    }
    // Connected hosts invoke the native unmount chain on removal. Also release
    // constructor-owned resources if cancellation happened before first connect.
    // FramePreviewScope makes these two paths one idempotent release.
    this._previewHost?.remove();
    this._previewScope?.unmount();
    this._previewHost = null;
    this._previewScope = null;
    this._previewDoc = null;
    this._runtimePreviewExt = [];
    this.requestUpdate();
  }

  private _schedulePreview() {
    if (this._cancelPreview || !this.isConnected || !this._visible) return;
    this._cancelPreview = getPreviewQueue(this.std).enqueue(async signal => {
      if (signal.aborted || !this.isConnected || !this._visible) return;
      try {
        this._initSpec();
        this._initPreviewDoc();
        if (!this._previewDoc) return;
        this._previewScope = new FramePreviewScope({
          store: this._previewDoc,
          extensions: this._previewSpec.concat(this._runtimePreviewExt),
        });
        this._previewHost = this._previewScope.render();
        this.requestUpdate();
        await this.updateComplete;
        if (signal.aborted || !this.isConnected) return;
        // The lane owns construction and our DOM commit. EditorHost's completion
        // recursively awaits every descendant; keeping that unrelated async work
        // in this lane starves other already-visible cards. Native Lit updates and
        // the size watcher finish their rendering without owning this lane.
        this._refreshViewport();
      } catch (error) {
        if (!signal.aborted) this._releasePreview();
        throw error;
      }
    });
  }

  override connectedCallback() {
    super.connectedCallback();
    connectedPreviews.add(this);
    this._updateFrameViewportWH();
    this._setFrameDisposables(this.frame);
    this._visibilityObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (entry.target !== this) continue;
        this._visible = entry.isIntersecting;
        if (this._visible) this._schedulePreview();
        else this._releasePreview();
      }
    });
    this._visibilityObserver.observe(this);
  }

  override disconnectedCallback() {
    this._visible = false;
    this._visibilityObserver?.disconnect();
    this._visibilityObserver = null;
    this._releasePreview();
    this._clearFrameDisposables();
    connectedPreviews.delete(this);
    super.disconnectedCallback();
  }

  override render() {
    const { frame } = this;
    const noContent = !frame || !frame.xywh;

    return html`<div class="frame-preview-container">
      ${noContent ? nothing : this._renderSurfaceContent()}
    </div>`;
  }

  override willUpdate(_changedProperties: PropertyValues) {
    if (_changedProperties.has('frame')) {
      this._setFrameDisposables(this.frame);
      this._updateFrameViewportWH();
      this._releasePreview();
      this._schedulePreview();
    }
  }

  override updated(_changedProperties: PropertyValues) {
    if (_changedProperties.has('frameViewportWH')) {
      this._refreshViewport();
    }
  }

  @property({ attribute: false })
  accessor std!: BlockStdScope;

  @state()
  accessor fillScreen = false;

  @property({ attribute: false })
  accessor frame!: FrameBlockModel;

  @state()
  accessor frameViewportWH = {
    width: 0,
    height: 0,
  };

  @query('editor-host')
  accessor previewEditor: EditorHost | null = null;

  @property({ attribute: false })
  accessor surfaceHeight: number = DEFAULT_PREVIEW_CONTAINER_HEIGHT;

  @property({ attribute: false })
  accessor surfaceWidth: number = DEFAULT_PREVIEW_CONTAINER_WIDTH;
}
