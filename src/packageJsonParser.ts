import { parseTree, findNodeAtLocation } from "jsonc-parser";
import { DependencyEntry } from "./types";
import { offsetToLine } from "./util";

const DEP_GROUPS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

export function parsePackageJsonEntries(text: string): DependencyEntry[] {
  const entries: DependencyEntry[] = [];

  const tree = parseTree(text);
  if (!tree) return entries;

  for (const group of DEP_GROUPS) {
    const groupNode = findNodeAtLocation(tree, [group]);
    if (!groupNode || groupNode.type !== "object" || !groupNode.children)
      continue;

    for (const prop of groupNode.children) {
      if (
        prop.type !== "property" ||
        !prop.children ||
        prop.children.length < 2
      )
        continue;

      const keyNode = prop.children[0];
      const valueNode = prop.children[1];

      if (keyNode.type !== "string" || valueNode.type !== "string") continue;

      const packageName = keyNode.value as string;
      const version = valueNode.value as string;
      const line = offsetToLine(text, keyNode.offset);

      entries.push({ packageName, version, line, section: group });
    }
  }

  return entries;
}
