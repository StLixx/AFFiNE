/**
 * @vitest-environment happy-dom
 */
import { act, cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, expect, test } from 'vitest';

import { type ReactToLit, useLitPortalFactory } from './lit-portal';

afterEach(cleanup);

// React retains the previous hook state in its alternate Fiber. Inspect that
// actual owner rather than pretending disconnecting a portal releases its DOM.
type HookState = {
  memoizedState: unknown;
  baseState: unknown;
  next: HookState | null;
};
type Fiber = { memoizedState: HookState | null; alternate: Fiber | null };
function retainedByHookState(fiber: Fiber, target: HTMLElement) {
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth = 0): boolean => {
    if (value === target) return true;
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 7)
      return false;
    seen.add(value);
    if (value instanceof Map)
      return [...value.values()].some(v => visit(v, depth + 1));
    return Object.values(Object.getOwnPropertyDescriptors(value)).some(
      d => 'value' in d && visit(d.value, depth + 1)
    );
  };
  for (const owner of [fiber, fiber.alternate]) {
    for (let hook = owner?.memoizedState; hook; hook = hook.next) {
      if (visit(hook.memoizedState) || visit(hook.baseState)) return true;
    }
  }
  return false;
}

test('disconnect releases portal DOM from current and alternate hook state', async () => {
  let factory!: ReactToLit;
  const Probe = () => {
    const [create, portals] = useLitPortalFactory();
    useEffect(() => {
      factory = create;
    }, [create]);
    return <div data-testid="probe">{portals.map(p => p.portal)}</div>;
  };
  const result = render(<Probe />);
  const probe = result.getByTestId('probe');
  const fiberKey = Object.keys(probe).find(k => k.startsWith('__reactFiber$'))!;
  expect(fiberKey).toBeTruthy();
  const target = Object.assign(document.createElement('div'), {
    portalId: 'one',
  });
  document.body.append(target);
  const template = factory(<span>native portal content</span>, true);
  const notify = template.values[0] as (event: {
    name: string;
    target: HTMLElement;
  }) => void;
  await act(async () => notify({ name: 'connectedCallback', target }));
  expect(target.textContent).toBe('native portal content');
  await act(async () => {
    target.remove();
    notify({ name: 'disconnectedCallback', target });
  });
  expect(target.textContent).toBe('');
  const fiber = (probe as unknown as Record<string, { return: Fiber }>)[
    fiberKey
  ].return;
  expect(retainedByHookState(fiber, target)).toBe(false);
});

test('connected siblings, updates and reconnection preserve native portal behavior', async () => {
  let factory!: ReactToLit;
  const Probe = () => {
    const [create, portals] = useLitPortalFactory();
    useEffect(() => {
      factory = create;
    }, [create]);
    return <>{portals.map(p => p.portal)}</>;
  };
  render(<Probe />);
  const first = Object.assign(document.createElement('div'), {
    portalId: 'first',
  });
  const second = Object.assign(document.createElement('div'), {
    portalId: 'second',
  });
  document.body.append(first, second);
  type Notify = (event: { name: string; target: HTMLElement }) => void;
  const firstNotify = factory(<span>first content</span>, true)
    .values[0] as Notify;
  const secondNotify = factory(<span>second content</span>).values[0] as Notify;
  await act(async () => {
    firstNotify({ name: 'connectedCallback', target: first });
    secondNotify({ name: 'connectedCallback', target: second });
  });
  expect(first.textContent).toBe('first content');
  expect(second.textContent).toBe('second content');
  const updatedNotify = factory(<span>updated content</span>, true)
    .values[0] as Notify;
  await act(async () => updatedNotify({ name: 'willUpdate', target: first }));
  expect(first.textContent).toBe('updated content');
  await act(async () => {
    first.remove();
    updatedNotify({ name: 'disconnectedCallback', target: first });
  });
  expect(first.textContent).toBe('');
  expect(second.textContent).toBe('second content');
  await act(async () => {
    document.body.append(first);
    updatedNotify({ name: 'connectedCallback', target: first });
  });
  expect(first.textContent).toBe('updated content');
  expect(second.textContent).toBe('second content');
  await act(async () => {
    first.remove();
    second.remove();
    updatedNotify({ name: 'disconnectedCallback', target: first });
    secondNotify({ name: 'disconnectedCallback', target: second });
  });
});
