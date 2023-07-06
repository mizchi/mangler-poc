import "../__tests/globals";
import { initTestLanguageServiceWithFiles } from "../__tests/testHarness";
import { RenameItem, collectRenameItems, getRenamedChanges } from "./renamer";
import { createSymbolBuilder } from "./symbolBuilder";
import { expect, test } from "vitest";
import {
  createGetMangleRenameItems,
  findExportedNodesFromRoot,
  findMangleNodes,
  getRenameActionsFromMangleNode,
} from "./mangler";

// assert expected mangle results
function assertExpectedMangleResult(entry: string, files: Record<string, string>, expected: Record<string, string>) {
  const { service, normalizePath, projectPath } = initTestLanguageServiceWithFiles(files);
  const targets = Object.keys(files).map(normalizePath);
  entry = normalizePath(entry);

  const checker = service.getProgram()!.getTypeChecker();

  const getMangledRenameItem = createGetMangleRenameItems(
    checker,
    service.findRenameLocations,
    service.getCurrentSourceFile,
    entry,
  );
  const items = targets.flatMap(getMangledRenameItem);
  const rawChanges = getRenamedChanges(items, service.readSnapshotContent, normalizePath);

  // rename for assert
  const changes = rawChanges.map((x) => {
    return {
      fileName: x.fileName.replace(projectPath + "/", ""),
      content: x.content,
    };
  });

  expect(changes.length).toBe(Object.keys(expected).length);
  for (const change of changes) {
    const expectedContent = expected[change.fileName];
    expect(change.content).toEqualFormatted(expectedContent);
  }
}

test("mangle", () => {
  const input = {
    "src/index.ts": `
      type Local = {
        local: number;
      }
      type Pub = {
        pub: number;
      }
      function fff(): Pub {
        const fLocal: Local = {local: 1};
        return {
          pub: fLocal.local
        }
      }
      export const x = fff();
    `,
  };
  const expected = {
    "src/index.ts": `
      type Local = {
        k: number;
      };
      type Pub = {
        pub: number;
      };
      function j(): Pub {
        const q: Local = { k: 1 };
        return {
          pub: q.k,
        };
      }
      export const x = j();  
    `,
  };
  assertExpectedMangleResult("src/index.ts", input, expected);
});

test("mangle: multi files", () => {
  const files = {
    "src/sub.ts": `
      type SubLocal = {
        subLocal: number;
      }
      const vvv = 1;
      export const sub: SubLocal = {
        subLocal: 1
      };
    `,
    "src/index.ts": `
      import { sub } from "./sub";
      const indexLocal = 1;
      export const x = sub.subLocal;
      `,
  };

  const expected = {
    "src/index.ts": `
      import { sub } from "./sub";
      const k = 1;
      export const x = sub.k;
    `,
    "src/sub.ts": `
      type SubLocal = {
        k: number;
      };
      const x = 1;
      export const sub: SubLocal = {
        k: 1,
      };
    `,
  };

  assertExpectedMangleResult("src/index.ts", files, expected);
});

test("rename local object member", () => {
  const { service, normalizePath } = initTestLanguageServiceWithFiles({
    "src/index.ts": `
      type Local = {
        xxx: number;
      }; 
      type Pub = {
        pubv: number;
      };
      const loc: Local = { xxx: 1 };
      const pub: Pub = { pubv: 1 };
      export { pub };  
    `,
  });
  const file = service.getCurrentSourceFile("src/index.ts")!;
  const checker = service.getProgram()!.getTypeChecker();

  const exportedNodes = findExportedNodesFromRoot(checker, file);
  const nodes = findMangleNodes(checker, file, exportedNodes);
  const symbolBuilder = createSymbolBuilder();

  // const item
  const items: RenameItem[] = [...nodes].flatMap((node) => {
    const action = getRenameActionsFromMangleNode(checker, symbolBuilder, node);
    const renames = collectRenameItems(service.findRenameLocations, file, action.start, action.original, action.to);
    return renames ?? [];
  });

  const newState = getRenamedChanges(items, service.readSnapshotContent, normalizePath);
  for (const content of newState) {
    service.writeSnapshotContent(content.fileName, content.content);
  }
  const newFile = service.getCurrentSourceFile(normalizePath("src/index.ts"))!;
  const result = newFile.getText();

  expect(result).toEqualFormatted(`
  type Local = {
    k: number;
  };
  type Pub = {
    pubv: number;
  };
  const x: Local = { k: 1 };
  const j: Pub = { pubv: 1 };
  export { j as pub };
  `);
});

