import { expect, test, vi } from 'vitest';
import { Doc as YDoc, encodeStateAsUpdate } from 'yjs';

import { DocFrontend } from '../frontend/doc';
import { IndexedDBDocStorage } from '../impls/idb/doc';
import type { DocUpdate } from '../storage';
import { DummyDocStorage } from '../storage/dummy/doc';
import { DocSyncImpl } from '../sync/doc';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

class DeferredDocStorage extends DummyDocStorage {
  readonly writes: {
    update: DocUpdate;
    completion: ReturnType<typeof deferred<void>>;
  }[] = [];

  override async pushDocUpdate(update: DocUpdate) {
    const completion = deferred<void>();
    this.writes.push({ update, completion });
    await completion.promise;
    return { docId: update.docId, timestamp: new Date() };
  }
}

const pending = (frontend: DocFrontend) =>
  Boolean(
    (
      frontend as DocFrontend & {
        readonly hasPendingLocalUpdates?: boolean;
      }
    ).hasPendingLocalUpdates
  );

async function open(frontend: DocFrontend, doc: YDoc) {
  frontend.start();
  frontend.connectDoc(doc);
  await frontend.waitForDocLoaded(doc.guid);
}

function close(frontend: DocFrontend, doc: YDoc, storage: DeferredDocStorage) {
  frontend.stop();
  for (const write of storage.writes) write.completion.resolve();
  doc.destroy();
}

test('a local Yjs edit is pending synchronously, including another edit during the first durable write', async () => {
  const storage = new DeferredDocStorage();
  const frontend = new DocFrontend(storage, DocSyncImpl.dummy);
  const doc = new YDoc();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await open(frontend, doc);
    expect(pending(frontend)).toBe(false);
    doc.getMap('test').set('first', 'native edit');
    expect(pending(frontend)).toBe(true);
    await vi.waitFor(() => expect(storage.writes).toHaveLength(1));
    expect(pending(frontend)).toBe(true);

    doc.getMap('test').set('second', 'edit during await');
    storage.writes[0].completion.resolve();
    await vi.waitFor(() => expect(storage.writes).toHaveLength(2));
    expect(pending(frontend)).toBe(true);
    storage.writes[1].completion.resolve();
    await frontend.waitForUpdated(doc.guid);
    expect(pending(frontend)).toBe(false);
  } finally {
    close(frontend, doc, storage);
    await Promise.resolve();
    errors.mockRestore();
  }
});

test('initial cached content and remote apply are not user-local pending writes', async () => {
  const storage = new DeferredDocStorage();
  const frontend = new DocFrontend(storage, DocSyncImpl.dummy);
  const doc = new YDoc();
  const cached = new YDoc({ guid: doc.guid });
  cached.getMap('test').set('cache', 'already locally durable');
  vi.spyOn(storage, 'getDoc').mockResolvedValue({
    docId: doc.guid,
    bin: encodeStateAsUpdate(cached),
    timestamp: new Date(),
  });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await open(frontend, doc);
    expect(doc.getMap('test').get('cache')).toBe('already locally durable');
    expect(pending(frontend)).toBe(false);
    expect(storage.writes).toHaveLength(0);

    const remote = new YDoc({ guid: doc.guid });
    remote.getMap('remote').set('value', 'downloaded');
    frontend.applyUpdate(doc.guid, encodeStateAsUpdate(remote));
    expect(doc.getMap('remote').get('value')).toBe('downloaded');
    expect(pending(frontend)).toBe(false);
    expect(storage.writes).toHaveLength(0);
    remote.destroy();
  } finally {
    close(frontend, doc, storage);
    await Promise.resolve();
    errors.mockRestore();
    cached.destroy();
    vi.restoreAllMocks();
  }
});

test('pre-connect seed data is pending immediately until its local transaction completes', async () => {
  const storage = new DeferredDocStorage();
  const frontend = new DocFrontend(storage, DocSyncImpl.dummy);
  const doc = new YDoc();
  doc.getMap('test').set('seed', 'not yet in local storage');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    frontend.start();
    frontend.connectDoc(doc);
    expect(pending(frontend)).toBe(true);
    await frontend.waitForDocLoaded(doc.guid);
    await vi.waitFor(() => expect(storage.writes).toHaveLength(1));
    expect(pending(frontend)).toBe(true);
    storage.writes[0].completion.resolve();
    await frontend.waitForUpdated(doc.guid);
    expect(pending(frontend)).toBe(false);
  } finally {
    close(frontend, doc, storage);
    await Promise.resolve();
    errors.mockRestore();
  }
});

