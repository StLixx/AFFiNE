/**
 * @vitest-environment happy-dom
 */
import {
  DocDisplayMetaProvider,
  UserListProvider,
  UserProvider,
} from '@blocksuite/affine/shared/services';
import {
  type BlockStdScope,
  LifeCycleWatcherIdentifier,
  StdIdentifier,
} from '@blocksuite/affine/std';
import { Container } from '@blocksuite/global/di';
import { LiveData } from '@toeverything/infra';
import { expect, test, vi } from 'vitest';

import { patchUserExtensions } from '../view-extensions/cloud/user';
import { patchUserListExtensions } from '../view-extensions/cloud/user-list';
import { buildDocDisplayMetaExtension } from '../view-extensions/editor-view/display-meta';

vi.mock('@affine/core/modules/doc-display-meta', () => ({
  DocDisplayMetaService: class DocDisplayMetaService {},
}));

function tracked<T>(initial: T) {
  const data = new LiveData(initial);
  const original = data.subscribe.bind(data);
  let active = 0;
  vi.spyOn(data, 'subscribe').mockImplementation((...args) => {
    const subscription = Reflect.apply(original, data, args);
    active++;
    subscription.add(() => active--);
    return subscription;
  });
  return { data, active: () => active };
}

type Account = { id: string; label: string; avatar: string };
type Member = { id: string; name: string; avatarUrl: string };

function fixture() {
  const account = tracked<Account | null>(null);
  const members = tracked<Member[]>([]);
  const publicUsers = tracked(new Map<string, { id: string; name: string }>());
  const loading = tracked(new Map<string, boolean>());
  const errors = tracked(new Map<string, Error | null>());
  const auth = { session: { account$: account.data } } as unknown as Parameters<
    typeof patchUserExtensions
  >[1];
  const users = {
    publicUser$: (id: string) =>
      publicUsers.data.selector(values => values.get(id) ?? null),
    isLoading$: (id: string) =>
      loading.data.selector(values => values.get(id) ?? false),
    error$: (id: string) => errors.data.selector(values => values.get(id)),
    revalidate: vi.fn(),
  } as unknown as Parameters<typeof patchUserExtensions>[0];
  const search = {
    hasMore$: new LiveData(false),
    isLoading$: new LiveData(false),
    searchText$: new LiveData(''),
    result$: members.data,
    loadMore: vi.fn(),
    search: vi.fn(),
  } as unknown as Parameters<typeof patchUserListExtensions>[0];
  function open() {
    const di = new Container();
    di.addImpl(StdIdentifier, () => ({}) as BlockStdScope);
    patchUserExtensions(users, auth).setup(di);
    patchUserListExtensions(search).setup(di);
    const provider = di.provider();
    const user = provider.get(UserProvider);
    const list = provider.get(UserListProvider);
    const watchers = [...provider.getAll(LifeCycleWatcherIdentifier).values()];
    return {
      user,
      list,
      watchers,
      mount: () => watchers.forEach(watcher => watcher.mounted()),
      close: () => watchers.forEach(watcher => watcher.unmounted()),
    };
  }
  return {
    account,
    members,
    publicUsers,
    loading,
    errors,
    auth,
    users,
    search,
    open,
  };
}

test('building unused cloud extensions does not subscribe long-lived services', () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) {
    patchUserExtensions(f.users, f.auth);
    patchUserListExtensions(f.search);
  }
  expect(f.account.active()).toBe(0);
  expect(f.members.active()).toBe(0);
});

test('cloud providers are the instances receiving scope lifecycle callbacks', () => {
  const f = fixture();
  const scope = f.open();
  try {
    expect(scope.watchers).toContain(scope.user);
    expect(scope.watchers).toContain(scope.list);
  } finally {
    scope.close();
  }
});

test('closing repeated preview scopes releases account and member subscriptions', () => {
  const f = fixture();
  for (let i = 0; i < 12; i++) {
    const scope = f.open();
    scope.mount();
    f.account.data.next({ id: 'one', label: 'User One', avatar: 'avatar' });
    f.members.data.next([{ id: 'one', name: 'User One', avatarUrl: 'avatar' }]);
    expect(scope.user.currentUserInfo$.value?.name).toBe('User One');
    expect(scope.list.users$.value[0]?.avatar).toBe('avatar');
    scope.close();
    scope.close();
    expect(f.account.active()).toBe(0);
    expect(f.members.active()).toBe(0);
  }
});

test('disposing previews preserves the main editor shared services', () => {
  const f = fixture();
  const main = f.open();
  try {
    for (let i = 0; i < 4; i++) {
      const preview = f.open();
      preview.close();
      expect(f.account.active()).toBe(1);
      expect(f.members.active()).toBe(1);
    }
    f.account.data.next({
      id: 'one',
      label: 'Still live',
      avatar: 'new-avatar',
    });
    expect(main.user.currentUserInfo$.value?.name).toBe('Still live');
    f.members.data.next([
      { id: 'one', name: 'Still live', avatarUrl: 'new-avatar' },
    ]);
    expect(main.list.users$.value[0]?.avatar).toBe('new-avatar');
  } finally {
    main.close();
  }
  expect(f.account.active()).toBe(0);
  expect(f.members.active()).toBe(0);
});

test('per-user signals release selectors and refresh after reconnect', () => {
  const f = fixture();
  const scope = f.open();
  const user = scope.user.userInfo$('one');
  const loading = scope.user.isLoading$('one');
  const error = scope.user.error$('one');
  f.publicUsers.data.next(new Map([['one', { id: 'one', name: 'Before' }]]));
  f.loading.data.next(new Map([['one', true]]));
  f.errors.data.next(new Map([['one', new Error('synthetic')]]));
  expect(user.value?.name).toBe('Before');
  expect(loading.value).toBe(true);
  expect(error.value).toBeTruthy();
  scope.close();
  expect(f.publicUsers.active()).toBe(0);
  expect(f.loading.active()).toBe(0);
  expect(f.errors.active()).toBe(0);
  f.publicUsers.data.next(new Map([['one', { id: 'one', name: 'After' }]]));
  f.loading.data.next(new Map([['one', false]]));
  f.errors.data.next(new Map([['one', null]]));
  scope.mount();
  scope.mount();
  expect(user.value?.name).toBe('After');
  expect(loading.value).toBe(false);
  expect(error.value).toBe(null);
  expect(f.publicUsers.active()).toBe(1);
  scope.close();
  expect(f.publicUsers.active()).toBe(0);
});

test('display metadata uses its registered lifecycle owner and releases titles', () => {
  const title = tracked('Original title');
  const framework = {
    get: () => ({ title$: () => title.data.map(value => value) }),
  } as unknown as Parameters<typeof buildDocDisplayMetaExtension>[0];
  const extension = buildDocDisplayMetaExtension(framework);
  const di = new Container();
  di.addImpl(StdIdentifier, () => ({}) as BlockStdScope);
  extension.setup(di);
  const provider = di.provider();
  const service = provider.get(DocDisplayMetaProvider);
  const watchers = [...provider.getAll(LifeCycleWatcherIdentifier).values()];
  const value = service.title('synthetic-doc');
  expect(value.value).toBe('Original title');
  expect(watchers).toContain(service);
  watchers.forEach(watcher => watcher.unmounted());
  expect(title.active()).toBe(0);
  title.data.next('Reconnected title');
  watchers.forEach(watcher => watcher.mounted());
  expect(value.value).toBe('Reconnected title');
  watchers.forEach(watcher => watcher.unmounted());
  expect(title.active()).toBe(0);
});
