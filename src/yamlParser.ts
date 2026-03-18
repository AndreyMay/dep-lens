import { parseDocument, isMap, isScalar, isPair } from "yaml";
import type { YAMLMap } from "yaml";
import { DependencyEntry } from "./types";

export function parseCatalogEntries(text: string): DependencyEntry[] {
  const entries: DependencyEntry[] = [];

  let doc;
  try {
    doc = parseDocument(text);
  } catch {
    return entries;
  }

  const root = doc.contents;
  if (!isMap(root)) return entries;

  for (const item of root.items) {
    if (!isPair(item) || !isScalar(item.key)) continue;

    // Default catalog: `catalog:` top-level key
    if (item.key.value === "catalog" && isMap(item.value)) {
      extractEntries(item.value, text, entries, "catalog");
    }

    // Named catalogs: `catalogs:` top-level key with nested maps
    if (item.key.value === "catalogs" && isMap(item.value)) {
      for (const catItem of item.value.items) {
        if (
          !isPair(catItem) ||
          !isScalar(catItem.key) ||
          !isMap(catItem.value)
        )
          continue;
        const catalogName = String(catItem.key.value);
        extractEntries(catItem.value, text, entries, catalogName);
      }
    }
  }

  return entries;
}

function extractEntries(
  map: YAMLMap,
  text: string,
  entries: DependencyEntry[],
  section: string,
) {
  for (const item of map.items) {
    if (!isPair(item) || !isScalar(item.key) || !isScalar(item.value)) continue;

    const packageName = String(item.key.value);
    const version = String(item.value.value);
    const range = item.key.range;

    if (!range) continue;

    const line = offsetToLine(text, range[0]);
    entries.push({ packageName, version, line, section });
  }
}

function offsetToLine(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}
