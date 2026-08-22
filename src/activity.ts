/**
 * AgentActivity emission.
 *
 * Linear derives AgentSession state from the most recent activity — you never set
 * the state directly. The five types map to the states a user sees:
 *
 *   thought      -> active        (internal reasoning; also the holding signal)
 *   action       -> active        (a tool call, optionally with its result)
 *   elicitation  -> awaitingInput (the primitive the human review gate is built on)
 *   response     -> complete      (final result)
 *   error        -> error         (failure, optionally with a remediation link)
 */
export type ActivityType = "thought" | "action" | "elicitation" | "response" | "error";

export interface Activity {
  sessionId: string;
  type: ActivityType;
  body: string;
  /** Ephemeral activities are replaced by the next one — right for transient progress. */
  ephemeral?: boolean;
}

export interface ActivityEmitter {
  emit(activity: Activity): Promise<void>;
}

/** Records activities in memory. Zero network, zero cost — what CI runs against. */
export class ReplayEmitter implements ActivityEmitter {
  readonly emitted: Array<Activity & { at: number }> = [];

  constructor(private now: () => number = Date.now) {}

  async emit(activity: Activity): Promise<void> {
    this.emitted.push({ ...activity, at: this.now() });
  }

  forSession(sessionId: string): Array<Activity & { at: number }> {
    return this.emitted.filter((a) => a.sessionId === sessionId);
  }

  first(sessionId: string): (Activity & { at: number }) | undefined {
    return this.forSession(sessionId)[0];
  }
}

/**
 * Live emitter against Linear's GraphQL API.
 *
 * NOT YET VERIFIED against the real endpoint — the app is not installed at the time
 * of writing, so the mutation shape below is written from the documented interaction
 * model rather than from a successful call. Treat the first live run as the test.
 * Everything above this class is exercised by the suite; this adapter is not.
 */
export class LinearEmitter implements ActivityEmitter {
  constructor(
    private getToken: () => string | undefined,
    private endpoint = "https://api.linear.app/graphql",
    private doFetch: typeof fetch = fetch,
  ) {}

  async emit(activity: Activity): Promise<void> {
    const token = this.getToken();
    if (!token) throw new Error("cannot emit activity: app is not installed");

    const query = `
      mutation AgentActivityCreate($input: AgentActivityCreateInput!) {
        agentActivityCreate(input: $input) { success }
      }`;

    const res = await this.doFetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        query,
        variables: {
          input: {
            agentSessionId: activity.sessionId,
            content: { type: activity.type, body: activity.body },
            ephemeral: activity.ephemeral ?? false,
          },
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`agentActivityCreate failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as { errors?: Array<{ message: string }> };
    if (json.errors?.length) {
      throw new Error(`agentActivityCreate failed: ${json.errors[0]!.message}`);
    }
  }
}
