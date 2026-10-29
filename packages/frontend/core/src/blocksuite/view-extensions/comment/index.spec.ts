/**
 * @vitest-environment happy-dom
 */
import type {
  ViewExtensionContext,
  ViewScope,
} from '@blocksuite/affine/ext-loader';
import { FrameworkProvider } from '@toeverything/infra';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { CommentViewExtension } from './index';

const { provider } = vi.hoisted(() => ({
  provider: vi.fn(() => ({ setup() {} })),
}));
vi.mock('./comment-provider', () => ({ AffineCommentProvider: provider }));

describe('comment provider editor ownership', () => {
  beforeEach(() => provider.mockClear());
  const framework = Object.create(
    FrameworkProvider.prototype
  ) as FrameworkProvider;
  const setup = (scope: ViewScope, enableComment = true) => {
    const register = vi.fn();
    const context = { scope, register } as unknown as ViewExtensionContext;
    new CommentViewExtension().setup(context, { framework, enableComment });
    return register;
  };

  test.each(['preview-page', 'preview-edgeless'] as const)(
    '%s cannot replace the shared interactive comment editor',
    scope => {
      const register = setup(scope);
      expect(register).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    }
  );

  test.each(['page', 'edgeless', 'mobile-page', 'mobile-edgeless'] as const)(
    '%s preserves its comment provider',
    scope => {
      expect(setup(scope)).toHaveBeenCalledOnce();
      expect(provider).toHaveBeenCalledWith(framework);
    }
  );

  test('disabled comments remain disabled', () => {
    expect(setup('edgeless', false)).not.toHaveBeenCalled();
  });
});
