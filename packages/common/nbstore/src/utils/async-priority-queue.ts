import { PriorityQueue } from './priority-queue';

export class AsyncPriorityQueue extends PriorityQueue {
  private _resolveUpdate: (() => void) | null = null;
  private _waitForUpdate: Promise<void> | null = null;

  async asyncPop(
    minimumPriority?: number,
    abort?: AbortSignal
  ): Promise<string> {
    const update = this.pop(minimumPriority);
    if (update) {
      return update;
    } else {
      if (!this._waitForUpdate) {
        this._waitForUpdate = new Promise(resolve => {
          this._resolveUpdate = resolve;
        });
      }

      let onAbort: (() => void) | undefined;
      try {
        await Promise.race([
          this._waitForUpdate,
          new Promise((_, reject) => {
            if (abort?.aborted) {
              reject(abort.reason);
              return;
            }
            if (abort) {
              onAbort = () => reject(abort.reason);
              abort.addEventListener('abort', onAbort, { once: true });
            }
          }),
        ]);
      } finally {
        if (onAbort) {
          abort?.removeEventListener('abort', onAbort);
        }
      }

      return this.asyncPop(minimumPriority, abort);
    }
  }

  override push(id: string, priority: number = 0) {
    super.push(id, priority);
    if (this._resolveUpdate) {
      const resolve = this._resolveUpdate;
      this._resolveUpdate = null;
      this._waitForUpdate = null;
      resolve();
    }
  }
}
