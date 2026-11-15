import type { Octokit } from "@octokit/core";

type PendingFileChange =
	| { path: string; kind: "write"; content: string }
	| { path: string; kind: "delete" };

interface TreeEntry {
	path: string;
	mode: "100644";
	type: "blob";
	sha: string | null;
}

/**
 * Collect file operations and persist them as one Git commit per publication batch.
 */
export class GithubCommitBatch {
	private readonly changes = new Map<string, Map<string, PendingFileChange>>();

	constructor(private readonly octokit: Octokit) {}

	private scope(owner: string, repo: string, branch: string): string {
		return JSON.stringify([owner, repo, branch]);
	}

	private getChanges(owner: string, repo: string, branch: string): Map<string, PendingFileChange> {
		const scope = this.scope(owner, repo, branch);
		let changes = this.changes.get(scope);
		if (!changes) {
			changes = new Map<string, PendingFileChange>();
			this.changes.set(scope, changes);
		}
		return changes;
	}

	stageFile(owner: string, repo: string, branch: string, path: string, content: string): void {
		this.getChanges(owner, repo, branch).set(path, { path, content, kind: "write" });
	}

	stageDelete(owner: string, repo: string, branch: string, path: string): void {
		this.getChanges(owner, repo, branch).set(path, { path, kind: "delete" });
	}

	async commit(owner: string, repo: string, branch: string): Promise<void> {
		const scope = this.scope(owner, repo, branch);
		const changes = this.changes.get(scope);
		if (!changes?.size) return;

		const ref = await this.octokit.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
			owner,
			repo,
			ref: `heads/${branch}`,
		});
		const parentSha = ref.data.object.sha;
		const parentCommit = await this.octokit.request(
			"GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
			{
				owner,
				repo,
				commit_sha: parentSha,
			}
		);

		const treeEntries: TreeEntry[] = [];
		for (const change of changes.values()) {
			if (change.kind === "delete") {
				treeEntries.push({
					path: change.path,
					mode: "100644",
					type: "blob",
					sha: null,
				});
				continue;
			}
			const blob = await this.octokit.request("POST /repos/{owner}/{repo}/git/blobs", {
				owner,
				repo,
				content: change.content,
				encoding: "base64",
			});
			treeEntries.push({
				path: change.path,
				mode: "100644",
				type: "blob",
				sha: blob.data.sha,
			});
		}

		const tree = await this.octokit.request("POST /repos/{owner}/{repo}/git/trees", {
			owner,
			repo,
			base_tree: parentCommit.data.tree.sha,
			tree: treeEntries,
		});
		const commit = await this.octokit.request("POST /repos/{owner}/{repo}/git/commits", {
			owner,
			repo,
			message: "[PUBLISHER] Batch update (" + changes.size + " files)",
			tree: tree.data.sha,
			parents: [parentSha],
		});
		await this.octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
			owner,
			repo,
			ref: `heads/${branch}`,
			sha: commit.data.sha,
			force: false,
		});
		this.changes.delete(scope);
	}
}
