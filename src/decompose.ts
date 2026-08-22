import type { WorkPackage } from "./types.js";

/**
 * Turn an epic description into dependency-ordered work packages.
 *
 * In replay mode this is a PARSER, not a planner — decomposition is the one part
 * of the control plane that genuinely needs a model, so replay mode reads a spec
 * you wrote instead of inventing one. That keeps the demo free and deterministic
 * and is honest about where the intelligence actually sits.
 *
 * Spec format, anywhere in the issue description:
 *
 *   ## Work packages
 *   - [A] Database schema
 *   - [B] API endpoints (depends: A)
 *   - [C] Background worker (depends: A)
 *   - [D] UI (depends: B, C)
 */
const SPEC_LINE = /^\s*[-*]\s*\[([A-Za-z0-9_.-]+)\]\s*(.+?)\s*(?:\(depends:\s*([^)]*)\))?\s*$/;

export function parseWorkPackages(description: string | undefined): WorkPackage[] {
  if (!description) return [];

  const lines = description.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\s*#{1,6}\s*work packages\s*$/i.test(l));
  if (start === -1) return [];

  const packages: WorkPackage[] = [];
  for (const line of lines.slice(start + 1)) {
    // A blank line does not end the block; another heading does.
    if (/^\s*#{1,6}\s+/.test(line)) break;
    if (!line.trim()) continue;

    const m = SPEC_LINE.exec(line);
    if (!m) continue;

    const [, id, title, deps] = m;
    packages.push({
      id: id!,
      title: title!.trim(),
      dependsOn: (deps ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
    });
  }
  return packages;
}

/** The shape used when an epic carries no spec — enough to show dependency ordering. */
export function defaultWorkPackages(): WorkPackage[] {
  return [
    { id: "A", title: "Schema and migrations", dependsOn: [] },
    { id: "B", title: "API endpoints", dependsOn: ["A"] },
    { id: "C", title: "Background worker", dependsOn: ["A"] },
    { id: "D", title: "UI wiring", dependsOn: ["B", "C"] },
  ];
}
