import { TS } from "./types";
import { expect, test } from "vitest";
import { createTestLanguageService } from "./testHarness";
import { IncrementalLanguageService } from "./services";
import ts, { ClassDeclaration, FunctionDeclaration, FunctionExpression, VariableStatement, factory } from "typescript";
import { cloneNode } from "ts-clone-node";
import { getUnscopedAccesses } from "./analyzer/scope";
import { findClosestBlock } from "./nodeUtils";

test("bundle", () => {
  const { service, normalizePath } = createTestLanguageService();
  // TODO: skip declare function
  const codeSub = `
  export function f() {
    return 1;
  }
  export function ff() {
    return 1;
  }
  export class C {
    public x: number = 1;
  }
  export const sub = () => 1;
  export const sub2 = () => 2;
`;

  const codeIndex = `
    import { sub, f as g, C, ff } from "./sub";
    export const x = sub();
  `;
  service.writeSnapshotContent(normalizePath("src/index.ts"), codeIndex);
  service.writeSnapshotContent(normalizePath("src/sub.ts"), codeSub);
  // const program = service.getProgram()!;
  const bundled = bundle(service, normalizePath("src/index.ts"));

  // console.log(bundled);
  expect(bundled).toBe(`const sub = () => 1;
const f = function g() { return 1; };
class C {
    public x: number = 1;
}
function ff() { return 1; }
export const x = sub();
`);
});

test("bundle #2 with scope access", () => {
  const { service, normalizePath } = createTestLanguageService();
  // TODO: skip declare function
  const codeSub = `
  const x = 1;
  export function f() {
    return internal();
  }
  function internal() {
    return x;
  }
`;
  const codeIndex = `
    import { f } from "./sub";
    export const x = f();
  `;

  service.writeSnapshotContent(normalizePath("src/index.ts"), codeIndex);
  service.writeSnapshotContent(normalizePath("src/sub.ts"), codeSub);
  // const program = service.getProgram()!;
  const bundled = bundle(service, normalizePath("src/index.ts"));
  expect(bundled).toBe(`const x = 1;
function internal() { return x; }
function f() { return internal(); }
export const x = f();
`);

  // console.log(bundled);
});

test.skip("reference graph", () => {
  const { service, normalizePath } = createTestLanguageService();
  const codeSub = `
  const subLocal = 1;
  export function f() {
    return subLocal;
  }
  export function ff() {
    return 1;
  }
  `;
  const codeFoo = `
  const fooLocal = 2;
  export function foo() {
    return fooLocal;
  }
  `;

  const codeBar = `
  import { bar } from "./bar";
  export function bar() {
    return foo();
  }
  `;

  const codeIndex = `
    import { f as g, ff } from "./sub";
    import { bar } from "./bar";
    // export const x = g() + ff() + bar();
    export const x = g();
    export const y = ff();
    export const z = bar();
  `;
  service.writeSnapshotContent(normalizePath("src/index.ts"), codeIndex);
  service.writeSnapshotContent(normalizePath("src/sub.ts"), codeSub);
  service.writeSnapshotContent(normalizePath("src/foo.ts"), codeFoo);
  service.writeSnapshotContent(normalizePath("src/bar.ts"), codeBar);
  const program = service.getProgram()!;
  const graph = createModuleGraph(program, program.getSourceFile(normalizePath("src/index.ts"))!);
  console.log(flattenGraph(graph));
});

// test.skip("bundle #3 re-export", () => {});

function bundle(service: IncrementalLanguageService, entryFileName: string) {
  const program = service.getProgram()!;
  const checker = program.getTypeChecker();
  const indexFile = program.getSourceFile(entryFileName)!;
  const result = ts.transform(indexFile, [createBundleTransformerFactory(checker)]);
  const transformed = result.transformed[0];
  const printed = ts.createPrinter().printFile(transformed);
  return printed;
}

const flattenGraph = (graph: Map<ts.Symbol, Set<ts.Symbol>>) => {
  const result: Array<[from: string, to: string]> = [];
  for (const [from, tos] of graph) {
    for (const to of tos) {
      result.push([from.name, to.name]);
    }
  }
  return result;
};
function createModuleGraph(program: TS.Program, root: TS.SourceFile) {
  const checker = program.getTypeChecker();
  const graph = new Map<TS.Symbol, Set<TS.Symbol>>();

  const addDep = (from: TS.Symbol, to: TS.Symbol) => {
    if (!graph.has(from)) {
      graph.set(from, new Set());
    }
    graph.get(from)!.add(to);
  };

  const symbol = checker.getSymbolAtLocation(root)!;
  const symbols = checker.getExportsOfModule(symbol);
  for (const sym of symbols) {
    addDep(symbol, sym);
    visit(sym);
  }

  return graph;

  function visit(symbol: ts.Symbol) {
    console.log(
      "[visit]",
      symbol.name,
      ":",
      symbol.valueDeclaration && ts.SyntaxKind[symbol.valueDeclaration.kind],
      "=>",
      symbol.valueDeclaration?.getText(),
    );
    if (!symbol.valueDeclaration) return;
    const decl = symbol.valueDeclaration!;
    if (ts.isFunctionDeclaration(decl)) {
      const accesses = getUnscopedAccesses(checker, decl.body!);
      for (const access of accesses) {
        addDep(symbol, access);
        visit(access);
      }
    }

    if (ts.isVariableDeclaration(decl)) {
      if (decl.initializer) {
        const block = findClosestBlock(decl);
        const accesses = getUnscopedAccesses(checker, block!, decl.initializer);

        // console.log("block", block);
        // throw "stop";
        // const accesses = getUnscopedAccesses(checker, block, decl.initializer);
        console.log(
          "accesses",
          [...accesses].map((x) => x.name),
        );
        // for (const access of accesses) {
        //   addDep(symbol, access);
        //   visit(access);
        // }
      }
    }
  }
}

