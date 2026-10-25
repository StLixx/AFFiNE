/** Browser lifecycle wiring kept separate from React and worker construction. */
export interface PageLifecycleClient {
  readonly hasPendingLocalUpdates: boolean;
  dispose(): void;
}

export function bindStoreManagerPageLifecycle(
  target: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  client: PageLifecycleClient
) {
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (!client.hasPendingLocalUpdates) return;
    event.preventDefault();
    event.returnValue = '';
  };
  const pageHide = (event: PageTransitionEvent) => {
    // A cancelled navigation or BFCache page must keep the saving pipeline alive.
    if (!event.persisted) client.dispose();
  };
  target.addEventListener('beforeunload', beforeUnload);
  target.addEventListener('pagehide', pageHide);
  return () => {
    target.removeEventListener('beforeunload', beforeUnload);
    target.removeEventListener('pagehide', pageHide);
  };
}
