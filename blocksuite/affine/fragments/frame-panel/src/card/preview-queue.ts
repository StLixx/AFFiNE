import { handleError } from '@blocksuite/global/exceptions';

/** One cancellable initialization lane shared by panel cards and drag ghosts. */
export class PreviewQueue {
  private readonly pending = new Map<
    AbortController,
    (signal: AbortSignal) => Promise<void>
  >();
  private active: AbortController | null = null;
  private animation: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  get size() {
    return this.pending.size + (this.active ? 1 : 0);
  }

  enqueue(work: (signal: AbortSignal) => Promise<void>) {
    const controller = new AbortController();
    this.pending.set(controller, work);
    this.schedule();
    return () => {
      controller.abort();
      this.pending.delete(controller);
      if (!this.pending.size && !this.active) this.cancelSchedule();
    };
  }

  private cancelSchedule() {
    if (this.animation !== null) cancelAnimationFrame(this.animation);
    if (this.timer !== null) clearTimeout(this.timer);
    this.animation = this.timer = null;
  }

  private schedule() {
    if (
      this.active ||
      this.animation !== null ||
      this.timer !== null ||
      !this.pending.size
    )
      return;
    // Yield an actual paint of the native titles and navigation before starting
    // any synchronous editor construction; a microtask alone does not paint.
    this.animation = requestAnimationFrame(() => {
      this.animation = null;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.run().catch(handleError);
      }, 0);
    });
  }

  private async run() {
    const next = this.pending.entries().next().value;
    if (!next) return;
    const [controller, work] = next;
    this.pending.delete(controller);
    this.active = controller;
    try {
      if (!controller.signal.aborted) await work(controller.signal);
    } finally {
      this.active = null;
      this.schedule();
    }
  }
}

const queues = new WeakMap<object, PreviewQueue>();

export function getPreviewQueue(owner: object) {
  let queue = queues.get(owner);
  if (!queue) {
    queue = new PreviewQueue();
    queues.set(owner, queue);
  }
  return queue;
}
