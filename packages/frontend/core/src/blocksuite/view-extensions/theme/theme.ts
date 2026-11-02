import { DocService, DocsService } from '@affine/core/modules/doc';
import { AppThemeService } from '@affine/core/modules/theme';
import type { Container } from '@blocksuite/affine/global/di';
import { ColorScheme } from '@blocksuite/affine/model';
import {
  type ThemeExtension,
  ThemeExtensionIdentifier,
} from '@blocksuite/affine/shared/services';
import type { Signal } from '@blocksuite/affine/shared/utils';
import { LifeCycleWatcher } from '@blocksuite/affine/std';
import { type FrameworkProvider } from '@toeverything/infra';
import type { Observable } from 'rxjs';
import { combineLatest, map } from 'rxjs';

import { ScopedObservableSignals } from '../scoped-observable-signals';

export function getThemeExtension(
  framework: FrameworkProvider
): typeof LifeCycleWatcher {
  class AffineThemeExtension
    extends LifeCycleWatcher
    implements ThemeExtension
  {
    static override readonly key = 'affine-theme';

    private readonly themes: Map<string, Signal<ColorScheme>> = new Map();

    private readonly signals = new ScopedObservableSignals();

    protected readonly disposables: (() => void)[] = [];

    static override setup(di: Container) {
      super.setup(di);
      di.override(ThemeExtensionIdentifier, provider => provider.get(this));
    }

    getAppTheme() {
      const keyName = 'app-theme';
      const cache = this.themes.get(keyName);
      if (cache) return cache;

      const theme$: Observable<ColorScheme> = framework
        .get(AppThemeService)
        .appTheme.theme$.map(theme => {
          return theme === ColorScheme.Dark
            ? ColorScheme.Dark
            : ColorScheme.Light;
        });
      const themeSignal = this.signals.watch(theme$, ColorScheme.Light);
      this.themes.set(keyName, themeSignal);
      return themeSignal;
    }

    getEdgelessTheme(docId?: string) {
      const doc =
        (docId && framework.get(DocsService).list.doc$(docId).getValue()) ||
        framework.get(DocService).doc;

      const cache = this.themes.get(doc.id);
      if (cache) return cache;

      const appTheme$ = framework.get(AppThemeService).appTheme.theme$;
      const docTheme$ = doc.properties$.map(
        props => props.edgelessColorTheme || 'system'
      );
      const theme$: Observable<ColorScheme> = combineLatest([
        appTheme$,
        docTheme$,
      ]).pipe(
        map(([appTheme, docTheme]) => {
          const theme = docTheme === 'system' ? appTheme : docTheme;
          return theme === ColorScheme.Dark
            ? ColorScheme.Dark
            : ColorScheme.Light;
        })
      );
      const themeSignal = this.signals.watch(theme$, ColorScheme.Light);
      this.themes.set(doc.id, themeSignal);
      return themeSignal;
    }

    override mounted() {
      this.signals.mount();
    }

    override unmounted() {
      this.dispose();
    }

    dispose() {
      this.signals.unmount();
      this.disposables.forEach(dispose => dispose());
    }
  }

  return AffineThemeExtension;
}
