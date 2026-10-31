import { type Signal, signal } from '@preact/signals-core';
import type { Observable, Subscription } from 'rxjs';

/** Keep the same signals on reconnect, but release their upstream subscriptions. */
export class ScopedObservableSignals {
  private active = true;
  private readonly bindings: (() => void)[] = [];
  private readonly subscriptions: Subscription[] = [];

  watch<T>(source: Observable<T>, initialValue: T): Signal<T> {
    const value = signal(initialValue);
    const attach = () => {
      this.subscriptions.push(
        source.subscribe(next => {
          value.value = next;
        })
      );
    };
    this.bindings.push(attach);
    if (this.active) {
      attach();
    }
    return value;
  }

  mount() {
    if (this.active) {
      return;
    }
    this.active = true;
    this.bindings.forEach(attach => attach());
  }

  unmount() {
    this.active = false;
    while (this.subscriptions.length) {
      this.subscriptions.pop()?.unsubscribe();
    }
  }
}
