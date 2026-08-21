import { DependencyGraph } from "./graph.js";
import { ReviewGate } from "./gate.js";

export interface AgentResult {
  packageId: string;
  outcome: "completed" | "errored";
  /** Cost in USD. Always 0 in replay mode. */
  costUsd: number;
  turns: number;
}

/**
 * A worker that takes a work package and (notionally) opens a PR.
 *
 * `replay` serves recorded fixtures and spends nothing. `live` would call a model.
 * The orchestrator cannot tell the difference, which is the point: every scheduling,
 * dependency and gate behaviour below is exercised by the fixture runner in CI.
 */
export interface AgentRunner {
  run(packageId: string): Promise<AgentResult>;
}

export interface Caps {
  maxConcurrent: number;
  maxTurnsPerPackage: number;
  spendCeilingUsd: number;
}

export class SpendCeilingExceeded extends Error {
  constructor(spent: number, ceiling: number) {
    super(`spend ceiling reached: $${spent.toFixed(2)} of $${ceiling.toFixed(2)}`);
    this.name = "SpendCeilingExceeded";
  }
}

export class Orchestrator {
  private inFlight = new Set<string>();
  private spentUsd = 0;
  private halted = false;

  constructor(
    private graph: DependencyGraph,
    private gate: ReviewGate,
    private runner: AgentRunner,
    private caps: Caps,
  ) {}

  get spent(): number { return this.spentUsd; }
  get isHalted(): boolean { return this.halted; }
  get running(): number { return this.inFlight.size; }

  /**
   * Dispatch as many ready packages as the concurrency cap allows.
   *
   * Dispatch is claimed synchronously (graph.dispatch moves the package out of
   * `ready` before any await), so two concurrent ticks cannot both claim one package.
   */
  tick(now: number = Date.now()): Promise<AgentResult>[] {
    if (this.halted) return [];

    const slots = this.caps.maxConcurrent - this.inFlight.size;
    if (slots <= 0) return [];

    return this.graph
      .ready()
      .slice(0, slots)
      .map((rec) => {
        const id = rec.pkg.id;
        this.graph.dispatch(id, now);
        this.inFlight.add(id);
        return this.execute(id);
      });
  }

  private async execute(id: string): Promise<AgentResult> {
    try {
      const result = await this.runner.run(id);
      this.spentUsd += result.costUsd;

      if (result.outcome === "errored" || result.turns > this.caps.maxTurnsPerPackage) {
        this.graph.fail(id);
      } else {
        // Completed work does not merge itself — it opens a human gate.
        this.gate.open(id);
      }

      // Checked after accounting so the ceiling cannot be overshot silently by
      // a package that was already in flight when the limit was crossed.
      if (this.spentUsd >= this.caps.spendCeilingUsd) this.halted = true;

      return result;
    } catch (err) {
      this.graph.fail(id);
      throw err;
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** Run to quiescence, auto-approving gates via `decide`. Test/demo driver. */
  async drain(
    decide: (packageId: string) => boolean,
    now: () => number = Date.now,
  ): Promise<void> {
    // Bounded rather than `while(true)`: a scheduling bug should fail the test
    // loudly instead of hanging CI.
    const maxRounds = this.graph.all().length * 4 + 10;

    for (let round = 0; round < maxRounds; round++) {
      const running = this.tick(now());
      if (running.length) await Promise.allSettled(running);

      for (const rec of this.graph.byState("awaitingGate")) {
        if (decide(rec.pkg.id)) this.gate.approve(rec.pkg.id);
        else this.gate.reject(rec.pkg.id);
      }

      if (this.halted) return;
      if (this.graph.isQuiescent() && this.inFlight.size === 0) return;
    }

    throw new Error("orchestrator did not reach quiescence — scheduling bug");
  }
}

/** Fixture-backed runner. Zero cost, deterministic, no network. */
export class ReplayRunner implements AgentRunner {
  constructor(
    private fixtures: Record<string, { outcome: "completed" | "errored"; turns: number }>,
    private fallback: { outcome: "completed" | "errored"; turns: number } = {
      outcome: "completed",
      turns: 3,
    },
  ) {}

  async run(packageId: string): Promise<AgentResult> {
    const f = this.fixtures[packageId] ?? this.fallback;
    return { packageId, outcome: f.outcome, costUsd: 0, turns: f.turns };
  }
}
