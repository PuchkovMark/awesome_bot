import ts from 'typescript';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
/** Проверяет локальный граф, не исполняя загружаемые модули.
 * @param {string} root
 * @returns {string[]}
 */
export function checkCatalogBoundary(root = process.cwd()) {
  root = resolve(root);
  const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  if (config.error) throw new Error('catalog_boundary: invalid_config');
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  if (parsed.errors.length) throw new Error('catalog_boundary: invalid_config');
  const target = resolve(root, 'src/storage/catalog-admin.ts');
  /** @type {Map<string,{edges:string[],computed:boolean,unresolved:boolean,privileged:boolean}>} */
  const graph = new Map();
  /** @param {string} file */
  function dependencies(file) {
    const cached = graph.get(file);
    if (cached) return cached;
    /** @type {{edges:string[],computed:boolean,unresolved:boolean,privileged:boolean}} */
    const result = { edges: [], computed: false, unresolved: false, privileged: false };
    graph.set(file, result);
    const source = ts.sys.readFile(file);
    if (source === undefined) {
      result.unresolved = true;
      return result;
    }
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    /** @param {ts.Node|undefined} node */
    function add(node) {
      if (!node) {
        result.computed = true;
        return;
      }
      if (ts.isLiteralTypeNode(node)) node = node.literal;
      if (!ts.isStringLiteralLike(node)) {
        result.computed = true;
        return;
      }
      const name = node.text,
        resolved = ts.resolveModuleName(name, file, parsed.options, ts.sys).resolvedModule;
      if (resolved) {
        const p = resolve(resolved.resolvedFileName);
        if (p === resolve(root, 'src/storage/version-registry.ts')) {
          const parent = node.parent;
          const registration =
            ts.isImportDeclaration(parent) &&
            !parent.importClause?.name &&
            parent.importClause?.namedBindings;
          const allowed =
            file === resolve(root, 'src/storage/storage.ts') &&
            registration &&
            ts.isNamedImports(registration) &&
            registration.elements.every(
              (e) => (e.propertyName ?? e.name).text === 'registerVersions',
            );
          if (!allowed) result.privileged = true;
        }
        if (p === resolve(root, 'src/storage/lifecycle-store.ts')) {
          const parent = node.parent;
          const clause = ts.isImportDeclaration(parent) && parent.importClause;
          const bindings = clause && !clause.name && clause.namedBindings;
          const allowed =
            (clause && clause.isTypeOnly) ||
            (bindings &&
              ts.isNamedImports(bindings) &&
              bindings.elements.every((element) => {
                const imported = (element.propertyName ?? element.name).text;
                return (
                  element.isTypeOnly ||
                  (file === resolve(root, 'src/storage/storage.ts') &&
                    ['createLifecycleBackend', 'registerLifecycle'].includes(imported)) ||
                  (file === resolve(root, 'src/storage/chats.ts') &&
                    imported === 'installAuthorities')
                );
              }));
          if (!allowed) result.privileged = true;
        }
        if (p === resolve(root, 'src/storage/autonomous-questions.ts')) {
          const parent = node.parent;
          const bindings =
            ts.isImportDeclaration(parent) &&
            !parent.importClause?.name &&
            parent.importClause?.namedBindings;
          const allowed =
            bindings &&
            ts.isNamedImports(bindings) &&
            bindings.elements.every((element) => {
              const imported = (element.propertyName ?? element.name).text;
              return (
                (file === resolve(root, 'src/storage/queue-store.ts') &&
                  [
                    'dueQuestions',
                    'initiativeDenial',
                    'questionEvidence',
                    'removeWaitingQuestion',
                    'waitForQuestion',
                  ].includes(imported)) ||
                (file === resolve(root, 'src/storage/chats.ts') && imported === 'cancelInitiatives')
              );
            });
          if (!allowed) result.privileged = true;
        }
        for (const [moduleName, factory] of [
          ['queue-registry.ts', 'registerQueue'],
          ['queue-store.ts', 'createQueueBackend'],
          ['notice-store.ts', 'registerNotices'],
          ['token-budget-store.ts', 'registerTokenBudgets'],
          ['reminder-store.ts', 'registerReminders'],
          ['participant-registry.ts', 'registerParticipantRegistry'],
          ['address-preference-store.ts', 'registerAddressPreferences'],
          ['profile-fact-store.ts', 'registerProfileInference'],
          ['profile-update-store.ts', 'registerProfileUpdates'],
          ['greeting-store.ts', 'registerGreetings'],
          ['profile-command-store.ts', 'registerProfileCommands'],
          ['chat-passport-store.ts', 'registerChatPassport'],
          ['questionnaire-store.ts', 'registerQuestionnaires'],
        ]) {
          if (p === resolve(root, 'src/storage/' + moduleName)) {
            const parent = node.parent;
            const bindings =
              ts.isImportDeclaration(parent) &&
              !parent.importClause?.name &&
              parent.importClause?.namedBindings;
            const storageFactory =
              file === resolve(root, 'src/storage/storage.ts') &&
              bindings &&
              ts.isNamedImports(bindings) &&
              bindings.elements.every(
                (e) =>
                  (e.propertyName ?? e.name).text === factory ||
                  (moduleName === 'notice-store.ts' &&
                    (e.propertyName ?? e.name).text === 'createNoticeBackend') ||
                  (moduleName === 'token-budget-store.ts' &&
                    (e.propertyName ?? e.name).text === 'createTokenBudgetStore') ||
                  (moduleName === 'reminder-store.ts' &&
                    (e.propertyName ?? e.name).text === 'createReminderStore') ||
                  (moduleName === 'participant-registry.ts' &&
                    (e.propertyName ?? e.name).text === 'createParticipantRegistry') ||
                  (moduleName === 'address-preference-store.ts' &&
                    (e.propertyName ?? e.name).text === 'createAddressPreferenceStore') ||
                  (moduleName === 'profile-fact-store.ts' &&
                    (e.propertyName ?? e.name).text === 'createProfileFactStore') ||
                  (moduleName === 'profile-update-store.ts' &&
                    (e.propertyName ?? e.name).text === 'createProfileUpdateStore') ||
                  (moduleName === 'greeting-store.ts' &&
                    (e.propertyName ?? e.name).text === 'createGreetingStore') ||
                  (moduleName === 'profile-command-store.ts' &&
                    (e.propertyName ?? e.name).text === 'createProfileCommandStore') ||
                  (moduleName === 'chat-passport-store.ts' &&
                    (e.propertyName ?? e.name).text === 'createChatPassportStore') ||
                  (moduleName === 'questionnaire-store.ts' &&
                    (e.propertyName ?? e.name).text === 'createQuestionnaireStore'),
              );
            const registryType =
              moduleName === 'queue-store.ts' &&
              file === resolve(root, 'src/storage/queue-registry.ts') &&
              ts.isImportDeclaration(parent) &&
              parent.importClause?.isTypeOnly;
            const queueBudget =
              moduleName === 'token-budget-store.ts' &&
              file === resolve(root, 'src/storage/queue-store.ts') &&
              bindings &&
              ts.isNamedImports(bindings) &&
              bindings.elements.every((e) =>
                [
                  'canReserveTokens',
                  'insertTokenReservation',
                  'deleteUnsentTokenReservation',
                  'pruneTokenBudget',
                  'reconcileTokenReservation',
                  'TokenReservation',
                  'FinalBudget',
                ].includes((e.propertyName ?? e.name).text),
              );
            const groupReplyBudget =
              moduleName === 'token-budget-store.ts' &&
              file === resolve(root, 'src/storage/group-reply-gate-store.ts') &&
              bindings &&
              ts.isNamedImports(bindings) &&
              bindings.elements.every((e) =>
                [
                  'canReserveTokens',
                  'insertTokenReservation',
                  'deleteUnsentTokenReservation',
                  'reconcileTokenReservation',
                ].includes((e.propertyName ?? e.name).text),
              );
            const membership =
              moduleName === 'participant-registry.ts' &&
              bindings &&
              ts.isNamedImports(bindings) &&
              bindings.elements.every((element) => {
                const name = (element.propertyName ?? element.name).text;
                return (
                  (file === resolve(root, 'src/storage/queue-store.ts') &&
                    name === 'noteParticipantMessage') ||
                  (file === resolve(root, 'src/storage/token-budget-store.ts') &&
                    ['participantSync', 'applyParticipantSnapshot'].includes(name))
                );
              });
            const profileBudget =
              moduleName === 'token-budget-store.ts' &&
              file === resolve(root, 'src/storage/profile-update-store.ts') &&
              bindings &&
              ts.isNamedImports(bindings) &&
              bindings.elements.every((e) =>
                [
                  'profileUpdateAllowance',
                  'createTokenAttemptMeter',
                  'insertTokenReservation',
                  'deleteUnsentTokenReservation',
                  'reconcileTokenReservation',
                ].includes((e.propertyName ?? e.name).text),
              );
            if (
              !storageFactory &&
              !registryType &&
              !queueBudget &&
              !membership &&
              !profileBudget &&
              !groupReplyBudget
            )
              result.privileged = true;
          }
        }
        if (!p.split(sep).includes('node_modules')) result.edges.push(p);
      } else if (
        name.startsWith('.') ||
        name.startsWith('/') ||
        Object.keys(parsed.options.paths ?? {}).some((k) => name.startsWith(k.split('*')[0] ?? k))
      )
        result.unresolved = true;
    }
    /** @param {ts.Node} node */
    function visit(node) {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
        if (node.moduleSpecifier) add(node.moduleSpecifier);
      } else if (ts.isImportTypeNode(node)) add(node.argument);
      else if (ts.isExternalModuleReference(node)) add(node.expression);
      else if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      )
        add(node.arguments[0]);
      ts.forEachChild(node, visit);
    }
    visit(sf);
    return result;
  }
  const roots = parsed.fileNames.filter((f) =>
    /^src\/(tools|commands|context)\/|^src\/core\/(commands|context)\/|^src\/core\/context\.[cm]?ts$/.test(
      relative(root, f).split(sep).join('/'),
    ),
  );
  /** @type {string[]} */ const errors = [];
  for (const start of roots) {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
      const file = queue.pop();
      if (!file || seen.has(file)) continue;
      seen.add(file);
      if (file === target) {
        errors.push(`${relative(root, start)}: catalog_boundary: forbidden_access`);
        break;
      }
      const deps = dependencies(file);
      if (deps.privileged) {
        errors.push(`${relative(root, start)}: catalog_boundary: forbidden_access`);
        break;
      }
      if (deps.computed || deps.unresolved) {
        errors.push(`${relative(root, start)}: catalog_boundary: uncheckable_import`);
        break;
      }
      queue.push(...deps.edges);
    }
  }
  return errors;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const errors = checkCatalogBoundary();
    for (const error of errors) process.stderr.write(error + '\n');
    if (errors.length) process.exitCode = 1;
  } catch {
    process.stderr.write('catalog_boundary: check_failed\n');
    process.exitCode = 1;
  }
}
