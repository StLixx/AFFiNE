import type { ReferenceParams } from '@blocksuite/affine-model';
import type { SurfaceBlockModel } from '@blocksuite/affine-block-surface';
import type { BlockModel, Query, Store } from '@blocksuite/store';
import type * as Y from 'yjs';

/** Reuse original models and Y.Text. Never store a second body in a reference. */
export function referenceContentBlocks(store: Store, params: ReferenceParams) {
  const seen = new Set<string>();
  const result: BlockModel[] = [];
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const model = store.getBlock(id)?.model;
    if (!model) return;
    if (
      ['affine:page', 'affine:surface', 'affine:note', 'affine:frame'].includes(
        model.flavour
      )
    ) {
      model.children.forEach(child => visit(child.id));
    } else if (
      model.flavour !== 'affine:embed-linked-doc' &&
      model.flavour !== 'affine:embed-synced-doc'
    ) {
      // Embedded references are omitted to prevent recursive same-document previews.
      result.push(model);
    }
  };
  (params.blockIds ?? []).forEach(visit);
  return result;
}

export function referenceContentElementTexts(
  store: Store,
  params: ReferenceParams
) {
  const surface = store.getModelsByFlavour('affine:surface')[0] as
    | SurfaceBlockModel
    | undefined;
  const result: { id: string; text: Y.Text }[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    const model = surface?.getElementById(id);
    if (!model) return;
    if ('text' in model && model.text && typeof model.text !== 'string') {
      result.push({ id, text: model.text as Y.Text });
    }
    if ('childIds' in model) {
      (model.childIds as string[]).forEach(visit);
    }
  };
  (params.elementIds ?? []).forEach(visit);
  return result;
}

/** Preserve the entire selected native subtree, including nested list/formula children. */
export function referenceContentQuery(
  store: Store,
  blocks: BlockModel[]
): Query {
  const ids = new Set<string>();
  const visit = (model: BlockModel) => {
    if (ids.has(model.id)) return;
    if (
      model.flavour === 'affine:embed-linked-doc' ||
      model.flavour === 'affine:embed-synced-doc'
    )
      return;
    ids.add(model.id);
    model.children.forEach(visit);
  };
  blocks.forEach(visit);
  blocks.forEach(block => {
    let parent = store.getParent(block.id);
    while (parent && !ids.has(parent.id)) {
      ids.add(parent.id);
      parent = store.getParent(parent.id);
    }
  });
  return {
    mode: 'strict',
    match: [...ids].map(id => ({ id, viewType: 'display' })),
  };
}
