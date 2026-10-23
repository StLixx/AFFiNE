import { describe, expect, it, vi } from 'vitest';

import type { Block } from '../model/block/index.js';
import { type Query, runQuery } from '../model/store/query.js';

function setup(children: string[] | undefined = []) {
  const propsRead = vi.fn(() => ['text']);
  const parent = { id: 'parent', blockViewType: 'hidden' };
  const getParent = vi.fn(() => null);
  const block = {
    blockViewType: 'hidden',
    model: {
      id: 'child',
      flavour: 'test:child',
      get keys() {
        return propsRead();
      },
      props: { text: '原生正文' },
      store: {
        getParent,
        getBlock: () => parent,
        schema: {
          flavourSchemaMap: new Map([['test:hidden', { model: { children } }]]),
        },
      },
    },
  } as unknown as Block;
  return { block, parent, getParent, propsRead };
}

describe('native loose-query initialization cost and ancestry', () => {
  it('does not expand properties for flavour-only queries', () => {
    const { block, propsRead } = setup();
    runQuery(
      {
        mode: 'loose',
        match: [{ flavour: 'test:hidden', viewType: 'hidden' }],
      },
      block
    );
    expect(block.blockViewType).toBe('display');
    expect(propsRead).not.toHaveBeenCalled();
  });
  it('does not walk ancestors when the only hidden flavour cannot have children', () => {
    const { block, getParent } = setup();
    runQuery(
      {
        mode: 'loose',
        match: [{ flavour: 'test:hidden', viewType: 'hidden' }],
      },
      block
    );
    expect(block.blockViewType).toBe('display');
    expect(getParent).not.toHaveBeenCalled();
  });
  it.each(['strict', 'include'] as const)(
    'preserves hidden ancestor handling in %s mode',
    mode => {
      const { block, parent, getParent } = setup();
      getParent.mockImplementationOnce(() => ({ id: 'parent' }) as never);
      runQuery({ mode, match: [{ id: 'child', viewType: 'display' }] }, block);
      expect(parent.blockViewType).toBe(
        mode === 'include' ? 'display' : 'bypass'
      );
    }
  );
  it('keeps ancestry traversal for loose rules that can hide a parent', () => {
    const { block, parent, getParent } = setup(['*']);
    getParent.mockImplementationOnce(() => ({ id: 'parent' }) as never);
    runQuery(
      {
        mode: 'loose',
        match: [{ flavour: 'test:hidden', viewType: 'hidden' }],
      },
      block
    );
    expect(parent.blockViewType).toBe('bypass');
  });
  it('keeps props matching and first-match order', () => {
    const { block, propsRead } = setup();
    const query: Query = {
      mode: 'loose',
      match: [
        { id: 'other', props: { text: '原生正文' }, viewType: 'hidden' },
        { id: 'child', props: { text: '原生正文' }, viewType: 'bypass' },
        { id: 'child', viewType: 'hidden' },
      ],
    };
    runQuery(query, block);
    expect(block.blockViewType).toBe('bypass');
    expect(propsRead).toHaveBeenCalledOnce();
  });
});
