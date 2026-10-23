import {
  type FrameBlockModel,
  type NoteBlockModel,
  NoteBlockSchemaExtension,
  RootBlockSchemaExtension,
} from '@blocksuite/affine-model';
import {
  GfxBlockElementModel,
  type GfxLocalElementModel,
  leaseReadonlyLocalElement,
  type SurfaceBlockModel,
} from '@blocksuite/std/gfx';
import { BlockStdScope, EditorHost, LifeCycleWatcher } from '@blocksuite/std';
import type { Store } from '@blocksuite/store';
import { TestWorkspace } from '@blocksuite/store/test';
import { signal } from '@preact/signals-core';
import { html } from 'lit';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EdgelessNoteMask } from '../../../blocks/note/src/components/edgeless-note-mask';
import {
  FramePreview,
  FramePreviewScope,
} from '../../../fragments/frame-panel/src/card/frame-preview';
import {
  getPreviewQueue,
  PreviewQueue,
} from '../../../fragments/frame-panel/src/card/preview-queue';

class PreviewProbe extends FramePreview {
  override render() {
    return html``;
  }
}

if (!customElements.get('xenica-frame-preview-probe')) {
  customElements.define('xenica-frame-preview-probe', PreviewProbe);
}
if (!customElements.get('editor-host')) {
  customElements.define('editor-host', EditorHost);
}
if (!customElements.get('edgeless-note-mask')) {
  customElements.define('edgeless-note-mask', EdgelessNoteMask);
}

let resize: ResizeObserverCallback;

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Frames preview runtime ownership', () => {
  it('does not allocate a readonly store before an offscreen card becomes visible', async () => {
    const preview = new PreviewProbe();
    const lifecycle = preview as unknown as {
      _initSpec(): void;
      _initPreviewDoc(): void;
      _updateFrameViewportWH(): void;
      _setFrameDisposables(frame: FrameBlockModel): void;
    };
    vi.spyOn(lifecycle, '_initSpec').mockImplementation(() => {});
    const allocate = vi
      .spyOn(lifecycle, '_initPreviewDoc')
      .mockImplementation(() => {});
    vi.spyOn(lifecycle, '_updateFrameViewportWH').mockImplementation(() => {});
    vi.spyOn(lifecycle, '_setFrameDisposables').mockImplementation(() => {});
    preview.frame = { xywh: '[0,0,100,100]' } as unknown as FrameBlockModel;
    document.body.append(preview);
    await preview.updateComplete;
    expect(allocate).not.toHaveBeenCalled();
  });
});

