import { UserFriendlyError } from '@affine/error';
import { type OAuthProviderType, ServerDeploymentType } from '@affine/graphql';
import { track } from '@affine/track';
import { OnEvent, Service } from '@toeverything/infra';
import { nanoid } from 'nanoid';
import { distinctUntilChanged, map, skip, type Subscription } from 'rxjs';

import type { GlobalDialogService } from '../../dialogs';
import type { GlobalContextService } from '../../global-context';
import { ApplicationFocused } from '../../lifecycle';
import type { NbstoreService } from '../../storage';
import type { UrlService } from '../../url';
import { type AuthAccountInfo, AuthSession } from '../entities/session';
import { AccountChanged } from '../events/account-changed';
import { AccountLoggedIn } from '../events/account-logged-in';
import { AccountLoggedOut } from '../events/account-logged-out';
import { ServerStarted } from '../events/server-started';
import type { AuthStore } from '../stores/auth';
import { assertSupportedServerVersion } from '../stores/server-config';
import type { FetchService } from './fetch';
import type { ServerService } from './server';

export interface DeviceAuthSession {
  id: string;
  installationId: string;
  platform: 'ios' | 'android' | 'electron';
  deviceName?: string | null;
  appVersion?: string | null;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
  current: boolean;
}

function csrfHeader(): Record<string, string> {
  if (typeof document === 'undefined') return {};
  const prefix = 'affine_csrf_token=';
  const cookie = document.cookie
    .split('; ')
    .find(value => value.startsWith(prefix));
  return cookie ? { 'x-affine-csrf-token': cookie.slice(prefix.length) } : {};
}

@OnEvent(ApplicationFocused, e => e.onApplicationFocused)
@OnEvent(ServerStarted, e => e.onServerStarted)
export class AuthService extends Service {
  session = this.framework.createEntity(AuthSession);
  private profileSubscription?: Subscription;
  private readonly accountSubscription: Subscription;
  private readonly serverSubscription: Subscription;
  private accountGeneration = 0;

  constructor(
    private readonly fetchService: FetchService,
    private readonly store: AuthStore,
    private readonly urlService: UrlService,
    private readonly dialogService: GlobalDialogService,
    private readonly nbstoreService: NbstoreService,
    private readonly serverService: ServerService,
    private readonly globalContextService: GlobalContextService
  ) {
    super();

    this.accountSubscription = this.session.account$
      .pipe(
        map(a => ({
          id: a?.id,
          account: a,
        })),
        distinctUntilChanged((a, b) => a.id === b.id), // only emit when the value changes
        skip(1) // skip the initial value
      )
      .subscribe(({ account }) => {
        void this.publishAccountChange(account).catch(error => {
          console.error('Failed to prepare realtime account identity', error);
        });
      });

    this.serverSubscription =
      this.globalContextService.globalContext.serverId.$.subscribe(() => {
        if (this.isCurrentServer()) {
          this.refreshProfileIdentity();
        } else {
          this.profileSubscription?.unsubscribe();
          this.profileSubscription = undefined;
        }
      });
  }

  private async prepareRealtimeIdentity(account: AuthAccountInfo | null) {
    const server = this.serverService.server;
    if (
      this.globalContextService.globalContext.serverId.$.value !== server.id
    ) {
      return;
    }
    // Account lifecycle consumers create requests and subscriptions immediately.
    // Wait for the worker identity reset before publishing the new account.
    await this.nbstoreService.realtime.configure({
      endpoint: server.baseUrl,
      authenticated: !!account,
      userId: account?.id,
      isSelfHosted:
        server.config$.value.type === ServerDeploymentType.Selfhosted,
    });
  }

  private async publishAccountChange(account: AuthAccountInfo | null) {
    const generation = ++this.accountGeneration;
    this.profileSubscription?.unsubscribe();
    this.profileSubscription = undefined;
    await this.prepareRealtimeIdentity(account);
    if (generation !== this.accountGeneration) return;
    if (account === null) {
      this.eventBus.emit(AccountLoggedOut, account);
    } else {
      this.eventBus.emit(AccountLoggedIn, account);
      this.subscribeProfile();
    }
    this.eventBus.emit(AccountChanged, account);
  }

  private isCurrentServer() {
    return (
      this.globalContextService.globalContext.serverId.$.value ===
      this.serverService.server.id
    );
  }

