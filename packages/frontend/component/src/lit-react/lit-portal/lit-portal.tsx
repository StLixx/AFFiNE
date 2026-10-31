import { html, LitElement, type TemplateResult } from 'lit';
import { customElement } from 'lit/decorators.js';
import { nanoid } from 'nanoid';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import ReactDOM from 'react-dom';

type PortalEvent = {
  name: 'connectedCallback' | 'disconnectedCallback' | 'willUpdate';
  target: LitReactPortal;
};

type PortalListener = (event: PortalEvent) => void;

function createLitPortalAnchor(callback: (event: PortalEvent) => void) {
  return html`<lit-react-portal
    .notify=${callback}
    portalId=${nanoid()}
  ></lit-react-portal>`;
}

export const LIT_REACT_PORTAL = 'lit-react-portal';

@customElement(LIT_REACT_PORTAL)
class LitReactPortal extends LitElement {
  portalId!: string;
  notify?: PortalListener;

  static override get properties() {
    return {
      portalId: { type: String },
      notify: { attribute: false },
    };
  }

  override connectedCallback() {
    super.connectedCallback();
    this.notify?.({
      name: 'connectedCallback',
      target: this,
    });
  }

  override attributeChangedCallback(
    name: string,
    oldVal: string,
    newVal: string
  ) {
    super.attributeChangedCallback(name, oldVal, newVal);
    if (name.toLowerCase() === 'portalid') {
      this.notify?.({
        name: 'willUpdate',
        target: this,
      });
    }
  }

  // do not enable shadow root
  override createRenderRoot() {
    return this;
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.notify?.({
      name: 'disconnectedCallback',
      target: this,
    });
  }
}

declare global {
  interface HTMLElementTagNameMap {
    [LIT_REACT_PORTAL]: LitReactPortal;
  }
}

export type ElementOrFactory = React.ReactNode | (() => React.ReactNode);

type LitPortal = {
  id: string;
  portal: React.ReactNode;
};

type OwnedLitPortal = {
  id: string;
  portal: React.ReactPortal;
  litElement: LitReactPortal;
};

// Only this live registry owns native containers. React snapshots and rendered
// props contain primitive keys, so prior Fibers cannot park detached editors.
class LitPortalRegistry {
  private readonly entries = new Map<string, OwnedLitPortal>();
  private readonly targetKeys = new WeakMap<LitReactPortal, string>();
  private readonly listeners = new Set<() => void>();
  private snapshot: readonly string[] = [];

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private publish() {
    this.snapshot = [...this.entries.keys()];
    this.listeners.forEach(listener => listener());
  }

  upsert(target: LitReactPortal, element: React.ReactNode) {
    const entryKey = this.targetKeys.get(target) ?? target.portalId;
    this.targetKeys.set(target, entryKey);
    this.entries.set(entryKey, {
      id: target.portalId,
      portal: ReactDOM.createPortal(element, target),
      litElement: target,
    });
    this.publish();
  }

  prune() {
    let changed = false;
    for (const [key, entry] of this.entries) {
      if (!entry.litElement.isConnected) {
        this.entries.delete(key);
        this.targetKeys.delete(entry.litElement);
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  get(entryKey: string) {
    return this.entries.get(entryKey);
  }
}

function LitPortalRenderer({
  registry,
  entryKey,
}: {
  registry: LitPortalRegistry;
  entryKey: string;
}) {
  return registry.get(entryKey)?.portal ?? null;
}

export type ReactToLit = (
  elementOrFactory: ElementOrFactory,
  rerendering?: boolean
) => TemplateResult;

// The wrapper is a React component only; it adds no DOM around native content.
export const useLitPortalFactory = () => {
  const registry = useMemo(() => new LitPortalRegistry(), []);
  const keys = useSyncExternalStore(
    registry.subscribe,
    registry.getSnapshot,
    registry.getSnapshot
  );

  const reactToLit: ReactToLit = useCallback(
    (elementOrFactory, rerendering) => {
      const element =
        typeof elementOrFactory === 'function'
          ? elementOrFactory()
          : elementOrFactory;
      return createLitPortalAnchor(({ name, target }) => {
        if (
          name === 'connectedCallback' ||
          (name === 'willUpdate' && target.isConnected && rerendering)
        ) {
          registry.upsert(target, element);
        } else if (name === 'disconnectedCallback') {
          registry.prune();
        }
      });
    },
    [registry]
  );

  const portals: LitPortal[] = keys.flatMap(entryKey => {
    const entry = registry.get(entryKey);
    return entry
      ? [
          {
            id: entry.id,
            portal: (
              <LitPortalRenderer
                key={entry.id}
                registry={registry}
                entryKey={entryKey}
              />
            ),
          },
        ]
      : [];
  });
  return [reactToLit, portals] as const;
};

// render a react element to a lit template
export const useLitPortal = (elementOrFactory: ElementOrFactory) => {
  const [anchor, setAnchor] = useState<HTMLElement>();
  const template = useMemo(
    () =>
      createLitPortalAnchor(event => {
        let anchor: HTMLElement | undefined;
        if (event.name !== 'disconnectedCallback') {
          anchor = event.target as HTMLElement;
        }
        setAnchor(anchor);
      }),
    []
  );

  const element = useMemo(
    () =>
      typeof elementOrFactory === 'function'
        ? elementOrFactory()
        : elementOrFactory,
    [elementOrFactory]
  );
  return {
    template,
    portal: anchor ? ReactDOM.createPortal(element, anchor) : undefined,
  };
};
