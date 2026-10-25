import {
  BookmarkBlockSchemaExtension,
  type BookmarkBlockModel,
  NoteBlockSchemaExtension,
  RootBlockSchemaExtension,
} from '@blocksuite/affine-model';
import { TestWorkspace } from '@blocksuite/store/test';
import { describe, expect, it, vi } from 'vitest';

import type { BookmarkBlockComponent } from '../../../blocks/bookmark/src/bookmark-block';
import { refreshBookmarkUrlData } from '../../../blocks/bookmark/src/utils';

const cached = {
  url: 'https://example.test/current',
  title: 'Stored title',
  description: 'Stored description',
  icon: 'stored-icon',
  image: 'stored-image',
};

function fixture(readonly = false) {
  const workspace = new TestWorkspace();
  workspace.meta.initialize();
  const doc = workspace.createDoc();
  doc.load();
  const extensions = [
    RootBlockSchemaExtension,
    NoteBlockSchemaExtension,
    BookmarkBlockSchemaExtension,
  ];
  const writable = doc.getStore({ extensions });
  const page = writable.addBlock('affine:page');
  const note = writable.addBlock('affine:note', {}, page);
  const id = writable.addBlock('affine:bookmark', cached, note);
  const store = readonly
    ? doc.getStore({ extensions, readonly: true })
    : writable;
  const model = store.getModelById<BookmarkBlockModel>(id)!;
  const query = vi.fn();
  const element = {
    store,
    model,
    std: { get: () => ({ query }) },
    loading: false,
    error: false,
  } as unknown as BookmarkBlockComponent;
  return { element, store, model, query };
}

describe('bookmark refresh preserves stored native data', () => {
  it('keeps cached metadata when a partial response omits icon and image', async () => {
    const { element, model, query } = fixture();
    query.mockResolvedValue({ title: 'Updated title', description: null });
    await refreshBookmarkUrlData(element);
    expect(model.props.title).toBe('Updated title');
    expect(model.props.description).toBe(cached.description);
    expect(model.props.icon).toBe(cached.icon);
    expect(model.props.image).toBe(cached.image);
  });

  it('does not replace any stored field or create a native write for an empty response', async () => {
    const { element, store, model, query } = fixture();
    const update = vi.spyOn(store, 'updateBlock');
    query.mockResolvedValue({
      title: null,
      description: null,
      icon: null,
      image: null,
    });
    await refreshBookmarkUrlData(element);
    expect(update).not.toHaveBeenCalled();
    expect(model.props.icon).toBe(cached.icon);
    expect(model.props.title).toBe(cached.title);
    expect(element.error).toBe(true);
    expect(element.loading).toBe(false);
  });

  it('does not use the persistent refresh path for a readonly store', async () => {
    const { element, store, query } = fixture(true);
    const update = vi.spyOn(store, 'updateBlock');
    query.mockResolvedValue({ title: 'Unexpected write' });
    await refreshBookmarkUrlData(element);
    expect(query).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('discards a response after the bookmark URL changed in native Yjs', async () => {
    const { element, store, model, query } = fixture();
    let complete!: (value: { title: string }) => void;
    query.mockImplementation(
      () =>
        new Promise(resolve => {
          complete = resolve;
        })
    );
    const refreshing = refreshBookmarkUrlData(element);
    store.updateBlock(model, { url: 'https://example.test/new' });
    complete({ title: 'Old URL title' });
    await refreshing;
    expect(model.props.url).toBe('https://example.test/new');
    expect(model.props.title).toBe(cached.title);
  });

  it('keeps a concurrent native title edit instead of overwriting it with stale metadata', async () => {
    const { element, store, model, query } = fixture();
    let complete!: (value: { title: string }) => void;
    query.mockImplementation(
      () =>
        new Promise(resolve => {
          complete = resolve;
        })
    );
    const refreshing = refreshBookmarkUrlData(element);
    store.updateBlock(model, { title: 'Human title' });
    complete({ title: 'Remote title' });
    await refreshing;
    expect(model.props.title).toBe('Human title');
    expect(model.props.icon).toBe(cached.icon);
  });

  it('retains all fields after cancellation without creating a native write', async () => {
    const { element, store, model, query } = fixture();
    const update = vi.spyOn(store, 'updateBlock');
    const controller = new AbortController();
    let complete!: (value: { title: string }) => void;
    query.mockImplementation(
      () =>
        new Promise(resolve => {
          complete = resolve;
        })
    );
    const refreshing = refreshBookmarkUrlData(element, controller.signal);
    controller.abort();
    complete({ title: 'Cancelled response' });
    await refreshing;
    expect(update).not.toHaveBeenCalled();
    expect(model.props.title).toBe(cached.title);
    expect(element.loading).toBe(false);
  });
  it('resets missing metadata only when refreshing a real URL change', async () => {
    const { element, store, model, query } = fixture();
    store.updateBlock(model, { url: 'https://example.test/new' });
    query.mockResolvedValue({ title: 'New URL title' });
    await refreshBookmarkUrlData(element, undefined, { resetMissing: true });
    expect(model.props.url).toBe('https://example.test/new');
    expect(model.props.title).toBe('New URL title');
    expect(model.props.icon).toBe(null);
    expect(model.props.image).toBe(null);
    expect(model.props.description).toBe(null);
  });

  it('only commits the newest refresh and keeps its loading ownership', async () => {
    const { element, model, query } = fixture();
    let oldComplete!: (value: { title: string }) => void;
    let newComplete!: (value: { title: string }) => void;
    query.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          oldComplete = resolve;
        })
    );
    query.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          newComplete = resolve;
        })
    );
    const oldRefresh = refreshBookmarkUrlData(element);
    const newRefresh = refreshBookmarkUrlData(element);
    oldComplete({ title: 'Old response' });
    await oldRefresh;
    expect(model.props.title).toBe(cached.title);
    expect(element.loading).toBe(true);
    newComplete({ title: 'Latest response' });
    await newRefresh;
    expect(model.props.title).toBe('Latest response');
    expect(element.loading).toBe(false);
  });
  it('clears the previous URL metadata even when the new URL request fails', async () => {
    const { element, store, model, query } = fixture();
    store.updateBlock(model, { url: 'https://example.test/new' });
    query.mockRejectedValue(new Error('Provider unavailable'));
    await expect(
      refreshBookmarkUrlData(element, undefined, { resetMissing: true })
    ).rejects.toThrow('Provider unavailable');
    expect(model.props.url).toBe('https://example.test/new');
    expect(model.props.icon).toBe(null);
    expect(model.props.title).toBe(null);
    expect(model.props.description).toBe(null);
    expect(model.props.image).toBe(null);
    expect(element.loading).toBe(false);
  });

  it('keeps same-URL cached metadata when an explicit reload fails', async () => {
    const { element, store, model, query } = fixture();
    const update = vi.spyOn(store, 'updateBlock');
    query.mockRejectedValue(new Error('Provider unavailable'));
    await expect(refreshBookmarkUrlData(element)).rejects.toThrow(
      'Provider unavailable'
    );
    expect(update).not.toHaveBeenCalled();
    expect(model.props.icon).toBe(cached.icon);
    expect(model.props.title).toBe(cached.title);
    expect(element.loading).toBe(false);
  });
});
