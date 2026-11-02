/**
 * @vitest-environment happy-dom
 */
import { DocService, DocsService } from '@affine/core/modules/doc';
import { AppThemeService } from '@affine/core/modules/theme';
import { ColorScheme } from '@blocksuite/affine/model';
import { ThemeExtensionIdentifier } from '@blocksuite/affine/shared/services';
import {
  type BlockStdScope,
  LifeCycleWatcherIdentifier,
  StdIdentifier,
} from '@blocksuite/affine/std';
import { Container } from '@blocksuite/global/di';
import { LiveData } from '@toeverything/infra';
import { expect, test, vi } from 'vitest';

import { getPreviewThemeExtension } from '../view-extensions/theme/preview-theme';
import { getThemeExtension } from '../view-extensions/theme/theme';

vi.mock('@affine/core/modules/theme', () => ({
  AppThemeService: class AppThemeService {},
}));
vi.mock('@affine/core/modules/doc', () => ({
  DocService: class DocService {},
  DocsService: class DocsService {},
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

for (const [name, extensionFactory] of [
  ['editor theme', getThemeExtension],
  ['preview theme', getPreviewThemeExtension],
] as const) {
  test(
    name + ' releases preview subscriptions while main editor stays live',
    () => {
      const app = tracked(ColorScheme.Light);
      const properties = tracked({ edgelessColorTheme: 'system' });
      const doc = { id: 'synthetic-doc', properties$: properties.data };
      const framework = {
        get(token: unknown) {
          if (token === AppThemeService)
            return { appTheme: { theme$: app.data } };
          if (token === DocService) return { doc };
          if (token === DocsService) {
            return { list: { doc$: () => new LiveData(doc) } };
          }
          throw new Error('Unexpected synthetic service');
        },
      } as unknown as Parameters<typeof getThemeExtension>[0];
      const extension = extensionFactory(framework);
      const open = () => {
        const di = new Container();
        di.addImpl(StdIdentifier, () => ({}) as BlockStdScope);
        extension.setup(di);
        const provider = di.provider();
        const service = provider.get(ThemeExtensionIdentifier);
        const watchers = [
          ...provider.getAll(LifeCycleWatcherIdentifier).values(),
        ];
        const appTheme = service.getAppTheme();
        const canvasTheme = service.getEdgelessTheme();
        return {
          appTheme,
          canvasTheme,
          close: () => watchers.forEach(watcher => watcher.unmounted()),
        };
      };
      const main = open();
      const baseline = { app: app.active(), properties: properties.active() };
      try {
        for (let cycle = 0; cycle < 12; cycle++) {
          const preview = open();
          app.data.next(ColorScheme.Dark);
          expect(preview.appTheme.value).toBe(ColorScheme.Dark);
          expect(preview.canvasTheme.value).toBe(ColorScheme.Dark);
          preview.close();
          preview.close();
          expect(app.active()).toBe(baseline.app);
          expect(properties.active()).toBe(baseline.properties);
          app.data.next(ColorScheme.Light);
          expect(main.appTheme.value).toBe(ColorScheme.Light);
          expect(main.canvasTheme.value).toBe(ColorScheme.Light);
        }
      } finally {
        main.close();
      }
      expect(app.active()).toBe(0);
      expect(properties.active()).toBe(0);
    }
  );
}
