import type { Store } from './store.ts';
import { Buffer } from 'node:buffer';
import * as git from './git.ts';

export function handleMcp(req: any, res: any, ctx: { store: Store; reqId: string }, body: Buffer, sendJson: (res: any, status: number, obj: any, extraHeaders?: Record<string, string>) => void): boolean {
  let requestData: any;
  try {
    requestData = JSON.parse(body.toString('utf8'));
    if (typeof requestData !== 'object' || requestData === null || Array.isArray(requestData)) throw new Error();
  } catch {
    sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return true;
  }

  const { jsonrpc, id, method, params } = requestData;
  const sendRpc = (result?: any, error?: any) => {
    sendJson(res, 200, { jsonrpc: "2.0", id, result, error });
  };

  if (method === 'server/discover') {
    sendRpc({
      supportedVersions: ["2026-07-28", "2025-11-25"],
      capabilities: { tools: {} },
      serverInfo: { name: "forge", version: "1.0.0" },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "forge", version: "1.0.0" } }
    });
  } else if (method === 'initialize') {
    const version = (params?.protocolVersion === "2026-07-28" || params?.protocolVersion === "2025-11-25") ? params.protocolVersion : "2025-11-25";
    sendRpc({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "forge", version: "1.0.0" } });
  } else if (method === 'notifications/initialized') {
    res.writeHead(202, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': ctx.reqId });
    res.end();
  } else if (method === 'ping') {
    sendRpc({});
  } else if (method === 'tools/list') {
    sendRpc({ tools: [
      { name: "create_repo", description: "Create a new repository", inputSchema: { type: "object", properties: { name: { type: "string", description: "Repository name" }, description: { type: "string" }, private: { type: "boolean" } }, required: ["name"] } },
      { name: "get_repo", description: "Get a repository by owner and name", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] } },
      { name: "create_issue", description: "Create an issue in a repository", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] } },
      { name: "list_issues", description: "List issues in a repository", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string", enum: ["open", "closed", "all"] } }, required: ["owner", "repo"] } },
      { name: "create_pull_request", description: "Create a pull request", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, head: { type: "string" }, base: { type: "string" } }, required: ["owner", "repo", "title", "head", "base"] } },
      { name: "merge_pull_request", description: "Merge a pull request using squash merge", inputSchema: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "number" } }, required: ["owner", "repo", "pull_number"] } }
    ] });
  } else if (method === 'tools/call') {
    const { name, arguments: args } = params || {};
    const repoName = args?.repo ?? args?.repository ?? args?.name;
    const pullNumber = args?.pull_number ?? args?.number ?? args?.pullNumber;
    const title = args?.title;
    const head = args?.head ?? args?.headRef;
    const base = args?.base ?? args?.baseRef;

    if (name === 'create_repo') {
        const repo = ctx.store.createRepo(args.name, { description: args.description, private: args.private });
        if (!repo) sendRpc(undefined, { code: -32602, message: "already exists" });
        else sendRpc({ content: [{ type: "text", text: JSON.stringify(formatRepo(repo, ctx.store)) }], structuredContent: formatRepo(repo, ctx.store) });
    } else if (name === 'get_repo') {
        ctx.store.learnOwner(args.owner);
        if (args.owner !== ctx.store.ownerLogin()) sendRpc(undefined, { code: -32602, message: "repository not found" });
        else {
            const repo = ctx.store.getRepo(repoName);
            if (!repo) sendRpc(undefined, { code: -32602, message: "repository not found" });
            else sendRpc({ content: [{ type: "text", text: JSON.stringify(formatRepo(repo, ctx.store)) }], structuredContent: formatRepo(repo, ctx.store) });
        }
    } else if (name === 'create_issue') {
        ctx.store.learnOwner(args.owner);
        if (args.owner !== ctx.store.ownerLogin()) sendRpc(undefined, { code: -32602, message: "repository not found" });
        else {
            const repo = ctx.store.getRepo(repoName);
            if (!repo) sendRpc(undefined, { code: -32602, message: "repository not found" });
            else {
                const issue = { id: repo.nextNumber, nodeId: ctx.store.globalId('Issue', repo.id, repo.nextNumber), number: repo.nextNumber++, title, body: args.body ?? '', state: 'open', labels: [], userLogin: ctx.store.ownerLogin(), createdAt: ctx.store.nowIso(), updatedAt: ctx.store.nowIso(), closedAt: null, comments: [] };
                repo.issues.push(issue as any);
                sendRpc({ content: [{ type: "text", text: JSON.stringify(issue) }], structuredContent: issue });
            }
        }
    } else if (name === 'list_issues') {
        ctx.store.learnOwner(args.owner);
        if (args.owner !== ctx.store.ownerLogin()) sendRpc(undefined, { code: -32602, message: "repository not found" });
        else {
            const repo = ctx.store.getRepo(repoName);
            if (!repo) sendRpc(undefined, { code: -32602, message: "repository not found" });
            else {
                const issues = repo.issues.filter(i => args.state === 'all' || i.state === (args.state ?? 'open'));
                sendRpc({ content: [{ type: "text", text: JSON.stringify({ issues }) }], structuredContent: { issues } });
            }
        }
    } else if (name === 'create_pull_request') {
        ctx.store.learnOwner(args.owner);
        if (args.owner !== ctx.store.ownerLogin()) sendRpc(undefined, { code: -32602, message: "repository not found" });
        else {
            const repo = ctx.store.getRepo(repoName);
            if (!repo) sendRpc(undefined, { code: -32602, message: "repository not found" });
            else if (!repo.refs.has('refs/heads/' + head) || !repo.refs.has('refs/heads/' + (base ?? repo.defaultBranch))) sendRpc(undefined, { code: -32602, message: "branch missing" });
            else {
                const pull = { id: repo.nextNumber, nodeId: ctx.store.globalId('PullRequest', repo.id, repo.nextNumber), number: repo.nextNumber++, title, body: args.body ?? '', state: 'open', headRef: head, baseRef: base ?? repo.defaultBranch, headSha: repo.refs.get('refs/heads/' + head), baseSha: repo.refs.get('refs/heads/' + (base ?? repo.defaultBranch)), merged: false, mergedAt: null, mergeCommitSha: null, userLogin: ctx.store.ownerLogin(), createdAt: ctx.store.nowIso(), updatedAt: ctx.store.nowIso() };
                repo.pulls.push(pull as any);
                sendRpc({ content: [{ type: "text", text: JSON.stringify(pull) }], structuredContent: pull });
            }
        }
    } else if (name === 'merge_pull_request') {
        ctx.store.learnOwner(args.owner);
        if (args.owner !== ctx.store.ownerLogin()) sendRpc(undefined, { code: -32602, message: "repository not found" });
        else {
            const repo = ctx.store.getRepo(repoName);
            if (!repo) sendRpc(undefined, { code: -32602, message: "repository not found" });
            else {
                const pull = repo.pulls.find(p => p.number === pullNumber);
                if (!pull) sendRpc(undefined, { code: -32602, message: "pull request not found" });
                else if (pull.merged) sendRpc(undefined, { code: -32602, message: "already merged" });
                else {
                    const baseSha = repo.refs.get('refs/heads/' + pull.baseRef)!;
                    const result = git.computeMerge(repo.objects, baseSha, pull.headSha);
                    if (result.conflict) sendRpc({ isError: true, content: [{ type: "text", text: "merge conflict" }] });
                    else {
                        const commit = git.buildCommit({ tree: result.treeOid!, parents: [baseSha], message: pull.title, ts: ctx.store.nowSec() });
                        const commitOid = git.sha1Object('commit', commit);
                        repo.objects.set(commitOid, { type: 'commit', data: commit });
                        repo.refs.set('refs/heads/' + pull.baseRef, commitOid);
                        pull.merged = true;
                        pull.mergeCommitSha = commitOid;
                        pull.state = 'closed';
                        sendRpc({ content: [{ type: "text", text: JSON.stringify({ sha: commitOid, merged: true, number: pull.number }) }], structuredContent: { sha: commitOid, merged: true, number: pull.number } });
                    }
                }
            }
        }
    } else {
        sendRpc(undefined, { code: -32602, message: `Unknown tool: ${name}` });
    }
  } else {
    sendRpc(undefined, { code: -32601, message: `Method not found: ${method}` });
  }
  return true;
}

function formatRepo(repo: any, store: Store): any {
    const owner = store.ownerLogin();
    return {
        id: repo.id,
        node_id: repo.nodeId,
        name: repo.name,
        full_name: `${owner}/${repo.name}`,
        owner: { login: owner, id: 1, type: "User" },
        description: repo.description,
        private: repo.private,
        default_branch: repo.defaultBranch,
        created_at: repo.createdAt,
        updated_at: repo.updatedAt,
        pushed_at: repo.pushedAt,
        html_url: `https://example.com/${owner}/${repo.name}`,
        clone_url: `https://example.com/${owner}/${repo.name}.git`,
        git_url: `git://example.com/${owner}/${repo.name}.git`,
        ssh_url: `git@example.com:${owner}/${repo.name}.git`
    };
}
