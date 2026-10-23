import type { Store } from '@blocksuite/store';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  referenceContentBlocks,
  referenceContentElementTexts,
  referenceContentQuery,
} from '../../../blocks/embed-doc/src/common/reference-content';

describe('Canonical native reference content', () => {
  it('selects target descendants and native formula instead of unrelated notes', () => {
    const paragraph = { id: 'p', flavour: 'affine:paragraph', children: [] };
    const formula = { id: 'f', flavour: 'affine:latex', children: [] };
    const unrelated = {
      id: 'other',
      flavour: 'affine:paragraph',
      children: [],
    };
    const note = {
      id: 'n',
      flavour: 'affine:note',
      children: [paragraph, formula],
    };
    const models = new Map(
      [paragraph, formula, unrelated, note].map(m => [m.id, m])
    );
    const store = {
      getBlock: (id: string) =>
        models.has(id) ? { model: models.get(id) } : null,
    } as unknown as Store;
    expect(referenceContentBlocks(store, { blockIds: ['n'] })).toEqual([
      paragraph,
      formula,
    ]);
    expect(referenceContentBlocks(store, { blockIds: ['p'] })[0]).toBe(
      paragraph
    );
  });
  it('does not recurse into self-document embeds or invent missing target content', () => {
    const linked = {
      id: 'r',
      flavour: 'affine:embed-linked-doc',
      children: [],
    };
    const note = { id: 'n', flavour: 'affine:note', children: [linked] };
    const store = {
      getBlock: (id: string) => ({ model: id === 'n' ? note : linked }),
    } as unknown as Store;
    expect(referenceContentBlocks(store, { blockIds: ['n'] })).toEqual([]);
    expect(
      referenceContentBlocks({ getBlock: () => null } as unknown as Store, {
        blockIds: ['missing'],
      })
    ).toEqual([]);
  });
  it('keeps nested native descendants, formulas and ancestor paths in the readonly query', () => {
    const formula = { id: 'latex', flavour: 'affine:latex', children: [] };
    const nested = {
      id: 'nested',
      flavour: 'affine:list',
      children: [formula],
    };
    const list = { id: 'list', flavour: 'affine:list', children: [nested] };
    const note = { id: 'note', flavour: 'affine:note', children: [list] };
    const page = { id: 'page', flavour: 'affine:page', children: [note] };
    const parents = new Map([
      [list.id, note],
      [nested.id, list],
      [formula.id, nested],
      [note.id, page],
    ]);
    const store = {
      getParent: (id: string) => parents.get(id) ?? null,
    } as unknown as Store;
    const query = referenceContentQuery(store, [list] as never);
    expect(query.mode).toBe('strict');
    expect(query.match.map(rule => rule.id)).toEqual([
      'list',
      'nested',
      'latex',
      'note',
      'page',
    ]);
  });

  it('uses the same native Y.Text for multiple element placements and reflects canonical edits', () => {
    const text = new Y.Text('课内节点'),
      doc = new Y.Doc();
    doc.getMap('texts').set('s', text);
    const shape = { text },
      group = { childIds: ['s'] };
    const surface = {
      getElementById: (id: string) =>
        id === 's' ? shape : id === 'g' ? group : null,
    };
    const store = { getModelsByFlavour: () => [surface] } as unknown as Store;
    const first = referenceContentElementTexts(store, { elementIds: ['g'] });
    const second = referenceContentElementTexts(store, { elementIds: ['s'] });
    expect(first[0].text).toBe(second[0].text);
    text.insert(0, '更新 ');
    expect(first[0].text.toString()).toBe('更新 课内节点');
  });
});