describe('native initial viewport readiness', () => {
  it('does not let a late event from a cancelled owner release the next owner', async () => {
    const preview = new PreviewProbe();
    const viewUpdated = new Subject<unknown>();
    const sizeUpdated = new Subject<unknown>();
    const owner = {
      view: { viewUpdated },
      get: () => ({ viewport: { sizeUpdated } }),
    } as unknown as BlockStdScope;
    preview.std = owner;
    const lifecycle = preview as unknown as {
      _watcherListeners: number;
      _runtimePreviewExt: {
        key?: string;
        new (std: BlockStdScope): LifeCycleWatcher;
      }[];
      _initSpec(): Promise<void>;
      _refreshViewport(): void;
      _releasePreview(): void;
    };
    vi.spyOn(lifecycle, '_refreshViewport').mockImplementation(() => {});
    const first = lifecycle._initSpec();
    const FirstWatcher = lifecycle._runtimePreviewExt.find(
      ext => ext.key === 'frame-preview-watcher'
    )!;
    const firstWatcher = new FirstWatcher(owner);
    firstWatcher.mounted();
    viewUpdated.next({
      type: 'block',
      method: 'add',
      view: { model: { flavour: 'affine:page' } },
    });
    lifecycle._releasePreview();
    await first;
    let nextReady = false;
    const next = lifecycle._initSpec().then(() => {
      nextReady = true;
    });
    sizeUpdated.next({});
    await Promise.resolve();
    expect(nextReady).toBe(false);
    firstWatcher.unmounted();
    const NextWatcher = lifecycle._runtimePreviewExt.find(
      ext => ext.key === 'frame-preview-watcher'
    )!;
    const nextWatcher = new NextWatcher(owner);
    nextWatcher.mounted();
    viewUpdated.next({
      type: 'block',
      method: 'add',
      view: { model: { flavour: 'affine:page' } },
    });
    sizeUpdated.next({});
    await next;
    expect(nextReady).toBe(true);
    nextWatcher.unmounted();
    expect(lifecycle._watcherListeners).toBe(0);
    lifecycle._releasePreview();
    viewUpdated.complete();
    sizeUpdated.complete();
  });

  it('waits for the first native viewport event and releases cancelled readiness', async () => {
    const preview = new PreviewProbe();
    const viewUpdated = new Subject<unknown>();
    const sizeUpdated = new Subject<unknown>();
    const owner = {
      view: { viewUpdated },
      get: () => ({ viewport: { sizeUpdated } }),
    } as unknown as BlockStdScope;
    preview.std = owner;
    const lifecycle = preview as unknown as {
      _watcherListeners: number;
      _runtimePreviewExt: {
        key?: string;
        new (std: BlockStdScope): LifeCycleWatcher;
      }[];
      _initSpec(): Promise<void>;
      _refreshViewport(): void;
      _releasePreview(): void;
    };
    const refresh = vi
      .spyOn(lifecycle, '_refreshViewport')
      .mockImplementation(() => {});
    let ready = false;
    const promise = Promise.resolve(lifecycle._initSpec()).then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    const Watcher = lifecycle._runtimePreviewExt.find(
      ext => ext.key === 'frame-preview-watcher'
    )!;
    const watcher = new Watcher(owner);
    watcher.mounted();
    viewUpdated.next({
      type: 'block',
      method: 'add',
      view: { model: { flavour: 'affine:page' } },
    });
    await Promise.resolve();
    expect(ready).toBe(false);
    sizeUpdated.next({});
    await promise;
    expect(ready).toBe(true);
    expect(refresh).toHaveBeenCalledOnce();
    watcher.unmounted();
    expect(lifecycle._watcherListeners).toBe(0);
    const cancelled = lifecycle._initSpec();
    lifecycle._releasePreview();
    await cancelled;
  });
});