const createBundleTransformerFactory: (checker: TS.TypeChecker) => TS.TransformerFactory<any> =
  (checker) => (context) => {
    // const logger = createLogger("[transformer]");
    // const visitedModules: Set<TS.ModuleDeclaration> = new Set();
    const hoistedDeclarations: TS.Statement[] = [];
    return (file) => {
      const toplevelHoisted: TS.Statement[] = [];
      const visit: TS.Visitor = (node) => {
        // delete imports
        if (ts.isImportDeclaration(node)) {
          const hoisted = transformImportDeclarationToVariableDeclaration(node, checker);
          toplevelHoisted.push(...hoisted);
          return;
        }
        if (ts.isSourceFile(node)) {
          const visited = ts.visitEachChild(node, visit, context);
          return ts.factory.updateSourceFile(node, [...toplevelHoisted, ...visited.statements]);
        }
        return node;
      };
      return visit(file);
    };

    // TODO: Recursive
    function transformImportDeclarationToVariableDeclaration(
      node: TS.ImportDeclaration,
      checker: TS.TypeChecker,
    ): TS.Statement[] {
      if (
        node.importClause &&
        ts.isImportClause(node.importClause) &&
        node.importClause.namedBindings &&
        ts.isNamedImports(node.importClause.namedBindings)
      ) {
        for (const specifier of node.importClause.namedBindings.elements) {
          insertFromImportSpecifier(specifier);
        }
      }
      return hoistedDeclarations;

      function insertFromImportSpecifier(specifier: ts.ImportSpecifier) {
        const targetModule = checker.getSymbolAtLocation(node.moduleSpecifier);
        const outerSymbol = findDeclarationByName(
          checker,
          targetModule?.valueDeclaration! as TS.SourceFile,
          (specifier.propertyName ?? specifier.name).text,
        );
        if (!outerSymbol) {
          throw new Error("No specified symbol");
        }

        // DeclarationList > VariableDeclaration
        if (
          outerSymbol?.valueDeclaration &&
          outerSymbol.valueDeclaration.parent?.parent &&
          ts.isVariableStatement(outerSymbol.valueDeclaration.parent.parent)
        ) {
          const cloned = cloneNode(outerSymbol.valueDeclaration.parent.parent, {
            hook: (_node) => {
              return {
                modifiers: (modifiers) => {
                  return modifiers && ensureNoExportModifier(modifiers as TS.Modifier[]);
                },
              };
            },
          });
          hoistedDeclarations.push(cloned as TS.Node as TS.VariableStatement);
          return;
          // continue;
        }
        if (
          outerSymbol?.valueDeclaration &&
          (ts.isFunctionDeclaration(outerSymbol.valueDeclaration) ||
            ts.isFunctionExpression(outerSymbol.valueDeclaration))
        ) {
          const func = outerSymbol.valueDeclaration as FunctionDeclaration | FunctionExpression;

          const touchingSymbols: TS.Symbol[] = [];
          const visit = (node: TS.Node): void => {
            if (ts.isIdentifier(node)) {
              // skip self name
              if (node === func.name) {
                return;
              }
              const symbol = checker.getSymbolAtLocation(node);
              symbol && touchingSymbols.push(symbol);
            }
            ts.forEachChild(node, visit);
          };
          visit(func);

          const accesses = getUnscopedAccesses(checker, func.body!);
          for (const access of accesses) {
            if (access.valueDeclaration) {
              if (ts.isFunctionDeclaration(access.valueDeclaration)) {
                // TODO: recursive
                const accesses = getUnscopedAccesses(checker, access.valueDeclaration.body!);
                for (const access of accesses) {
                  insertAccessingSymbol(access);
                }

                const clonedFunction = cloneImportedFunction(
                  access.valueDeclaration,
                  specifier.name.text,
                  specifier.propertyName?.text,
                );
                hoistedDeclarations.push(...clonedFunction);
              }
            }
          }
          const clonedFunction = cloneImportedFunction(
            outerSymbol.valueDeclaration,
            specifier.name.text,
            specifier.propertyName?.text,
          );
          hoistedDeclarations.push(...clonedFunction);
        }
        if (
          outerSymbol?.valueDeclaration &&
          (ts.isClassDeclaration(outerSymbol.valueDeclaration) || ts.isClassExpression(outerSymbol.valueDeclaration))
        ) {
          const clonedFunction = cloneImportedClass(
            outerSymbol.valueDeclaration,
            specifier.name.text,
            specifier.propertyName?.text,
          );
          if (clonedFunction) {
            hoistedDeclarations.push(clonedFunction);
          }
        }
      }
      function insertAccessingSymbol(symbol: ts.Symbol) {
        if (!symbol.valueDeclaration) {
          throw new Error("No value declaration");
        }
        // if (ts.isFunctionDeclaration(symbol.valueDeclaration)) {
        //   const accesses = getUnscopedAccesses(checker, symbol.valueDeclaration.body!);
        //   for (const access of accesses) {
        //     const children = insertAccessingDeclarationFromSymbol(access, specifier);
        //     stmts.push(...children);
        //   }
        //   const clonedFunction = cloneImportedFunction(
        //     symbol.valueDeclaration,
        //     specifier!.name.text,
        //     specifier!.propertyName?.text,
        //   );
        //   stmts.push(...clonedFunction);
        // }
        if (ts.isVariableDeclaration(symbol.valueDeclaration)) {
          const clonedVariableDecl = cloneNode<ts.VariableDeclaration>(symbol.valueDeclaration);
          hoistedDeclarations.push(
            ts.factory.createVariableStatement(
              undefined,
              ts.factory.createVariableDeclarationList([clonedVariableDecl], ts.NodeFlags.Const),
            ),
          );
        }
      }
    }

    function cloneImportedFunction(
      node: TS.FunctionDeclaration | TS.FunctionExpression,
      originalName: string,
      nameAs?: string,
    ): Array<TS.VariableStatement | TS.FunctionDeclaration> {
      if (node.body == null) {
        return [];
      }
      const hoistedDeclarations: Array<TS.VariableStatement | TS.FunctionDeclaration> = [];
      if (nameAs == null) {
        const cloned = cloneNode(node as FunctionDeclaration, {
          hook: (_node) => {
            return {
              modifiers: (modifiers) => {
                return modifiers && ensureNoExportModifier(modifiers as TS.Modifier[]);
              },
            };
          },
        });
        hoistedDeclarations.push(cloned);
        return hoistedDeclarations;
        // hoistedDeclarations.push(cloned);
      }
      if (node.body == null) {
        return hoistedDeclarations;
      }
      const clonedAsExpression = ts.factory.createFunctionExpression(
        node.modifiers && (ensureNoExportModifier(node.modifiers) as TS.Modifier[]),
        node.asteriskToken,
        ts.factory.createIdentifier(originalName),
        node.typeParameters,
        node.parameters,
        node.type,
        cloneNode(node.body),
      );
      const clonedStatement = ts.factory.createVariableStatement(
        undefined,
        ts.factory.createVariableDeclarationList(
          [
            ts.factory.createVariableDeclaration(
              ts.factory.createIdentifier(nameAs),
              // ts.factory.createIdentifier(outerName),
              undefined,
              undefined,
              clonedAsExpression,
            ),
          ],
          ts.NodeFlags.Const,
        ),
      );
      return [clonedStatement];
    }

    function cloneImportedClass(
      node: TS.ClassDeclaration | TS.ClassExpression,
      originalName: string,
      nameAs?: string,
    ): TS.VariableStatement | TS.ClassDeclaration | undefined {
      if (nameAs == null) {
        const cloned = cloneNode(node as ClassDeclaration, {
          hook: (_node) => {
            return {
              modifiers: (modifiers) => {
                return modifiers && ensureNoExportModifier(modifiers as TS.Modifier[]);
              },
            };
          },
        });
        return cloned;
      }
      const clonedAsExpression = ts.factory.createClassExpression(
        node.modifiers && (ensureNoExportModifier(node.modifiers) as TS.Modifier[]),
        node.name,
        node.typeParameters,
        node.heritageClauses,
        node.members,
      );
      const clonedStatement = ts.factory.createVariableStatement(
        undefined,
        ts.factory.createVariableDeclarationList(
          [
            ts.factory.createVariableDeclaration(
              ts.factory.createIdentifier(nameAs),
              // ts.factory.createIdentifier(outerName),
              undefined,
              undefined,
              clonedAsExpression,
            ),
          ],
          ts.NodeFlags.Const,
        ),
      );
      return clonedStatement;
    }
  };

const ensureNoExportModifier = <M extends TS.ModifierLike>(modifiers: M[] | TS.NodeArray<M>): M[] => {
  return modifiers.filter((modifier) => {
    return modifier.kind !== ts.SyntaxKind.ExportKeyword;
  });
};

function findDeclarationByName(checker: TS.TypeChecker, outer: ts.SourceFile, name: string): TS.Symbol | undefined {
  // const exportedSymbols = collectExportSymbols(checker, outer);
  // const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(outer);
  const exportSymbols = checker.getExportsOfModule(symbol!);
  return exportSymbols.find((symbol) => symbol.name === name);
}
