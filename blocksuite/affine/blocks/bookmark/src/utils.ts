import type { LinkPreviewData } from '@blocksuite/affine-model';
import { LinkPreviewServiceIdentifier } from '@blocksuite/affine-shared/services';
import { isAbortError } from '@blocksuite/affine-shared/utils';

import type { BookmarkBlockComponent } from './bookmark-block.js';

const metadataFields = ['title', 'description', 'icon', 'image'] as const;
const activeRefreshes = new WeakMap<BookmarkBlockComponent, object>();

export function invalidateBookmarkUrlRefresh(
  bookmarkElement: BookmarkBlockComponent
) {
  activeRefreshes.delete(bookmarkElement);
}

export async function refreshBookmarkUrlData(
  bookmarkElement: BookmarkBlockComponent,
  signal?: AbortSignal,
  options: { resetMissing?: boolean } = {}
) {
  if (bookmarkElement.store.readonly || signal?.aborted) return;

  const props = bookmarkElement.model.props;
  const requestedUrl = props.url;
  // The caller only requests this reset for a real URL change. Clear metadata
  // from the previous URL even if the new provider request fails.
  if (options.resetMissing) {
    const reset: Partial<LinkPreviewData> = {};
    for (const key of metadataFields) {
      if (props[key] !== null) reset[key] = null;
    }
    if (Object.keys(reset).length) {
      bookmarkElement.store.updateBlock(bookmarkElement.model, reset);
    }
  }
  const initial = {
    title: props.title,
    description: props.description,
    icon: props.icon,
    image: props.image,
  };
  const refresh = {};
  activeRefreshes.set(bookmarkElement, refresh);

  try {
    bookmarkElement.loading = true;
    const linkPreviewer = bookmarkElement.std.get(LinkPreviewServiceIdentifier);
    const data = await linkPreviewer.query(requestedUrl, signal);

    // A response is only derived metadata for the URL and native values read
    // when this request started. Do not overwrite a newer refresh or user edit.
    if (
      signal?.aborted ||
      bookmarkElement.store.readonly ||
      activeRefreshes.get(bookmarkElement) !== refresh ||
      props.url !== requestedUrl ||
      metadataFields.some(key => props[key] !== initial[key])
    ) {
      return;
    }

    const updates: Partial<LinkPreviewData> = {};
    let hasData = false;
    for (const key of metadataFields) {
      const value = data[key];
      const provided = typeof value === 'string' && value.trim().length > 0;
      hasData ||= provided;
      // Missing same-URL provider fields do not erase valid cached metadata.
      const next = provided ? value : initial[key];
      if (next !== initial[key]) updates[key] = next;
    }

    bookmarkElement.error = !hasData;
    if (Object.keys(updates).length) {
      bookmarkElement.store.updateBlock(bookmarkElement.model, updates);
    }
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) return;
    throw error;
  } finally {
    if (activeRefreshes.get(bookmarkElement) === refresh) {
      activeRefreshes.delete(bookmarkElement);
      bookmarkElement.loading = false;
    }
  }
}
