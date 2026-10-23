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
import type { Store } from '@blocksuite/store';
import { TestWorkspace } from '@blocksuite/store/test';
import { signal } from '@preact/signals-core';
import { nothing } from 'lit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EdgelessNoteMask } from '../../../blocks/note/src/components/edgeless-note-mask';
import { FramePreview } from '../../../fragments/frame-panel/src/card/frame-preview';
import { PreviewQueue } from '../../../fragments/frame-panel/src/card/preview-queue';

class PreviewProbe extends FramePreview {
  override render() {
    return nothing;
  }
}

if (!customElements.get('xenica-frame-preview-probe')) {
  customElements.define('xenica-frame-preview-probe', PreviewProbe);
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
    preview.frame = { xywh: '[0,0,100,100]' } as FrameBlockModel;
    document.body.append(preview);
    await preview.updateComplete;
    expect(allocate).not.toHaveBeenCalled();
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