describe('discarded preview media ownership', () => {
  it('stops image requests only inside its permanently discarded native host', () => {
    const preview = new PreviewProbe();
    const ownedHost = document.createElement('div');
    const ownedImage = document.createElement('img');
    ownedImage.setAttribute('src', 'https://example.test/shared-icon.png');
    ownedImage.setAttribute(
      'srcset',
      'https://example.test/shared-icon-2x.png 2x'
    );
    ownedHost.append(ownedImage);
    const activeImage = document.createElement('img');
    activeImage.setAttribute('src', 'https://example.test/shared-icon.png');
    activeImage.setAttribute(
      'srcset',
      'https://example.test/shared-icon-2x.png 2x'
    );
    document.body.append(ownedHost, activeImage);
    const lifecycle = preview as unknown as {
      _previewHost: HTMLElement | null;
      _previewScope: object | null;
      _releasePreview(): void;
    };
    lifecycle._previewHost = ownedHost;
    lifecycle._previewScope = null;
    lifecycle._releasePreview();
    expect(ownedHost.isConnected).toBe(false);
    expect(ownedImage.hasAttribute('src')).toBe(false);
    expect(ownedImage.hasAttribute('srcset')).toBe(false);
    expect(activeImage.getAttribute('src')).toBe(
      'https://example.test/shared-icon.png'
    );
    expect(activeImage.getAttribute('srcset')).toBe(
      'https://example.test/shared-icon-2x.png 2x'
    );
    expect(lifecycle._previewHost).toBe(null);
    expect(lifecycle._previewScope).toBe(null);
  });

  it('releases created native scope resources even if its host never connected', () => {
    const workspace = new TestWorkspace();
    workspace.meta.initialize();
    const doc = workspace.createDoc('unconnected-preview');
    doc.load();
    const store = doc.getStore({ extensions: [RootBlockSchemaExtension] });
    store.addBlock('affine:page');
    let created = 0;
    let released = 0;
    class CreatedResourceProbe extends LifeCycleWatcher {
      static override key = 'xenica-preview-created-resource-probe';
      override created() {
        created++;
      }
      override unmounted() {
        released++;
      }
    }
    const before = JSON.stringify(store.spaceDoc.toJSON());
    const scope = new BlockStdScope({
      store,
      extensions: [CreatedResourceProbe],
    });
    const preview = new PreviewProbe();
    const lifecycle = preview as unknown as {
      _previewHost: HTMLElement | null;
      _previewScope: BlockStdScope | null;
      _releasePreview(): void;
    };
    lifecycle._previewHost = document.createElement('div');
    lifecycle._previewScope = scope;
    expect(created).toBe(1);
    expect(lifecycle._previewHost.isConnected).toBe(false);
    lifecycle._releasePreview();
    expect(released).toBe(1);
    lifecycle._releasePreview();
    expect(released).toBe(1);
    expect(JSON.stringify(store.spaceDoc.toJSON())).toBe(before);
    store.dispose();
    workspace.doc.destroy();
  });

  it('unmounts each disposable preview scope once across both native and owner paths', async () => {
    const workspace = new TestWorkspace();
    workspace.meta.initialize();
    const doc = workspace.createDoc('preview-release-once');
    doc.load();
    const store = doc.getStore({ extensions: [RootBlockSchemaExtension] });
    store.addBlock('affine:page');
    let released = 0;
    let mounted = 0;
    class NativeReleaseProbe extends LifeCycleWatcher {
      static override key = 'xenica-preview-native-release-probe';
      override mounted() {
        mounted++;
      }
      override unmounted() {
        released++;
      }
    }
    const scope = new FramePreviewScope({
      store,
      extensions: [NativeReleaseProbe],
    });
    const host = scope.render();
    vi.spyOn(host, 'render').mockReturnValue(html``);
    document.body.append(host);
    await host.updateComplete;
    expect(mounted).toBe(1);
    const preview = new PreviewProbe();
    const lifecycle = preview as unknown as {
      _previewHost: EditorHost | null;
      _previewScope: FramePreviewScope | null;
      _releasePreview(): void;
    };
    lifecycle._previewHost = host;
    lifecycle._previewScope = scope;
    lifecycle._releasePreview();
    scope.unmount();
    expect(host.isConnected).toBe(false);
    expect(released).toBe(1);
    store.dispose();
    workspace.doc.destroy();
  });

  it('leaves unrelated images alone when no preview host is owned', () => {
    const preview = new PreviewProbe();
    const activeImage = document.createElement('img');
    activeImage.setAttribute('src', 'https://example.test/active.png');
    document.body.append(activeImage);
    const lifecycle = preview as unknown as { _releasePreview(): void };
    lifecycle._releasePreview();
    lifecycle._releasePreview();
    expect(activeImage.getAttribute('src')).toBe(
      'https://example.test/active.png'
    );
  });
});

describe('Note measured geometry', () => {
  it('does not persist editing-only mask padding as document height', async () => {
    const model = {
      xywh: '[10,20,300,200]',
      store: { readonly: false },
      props: {
        edgeless: { scale: 2, collapse: false, style: { borderRadius: 0 } },
      },
      stash: vi.fn(),
      pop: vi.fn(),
    } as unknown as NoteBlockModel;
    const mask = new EdgelessNoteMask();
    mask.model = model;
    mask.editing = true;
    mask.disableMask = true;
    mask.zoom = 1;
    document.body.append(mask);
    await mask.updateComplete;
    resize(
      [{ contentRect: { height: 140 } }] as ResizeObserverEntry[],
      {} as ResizeObserver
    );
    expect(JSON.parse(model.xywh)).toEqual([10, 20, 300, 200]);
  });
});

