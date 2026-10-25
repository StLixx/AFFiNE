import { expect, test, vi } from 'vitest';

import { bindStoreManagerPageLifecycle } from '../worker/page-lifecycle';

function setup(initialPending: boolean) {
  const target = new EventTarget();
  let pending = initialPending;
  const dispose = vi.fn();
  const unbind = bindStoreManagerPageLifecycle(target as unknown as Window, {
    get hasPendingLocalUpdates() {
      return pending;
    },
    dispose,
  });
  const beforeUnload = () => {
    const event = new Event('beforeunload', { cancelable: true });
    Object.defineProperty(event, 'returnValue', {
      value: undefined,
      writable: true,
    });
    const allowed = target.dispatchEvent(event);
    return { event, allowed };
  };
  const pageHide = (persisted: boolean) => {
    const event = new Event('pagehide');
    Object.defineProperty(event, 'persisted', { value: persisted });
    target.dispatchEvent(event);
  };
  return {
    target,
    dispose,
    unbind,
    beforeUnload,
    pageHide,
    setPending(value: boolean) {
      pending = value;
    },
  };
}

test('pending local changes cancel beforeunload without closing the saving connection', () => {
  const f = setup(true);
  try {
    const { event, allowed } = f.beforeUnload();
    expect(allowed).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(event.returnValue).toBe('');
    expect(f.dispose).not.toHaveBeenCalled();
  } finally {
    f.unbind();
  }
});

test('staying keeps the pipeline alive, then durable local data may leave without waiting for remote sync', () => {
  const f = setup(true);
  try {
    expect(f.beforeUnload().allowed).toBe(false);
    expect(f.dispose).not.toHaveBeenCalled();
    f.setPending(false);
    expect(f.beforeUnload().allowed).toBe(true);
    expect(f.dispose).not.toHaveBeenCalled();
    f.pageHide(false);
    expect(f.dispose).toHaveBeenCalledTimes(1);
  } finally {
    f.unbind();
  }
});

test('a persisted back-forward-cache page keeps its connection', () => {
  const f = setup(false);
  try {
    f.pageHide(true);
    expect(f.dispose).not.toHaveBeenCalled();
  } finally {
    f.unbind();
  }
});

test('unbind removes both lifecycle listeners', () => {
  const f = setup(true);
  f.unbind();
  expect(f.beforeUnload().allowed).toBe(true);
  f.pageHide(false);
  expect(f.dispose).not.toHaveBeenCalled();
});
