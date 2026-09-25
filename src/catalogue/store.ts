import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { type CatalogueMirror, CatalogueMirrorSchema, emptyMirror } from "./mirror";

export interface CatalogueStore {
  load(): CatalogueMirror;
  save(mirror: CatalogueMirror): void;
}

export function memoryStore(initial: CatalogueMirror = emptyMirror()): CatalogueStore {
  let current = structuredClone(initial);
  return {
    load: () => structuredClone(current),
    save: (mirror) => {
      current = structuredClone(mirror);
    },
  };
}

export function fileStore(path: string): CatalogueStore {
  return {
    load: () => {
      const text = readIfPresent(path);
      return text === undefined ? emptyMirror() : CatalogueMirrorSchema.parse(JSON.parse(text));
    },
    save: (mirror) => {
      mkdirSync(dirname(path), { recursive: true });
      const pending = `${path}.${process.pid}.tmp`;
      writeFileSync(pending, `${JSON.stringify(mirror, null, 2)}\n`);
      renameSync(pending, path);
    },
  };
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
