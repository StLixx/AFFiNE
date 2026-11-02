import { AppThemeService } from '@affine/core/modules/theme';
import { ColorScheme } from '@blocksuite/affine/model';
import {
  type ThemeExtension,
  ThemeExtensionIdentifier,
} from '@blocksuite/affine/shared/services';
import type { Signal } from '@blocksuite/affine/shared/utils';
import { type BlockStdScope, LifeCycleWatcher } from '@blocksuite/affine/std';
import type { Container } from '@blocksuite/global/di';
import type { FrameworkProvider } from '@toeverything/infra';
import type { Observable } from 'rxjs';

import { ScopedObservableSignals } from '../scoped-observable-signals';

export function getPreviewThemeExtension(framework: FrameworkProvider) {
  class AffinePagePreviewThemeExtension
    extends LifeCycleWatcher
    implements ThemeExtension
  {
    static override readonly key = 'affine-page-preview-theme';

    readonly theme: Signal<ColorScheme>;

    private readonly signals = new ScopedObservableSignals();

    readonly disposables: (() => void)[] = [];

    static override setup(di: Container) {
      super.setup(di);
      di.override(ThemeExtensionIdentifier, provider => provider.get(this));
    }

    constructor(std: BlockStdScope) {
      super(std);
      const theme$: Observable<ColorScheme> = framework
        .get(AppThemeService)
        .appTheme.theme$.map(theme => {
          return theme === ColorScheme.Dark
            ? ColorScheme.Dark
            : ColorScheme.Light;
        });
      this.theme = this.signals.watch(theme$, ColorScheme.Light);
    }

    getAppTheme() {
      return this.theme;
    }

    getEdgelessTheme() {
      return this.theme;
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

  return AffinePagePreviewThemeExtension;
}
