import { getEventListeners } from 'node:events';

import { describe, expect, test } from 'vitest';

import { AsyncPriorityQueue } from '../async-priority-queue';

describe('Async Priority Queue abort listener lifetime', () => {
  test('successful wakeups release each completed abort listener', async () => {
    const queue = new AsyncPriorityQueue();
    const controller = new AbortController();
    for (let i = 0; i < 100; i++) {
      const pending = queue.asyncPop(undefined, controller.signal);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
      queue.push('job-' + i);
      expect(await pending).toBe('job-' + i);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    }
  });

  test('cancellation preserves the reason and leaves the queue usable', async () => {
    const queue = new AsyncPriorityQueue();
    const controller = new AbortController();
    const pending = queue.asyncPop(undefined, controller.signal);
    const reason = new Error('cancel this waiter');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    const next = queue.asyncPop();
    queue.push('next');
    expect(await next).toBe('next');
  });

  test('an already cancelled empty wait installs no abort listener', async () => {
    const queue = new AsyncPriorityQueue();
    const controller = new AbortController();
    const reason = new Error('already cancelled');
    controller.abort(reason);
    await expect(queue.asyncPop(undefined, controller.signal)).rejects.toBe(
      reason
    );
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  test('priority wakeups retain only one live listener per independent waiter', async () => {
    const queue = new AsyncPriorityQueue();
    const high = new AbortController();
    const low = new AbortController();
    const highResult = queue.asyncPop(5, high.signal);
    const lowResult = queue.asyncPop(undefined, low.signal);
    queue.push('low-priority', 1);
    expect(await lowResult).toBe('low-priority');
    await expect
      .poll(() => getEventListeners(high.signal, 'abort').length)
      .toBe(1);
    expect(getEventListeners(low.signal, 'abort')).toHaveLength(0);
    queue.push('high-priority', 5);
    expect(await highResult).toBe('high-priority');
    expect(getEventListeners(high.signal, 'abort')).toHaveLength(0);
  });

  test('a cancelled waiter cannot consume another waiter queued work', async () => {
    const queue = new AsyncPriorityQueue();
    const cancelled = new AbortController();
    const active = new AbortController();
    const first = queue.asyncPop(undefined, cancelled.signal);
    const second = queue.asyncPop(undefined, active.signal);
    const reason = new Error('cancel only the first');
    cancelled.abort(reason);
    await expect(first).rejects.toBe(reason);
    queue.push('retained-work');
    expect(await second).toBe('retained-work');
    expect(getEventListeners(cancelled.signal, 'abort')).toHaveLength(0);
    expect(getEventListeners(active.signal, 'abort')).toHaveLength(0);
  });

  test('a signal-free wait and an immediately available priority result remain unchanged', async () => {
    const queue = new AsyncPriorityQueue();
    const pending = queue.asyncPop();
    queue.push('normal', 1);
    expect(await pending).toBe('normal');
    queue.push('higher', 3);
    queue.push('lower', 1);
    expect(await queue.asyncPop(2)).toBe('higher');
    expect(queue.pop()).toBe('lower');
  });
});
