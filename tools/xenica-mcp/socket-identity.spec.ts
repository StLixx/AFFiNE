import 'fake-indexeddb/auto';
import { afterEach, expect, test, vi } from 'vitest';
import { SocketConnection } from '../../packages/common/nbstore/src/impls/cloud/socket';
import { IndexedDBDocStorage } from '../../packages/common/nbstore/src/impls/idb/doc';

const control = vi.hoisted(() => ({ user: 'a', sockets: [] as any[] }));
vi.mock('socket.io-client', () => ({
  Manager: class {
    value: any;
    constructor() {
      const handlers = new Map<string, Set<(...args: any[]) => void>>();
      const socket: any = {
        connected: false,
        user: '',
        on(event: string, fn: (...args: any[]) => void) {
          if (!handlers.has(event)) handlers.set(event, new Set());
          handlers.get(event)!.add(fn);
          return socket;
        },
        once(event: string, fn: (...args: any[]) => void) {
          const once = (...args: any[]) => {
            socket.off(event, once);
            fn(...args);
          };
          return socket.on(event, once);
        },
        off(event: string, fn?: (...args: any[]) => void) {
          if (fn) handlers.get(event)?.delete(fn);
          else handlers.delete(event);
          return socket;
        },
        emit(event: string, ...args: any[]) {
          for (const fn of Array.from(handlers.get(event) ?? [])) fn(...args);
        },
        connect() {
          if (!socket.connected) {
            socket.user = control.user;
            socket.connected = true;
            socket.emit('connect');
          }
        },
        disconnect() {
          if (socket.connected) {
            socket.connected = false;
            socket.emit('disconnect', 'io client disconnect');
          }
        },
      };
      this.value = socket;
      control.sockets.push(socket);
    }
    socket() {
      return this.value;
    }
  },
}));
const connections: SocketConnection[] = [];
function connection(endpoint: string) {
  const value = new SocketConnection(endpoint, true);
  connections.push(value);
  value.connect();
  return value;
}
afterEach(() => {
  for (const value of connections.splice(0)) value.disconnect(true);
  for (const endpoint of ['https://one.test', 'https://other.test']) {
    SocketConnection.resetSharedConnection(endpoint, true);
  }
  control.user = 'a';
  control.sockets.length = 0;
});

test('retiring an identity stops old handles while a different server stays connected', async () => {
  const first = connection('https://one.test');
  const other = connection('https://other.test');
  await Promise.all([first.waitForConnected(), other.waitForConnected()]);
  expect(first.inner.socket).not.toBe(other.inner.socket);
  control.user = 'b';
  SocketConnection.resetSharedConnection('https://one.test', true);
  expect(first.status).toBe('closed');
  expect(other.status).toBe('connected');
  const next = connection('https://one.test');
  await next.waitForConnected();
  expect((next.inner.socket as any).user).toBe('b');
  expect(control.sockets).toHaveLength(3);
});

test('pending IndexedDB updates survive identity retirement and reopen', async () => {
  const local = new IndexedDBDocStorage({
    flavour: 'identity-test',
    type: 'workspace',
    id: 'pending-a',
  });
  local.connection.connect();
  await local.connection.waitForConnected();
  const pending = new Uint8Array([12, 3, 6, 9]);
  await local.pushDocUpdate({ docId: 'local-only', bin: pending });
  const remote = connection('https://one.test');
  await remote.waitForConnected();
  SocketConnection.resetSharedConnection('https://one.test', true);
  const before = await local.db.getAll('updates');
  expect(before).toHaveLength(1);
  expect(before[0].bin).toEqual(pending);
  local.connection.disconnect(true);
  local.connection.connect();
  await local.connection.waitForConnected();
  const after = await local.db.getAll('updates');
  expect(after).toEqual(before);
  local.connection.disconnect(true);
});
