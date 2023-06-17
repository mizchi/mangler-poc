// import { Program, Node, SourceFile, FunctionDeclaration, FunctionExpression, isFunctionDeclaration } from "typescript";
// import { Block, ClassDeclaration, FunctionDeclaration, Node, Program, Signature, SourceFile, Symbol, SymbolFlags, Type, isExpression, isFunctionDeclaration, isVariableStatement } from "typescript";
import ts from "typescript";
import { TraverseableNode, createTypeVisitor, visitScopedIdentifierSymbols } from "./nodeUtils";

export type ScopedSymbol = {
  symbol: ts.Symbol;
  parentBlock: TraverseableNode;
  paths: TraverseableNode[];
  isExportRelated?: boolean;
}

export function collectScopedSymbols(program: ts.Program, file: ts.SourceFile, debug = false): ScopedSymbol[] {
  // const debugLog = debug ? console.log : () => {};
  const checker = program.getTypeChecker();
  const collector = createRelatedTypesCollector(program, debug);

  const exportSymbols = collectExportSymbols(program, file, debug);
  const globalVariables = collectGlobalVariables(program, file);
  const globalTypes = collectGlobalTypes(program, file);
  for (const symbol of exportSymbols) {
    collector.collectRelatedTypesFromSymbol(symbol);
    // console.log("exportSymbols", symbol.getName(), symbol.declarations?.map(x => x.getText()));
  }
  for (const symbol of globalVariables) {
    collector.collectRelatedTypesFromSymbol(symbol);
  }
  for (const symbol of globalTypes) {
    collector.collectRelatedTypesFromSymbol(symbol);
  }

  const result: ScopedSymbol[] = [];
  
  // console.log("---start---", file.fileName);
  visitScopedIdentifierSymbols(program, file, (symbol, parentBlock, paths, depth) => {
    // console.log("symbol", symbol.getName(), symbol.declarations?.length);

    if (symbol.valueDeclaration == null) {
      const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!);
      const isExportRelated = collector.isRelatedType(type);
      result.push({
        symbol,
        parentBlock,
        isExportRelated,
        paths,
      });
    } else {
      if (symbol.declarations) {
        for (const decl of symbol.declarations) {
          const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
          const isExportRelated = collector.isRelatedType(type);
          result.push({
            symbol,
            parentBlock,
            isExportRelated,
            paths,
          });  
        }  
      }
    }
  }, 0, debug);
  return result;
}

export function createRelatedTypesCollector(program: ts.Program, debug = false) {
  const checker = program.getTypeChecker();
  // let symbols = new Map<string, Symbol>();
  let relatedTypes = new Set<ts.Type>();
  let relatedSymbols = new Set<ts.Symbol>();

  const debugLog = debug ? console.log : () => {};

  const visitType = createTypeVisitor(checker, debug);

  return {
    getRelatedTypes: () => relatedTypes,
    isRelatedType: (type: ts.Type) => {
      return relatedTypes.has(type)
    },
    isRelatedSymbol: (symbol: ts.Symbol) => {
      if (symbol.valueDeclaration != null) {
        const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration);
        return relatedTypes.has(type);
      }
      return relatedSymbols.has(symbol);
    },
    isRelatedTypeFromSymbol: (symbol: ts.Symbol) => {
      const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration!);
      return relatedTypes.has(type);
    },

    collectRelatedTypesFromSymbol: (symbol: ts.Symbol, depth = 0): Set<ts.Type> => {
      if (symbol.declarations) {
        for (const decl of symbol.declarations) {
          const declaredType = checker.getTypeAtLocation(decl);
          if (declaredType == null) continue;
          collectRelatedType(declaredType, depth);
        }
      }
      if (symbol.valueDeclaration == null) {
        return relatedTypes;
      }
      const type = checker.getTypeOfSymbolAtLocation(symbol, symbol.valueDeclaration);
      collectRelatedType(type, depth);
      return relatedTypes;
    },
  }

  function collectRelatedType(type: ts.Type, depth = 0) {
    visitType(
      type,
      (type) => {
        if (relatedTypes.has(type)) {
          return true;
        }
        relatedTypes.add(type);
      },
      (symbol) => {
        if (relatedSymbols.has(symbol)) {
          return true;
        }
      }
    );
    return;
  }
}

export function collectExportSymbols(program: ts.Program, source: ts.SourceFile, debug = false): ts.Symbol[] {
  const checker = program.getTypeChecker();
  const symbol = checker.getSymbolAtLocation(source);
  const exportSymbols = checker.getExportsOfModule(symbol!);
  return exportSymbols;
}

export function collectImportableModules(program: ts.Program, file: ts.SourceFile) {
  const checker = program.getTypeChecker();
  const values = checker.getSymbolsInScope(file, ts.SymbolFlags.ValueModule);
  return values;  
}

export function collectGlobalVariables(program: ts.Program, file: ts.SourceFile) {
  const checker = program.getTypeChecker();
  const scopedSymbols =  new Set(checker.getSymbolsInScope(file, ts.SymbolFlags.BlockScoped));

  const variables = checker.getSymbolsInScope(file, ts.SymbolFlags.Variable).filter((s) => {
    return !scopedSymbols.has(s);
  });
  return variables;
}

export function collectGlobalTypes(program: ts.Program, file: ts.SourceFile) {
  const checker = program.getTypeChecker();
  const types = checker.getSymbolsInScope(file, ts.SymbolFlags.Type).filter((s) => {
    if (s.declarations) {
      for (const decl of s.declarations) {
        if (decl.getSourceFile() === file) {
          return false;
        }
      }
    }
    return s.valueDeclaration == null;
  });
  return types;
}

// collect unsafe rename targets
/** @internal */
export function collectUnsafeRenameTargets(program: ts.Program, source: ts.SourceFile, scopedSymbols: ScopedSymbol[]) {
  const checker = program.getTypeChecker();
  const unsafeRenameTargets = new Set<string>();
  // register global names to unsafe
  for (const gvar of collectGlobalVariables(program, source)) {
    unsafeRenameTargets.add(gvar.name);
  }
  // register existed local names to unsafe
  for (const blockSymbol of scopedSymbols) {
    const symbols = checker.getSymbolsInScope(blockSymbol.parentBlock, ts.SymbolFlags.BlockScoped);
    for (const symbol of symbols) {
      unsafeRenameTargets.add(symbol.name);
    }
  }
  return unsafeRenameTargets;  
}

