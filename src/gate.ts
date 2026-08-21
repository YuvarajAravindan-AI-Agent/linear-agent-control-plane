import { DependencyGraph } from "./graph.js";

export interface Human {
  id: string;
  role: "reviewer" | "lead" | "founder";
}

export interface Notification {
  to: string;
  packageId: string;
  kind: "gate-opened" | "gate-escalated";
  at: number;
}

export interface GateConfig {
  /** How long a gate may sit before it escalates. */
  slaMs: number;
  humans: Human[];
}

/**
 * The human "understanding review" gate.
 *
 * Built on stock Linear semantics: opening a gate corresponds to emitting an
 * `elicitation` activity, which is what drives an AgentSession to `awaitingInput`.
 * Nothing here is a custom Linear state — that was an explicit requirement.
 *
 * Deliberately not an LLM. Timers and routing rules are ordinary code.
 */
export class ReviewGate {
  private notifications: Notification[] = [];

  constructor(
    private graph: DependencyGraph,
    private config: GateConfig,
  ) {
    if (config.humans.length === 0) throw new Error("gate needs at least one human");
    if (!config.humans.some((h) => h.role === "reviewer")) {
      throw new Error("gate needs at least one reviewer");
    }
  }

  /**
   * Route by role, not broadcast.
   *
   * The requirement was "notification design that doesn't drown four humans", so an
   * opened gate reaches reviewers only. Leads and the founder are reached solely on
   * escalation — otherwise every gate pages everyone and the signal dies.
   */
  open(packageId: string, now: number = Date.now()): Notification[] {
    this.graph.openGate(packageId, now);
    const sent = this.config.humans
      .filter((h) => h.role === "reviewer")
      .map<Notification>((h) => ({ to: h.id, packageId, kind: "gate-opened", at: now }));
    this.notifications.push(...sent);
    return sent;
  }

  /**
   * Escalate any gate that has been open past the SLA.
   *
   * Escalates **once** per package — `escalatedAt` is the latch. Without it, every
   * sweep past the deadline re-notifies, which is precisely the drowning the design
   * is meant to avoid.
   */
  sweep(now: number = Date.now()): Notification[] {
    const sent: Notification[] = [];

    for (const rec of this.graph.byState("awaitingGate")) {
      if (rec.gateOpenedAt === undefined) continue;
      if (now - rec.gateOpenedAt < this.config.slaMs) continue;
      if (rec.escalatedAt !== undefined) continue;

      rec.escalatedAt = now;
      for (const h of this.config.humans) {
        if (h.role === "reviewer") continue; // already notified at open
        sent.push({ to: h.id, packageId: rec.pkg.id, kind: "gate-escalated", at: now });
      }
    }

    this.notifications.push(...sent);
    return sent;
  }

  /** Reviewer approved: the package merges and its dependents unblock. */
  approve(packageId: string): void {
    this.graph.merge(packageId);
  }

  reject(packageId: string): void {
    this.graph.fail(packageId);
  }

  sent(): readonly Notification[] {
    return this.notifications;
  }

  countFor(humanId: string): number {
    return this.notifications.filter((n) => n.to === humanId).length;
  }
}
