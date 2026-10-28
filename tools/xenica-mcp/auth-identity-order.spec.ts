import { BehaviorSubject, of } from 'rxjs';
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
function fixture() {
  const account$ = new BehaviorSubject<any>(null);
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
    { globalContext: { serverId: { $: { value: 'server' } } } }
  );
  return { account$, service, configure, subscribe, pending };
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
