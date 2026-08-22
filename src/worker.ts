import type { SessionEvent, Worker } from "./consumer.js";

/**
 * The replay worker: acknowledges the delegation, states a plan, and opens the
 * human review gate. **It calls no model and spends nothing.**
 *
 * This is deliberately the default. It exercises the entire control plane —
 * delivery, dedupe, queue, activity emission, session state, review gate — against
 * real Linear, at zero cost. A client can clone this and watch it work without an
 * API key. The LLM belongs in the `live` worker, which replaces only this function.
 */
export function replayWorker(): Worker {
  return async (event: SessionEvent) => {
    const prompt = (event.promptContext ?? event.agentActivity?.body ?? "").trim();

    const body = [
      "**Replay mode — no model was called and nothing was spent.**",
      "",
      "What a live run would do here:",
      "",
      "1. Decompose this issue into dependency-ordered work packages",
      "2. Dispatch parallel agents, respecting the concurrency and spend caps",
      "3. Open a PR per package and hold each one at this gate",
      "",
      prompt ? `Prompt received: ${prompt.slice(0, 400)}` : "No prompt context was supplied.",
      "",
      "Approve here to continue, or reply with corrections.",
    ].join("\n");

    // needsReview drives an `elicitation`, which puts the session in awaitingInput.
    // That is the human understanding gate, expressed in stock Linear.
    return { body, needsReview: true };
  };
}
