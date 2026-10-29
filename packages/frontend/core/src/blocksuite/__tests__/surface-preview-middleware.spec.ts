/**
 * @vitest-environment happy-dom
 */
import { dirname, resolve } from 'node:path';

import type {
  ViewExtensionContext,
  ViewScope,
} from '@blocksuite/affine-ext-loader';
import { expect, test, vi } from 'vitest';

const viewPath = resolve('blocksuite/affine/blocks/surface/src/view.ts');
const viewDir = dirname(viewPath);
const editBuilder = class EditBuilder {};
vi.doMock(resolve(viewDir, 'effects.ts'), () => ({ effects: vi.fn() }));
vi.doMock(resolve(viewDir, 'extensions/index.ts'), () => ({
  EdgelessCRUDExtension: {},
  EdgelessLegacySlotExtension: {},
  EditPropsMiddlewareBuilder: editBuilder,
}));
vi.doMock(
  resolve(viewDir, 'extensions/export-manager/export-manager.ts'),
  () => ({ ExportManagerExtension: {} })
);
vi.doMock(resolve(viewDir, 'tool/default-tool.ts'), () => ({
  DefaultTool: class DefaultTool {},
}));
const { SurfaceViewExtension } = (await import(viewPath)) as {
  SurfaceViewExtension: new () => {
    setup(context: ViewExtensionContext): void;
  };
};

test.each([
  ['preview-edgeless', false],
  ['preview-page', false],
  ['edgeless', true],
  ['mobile-edgeless', true],
  ['page', false],
  ['mobile-page', false],
] satisfies Array<[ViewScope, boolean]>)(
  '%s registers edit middleware only for an editable surface',
  (scope, expected) => {
    const register = vi.fn();
    new SurfaceViewExtension().setup({
      scope,
      register,
    } as unknown as ViewExtensionContext);
    expect(register).toHaveBeenCalled();
    const extensions = register.mock.calls.flatMap(([value]) =>
      Array.isArray(value) ? value : [value]
    );
    expect(extensions.includes(editBuilder)).toBe(expected);
  }
);