  private refreshProfileIdentity() {
    if (!this.isCurrentServer()) return;
    const generation = this.accountGeneration;
    const account = this.session.account$.value;
    void this.prepareRealtimeIdentity(account)
      .then(() => {
        if (generation === this.accountGeneration) this.subscribeProfile();
      })
      .catch(error => {
        console.error('Failed to prepare realtime profile identity', error);
      });
  }

  private onServerStarted() {
    this.session.revalidate();
    this.refreshProfileIdentity();
  }

  private onApplicationFocused() {
    this.session.revalidate();
  }

  private subscribeProfile() {
    this.profileSubscription?.unsubscribe();
    this.profileSubscription = undefined;
    if (!this.isCurrentServer() || !this.session.account$.value) return;
    const accountId = this.session.account$.value.id;
    const generation = this.accountGeneration;
    this.profileSubscription = this.nbstoreService.realtime
      .subscribe('user.profile.changed', {})
      .subscribe({
        next: () => {
          void (async () => {
            this.session.revalidate();
            await this.session.waitForRevalidation();
            this.eventBus.emit(AccountChanged, this.session.account$.value);
          })().catch(() => {});
        },
        error: error => {
          this.profileSubscription = undefined;
          console.debug(
            'Realtime profile subscription interrupted',
            error?.name
          );
          if (
            error?.name === 'RealtimeIdentityChanged' ||
            error?.name === 'RealtimeUnauthenticated'
          ) {
            // A startup context can reset while this subscribe is in flight.
            // Retry only for the still-current account, never revive an old one.
            queueMicrotask(() => {
              if (
                generation === this.accountGeneration &&
                this.session.account$.value?.id === accountId &&
                this.isCurrentServer()
              ) {
                this.refreshProfileIdentity();
              }
            });
          }
        },
      });
  }

  override dispose() {
    super.dispose();
    this.accountGeneration++;
    this.accountSubscription.unsubscribe();
    this.serverSubscription.unsubscribe();
    this.profileSubscription?.unsubscribe();
    this.profileSubscription = undefined;
  }

  async sendEmailMagicLink(
    email: string,
    verifyToken?: string,
    challenge?: string,
    redirectUrl?: string // url to redirect to after signed-in
  ) {
    this.assertSupportedServerVersion();
    track.$.$.auth.signIn({ method: 'magic-link' });
    // Only native clients use `client_nonce` for magic-link/otp sign-in.
    // Web needs to keep cross-device magic-link compatibility.
    const magicLinkClientNonce = BUILD_CONFIG.isNative
      ? this.setClientNonce()
      : undefined;
    try {
      const scheme = this.urlService.getClientScheme();
      const magicLinkUrlParams = new URLSearchParams();
      if (redirectUrl) {
        magicLinkUrlParams.set('redirect_uri', redirectUrl);
      }
      if (scheme) {
        magicLinkUrlParams.set('client', scheme);
      }
      await this.fetchService.fetch('/api/auth/sign-in', {
        method: 'POST',
        body: JSON.stringify({
          email,
          // we call it [callbackUrl] instead of [redirect_uri]
          // to make it clear the url is used to finish the sign-in process instead of redirect after signed-in
          callbackUrl: `/magic-link?${magicLinkUrlParams.toString()}`,
          client_nonce: magicLinkClientNonce,
        }),
        headers: {
          'content-type': 'application/json',
          ...(verifyToken ? this.captchaHeaders(verifyToken, challenge) : {}),
        },
      });
    } catch (e) {
      track.$.$.auth.signInFail({
        method: 'magic-link',
        reason: UserFriendlyError.fromAny(e).name,
      });
      throw e;
    }
  }

  async signInMagicLink(email: string, token: string, byLink = true) {
    const method = byLink ? 'magic-link' : 'otp';
    try {
      await this.store.signInMagicLink(email, token);

      await this.session.revalidateOnce();
      track.$.$.auth.signedIn({ method });
    } catch (e) {
      track.$.$.auth.signInFail({
        method,
        reason: UserFriendlyError.fromAny(e).name,
      });
      throw e;
    }
  }

