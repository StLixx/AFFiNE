import { expect, test, vi } from 'vitest';
import { RealtimeGateway } from '../../packages/backend/server/src/core/realtime/gateway';
vi.mock('../../packages/backend/server/src/base', () => ({
  checkCanaryDateClientVersion: () => ({ matched: false }),
  EventBus: class {},
  GatewayErrorWrapper: () => () => {},
  OnEvent: () => () => {},
  UnsupportedClientVersion: class extends Error {},
}));
vi.mock('../../packages/backend/server/src/core/auth', () => ({
  CurrentUser: () => () => {},
}));
vi.mock('../../packages/backend/server/src/core/realtime/publisher', () => ({
  RealtimePublisher: class {},
}));
vi.mock('../../packages/backend/server/src/core/realtime/registry', () => ({
  RealtimeRegistry: class {},
}));
function fixture() {
  const rooms = new Set<string>();
  const socket = {
    id: 'socket-a',
    join: vi.fn(async (room: string) => {
      rooms.add(room);
    }),
    leave: vi.fn(async (room: string) => {
      rooms.delete(room);
    }),
  };
  const registry = {
    getTopic: () => ({
      input: { parse: (x: any) => x },
      authorize: async () => {},
      room: () => 'user:a:profile',
    }),
  };
  const gateway = new RealtimeGateway(registry as any, {} as any);
  const subscribe = () =>
    gateway.onSubscribe({ id: 'a' } as any, socket as any, {
      topic: 'user.profile.changed',
      input: {},
      clientVersion: '0.27.4',
    });
  const unsubscribe = (id: string) =>
    gateway.onUnsubscribe(socket as any, {
      topic: 'user.profile.changed',
      input: {},
      subscriptionId: id,
      clientVersion: '0.27.4',
    });
  return { rooms, socket, gateway, subscribe, unsubscribe };
}
test('late old unsubscribe cannot cancel its replacement on the same socket', async () => {
  const f = fixture(),
    old = await f.subscribe(),
    next = await f.subscribe();
  expect(next.data.subscriptionId).not.toBe(old.data.subscriptionId);
  await f.unsubscribe(old.data.subscriptionId);
  expect(f.rooms.has('user:a:profile')).toBe(true);
  await f.unsubscribe(next.data.subscriptionId);
  expect(f.rooms.size).toBe(0);
});
test('an overlapping old leave finishes before its replacement joins', async () => {
  const f = fixture(),
    old = await f.subscribe();
  let release!: () => void;
  f.socket.leave.mockImplementationOnce(async room => {
    await new Promise<void>(r => {
      release = r;
    });
    f.rooms.delete(room);
  });
  const leaving = f.unsubscribe(old.data.subscriptionId);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const next = f.subscribe();
  release();
  await Promise.all([leaving, next]);
  expect(f.rooms.has('user:a:profile')).toBe(true);
});
test('another socket cannot unsubscribe this socket and disconnect removes its registrations', async () => {
  const f = fixture(),
    sub = await f.subscribe();
  await f.gateway.onUnsubscribe({ id: 'socket-b', leave: vi.fn() } as any, {
    topic: 'user.profile.changed',
    input: {},
    subscriptionId: sub.data.subscriptionId,
    clientVersion: '0.27.4',
  });
  expect(f.rooms.has('user:a:profile')).toBe(true);
  f.gateway.handleDisconnect(f.socket as any);
  expect((f.gateway as any).subscriptions.size).toBe(0);
});
