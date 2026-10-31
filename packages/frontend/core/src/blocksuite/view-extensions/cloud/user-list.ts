import type { MemberSearchService } from '@affine/core/modules/permissions';
import type { Container } from '@blocksuite/affine/global/di';
import {
  UserListProvider,
  type UserListService,
} from '@blocksuite/affine/shared/services';
import { LifeCycleWatcher } from '@blocksuite/affine/std';
import type { ExtensionType } from '@blocksuite/affine/store';

import { ScopedObservableSignals } from '../scoped-observable-signals';

export function patchUserListExtensions(
  memberSearch: MemberSearchService
): ExtensionType {
  class AffineCloudUserListService
    extends LifeCycleWatcher
    implements UserListService
  {
    static override key = 'affine-cloud-user-list';
    private readonly signals = new ScopedObservableSignals();

    static override setup(di: Container) {
      super.setup(di);
      di.override(UserListProvider, provider => provider.get(this));
    }

    readonly hasMore$ = this.signals.watch(
      memberSearch.hasMore$,
      memberSearch.hasMore$.value
    );
    readonly isLoading$ = this.signals.watch(
      memberSearch.isLoading$,
      memberSearch.isLoading$.value
    );
    readonly searchText$ = this.signals.watch(
      memberSearch.searchText$,
      memberSearch.searchText$.value
    );
    readonly users$ = this.signals.watch(
      memberSearch.result$.map(users =>
        users.map(u => ({
          id: u.id,
          name: u.name,
          avatar: u.avatarUrl,
        }))
      ),
      []
    );

    loadMore() {
      memberSearch.loadMore();
    }

    search(keyword: string) {
      memberSearch.search(keyword);
    }

    override mounted() {
      this.signals.mount();
    }

    override unmounted() {
      this.signals.unmount();
    }
  }

  return AffineCloudUserListService;
}
