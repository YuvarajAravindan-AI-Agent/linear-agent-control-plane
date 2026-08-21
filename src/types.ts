/** A unit of work an agent is dispatched against. */
export interface WorkPackage {
  id: string;
  title: string;
  /** ids of packages that must reach `merged` before this one may dispatch. */
  dependsOn: string[];
}

export type PackageState =
  | "blocked"      // at least one dependency is not merged
  | "ready"        // dependencies satisfied, not yet dispatched
  | "dispatched"   // an agent is working
  | "awaitingGate" // agent finished, waiting on a human understanding review
  | "merged"       // review passed; unblocks dependents
  | "failed";      // agent or review rejected it; dependents stay blocked

export interface PackageRecord {
  pkg: WorkPackage;
  state: PackageState;
  /** set when dispatched, used for gate SLA timing. */
  dispatchedAt?: number;
  gateOpenedAt?: number;
  escalatedAt?: number;
}
