import ts from 'typescript';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
/** Метрики получают события, но не читают хранилище трассировок.
 * @param {string} root
 */
export function checkTraceBoundary(root = process.cwd()) {
  root = resolve(root);
  const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw Error('trace_boundary: invalid_config');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw Error('trace_boundary: invalid_config');
  const roots = parsed.fileNames.filter((f) =>
    /^src\/(core|metrics)\/.*metrics\.[cm]?ts$|^src\/metrics\//.test(
      relative(root, f).split(sep).join('/'),
    ),
  );
  const errors = [];
  for (const start of roots) {
    const pending = [start],
      seen = new Set();
    let bad = false;
    while (pending.length && !bad) {
      const f = pending.pop();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      const local = relative(root, f).split(sep).join('/');
      if (
        /^src\/storage\/(trace-store|storage|index|scoped-storage|queue-store|queue-registry|catalog-admin)\.[cm]?ts$/.test(
          local,
        )
      ) {
        bad = true;
        break;
      }
      const text = ts.sys.readFile(f);
      if (text === undefined) {
        bad = true;
        break;
      }
      const source = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
      /** @param {ts.Node} n */
      function inspect(n) {
        if (
          ts.isImportDeclaration(n) ||
          ts.isExportDeclaration(n) ||
          ts.isImportTypeNode(n) ||
          ts.isExternalModuleReference(n) ||
          (ts.isCallExpression(n) &&
            (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
              (ts.isIdentifier(n.expression) && n.expression.text === 'require')))
        ) {
          let v =
            ts.isImportDeclaration(n) || ts.isExportDeclaration(n)
              ? n.moduleSpecifier
              : ts.isImportTypeNode(n)
                ? n.argument
                : ts.isExternalModuleReference(n)
                  ? n.expression
                  : n.arguments[0];
          if (v && ts.isLiteralTypeNode(v)) v = v.literal;
          if (!v || !ts.isStringLiteralLike(v)) {
            bad = true;
            return;
          }
          const target = ts.resolveModuleName(
            v.text,
            f ?? start,
            parsed.options,
            ts.sys,
          ).resolvedModule;
          if (!target) {
            if (v.text.startsWith('.')) bad = true;
            return;
          }
          if (!target.resolvedFileName.split(sep).includes('node_modules'))
            pending.push(resolve(target.resolvedFileName));
        }
        ts.forEachChild(n, inspect);
      }
      inspect(source);
    }
    if (bad) errors.push(relative(root, start) + ': trace_boundary: forbidden_access');
  }
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const errors = checkTraceBoundary();
    for (const e of errors) process.stderr.write(e + '\n');
    if (errors.length) process.exitCode = 1;
  } catch {
    process.stderr.write('trace_boundary: check_failed\n');
    process.exitCode = 1;
  }
}
