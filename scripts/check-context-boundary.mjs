import ts from 'typescript';
import {resolve,relative,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
/** Контекст может получать узкий reader, но не фабрику/тип полного Storage.
 * @param {string} root
 */
export function checkContextBoundary(root=process.cwd()) {
 root=resolve(root);
 const config=ts.readConfigFile(resolve(root,'tsconfig.json'),ts.sys.readFile);
 if(config.error)throw Error('context_boundary: invalid_config');
 const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root);
 if(parsed.errors.length)throw Error('context_boundary: invalid_config');
 const roots=parsed.fileNames.filter(f=>/^src\/(context|core\/context)(\/|\.)|^src\/tools\/(context|search)(\/|\.)/.test(relative(root,f).split(sep).join('/')));
 const errors=[];
 for(const start of roots){const seen=new Set(),pending=[start];let invalid=false;
  while(pending.length&&!invalid){const file=pending.pop();if(!file||seen.has(file))continue;seen.add(file);
   const text=ts.sys.readFile(file);if(text===undefined){invalid=true;break;}
   const source=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
   /** @param {ts.Node} node */
   function inspect(node){
    if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)||ts.isImportTypeNode(node)||ts.isExternalModuleReference(node)||(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||(ts.isIdentifier(node.expression)&&node.expression.text==='require')))){
     let spec=ts.isImportDeclaration(node)||ts.isExportDeclaration(node)?node.moduleSpecifier:ts.isImportTypeNode(node)?node.argument:ts.isExternalModuleReference(node)?node.expression:node.arguments[0];
     if(spec&&ts.isLiteralTypeNode(spec))spec=spec.literal;
     if(!spec||!ts.isStringLiteralLike(spec)){invalid=true;return;}
     const resolved=ts.resolveModuleName(spec.text,file??start,parsed.options,ts.sys).resolvedModule;
     if(!resolved){if(spec.text.startsWith('.'))invalid=true;return;}
     const next=resolve(resolved.resolvedFileName),local=relative(root,next).split(sep).join('/');
     if(local==='src/storage/context-types.ts'){
      const facade=ts.sys.readFile(next);if(facade===undefined){invalid=true;return;}
      const body=ts.createSourceFile(next,facade,ts.ScriptTarget.Latest,true);
      for(const statement of body.statements){
       if(ts.isInterfaceDeclaration(statement)&&statement.name.text==='ContextMessageReader')continue;
       if(ts.isImportDeclaration(statement)&&statement.importClause?.isTypeOnly&&statement.importClause.namedBindings&&ts.isNamedImports(statement.importClause.namedBindings)&&statement.importClause.namedBindings.elements.every(e=>['ConnectionScope','StoredMessage','HistoryQuery'].includes((e.propertyName??e.name).text)))continue;
       invalid=true;
      }
      return;
     }
     if(/^src\/storage\//.test(local)){invalid=true;return;}
     if(!next.split(sep).includes('node_modules'))pending.push(next);
    }
    ts.forEachChild(node,inspect);
   }
   inspect(source);
  }
  if(invalid)errors.push(relative(root,start)+': context_boundary: forbidden_access');
 }
 return errors;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){try{const errors=checkContextBoundary();for(const e of errors)process.stderr.write(e+'\n');if(errors.length)process.exitCode=1;}catch{process.stderr.write('context_boundary: check_failed\n');process.exitCode=1;}}