  async oauthPreflight(
    provider: OAuthProviderType,
    client: string,
    /** @deprecated*/ redirectUrl?: string
  ): Promise<Record<string, string>> {
    this.assertSupportedServerVersion();
    // OAuth callback requires `client_nonce` for all clients (including web).
    const clientNonce = this.setClientNonce();
    try {
      const res = await this.fetchService.fetch('/api/oauth/preflight', {
        method: 'POST',
        body: JSON.stringify({
          provider,
          client,
          redirect_uri: redirectUrl,
          client_nonce: clientNonce,
        }),
        headers: {
          'content-type': 'application/json',
        },
      });

      return await res.json();
    } catch (e) {
      track.$.$.auth.signInFail({
        method: 'oauth',
        provider,
        reason: UserFriendlyError.fromAny(e).name,
      });
      throw e;
    }
  }

  async signInOauth(code: string, state: string, provider: string) {
    try {
      const { redirectUri } = await this.store.signInOauth(
        code,
        state,
        provider
      );

      await this.session.revalidateOnce();

      track.$.$.auth.signedIn({ method: 'oauth', provider });
      return { redirectUri };
    } catch (e) {
      track.$.$.auth.signInFail({
        method: 'oauth',
        provider,
        reason: UserFriendlyError.fromAny(e).name,
      });
      throw e;
    }
  }

  async createOpenAppSignInCode() {
    const res = await this.fetchService.fetch(
      '/api/auth/open-app/sign-in-code',
      {
        method: 'POST',
      }
    );
    const body = (await res.json()) as { code?: string };

    if (!body.code) {
      throw new Error('Missing open-app sign-in code');
    }

    return body.code;
  }

  async signInOpenAppSignInCode(code: string) {
    await this.store.signInOpenAppSignInCode(code);

    await this.session.revalidateOnce();
  }

  async signInPassword(credential: {
    email: string;
    password: string;
    verifyToken?: string;
    challenge?: string;
  }) {
    this.assertSupportedServerVersion();
    track.$.$.auth.signIn({ method: 'password' });
    try {
      const user = await this.store.signInPassword(credential);
      if (user) {
        this.store.setCachedSignInUser(user);
        this.session.revalidate();
      } else {
        await this.session.revalidateOnce();
      }
      track.$.$.auth.signedIn({ method: 'password' });
    } catch (e) {
      track.$.$.auth.signInFail({
        method: 'password',
        reason: UserFriendlyError.fromAny(e).name,
      });
      throw e;
    }
  }

  async signOut() {
    await this.store.signOut();
    this.store.setCachedAuthSession(null);
    this.session.revalidate();
  }

  async listDeviceSessions() {
    const response = await this.fetchService.fetch('/api/auth/sessions');
    return (await response.json()) as DeviceAuthSession[];
  }

  async revokeDeviceSession(id: string, current: boolean) {
    await this.fetchService.fetch(
      `/api/auth/sessions/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        headers: csrfHeader(),
      }
    );
    if (current) {
      try {
        await this.store.clearSession();
      } finally {
        this.store.setCachedAuthSession(null);
        this.session.revalidate();
      }
    }
  }

  async revokeAllDeviceSessions() {
    await this.fetchService.fetch('/api/auth/sessions/revoke-all', {
      method: 'POST',
      headers: csrfHeader(),
    });
    try {
      await this.store.clearSession();
    } finally {
      this.store.setCachedAuthSession(null);
      this.session.revalidate();
    }
  }

  async deleteAccount() {
    const res = await this.store.deleteAccount();
    this.store.setCachedAuthSession(null);
    this.session.revalidate();
    this.dialogService.open('deleted-account', {});
    return res;
  }

  checkUserByEmail(email: string) {
    return this.store.checkUserByEmail(email);
  }

  captchaHeaders(token: string, challenge?: string) {
    const headers: Record<string, string> = {
      'x-captcha-token': token,
      'x-captcha-provider': challenge ? 'hashcash' : 'turnstile',
    };

    if (challenge) {
      headers['x-captcha-challenge'] = challenge;
    }

    return headers;
  }

  private setClientNonce(): string {
    const nonce = nanoid();
    this.store.setClientNonce(nonce);
    return nonce;
  }

  private assertSupportedServerVersion() {
    const config = this.serverService.server.config$.value;
    if (config.type !== ServerDeploymentType.Selfhosted) return;
    assertSupportedServerVersion(config.version);
  }
}