test('failed pre-connect seed storage retains local pending protection', async () => {
  const storage = new DeferredDocStorage();
  const frontend = new DocFrontend(storage, DocSyncImpl.dummy);
  const doc = new YDoc();
  doc.getMap('test').set('seed', 'must not silently disappear');
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    frontend.start();
    frontend.connectDoc(doc);
    expect(pending(frontend)).toBe(true);
    await frontend.waitForDocLoaded(doc.guid);
    await vi.waitFor(() => expect(storage.writes).toHaveLength(1));
    storage.writes[0].completion.reject(
      new Error('synthetic local seed failure')
    );
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(pending(frontend)).toBe(true);
  } finally {
    close(frontend, doc, storage);
    await Promise.resolve();
    errors.mockRestore();
  }
});

test('a rejected local write must not clear pending protection', async () => {
  const storage = new DeferredDocStorage();
  const frontend = new DocFrontend(storage, DocSyncImpl.dummy);
  const doc = new YDoc();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await open(frontend, doc);
    doc.getMap('test').set('value', 'not durable');
    await vi.waitFor(() => expect(storage.writes).toHaveLength(1));
    storage.writes[0].completion.reject(
      new DOMException('synthetic storage full', 'QuotaExceededError')
    );
    await vi.waitFor(() => expect(errors).toHaveBeenCalled());
    expect(pending(frontend)).toBe(true);
  } finally {
    close(frontend, doc, storage);
    await Promise.resolve();
    errors.mockRestore();
  }
});

test('local durability does not depend on remote sync availability', async () => {
  const storage = new DeferredDocStorage();
  const sync = DocSyncImpl.dummy;
  const remoteSync = vi
    .spyOn(sync, 'waitForSynced')
    .mockRejectedValue(new Error('synthetic offline'));
  const frontend = new DocFrontend(storage, sync);
  const doc = new YDoc();
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await open(frontend, doc);
    doc.getMap('test').set('value', 'local survives offline');
    await vi.waitFor(() => expect(storage.writes).toHaveLength(1));
    expect(pending(frontend)).toBe(true);
    storage.writes[0].completion.resolve();
    await frontend.waitForUpdated(doc.guid);
    expect(pending(frontend)).toBe(false);
    expect(remoteSync).not.toHaveBeenCalled();
  } finally {
    close(frontend, doc, storage);
    await Promise.resolve();
    errors.mockRestore();
    remoteSync.mockRestore();
  }
});

function transactionFixture() {
  const completion = deferred<void>();
  const transaction = {
    objectStore: vi.fn(() => ({
      add: vi.fn(async () => {}),
      put: vi.fn(async () => {}),
    })),
    commit: vi.fn(),
    done: completion.promise,
  };
  const storage = new IndexedDBDocStorage({
    id: 'local-durability-contract',
    flavour: 'test',
    type: 'workspace',
  });
  vi.spyOn(storage, 'db', 'get').mockReturnValue({
    transaction: () => transaction,
  } as unknown as typeof storage.db);
  const postMessage = vi.fn();
  vi.spyOn(storage, 'channel', 'get').mockReturnValue({
    postMessage,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as BroadcastChannel);
  const published = vi.fn();
  const unsubscribe = storage.subscribeDocUpdate(published);
  return {
    storage,
    transaction,
    completion,
    postMessage,
    published,
    unsubscribe,
  };
}

test('IndexedDB acknowledges and publishes only after the transaction completes', async () => {
  const f = transactionFixture();
  let settled = false;
  const saved = f.storage
    .pushDocUpdate({ docId: 'doc', bin: new Uint8Array([1]) })
    .then(() => {
      settled = true;
    });
  try {
    await vi.waitFor(() => expect(f.transaction.commit).toHaveBeenCalled());
    expect(settled).toBe(false);
    expect(f.published).not.toHaveBeenCalled();
    expect(f.postMessage).not.toHaveBeenCalled();
    f.completion.resolve();
    await saved;
    expect(settled).toBe(true);
    expect(f.published).toHaveBeenCalledTimes(1);
    expect(f.postMessage).toHaveBeenCalledTimes(1);
  } finally {
    f.completion.resolve();
    await saved;
    f.unsubscribe();
    vi.restoreAllMocks();
  }
});

test('an aborted IndexedDB transaction never publishes a successful local update', async () => {
  const f = transactionFixture();
  const saved = f.storage.pushDocUpdate({
    docId: 'doc',
    bin: new Uint8Array([1]),
  });
  try {
    await vi.waitFor(() => expect(f.transaction.commit).toHaveBeenCalled());
    f.completion.reject(new DOMException('synthetic abort', 'AbortError'));
    await expect(saved).rejects.toThrow('synthetic abort');
    expect(f.published).not.toHaveBeenCalled();
    expect(f.postMessage).not.toHaveBeenCalled();
  } finally {
    f.completion.resolve();
    await saved.catch(() => {});
    f.unsubscribe();
    vi.restoreAllMocks();
  }
});
