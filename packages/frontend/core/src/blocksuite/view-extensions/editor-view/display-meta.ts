import { DocDisplayMetaService } from '@affine/core/modules/doc-display-meta';
import type { Container } from '@blocksuite/affine/global/di';
import type {
  DocDisplayMetaExtension,
  DocDisplayMetaParams,
} from '@blocksuite/affine/shared/services';
import { DocDisplayMetaProvider } from '@blocksuite/affine/shared/services';
import { referenceToNode } from '@blocksuite/affine/shared/utils';
import { LifeCycleWatcher } from '@blocksuite/affine/std';
import type { ExtensionType } from '@blocksuite/affine/store';
import { LinkedPageIcon, PageIcon } from '@blocksuite/icons/lit';
import { computed, type ReadonlySignal } from '@preact/signals-core';
import { type FrameworkProvider } from '@toeverything/infra';
import type { TemplateResult } from 'lit';

import { ScopedObservableSignals } from '../scoped-observable-signals';

export function buildDocDisplayMetaExtension(
  framework: FrameworkProvider
): ExtensionType {
  const docDisplayMetaService = framework.get(DocDisplayMetaService);

  function iconBuilder(
    icon: typeof PageIcon,
    size = '1.25em',
    style = 'user-select:none;flex-shrink:0;vertical-align:middle;font-size:inherit;margin-bottom:0.1em;'
  ) {
    return icon({
      width: size,
      height: size,
      style,
    });
  }

  class AffineDocDisplayMetaService
    extends LifeCycleWatcher
    implements DocDisplayMetaExtension
  {
    static override key = 'doc-display-meta';

    private readonly signals = new ScopedObservableSignals();

    static override setup(di: Container) {
      super.setup(di);
      di.override(DocDisplayMetaProvider, provider => provider.get(this));
    }

    dispose() {
      this.signals.unmount();
    }

    icon(
      docId: string,
      { params, title, referenced }: DocDisplayMetaParams = {}
    ): ReadonlySignal<TemplateResult> {
      const icon$ = docDisplayMetaService
        .icon$(docId, {
          type: 'lit',
          title,
          reference: referenced,
          referenceToNode: referenceToNode({ pageId: docId, params }),
        })
        .map(iconBuilder);

      const iconSignal = this.signals.watch(
        icon$,
        iconBuilder(referenced ? LinkedPageIcon : PageIcon)
      );

      return computed(() => iconSignal.value);
    }

    title(
      docId: string,
      { title, referenced }: DocDisplayMetaParams = {}
    ): ReadonlySignal<string> {
      const title$ = docDisplayMetaService.title$(docId, {
        title,
        reference: referenced,
      });

      const titleSignal = this.signals.watch(title$, title ?? '');

      return computed(() => titleSignal.value);
    }

    override mounted() {
      this.signals.mount();
    }

    override unmounted() {
      this.dispose();
    }
  }

  return AffineDocDisplayMetaService;
}
