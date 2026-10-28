import { beforeEach, expect, test, vi } from 'vitest';
import {
  AuthGuard,
  AuthWebsocketOptionsProvider,
} from '../../packages/backend/server/src/core/auth/guard';

vi.mock('../../packages/backend/server/src/base', () => {
  class AuthenticationRequired extends Error {
    constructor() {
      super('Authentication required');
      this.name = 'AuthenticationRequired';
    }
  }
  return {
    AccessDenied: AuthenticationRequired,
    AuthenticationRequired,
    Cache: class {},
    Config: class {},
    CryptoHelper: class {},
    UnsupportedClientVersion: AuthenticationRequired,
    checkCanaryDateClientVersion: () => ({ matched: false }),
    getClientVersionFromRequest: () => undefined,
    getRequestResponseFromContext: (context: any) => ({ req: context.req }),
    parseCookies: () => {},
  };
});
vi.mock('../../packages/backend/server/src/base/websocket', () => ({
  WEBSOCKET_OPTIONS: Symbol('websocket-options'),
}));
vi.mock('../../packages/backend/server/src/core/auth/access-token', () => ({
  AccessTokenService: class {},
  SessionAccessTokenError: class extends Error {},
}));
vi.mock('../../packages/backend/server/src/core/auth/auth-session', () => ({
  AuthSessionService: class {},
}));
vi.mock('../../packages/backend/server/src/core/auth/service', () => ({
  AuthService: class {},
}));
vi.mock('../../packages/backend/server/src/core/auth/session-exchange', () => ({
  AuthSessionHttpError: class extends Error {},
}));
vi.mock('../../packages/backend/server/src/core/auth/input', () => ({
  extractTokenFromHeader: (value: string) => value.slice(7),
}));
vi.mock('../../packages/backend/server/src/core/auth/token', () => ({
  isLikelyJwt: () => true,
}));

const old = { user: { id: 'account-a' }, sessionId: 'session-a' };
function fixture(fresh: any = null) {
  const authenticate = vi.fn(async () => fresh);
  const verify = vi.fn(async () => {
    throw new Error('revoked');
  });
  const guard = new AuthGuard(
    {} as any,
    {} as any,
    { client: { versionControl: { enabled: false } } } as any,
    {} as any,
    { getAllAndOverride: () => false } as any
  );
  Object.assign(guard, {
    auth: { getUserSessionFromRequest: authenticate },
    accessTokens: { verify },
  });
  const disconnect = vi.fn();
  const socket = { disconnect, data: {} };
  const req = { headers: {}, session: { ...old }, authType: 'session' };
  const context: any = {
    req,
    getType: () => 'ws',
    getClass: () => class {},
    getHandler: () => () => {},
    switchToWs: () => ({ getClient: () => socket }),
  };
  return { guard, authenticate, verify, req, context, disconnect };
}

test('deleted websocket user cannot use the cached handshake principal', async () => {
  const { guard, context, req, authenticate } = fixture();
  await expect(guard.canActivate(context)).rejects.toMatchObject({
    name: 'AuthenticationRequired',
  });
  expect(authenticate).toHaveBeenCalledOnce();
  expect(req.session).toBeUndefined();
});

test('websocket cookie fallback cannot silently change the principal', async () => {
  const { guard, context } = fixture({
    user: { id: 'account-b' },
    session: { sessionId: 'session-b' },
  });
  await expect(guard.canActivate(context)).rejects.toMatchObject({
    name: 'AuthenticationRequired',
  });
});

test('another valid websocket user remains authorized', async () => {
  const { guard, context } = fixture({
    user: { id: 'account-a' },
    session: { sessionId: 'session-a' },
  });
  await expect(guard.canActivate(context)).resolves.toBe(true);
});

test('revoked websocket jwt cannot reuse its cached principal', async () => {
  const { guard, context, req, verify } = fixture();
  Object.assign(req, {
    headers: { authorization: 'Bearer token' },
    authType: 'jwt',
  });
  await expect(guard.canActivate(context)).rejects.toThrow('revoked');
  expect(verify).toHaveBeenCalledOnce();
});

test('handshake subject is verified against authenticated cookies, never trusted as authorization', async () => {
  const factory = AuthWebsocketOptionsProvider.useFactory as any;
  const config = { websocket: {} };
  const guard = { signIn: vi.fn(async () => ({ user: { id: 'account-b' } })) };
  const options = factory(config, guard);
  const socket = {
    client: { request: { headers: {} } },
    handshake: { auth: { userId: 'account-a' } },
    data: {},
  };
  await expect(options.canActivate(socket)).resolves.toBe(false);
  socket.handshake.auth.userId = 'account-b';
  await expect(options.canActivate(socket)).resolves.toBe(true);
  expect(socket.data).toMatchObject({ affineAuthenticatedUserId: 'account-b' });
});

test('disabled websocket principal is rejected without affecting another socket', async () => {
  const disabled = fixture({
    user: { id: 'account-a', disabled: true },
    session: { sessionId: 'session-a' },
  });
  const valid = fixture({
    user: { id: 'account-a' },
    session: { sessionId: 'session-a' },
  });
  await expect(
    disabled.guard.canActivate(disabled.context)
  ).rejects.toMatchObject({ name: 'AuthenticationRequired' });
  await expect(valid.guard.canActivate(valid.context)).resolves.toBe(true);
  await vi.waitFor(() => expect(disabled.disconnect).toHaveBeenCalledOnce());
  expect(valid.disconnect).not.toHaveBeenCalled();
});
