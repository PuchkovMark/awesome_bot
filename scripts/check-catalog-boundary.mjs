import ts from 'typescript';
import {resolve,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
/** Проверяет локальный граф, не исполняя загружаемые модули.
 * @param {string} root
 * @returns {string[]}
 */
export function checkCatalogBoundary(root=process.cwd()) {
 root=resolve(root);const config=ts.readConfigFile(resolve(root,'tsconfig.json'),ts.sys.readFile);
 if(config.error)throw new Error('catalog_boundary: invalid_config');
 const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root);
 if(parsed.errors.length)throw new Error('catalog_boundary: invalid_config');
 const target=resolve(root,'src/storage/catalog-admin.ts');
 /** @type {Map<string,{edges:string[],computed:boolean,unresolved:boolean,privileged:boolean}>} */
 const graph=new Map();
 /** @param {string} file */
 function dependencies(file){
  const cached=graph.get(file);if(cached)return cached;
  /** @type {{edges:string[],computed:boolean,unresolved:boolean,privileged:boolean}} */
  const result={edges:[],computed:false,unresolved:false,privileged:false};graph.set(file,result);
  const source=ts.sys.readFile(file);if(source===undefined){result.unresolved=true;return result;}
  const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true);
  /** @param {ts.Node|undefined} node */
  function add(node){
   if(!node){result.computed=true;return;}
   if(ts.isLiteralTypeNode(node))node=node.literal;
   if(!ts.isStringLiteralLike(node)){result.computed=true;return;}
   const name=node.text,resolved=ts.resolveModuleName(name,file,parsed.options,ts.sys).resolvedModule;
   if(resolved){const p=resolve(resolved.resolvedFileName);
    if(p===resolve(root,'src/storage/version-registry.ts')){
     const parent=node.parent;
     const registration=ts.isImportDeclaration(parent)&&!parent.importClause?.name&&parent.importClause?.namedBindings;
     const allowed=file===resolve(root,'src/storage/storage.ts')&&registration&&ts.isNamedImports(registration)&&registration.elements.every(e=>(e.propertyName??e.name).text==='registerVersions');
     if(!allowed)result.privileged=true;
    }
    for(const [moduleName, factory] of [['queue-registry.ts','registerQueue'],['queue-store.ts','createQueueBackend']]) {
     if(p===resolve(root,'src/storage/'+moduleName)) {
      const parent=node.parent;
      const bindings=ts.isImportDeclaration(parent)&&!parent.importClause?.name&&parent.importClause?.namedBindings;
      const storageFactory=file===resolve(root,'src/storage/storage.ts')&&bindings&&ts.isNamedImports(bindings)&&bindings.elements.every(e=>(e.propertyName??e.name).text===factory);
      const registryType=moduleName==='queue-store.ts'&&file===resolve(root,'src/storage/queue-registry.ts')&&ts.isImportDeclaration(parent)&&parent.importClause?.isTypeOnly;
      if(!storageFactory&&!registryType)result.privileged=true;
     }
    }
    if(!p.split(sep).includes('node_modules'))result.edges.push(p);
   }
   else if(name.startsWith('.')||name.startsWith('/')||Object.keys(parsed.options.paths??{}).some(k=>name.startsWith(k.split('*')[0]??k)))result.unresolved=true;
  }
  /** @param {ts.Node} node */
  function visit(node){
   if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)){if(node.moduleSpecifier)add(node.moduleSpecifier);}
   else if(ts.isImportTypeNode(node))add(node.argument);
   else if(ts.isExternalModuleReference(node))add(node.expression);
   else if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&node.expression.text==='require')))add(node.arguments[0]);
   ts.forEachChild(node,visit);
  }
  visit(sf);return result;
 }
 const roots=parsed.fileNames.filter(f=>/^src\/(tools|commands|context)\/|^src\/core\/(commands|context)\/|^src\/core\/context\.[cm]?ts$/.test(relative(root,f).split(sep).join('/')));
 /** @type {string[]} */ const errors=[];
 for(const start of roots){const seen=new Set();const queue=[start];while(queue.length){const file=queue.pop();if(!file||seen.has(file))continue;seen.add(file);
  if(file===target){errors.push(`${relative(root,start)}: catalog_boundary: forbidden_access`);break;}
  const deps=dependencies(file);if(deps.privileged){errors.push(`${relative(root,start)}: catalog_boundary: forbidden_access`);break;}if(deps.computed||deps.unresolved){errors.push(`${relative(root,start)}: catalog_boundary: uncheckable_import`);break;}queue.push(...deps.edges);
 }}
 return errors;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{const errors=checkCatalogBoundary();for(const error of errors)process.stderr.write(error+'\n');if(errors.length)process.exitCode=1;}
 catch{process.stderr.write('catalog_boundary: check_failed\n');process.exitCode=1;}
}
