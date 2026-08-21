import type { WorkPackage, PackageRecord, PackageState } from "./types.js";

export class CycleError extends Error {
  constructor(public readonly cycle: string[]) {
    super(`dependency cycle: ${cycle.join(" -> ")}`);
    this.name = "CycleError";
  }
}

export class UnknownDependencyError extends Error {
  constructor(pkg: string, dep: string) {
    super(`work package "${pkg}" depends on unknown package "${dep}"`);
    this.name = "UnknownDependencyError";
  }
}

/**
 * The dependency graph over work packages.
 *
 * This is the part of a "control plane for AI agents" that involves no AI at all:
 * it is a DAG, a ready-set, and a state machine. Keeping it free of model calls is
 * what makes the whole thing testable offline and cheap to run.
 */
export class DependencyGraph {
  private records = new Map<string, PackageRecord>();

  constructor(packages: WorkPackage[]) {
    for (const pkg of packages) {
      if (this.records.has(pkg.id)) {
        throw new Error(`duplicate work package id "${pkg.id}"`);
      }
      this.records.set(pkg.id, { pkg, state: "blocked" });
    }

    // Validate edges before any cycle walk, so a typo reports as a typo
    // rather than surfacing as a confusing traversal result.
    for (const { pkg } of this.records.values()) {
      for (const dep of pkg.dependsOn) {
        if (!this.records.has(dep)) throw new UnknownDependencyError(pkg.id, dep);
      }
    }

    this.assertAcyclic();
    this.recomputeReady();
  }

  /** Iterative DFS with an explicit stack — a deep chain must not blow the call stack. */
  private assertAcyclic(): void {
    const WHITE = 0, GREY = 1, BLACK = 2;
    const colour = new Map<string, number>();
    for (const id of this.records.keys()) colour.set(id, WHITE);

    for (const start of this.records.keys()) {
      if (colour.get(start) !== WHITE) continue;

      const stack: Array<{ id: string; i: number }> = [{ id: start, i: 0 }];
      colour.set(start, GREY);

      while (stack.length) {
        const frame = stack[stack.length - 1]!;
        const deps = this.records.get(frame.id)!.pkg.dependsOn;

        if (frame.i >= deps.length) {
          colour.set(frame.id, BLACK);
          stack.pop();
          continue;
        }

        const next = deps[frame.i++]!;
        const c = colour.get(next);
        if (c === GREY) {
          const from = stack.findIndex((f) => f.id === next);
          throw new CycleError([...stack.slice(from).map((f) => f.id), next]);
        }
        if (c === WHITE) {
          colour.set(next, GREY);
          stack.push({ id: next, i: 0 });
        }
      }
    }
  }

  /** Any package whose dependencies are all merged moves blocked -> ready. */
  private recomputeReady(): void {
    for (const rec of this.records.values()) {
      if (rec.state !== "blocked") continue;
      const satisfied = rec.pkg.dependsOn.every(
        (d) => this.records.get(d)!.state === "merged",
      );
      if (satisfied) rec.state = "ready";
    }
  }

  get(id: string): PackageRecord {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`unknown work package "${id}"`);
    return rec;
  }

  all(): PackageRecord[] {
    return [...this.records.values()];
  }

  byState(state: PackageState): PackageRecord[] {
    return this.all().filter((r) => r.state === state);
  }

  /**
   * Packages eligible for dispatch right now, oldest-declared first.
   *
   * A package is never returned twice: dispatch() moves it out of `ready`
   * synchronously, which is what stops two concurrent pollers double-dispatching.
   */
  ready(): PackageRecord[] {
    return this.byState("ready");
  }

  dispatch(id: string, now: number = Date.now()): PackageRecord {
    const rec = this.get(id);
    if (rec.state !== "ready") {
      throw new Error(`cannot dispatch "${id}" from state "${rec.state}"`);
    }
    rec.state = "dispatched";
    rec.dispatchedAt = now;
    return rec;
  }

  /** Agent finished; work now needs a human understanding review. */
  openGate(id: string, now: number = Date.now()): PackageRecord {
    const rec = this.get(id);
    if (rec.state !== "dispatched") {
      throw new Error(`cannot open gate for "${id}" from state "${rec.state}"`);
    }
    rec.state = "awaitingGate";
    rec.gateOpenedAt = now;
    return rec;
  }

  /** Review passed. This is the only transition that unblocks dependents. */
  merge(id: string): PackageRecord {
    const rec = this.get(id);
    if (rec.state !== "awaitingGate") {
      throw new Error(`cannot merge "${id}" from state "${rec.state}"`);
    }
    rec.state = "merged";
    this.recomputeReady();
    return rec;
  }

  /** Agent errored, or a reviewer rejected. Dependents deliberately stay blocked. */
  fail(id: string): PackageRecord {
    const rec = this.get(id);
    if (rec.state !== "dispatched" && rec.state !== "awaitingGate") {
      throw new Error(`cannot fail "${id}" from state "${rec.state}"`);
    }
    rec.state = "failed";
    return rec;
  }

  /** True once nothing can make further progress. */
  isQuiescent(): boolean {
    return this.all().every(
      (r) => r.state === "merged" || r.state === "failed" || r.state === "blocked",
    ) && this.ready().length === 0;
  }
}
