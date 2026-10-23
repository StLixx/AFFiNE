import type { GfxLocalElementModel } from './local-element-model.js';
import type { SurfaceBlockModel } from './surface-model.js';

type Entry = { model: GfxLocalElementModel; count: number };
const leases = new WeakMap<SurfaceBlockModel, Map<string, Entry>>();

/**
 * Readonly scopes share a Store and therefore its local surface. Give their
 * identical decoration one identity, with one release per view. Editable views
 * keep their native ownership and never pass through this registry.
 * The caller initializes and adds a newly-created model before using it.
 */
export function leaseReadonlyLocalElement<T extends GfxLocalElementModel>(
  surface: SurfaceBlockModel,
  id: string,
  create: () => T
): { model: T; created: boolean; release(): void } {
  let entries = leases.get(surface);
  if (!entries) {
    entries = new Map();
    leases.set(surface, entries);
  }
  let entry = entries.get(id);
  const created = !entry;
  if (!entry) {
    entry = { model: create(), count: 0 };
    entries.set(id, entry);
  }
  const retained = entry;
  retained.count++;
  let released = false;
  return {
    model: retained.model as T,
    created,
    release() {
      if (released) return;
      released = true;
      if (--retained.count === 0) {
        entries.delete(id);
        surface.deleteLocalElement(retained.model);
        if (!entries.size) leases.delete(surface);
      }
    },
  };
}
