import type { EventStore } from "./store.js";
import type { ActivityEmitter } from "./activity.js";

export interface SessionEvent {
  action: "created" | "prompted";
  agentSession: { id: string };
  /** Prompt text, per Linear's interaction model. */
  promptContext?: string;
  agentActivity?: { body?: string };
}

/** What actually does the work once a session is claimed. Minutes are fine here. */
export type Worker = (event: SessionEvent) => Promise<{ body: string; needsReview: boolean }>;

export interface ConsumerOptions {
  store: EventStore;
  emitter: ActivityEmitter;
  worker: Worker;
  now?: () => number;
  /** Linear marks a session unresponsive without an activity this soon after `created`. */
  firstActivityBudgetMs?: number;
}

export const FIRST_ACTIVITY_BUDGET_MS = 10_000;

/**
 * Drains queued AgentSessionEvents.
 *
 * The ordering here is the whole point and is not an implementation detail: the
 * holding `thought` is emitted BEFORE the worker is even called. Linear gives the
 * webhook handler 5 seconds and the session 10 seconds to show its first activity;
 * a coding agent takes minutes. Emitting after the work would blow the budget on
 * every single session.
 */
export class Consumer {
  private now: () => number;
  private budget: number;

  constructor(private opts: ConsumerOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.budget = opts.firstActivityBudgetMs ?? FIRST_ACTIVITY_BUDGET_MS;
  }

  /** Process one queued event. Returns false when the queue is empty. */
  async step(): Promise<boolean> {
    const row = this.opts.store.nextQueued();
    if (!row) return false;

    let event: SessionEvent;
    try {
      event = JSON.parse(row.payload) as SessionEvent;
    } catch {
      // Unparseable payloads must settle, not spin. There is no session id to
      // report an error against, so this can only be dropped and recorded.
      this.opts.store.settle(row.id, "failed");
      return true;
    }

    const sessionId = event.agentSession?.id;
    if (!sessionId) {
      this.opts.store.settle(row.id, "failed");
      return true;
    }

    // FIRST, before anything slow. Ephemeral so the next activity replaces it
    // rather than leaving "Picking this up..." in the transcript forever.
    //
    // If this throws — a bad token, a wrong mutation shape — the row must not be
    // left in `running`, or requeueStale is the only thing that ever frees it and
    // the session sits at "Working..." with no explanation in between.
    try {
      await this.opts.emitter.emit({
        sessionId,
        type: "thought",
        body: "Picking this up and planning the work.",
        ephemeral: true,
      });
    } catch (err) {
      this.opts.store.settle(row.id, "failed");
      throw err;
    }

    try {
      const result = await this.opts.worker(event);

      await this.opts.emitter.emit({
        sessionId,
        // An elicitation is what drives the session to awaitingInput — it is the
        // human review gate. A response would mark the session complete and skip it.
        type: result.needsReview ? "elicitation" : "response",
        body: result.body,
      });

      this.opts.store.settle(row.id, "done");
    } catch (err) {
      await this.opts.emitter.emit({
        sessionId,
        type: "error",
        body: err instanceof Error ? err.message : "the agent failed",
      });
      this.opts.store.settle(row.id, "failed");
    }

    return true;
  }

  /** Drain the queue. Bounded so a bug fails loudly instead of hanging. */
  async drain(maxEvents = 1000): Promise<number> {
    let n = 0;
    while (n < maxEvents && (await this.step())) n++;
    return n;
  }

  /** How long the first activity took, for asserting against Linear's budget. */
  withinBudget(startedAt: number, emittedAt: number): boolean {
    return emittedAt - startedAt <= this.budget;
  }
}
