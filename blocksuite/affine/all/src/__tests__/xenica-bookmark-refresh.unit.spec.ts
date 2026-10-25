import {
  BookmarkBlockSchemaExtension,
  type BookmarkBlockModel,
  type LinkPreviewData,
  NoteBlockSchemaExtension,
  RootBlockSchemaExtension,
} from '@blocksuite/affine-model';
import {
  DocModeProvider,
  LinkPreviewServiceIdentifier,
} from '@blocksuite/affine-shared/services';
import { TestWorkspace } from '@blocksuite/store/test';
import { nothing } from 'lit';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BookmarkBlockComponent } from '../../../blocks/bookmark/src/bookmark-block';

class BookmarkRefreshFixture extends BookmarkBlockComponent {
  override render() {
    return nothing;
  }
}
const tag = 'xenica-bookmark-refresh-fixture';
if (!customElements.get(tag))
  customElements.define(tag, BookmarkRefreshFixture);
const mounted: BookmarkRefreshFixture[] = [];
const cached = {
  url: 'https://example.test/current',
  title: 'Stored title',
  description: 'Stored description',
  icon: 'stored-icon',
  image: 'stored-image',
};
const empty = { title: null, description: null, icon: null, image: null };
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function pending() {
  let resolve!: (data: Partial<LinkPreviewData>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Partial<LinkPreviewData>>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture(
  options: {
    readonly?: boolean;
    empty?: boolean;
    query?: ReturnType<typeof vi.fn>;
  } = {}
) {
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
  const id = writable.addBlock(
    'affine:bookmark',
    { ...cached, ...(options.empty ? empty : {}) },
    note
  );
  const readonly = doc.getStore({ extensions, readonly: true });
  const store = options.readonly ? readonly : writable;
  const model = writable.getModelById<BookmarkBlockModel>(id)!;
  const query = options.query ?? vi.fn().mockResolvedValue({});
  const element = document.createElement(tag) as BookmarkRefreshFixture;
  element.dataset.blockId = id;
  element.store = store;
  element.widgets = {};
  element.std = {
    store,
    host: { renderChildren: () => nothing },
    selection: { value: [] },
    view: { setBlock: vi.fn(), deleteBlock: vi.fn(), getBlock: () => null },
    get: (identifier: unknown) =>
      identifier === DocModeProvider
        ? { getEditorMode: () => 'page' }
        : identifier === LinkPreviewServiceIdentifier
          ? { query }
          : { isCitationModel: () => false },
    getOptional: () => null,
  } as unknown as BookmarkBlockComponent['std'];
  mounted.push(element);
  document.body.append(element);
  await element.updateComplete;
  await tick();
  return { element, writable, readonly, model, query };
}
afterEach(() => {
  for (const element of mounted.splice(0)) element.remove();
});

describe('real BookmarkBlockComponent refresh ownership', () => {
  it('does not treat a same-value native URL event as a real URL reset', async () => {
    const { element, writable, model, query } = await fixture();
    writable.updateBlock(model, { url: cached.url });
    await tick();
    expect(query).not.toHaveBeenCalled();
    expect(model.props.icon).toBe(cached.icon);
    expect(element.loading).toBe(false);
  });

  it('passes a genuine URL change through the component reset path', async () => {
    const response = pending(),
      query = vi.fn().mockReturnValue(response.promise);
    const { element, writable, model } = await fixture({ query });
    writable.updateBlock(model, { url: 'https://example.test/new' });
    await tick();
    expect(query).toHaveBeenCalledWith(
      'https://example.test/new',
      expect.any(AbortSignal)
    );
    expect(model.props.icon).toBe(null);
    response.resolve({ title: 'New URL title' });
    await tick();
    expect(model.props.title).toBe('New URL title');
    expect(model.props.icon).toBe(null);
    expect(element.loading).toBe(false);
  });

  it('discards an old readonly local result and retains the latest loading owner', async () => {
    const old = pending(),
      latest = pending(),
      query = vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(latest.promise);
    const { element, writable, model } = await fixture({
      readonly: true,
      empty: true,
      query,
    });
    writable.updateBlock(model, { url: 'https://example.test/new' });
    element.refreshData();
    old.resolve({ title: 'Old URL local title', icon: 'old-icon' });
    await tick();
    expect(element.loading).toBe(true);
    expect(element.linkPreview$.value.title).toBe(null);
    latest.resolve({ title: 'Latest local title', icon: 'latest-icon' });
    await tick();
    expect(element.linkPreview$.value.title).toBe('Latest local title');
    expect(element.loading).toBe(false);
    expect(model.props.title).toBe(null);
    expect(model.props.icon).toBe(null);
  });

  it('ignores an old readonly rejection without setting the latest request error', async () => {
    const old = pending(),
      latest = pending(),
      query = vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(latest.promise);
    const { element } = await fixture({ readonly: true, empty: true, query });
    element.refreshData();
    old.reject(new Error('obsolete network failure'));
    await tick();
    expect(element.loading).toBe(true);
    expect(element.error).toBe(false);
    latest.resolve({ title: 'Current local result' });
    await tick();
    expect(element.linkPreview$.value.title).toBe('Current local result');
    expect(element.loading).toBe(false);
  });

  it('does not present an old URL response after a readonly native URL change', async () => {
    const response = pending(),
      query = vi.fn().mockReturnValue(response.promise);
    const { element, writable, model } = await fixture({
      readonly: true,
      empty: true,
      query,
    });
    writable.updateBlock(model, { url: 'https://example.test/new' });
    response.resolve({ title: 'Stale URL result' });
    await tick();
    expect(element.linkPreview$.value.title).toBe(null);
    expect(model.props.title).toBe(null);
    expect(element.loading).toBe(false);
  });

  it('aborts on real disconnect and ignores a provider that resolves after cancellation', async () => {
    const response = pending(),
      query = vi.fn().mockReturnValue(response.promise);
    const { element, model } = await fixture({
      readonly: true,
      empty: true,
      query,
    });
    const signal = query.mock.calls[0][1] as AbortSignal;
    element.remove();
    expect(signal.aborted).toBe(true);
    response.resolve({ title: 'Detached result', icon: 'detached-icon' });
    await tick();
    expect(element.linkPreview$.value.title).toBe(null);
    expect(model.props.icon).toBe(null);
    expect(element.loading).toBe(false);
  });

  it('rechecks readonly after a persistent query awaits', async () => {
    const response = pending(),
      query = vi.fn().mockReturnValue(response.promise);
    const { element, readonly, model } = await fixture({ query });
    element.refreshData();
    element.store = readonly;
    response.resolve({ title: 'Must not persist' });
    await tick();
    expect(model.props.title).toBe(cached.title);
    expect(model.props.icon).toBe(cached.icon);
    expect(element.loading).toBe(false);
  });

  it('keeps local loading ownership when a persistent request is replaced by readonly refresh', async () => {
    const old = pending(),
      latest = pending(),
      query = vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockReturnValueOnce(latest.promise);
    const { element, readonly, model } = await fixture({ query });
    element.refreshData();
    element.store = readonly;
    element.refreshData();
    old.resolve({ title: 'Cancelled persistent result' });
    await tick();
    expect(element.loading).toBe(true);
    expect(model.props.title).toBe(cached.title);
    latest.resolve({ title: 'Local current result' });
    await tick();
    expect(element.loading).toBe(false);
    expect(model.props.title).toBe(cached.title);
  });
});
