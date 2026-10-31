import type {
  AuthService,
  PublicUserService,
} from '@affine/core/modules/cloud';
import { UserFriendlyError } from '@affine/error';
import type { Container } from '@blocksuite/affine/global/di';
import {
  type AffineUserInfo,
  UserProvider,
  type UserService,
} from '@blocksuite/affine/shared/services';
import { LifeCycleWatcher } from '@blocksuite/affine/std';
import type { ExtensionType } from '@blocksuite/affine/store';

import { ScopedObservableSignals } from '../scoped-observable-signals';

export function patchUserExtensions(
  publicUserService: PublicUserService,
  authService: AuthService
): ExtensionType {
  class AffineCloudUserService extends LifeCycleWatcher implements UserService {
    static override key = 'affine-cloud-user';
    private readonly signals = new ScopedObservableSignals();

    static override setup(di: Container) {
      super.setup(di);
      di.override(UserProvider, provider => provider.get(this));
    }

    readonly currentUserInfo$ = this.signals.watch(
      authService.session.account$.map(account => {
        if (!account) {
          return null;
        }
        return {
          id: account.id,
          name: account.label,
          avatar: account.avatar,
          removed: false,
        } as AffineUserInfo;
      }),
      null
    );

    userInfo$(id: string) {
      return this.signals.watch(publicUserService.publicUser$(id), null);
    }

    isLoading$(id: string) {
      return this.signals.watch(publicUserService.isLoading$(id), false);
    }

    error$(id: string) {
      return this.signals.watch(
        publicUserService
          .error$(id)
          .selector(error =>
            error ? UserFriendlyError.fromAny(error).name : null
          ),
        null
      );
    }

    revalidateUserInfo(id: string) {
      publicUserService.revalidate(id);
    }

    override mounted() {
      this.signals.mount();
    }

    override unmounted() {
      this.signals.unmount();
    }
  }

  return AffineCloudUserService;
}