test("mangle with complex", () => {
  // const { service, normalizePath } = createTestLanguageService();

  const files = {
    "src/index.ts": `
      export { sub } from "./sub";
      export const xxx = 1;
      export function fff() {}
      export class Ccc {}
      export enum Eee {}

      export type Ttt = number;
      export interface Iii {}

      const local = 1;
      {
        const nested = 2;
      }

      const vvv = 1;
      const yyy = 2;
      export {
        vvv,
        yyy as zzz
      }

    `,
    "src/sub.ts": `
      export const sub = 1;
    `,
  };
  const expected = {
    "src/index.ts": `
      export { sub } from "./sub";
      export const xxx = 1;
      export function fff() {}
      export class Ccc {}
      export enum Eee {}
      export type Ttt = number;
      export interface Iii {}
      const k = 1;
      {
        const x = 2;
      }
      const j = 1;
      const q = 2;
      export { j as vvv, q as zzz };
    `,
  };
  assertExpectedMangleResult("src/index.ts", files, expected);
});

test("mangle with scope internal", () => {
  const files = {
    "src/index.ts": `
  export function getInternal<T1 extends object>(arg: T1) {
    type Internal<T1> = { internalPub1: string, internalPub2: T1};
    type UnusedInternal = { hidden: number };
    const _hidden: UnusedInternal = {
      hidden: 1
    }
    const internal: Internal<T1> = { internalPub1: "foo", internalPub2: arg };
    return internal
  }`,
  };
  const expected = {
    "src/index.ts": `
    export function getInternal<T1 extends object>(arg: T1) {
      type Internal<T1> = { internalPub1: string; internalPub2: T1 };
      type UnusedInternal = { k: number };
      const x: UnusedInternal = {
        k: 1,
      };
      const j: Internal<T1> = { internalPub1: "foo", internalPub2: arg };
      return j;
    }
    `,
  };
  assertExpectedMangleResult("src/index.ts", files, expected);
});

test("mangle with partial type", () => {
  const files = {
    "src/index.ts": `type Exp = {
    public: {
      xxx: number;
    };
    priv: {
      yyy: string;
    }
  }
  export const exp: Exp["public"] = { xxx: 1 };
  type PubType = {
    pub: number;
  }
  export const pub: PubType = { pub: 1 };
  `,
  };

  const expected = {
    "src/index.ts": `
      type Exp = {
        k: {
          xxx: number;
        };
        x: {
          j: string;
        };
      };
      export const exp: Exp["k"] = { xxx: 1 };
      type PubType = {
        pub: number;
      };
      export const pub: PubType = { pub: 1 };
    `,
  };

  assertExpectedMangleResult("src/index.ts", files, expected);
});

test("mangle with externals", () => {
  const files = {
    "src/index.ts": `
    import {parseArgs} from "node:util";

    const allowPositionals = true;
    export function parse(args: string[]) {
      return parseArgs({
        args,
        allowPositionals,
        options: {
          name: {
            type: "string",
            alias: "n",
          }
        }
      });
    }
  `,
  };

  const expected = {
    "src/index.ts": `
      import { parseArgs } from "node:util";
      const k = true;
      export function parse(args: string[]) {
        return parseArgs({
          args,
          allowPositionals: k,
          options: {
            name: {
              type: "string",
              alias: "n",
            },
          },
        });
      }  
    `,
  };

  assertExpectedMangleResult("src/index.ts", files, expected);
});

test("mangle with externals", () => {
  const files = {
    "src/index.ts": `
    type MyType = {
      pubVal: {
        pub: number;
      };
      privVal: {
        pv: number;
      };
    };
    export class C {
      private v: MyType;
      static sv: number = 1;
      #hardPriv: number = 2;
      private static svp: number = 2;
      static sfoo() {
        return this.spfoo();
      }
      private static spfoo() {
        return this.svp;
      }
      constructor(v: number) {
        this.#hardPriv;
        this.v = { pubVal: { pub: v }, privVal: { pv: v + this.#hardPriv } };
      }
      public foo() {
        return this.v.pubVal;
      }
      private priv() {
        return this.v.privVal;
      }
    }      
  `,
  };

  const expected = {
    "src/index.ts": `
    type MyType = {
      k: {
        pub: number;
      };
      x: {
        j: number;
      };
    };
    export class C {
      private q: MyType;
      static sv: number = 1;
      #z: number = 2;
      private static p: number = 2;
      static sfoo() {
        return this.f();
      }
      private static f() {
        return this.p;
      }
      constructor(v: number) {
        this.#z;
        this.q = { k: { pub: v }, x: { j: v + this.#z } };
      }
      public foo() {
        return this.q.k;
      }
      private y() {
        return this.q.x;
      }
    }
    `,
  };

  assertExpectedMangleResult("src/index.ts", files, expected);
});
