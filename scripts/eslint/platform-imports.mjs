/** @typedef {import('@typescript-eslint/utils').TSESTree.Node} Node */
/** @typedef {'platformImport' | 'computedImport'} MessageId */
/** @typedef {[{ packages: string[] }]} Options */

/** @type {import('@typescript-eslint/utils').TSESLint.RuleModule<MessageId, Options>} */
const platformImports = {
  meta: {
    type: 'problem',
    docs: { description: 'Запрещает платформенные импорты в ядре и инструментах' },
    schema: [
      {
        type: 'object',
        properties: {
          packages: { type: 'array', items: { type: 'string', minLength: 1 }, uniqueItems: true },
        },
        required: ['packages'],
        additionalProperties: false,
      },
    ],
    messages: {
      platformImport: 'Платформенная зависимость {{name}} запрещена в ядре и инструментах.',
      computedImport: 'Вычисляемое имя модуля не позволяет проверить платформенную границу.',
    },
  },
  defaultOptions: [{ packages: [] }],
  create(context) {
    const packages = context.options[0]?.packages ?? [];

    /** @param {Node} source */
    function check(source) {
      let name;
      if (source.type === 'Literal' && typeof source.value === 'string') {
        name = source.value;
      } else if (source.type === 'TemplateLiteral' && source.expressions.length === 0) {
        name = source.quasis[0]?.value.cooked;
      }
      if (typeof name !== 'string') {
        context.report({ node: source, messageId: 'computedImport' });
      } else if (packages.some((pkg) => name === pkg || name.startsWith(`${pkg}/`))) {
        context.report({ node: source, messageId: 'platformImport', data: { name } });
      }
    }

    return {
      ImportDeclaration(node) {
        check(node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node.source);
      },
      ExportAllDeclaration(node) {
        check(node.source);
      },
      TSImportType(node) {
        check(node.source);
      },
      TSExternalModuleReference(node) {
        check(node.expression);
      },
      ImportExpression(node) {
        check(node.source);
      },
      CallExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'require') {
          const source = node.arguments[0];
          if (source) check(source);
          else context.report({ node, messageId: 'computedImport' });
        }
      },
    };
  },
};

export default platformImports;
