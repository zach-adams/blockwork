import { definePlugin, defineRule } from '@oxlint/plugins';
import type { ESTree } from '@oxlint/plugins';
import createPaddingLineRule from './anti-slop/vendor/eslint-stylistic/padding-line-between-statements.ts';

const topLevelFunctions = defineRule({
  meta: {
    type: 'suggestion',
    schema: [],
    messages: {
      declaration:
        'Use a function declaration for a named top-level function. Keep arrows for callbacks and local closures.',
    },
  },
  createOnce(context) {
    return {
      VariableDeclarator(node) {
        if (
          node.init?.type !== 'ArrowFunctionExpression' &&
          node.init?.type !== 'FunctionExpression'
        ) {
          return;
        }

        const declaration = node.parent;

        const statement =
          declaration.parent?.type === 'ExportNamedDeclaration' ? declaration.parent : declaration;

        if (statement.parent?.type === 'Program') {
          context.report({ node, messageId: 'declaration' });
        }
      },
    };
  },
});

const typeNames = defineRule({
  meta: {
    type: 'suggestion',
    schema: [],
    messages: { pascalCase: 'Use PascalCase for a named type.' },
  },
  createOnce(context) {
    const check = (node: ESTree.BindingIdentifier) => {
      if (!/^[A-Z][a-zA-Z0-9]*$/.test(node.name)) {
        context.report({ node, messageId: 'pascalCase' });
      }
    };

    return {
      TSInterfaceDeclaration(node) {
        check(node.id);
      },
      TSTypeAliasDeclaration(node) {
        check(node.id);
      },
      ClassDeclaration(node) {
        if (node.id) {
          check(node.id);
        }
      },
    };
  },
});

// Reuse the existing vendored spacing engine. Short declarations form a group;
// control flow and named type/function declarations keep their structural gaps.
const shortDeclarations = {
  selector: `:matches(${[
    'VariableDeclaration[kind="const"]',
    'VariableDeclaration[kind="let"]',
    'ExportNamedDeclaration[declaration.kind="const"]',
    'ExportNamedDeclaration[declaration.kind="let"]',
  ].join(', ')})`,
  lineMode: 'singleline' as const,
};
const namedDeclarations = {
  selector: `:matches(${[
    'FunctionDeclaration',
    'ClassDeclaration',
    'TSInterfaceDeclaration',
    'TSTypeAliasDeclaration',
    'ExportNamedDeclaration[declaration.type="FunctionDeclaration"]',
    'ExportNamedDeclaration[declaration.type="ClassDeclaration"]',
    'ExportNamedDeclaration[declaration.type="TSInterfaceDeclaration"]',
    'ExportNamedDeclaration[declaration.type="TSTypeAliasDeclaration"]',
    'ExportDefaultDeclaration[declaration.type="FunctionDeclaration"]',
    'ExportDefaultDeclaration[declaration.type="ClassDeclaration"]',
  ].join(', ')})`,
};
const statementSpacing = createPaddingLineRule([
  { blankLine: 'always', prev: 'import', next: '*' },
  { blankLine: 'always', prev: '*', next: namedDeclarations },
  { blankLine: 'always', prev: namedDeclarations, next: '*' },
  { blankLine: 'always', prev: '*', next: ['return', 'if', 'switch', 'try', 'for', 'while', 'do'] },
  { blankLine: 'always', prev: 'block-like', next: '*' },
  { blankLine: 'any', prev: 'import', next: 'import' },
  { blankLine: 'never', prev: shortDeclarations, next: shortDeclarations },
  {
    blankLine: 'any',
    prev: {
      selector:
        ':matches(TSDeclareFunction, ExportNamedDeclaration[declaration.type="TSDeclareFunction"])',
    },
    next: {
      selector:
        ':matches(TSDeclareFunction, FunctionDeclaration, ExportNamedDeclaration[declaration.type="TSDeclareFunction"], ExportNamedDeclaration[declaration.type="FunctionDeclaration"])',
    },
  },
]);

export default definePlugin({
  meta: { name: 'readability' },
  rules: {
    'top-level-functions': topLevelFunctions,
    'type-names': typeNames,
    'statement-spacing': statementSpacing,
  },
});