describe('Note geometry boundaries', () => {
  it.each([
    { editing: false, scale: 2, zoom: 0.5, measured: 120, expected: 240 },
    { editing: true, scale: 2, zoom: 3, measured: 160, expected: 240 },
    { editing: false, scale: 1, zoom: 3, measured: 120, expected: 120 },
  ])(
    'uses logical content height at scale $scale / zoom $zoom',
    async options => {
      const model = {
        xywh: '[10,20,300,200]',
        store: { readonly: false },
        props: {
          edgeless: {
            scale: options.scale,
            collapse: false,
            style: { borderRadius: 0 },
          },
        },
        stash: vi.fn(),
        pop: vi.fn(),
      } as unknown as NoteBlockModel;
      const mask = new EdgelessNoteMask();
      Object.assign(mask, {
        model,
        editing: options.editing,
        disableMask: true,
        zoom: options.zoom,
      });
      document.body.append(mask);
      await mask.updateComplete;
      resize(
        [
          { contentRect: { height: options.measured } },
        ] as ResizeObserverEntry[],
        {} as ResizeObserver
      );
      expect(JSON.parse(model.xywh)).toEqual([10, 20, 300, options.expected]);
    }
  );

  it.each([
    { readonly: true, collapse: false, height: 140 },
    { readonly: false, collapse: true, height: 140 },
    { readonly: false, collapse: false, height: 0 },
    { readonly: false, collapse: false, height: 20 },
    { readonly: false, collapse: false, height: NaN },
    { readonly: false, collapse: false, height: Infinity },
  ])(
    'does not write readonly/collapsed/invalid measurements %#',
    async options => {
      const model = {
        xywh: '[10,20,300,200]',
        store: { readonly: options.readonly },
        props: {
          edgeless: {
            scale: 2,
            collapse: options.collapse,
            style: { borderRadius: 0 },
          },
        },
        stash: vi.fn(),
        pop: vi.fn(),
      } as unknown as NoteBlockModel;
      const mask = new EdgelessNoteMask();
      Object.assign(mask, { model, editing: true, disableMask: true, zoom: 1 });
      document.body.append(mask);
      await mask.updateComplete;
      resize(
        [{ contentRect: { height: options.height } }] as ResizeObserverEntry[],
        {} as ResizeObserver
      );
      expect(model.xywh).toBe('[10,20,300,200]');
      expect(model.stash).not.toHaveBeenCalled();
    }
  );

  it('persists measured height through real model stash/pop and Yjs reread', async () => {
    const workspace = new TestWorkspace();
    workspace.meta.initialize();
    const doc = workspace.createDoc('note-geometry');
    doc.load();
    const store = doc.getStore({
      extensions: [RootBlockSchemaExtension, NoteBlockSchemaExtension],
    });
    const page = store.addBlock('affine:page');
    const id = store.addBlock('affine:note', { xywh: '[10,20,300,200]' }, page);
    const model = store.getModelById<NoteBlockModel>(id)!;
    model.props.edgeless = { ...model.props.edgeless, scale: 2 };
    const mask = new EdgelessNoteMask();
    Object.assign(mask, { model, editing: true, disableMask: true, zoom: 3 });
    document.body.append(mask);
    await mask.updateComplete;
    resize(
      [{ contentRect: { height: 160 } }] as ResizeObserverEntry[],
      {} as ResizeObserver
    );
    expect(JSON.parse(model.xywh)).toEqual([10, 20, 300, 240]);
    expect(model.yBlock.get('prop:xywh')).toBe('[10,20,300,240]');
    mask.remove();
    store.dispose();
    workspace.doc.destroy();
  });
});

