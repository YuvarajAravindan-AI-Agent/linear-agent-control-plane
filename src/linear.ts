/** Minimal Linear GraphQL client — only the operations the control plane needs. */
export class LinearClient {
  constructor(
    private getToken: () => string | undefined,
    private endpoint = "https://api.linear.app/graphql",
    private doFetch: typeof fetch = fetch,
  ) {}

  async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const token = this.getToken();
    if (!token) throw new Error("not installed: no access token");

    const res = await this.doFetch(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables }),
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`linear api HTTP ${res.status}: ${text.slice(0, 200)}`);

    const json = JSON.parse(text) as { data?: T; errors?: Array<{ message: string }> };
    // A GraphQL error arrives with HTTP 200, so `res.ok` alone proves nothing.
    if (json.errors?.length) throw new Error(`linear api: ${json.errors[0]!.message}`);
    if (!json.data) throw new Error("linear api: empty response");
    return json.data;
  }

  async issue(id: string): Promise<{
    id: string; identifier: string; title: string;
    description?: string; teamId: string; parentId?: string;
  }> {
    const d = await this.gql<{
      issue: {
        id: string; identifier: string; title: string; description?: string;
        team: { id: string }; parent?: { id: string } | null;
      };
    }>(
      `query Issue($id: String!) {
         issue(id: $id) { id identifier title description team { id } parent { id } } }`,
      { id },
    );
    // parent presence is what distinguishes an epic from a work package.
    return { ...d.issue, teamId: d.issue.team.id, parentId: d.issue.parent?.id };
  }

  /** Create a sub-issue under `parentId`. */
  async createSubIssue(input: { teamId: string; parentId: string; title: string; description?: string }): Promise<{ id: string; identifier: string }> {
    const d = await this.gql<{ issueCreate: { success: boolean; issue: { id: string; identifier: string } } }>(
      `mutation Create($input: IssueCreateInput!) {
         issueCreate(input: $input) { success issue { id identifier } } }`,
      { input },
    );
    if (!d.issueCreate.success) throw new Error("issueCreate returned success=false");
    return d.issueCreate.issue;
  }

  /**
   * Record that `issueId` is blocked by `relatedIssueId`.
   *
   * Dependencies live as issue relations, not a field — which is why the graph is
   * built in code and mirrored here, rather than read back out of Linear.
   */
  async addBlockedBy(issueId: string, relatedIssueId: string): Promise<void> {
    await this.gql(
      `mutation Rel($input: IssueRelationCreateInput!) {
         issueRelationCreate(input: $input) { success } }`,
      { input: { issueId, relatedIssueId, type: "blocks" } },
    );
  }

  async comment(issueId: string, body: string): Promise<void> {
    await this.gql(
      `mutation C($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId, body } },
    );
  }
}
