import { BehaviorSubject, of, Subject } from 'rxjs';
import { beforeEach, expect, test, vi } from 'vitest';
import { AuthService } from '../../packages/frontend/core/src/modules/cloud/services/auth';

const state = vi.hoisted(() => ({ framework: null as any, bus: null as any }));
vi.mock('@toeverything/infra', () => ({
  OnEvent: () => (target: unknown) => target,
  Service: class {
    framework = state.framework;
    eventBus = state.bus;
    dispose() {}
  },
}));
vi.mock('@affine/error', () => ({ UserFriendlyError: class {} }));
vi.mock('@affine/graphql', () => ({
  ServerDeploymentType: { Selfhosted: 'selfhosted' },
}));
vi.mock('@affine/track', () => ({ track: {} }));
vi.mock(
  '../../packages/frontend/core/src/modules/cloud/entities/session',
  () => ({ AuthSession: class {} })
);
vi.mock('../../packages/frontend/core/src/modules/lifecycle', () => ({
  ApplicationFocused: Symbol('focused'),
}));
vi.mock(
  '../../packages/frontend/core/src/modules/cloud/events/server-started',
  () => ({ ServerStarted: Symbol('started') })
);
vi.mock(
  '../../packages/frontend/core/src/modules/cloud/events/account-changed',
  () => ({ AccountChanged: 'changed' })
);
vi.mock(
  '../../packages/frontend/core/src/modules/cloud/events/account-logged-in',
  () => ({ AccountLoggedIn: 'in' })
);
vi.mock(
  '../../packages/frontend/core/src/modules/cloud/events/account-logged-out',
  () => ({ AccountLoggedOut: 'out' })
);
vi.mock(
  '../../packages/frontend/core/src/modules/cloud/stores/server-config',
  () => ({ assertSupportedServerVersion: () => {} })
);

beforeEach(() => {
  state.bus = { emit: vi.fn() };
});
function fixture(initialAccount: any = null, initialServerId: any = 'server') {
  const serverId$ = new BehaviorSubject<any>(initialServerId);
  const account$ = new BehaviorSubject<any>(initialAccount);
  state.framework = { createEntity: () => ({ account$ }) };
  const pending: (() => void)[] = [];
  const configure = vi.fn((context: any) =>
    context.userId ? new Promise<void>(r => pending.push(r)) : Promise.resolve()
  );
  const subscribe = vi.fn(() => of({ type: 'ready' }));
  const service = new (AuthService as any)(
    {},
    {},
    {},
    {},
    { realtime: { configure, subscribe } },
    {
      server: {
        id: 'server',
        baseUrl: 'https://example.com',
        config$: { value: { type: 'selfhosted' } },
      },
    },
    { globalContext: { serverId: { $: serverId$ } } }
  );
  return { account$, service, configure, subscribe, pending, serverId$ };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

test('new account lifecycle and profile subscription wait for worker identity acknowledgement', async () => {
  const f = fixture();
  await flush();
  state.bus.emit.mockClear();
  f.account$.next({ id: 'account-a' });
  expect(f.configure).toHaveBeenLastCalledWith({
    endpoint: 'https://example.com',
    authenticated: true,
    userId: 'account-a',
    isSelfHosted: true,
  });
  expect(state.bus.emit).not.toHaveBeenCalled();
  expect(f.subscribe).not.toHaveBeenCalled();
  f.pending.shift()!();
  await flush();
  expect(state.bus.emit).toHaveBeenCalledWith('changed', { id: 'account-a' });
  expect(f.subscribe).toHaveBeenCalledWith('user.profile.changed', {});
  f.service.dispose();
});

test('late account A acknowledgement cannot publish lifecycle or subscribe after switching to B', async () => {
  const f = fixture();
  await flush();
  state.bus.emit.mockClear();
  f.account$.next({ id: 'account-a' });
  f.account$.next({ id: 'account-b' });
  f.pending[0]();
  await flush();
  expect(state.bus.emit).not.toHaveBeenCalled();
  f.pending[1]();
  await flush();
  expect(state.bus.emit.mock.calls).toEqual([
    ['in', { id: 'account-b' }],
    ['changed', { id: 'account-b' }],
  ]);
  expect(f.subscribe).toHaveBeenCalledTimes(1);
  f.service.dispose();
});

test('cached account waits until its server becomes active before subscribing after startup', async () => {
  const f = fixture({ id: 'account-b' }, null);
  await flush();
  expect(f.subscribe).not.toHaveBeenCalled();
  expect(f.configure).not.toHaveBeenCalled();
  f.serverId$.next('server');
  expect(f.configure).toHaveBeenLastCalledWith({
    endpoint: 'https://example.com',
    authenticated: true,
    userId: 'account-b',
    isSelfHosted: true,
  });
  f.pending.shift()!();
  await flush();
  expect(f.subscribe).toHaveBeenCalledOnce();
  f.service.dispose();
});

test.each(['RealtimeIdentityChanged', 'RealtimeUnauthenticated'])(
  'current profile recovers from transient startup state %s',
  async errorName => {
    const f = fixture();
    await flush();
    const profile = new Subject<any>();
    f.subscribe.mockReturnValueOnce(profile as any);
    f.account$.next({ id: 'account-b' });
    f.pending[0]();
    await flush();
    profile.error(
      Object.assign(new Error('identity reset'), {
        name: errorName,
      })
    );
    await flush();
    expect(f.pending).toHaveLength(2);
    f.pending[1]();
    await flush();
    expect(f.subscribe).toHaveBeenCalledTimes(2);
    f.service.dispose();
  }
);
