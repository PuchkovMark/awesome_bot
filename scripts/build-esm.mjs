import { dirname, relative, sep } from 'node:path';
import ts from 'typescript';

/** @param {readonly ts.Diagnostic[]} diagnostics */
function printDiagnostics(diagnostics) {
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (file) => file,
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getNewLine: () => ts.sys.newLine,
    }),
  );
}

/** @param {ts.CompilerOptions} options */
function completeRelativeImports(options) {
  /** @type {ts.TransformerFactory<ts.SourceFile>} */
  return (context) => (source) => {
    const { factory } = context;

    /** @param {ts.Expression} specifier */
    function complete(specifier) {
      if (!ts.isStringLiteralLike(specifier)) return specifier;
      if (!/^\.\.?($|\/)/.test(specifier.text)) return specifier;

      const target = ts.resolveModuleName(
        specifier.text,
        source.fileName,
        options,
        ts.sys,
      ).resolvedModule;
      if (target?.extension !== ts.Extension.Ts) return specifier;

      const path = relative(dirname(source.fileName), target.resolvedFileName)
        .split(sep)
        .join('/')
        .replace(/\.ts$/, '.js');
      const completePath = path.startsWith('../') ? path : `./${path}`;
      return completePath === specifier.text
        ? specifier
        : factory.createStringLiteral(completePath);
    }

    /** @type {ts.Visitor} */
    function visit(node) {
      if (ts.isImportDeclaration(node)) {
        return factory.updateImportDeclaration(
          node,
          node.modifiers,
          node.importClause,
          complete(node.moduleSpecifier),
          node.attributes,
        );
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        return factory.updateExportDeclaration(
          node,
          node.modifiers,
          node.isTypeOnly,
          node.exportClause,
          complete(node.moduleSpecifier),
          node.attributes,
        );
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [specifier, ...attributes] = node.arguments;
        if (specifier) {
          return factory.updateCallExpression(node, node.expression, node.typeArguments, [
            complete(specifier),
            ...attributes,
          ]);
        }
      }
      return ts.visitEachChild(node, visit, context);
    }

    return ts.visitEachChild(source, visit, context);
  };
}

const config = ts.getParsedCommandLineOfConfigFile(
  'tsconfig.build.json',
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => printDiagnostics([diagnostic]),
  },
);
if (!config || config.errors.length > 0) {
  if (config) printDiagnostics(config.errors);
  process.exitCode = 1;
} else {
  const program = ts.createProgram(config.fileNames, config.options);
  // Меняем только узлы импорта в выпускаемом JavaScript после удаления типов.
  const result = program.emit(undefined, undefined, undefined, undefined, {
    after: [completeRelativeImports(config.options)],
  });
  if (result.diagnostics.length > 0) printDiagnostics(result.diagnostics);
  if (result.emitSkipped || result.diagnostics.length > 0) process.exitCode = 1;
}