describe('shared preview lane', () => {
  it('releases an unconnected host and ignores its late DOM completion after cancellation', async () => {
    const workspace = new TestWorkspace();
    workspace.meta.initialize();
    const doc = workspace.createDoc('preview-cancel-before-connect');
    doc.load();
    const store = doc.getStore({ extensions: [RootBlockSchemaExtension] });
    store.addBlock('affine:page');
    const owner = { store } as BlockStdScope;
    const preview = new PreviewProbe();
    let mounted = 0;
    let released = 0;
    class PendingHostProbe extends LifeCycleWatcher {
      static override key = 'xenica-preview-pending-host-probe';
      override mounted() {
        mounted++;
      }
      override unmounted() {
        released++;
      }
    }
    const lifecycle = preview as unknown as {
      _visible: boolean;
      _previewDoc: Store | null;
      _previewScope: FramePreviewScope | null;
      _previewHost: EditorHost | null;
      _previewSpec: [typeof PendingHostProbe];
      _initSpec(): void;
      _initPreviewDoc(): void;
      _setFrameDisposables(frame: FrameBlockModel): void;
      _updateFrameViewportWH(): void;
      _refreshViewport(): void;
      _schedulePreview(): void;
      getUpdateComplete(): Promise<boolean>;
    };
    vi.spyOn(lifecycle, '_initSpec').mockImplementation(() => {});
    vi.spyOn(lifecycle, '_initPreviewDoc').mockImplementation(() => {
      lifecycle._previewDoc = store;
    });
    vi.spyOn(lifecycle, '_previewSpec', 'get').mockReturnValue([
      PendingHostProbe,
    ]);
    vi.spyOn(lifecycle, '_setFrameDisposables').mockImplementation(() => {});
    vi.spyOn(lifecycle, '_updateFrameViewportWH').mockImplementation(() => {});
    const refresh = vi
      .spyOn(lifecycle, '_refreshViewport')
      .mockImplementation(() => {});
    const host = document.createElement('div');
    vi.spyOn(BlockStdScope.prototype, 'render').mockReturnValue(host as never);
    preview.std = owner;
    preview.frame = {
      xywh: '[0,0,100,100]',
      store,
    } as unknown as FrameBlockModel;
    document.body.append(preview);
    await preview.updateComplete;
    refresh.mockClear();
    let complete!: (value: boolean) => void;
    vi.spyOn(lifecycle, 'getUpdateComplete').mockReturnValue(
      new Promise(resolve => {
        complete = resolve;
      })
    );
    vi.useFakeTimers();
    lifecycle._visible = true;
    lifecycle._schedulePreview();
    await vi.advanceTimersByTimeAsync(32);
    expect(lifecycle._previewScope).not.toBe(null);
    expect(host.isConnected).toBe(false);
    preview.remove();
    expect(released).toBe(1);
    complete(true);
    await vi.advanceTimersByTimeAsync(96);
    expect(mounted).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(lifecycle._previewScope).toBe(null);
    expect(lifecycle._previewHost).toBe(null);
    expect(host.isConnected).toBe(false);
    expect(getPreviewQueue(owner).size).toBe(0);
    store.dispose();
    workspace.doc.destroy();
  });

  it('waits initial viewport readiness but not unrelated descendant updates', async () => {
    const workspace = new TestWorkspace();
    workspace.meta.initialize();
    const doc = workspace.createDoc('preview-lane-owner');
    doc.load();
    const store = doc.getStore({ extensions: [RootBlockSchemaExtension] });
    store.addBlock('affine:page');
    const owner = { store } as BlockStdScope;
    const preview = new PreviewProbe();
    const lifecycle = preview as unknown as {
      _visible: boolean;
      _previewDoc: Store | null;
      _previewSpec: [];
      _initSpec(): void;
      _initPreviewDoc(): void;
      _setFrameDisposables(frame: FrameBlockModel): void;
      _updateFrameViewportWH(): void;
      _refreshViewport(): void;
      _schedulePreview(): void;
    };
    let initialViewportReady!: () => void;
    const initialViewport = new Promise<void>(resolve => {
      initialViewportReady = resolve;
    });
    vi.spyOn(lifecycle, '_initSpec').mockImplementation(() => initialViewport);
    vi.spyOn(lifecycle, '_initPreviewDoc').mockImplementation(() => {
      lifecycle._previewDoc = store;
    });
    vi.spyOn(lifecycle, '_previewSpec', 'get').mockReturnValue([]);
    vi.spyOn(lifecycle, '_setFrameDisposables').mockImplementation(() => {});
    vi.spyOn(lifecycle, '_updateFrameViewportWH').mockImplementation(() => {});
    const refresh = vi
      .spyOn(lifecycle, '_refreshViewport')
      .mockImplementation(() => {});
    const host = document.createElement('div');
    const descendants = vi.fn(() => new Promise<boolean>(() => {}));
    Object.defineProperty(host, 'updateComplete', { get: descendants });
    vi.spyOn(BlockStdScope.prototype, 'render').mockReturnValue(host as never);
    preview.std = owner;
    preview.frame = {
      xywh: '[0,0,100,100]',
      store,
    } as unknown as FrameBlockModel;
    document.body.append(preview);
    await preview.updateComplete;
    vi.useFakeTimers();
    lifecycle._visible = true;
    lifecycle._schedulePreview();
    const next = vi.fn(async () => {});
    const queue = getPreviewQueue(owner);
    queue.enqueue(next);
    await vi.advanceTimersByTimeAsync(96);
    expect(next).not.toHaveBeenCalled();
    initialViewportReady();
    await vi.advanceTimersByTimeAsync(96);
    expect(next).toHaveBeenCalledOnce();
    expect(queue.size).toBe(0);
    expect(refresh).toHaveBeenCalled();
    expect(descendants).not.toHaveBeenCalled();
    preview.remove();
    store.dispose();
    workspace.doc.destroy();
  });

  it('yields titles a paint, starts at most one job and cancels queued work', async () => {
    vi.useFakeTimers();
    const queue = new PreviewQueue();
    let finish!: () => void;
    const first = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    const second = vi.fn(async () => {});
    queue.enqueue(first);
    const cancel = queue.enqueue(second);
    expect(first).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(32);
    expect(first).toHaveBeenCalledOnce();
    expect(second).not.toHaveBeenCalled();
    expect(queue.size).toBe(2);
    cancel();
    finish();
    await vi.runAllTimersAsync();
    expect(queue.size).toBe(0);
    expect(second).not.toHaveBeenCalled();
  });

  it('releases an active lane when a disconnected host never finishes its update', async () => {
    vi.useFakeTimers();
    const queue = new PreviewQueue();
    const cancel = queue.enqueue(() => new Promise<void>(() => {}));
    const next = vi.fn(async () => {});
    queue.enqueue(next);
    await vi.advanceTimersByTimeAsync(32);
    expect(queue.size).toBe(2);
    cancel();
    await vi.runAllTimersAsync();
    expect(next).toHaveBeenCalledOnce();
    expect(queue.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no scheduled timers when a panel closes before its first paint', () => {
    vi.useFakeTimers();
    const queue = new PreviewQueue();
    const work = vi.fn(async () => {});
    queue.enqueue(work)();
    expect(queue.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(work).not.toHaveBeenCalled();
  });
});

describe('local decoration ownership', () => {
  it('shares one readonly decoration and only the final owner removes it', () => {
    const remove = vi.fn();
    const surface = {
      deleteLocalElement: remove,
    } as unknown as SurfaceBlockModel;
    const create = vi.fn(() => ({ id: 'same-label' }) as GfxLocalElementModel);
    const first = leaseReadonlyLocalElement(surface, 'same-label', create);
    const second = leaseReadonlyLocalElement(surface, 'same-label', create);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(first.model).toBe(second.model);
    expect(create).toHaveBeenCalledOnce();
    first.release();
    first.release();
    expect(remove).not.toHaveBeenCalled();
    second.release();
    expect(remove).toHaveBeenCalledExactlyOnceWith(first.model);
    expect(
      leaseReadonlyLocalElement(surface, 'same-label', create).created
    ).toBe(true);
  });
});

describe('surface lookup invalidation', () => {
  it('shares a full-scan result and invalidates null/add/delete without listeners', () => {
    const blocks = signal({});
    let models: { model: object }[] = [];
    const scan = vi.fn(() => models);
    const store = { blocks, getBlocksByFlavour: scan } as unknown as Store;
    const first = new GfxBlockElementModel();
    first.store = store;
    const second = new GfxBlockElementModel();
    second.store = store;
    expect(first.surface).toBe(null);
    expect(second.surface).toBe(null);
    expect(scan).toHaveBeenCalledTimes(1);
    const surface = {};
    models = [{ model: surface }];
    blocks.value = { surface: {} };
    expect(first.surface).toBe(surface);
    expect(second.surface).toBe(surface);
    expect(scan).toHaveBeenCalledTimes(2);
    models = [];
    blocks.value = {};
    expect(second.surface).toBe(null);
    expect(scan).toHaveBeenCalledTimes(3);
  });
});
