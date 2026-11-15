import type { Store } from './store.ts';
import * as git from './git.ts';
import { Buffer } from 'node:buffer';

export function handleRest(
  req: any,
  res: any,
  ctx: { store: Store; reqId: string },
  parts: string[],
  body: Buffer,
  query: URLSearchParams,
  sendJson: (res: any, status: number, obj: any, extraHeaders?: Record<string, string>) => void
): boolean {
  
  let parsedData: any = null;
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && body.length > 0) {
      try {
          parsedData = JSON.parse(body.toString('utf8'));
      } catch (e) {
          sendJson(res, 400, { "message": "Invalid JSON" });
          return true;
      }
  }
  
  function getJsonBody(): any {
    return parsedData;
  }

  if (parts.length > 1 && parts[0] === 'repos') {
      const owner = parts[1];
      ctx.store.learnOwner(owner);
      if (owner !== ctx.store.ownerLogin()) {
          sendJson(res, 404, { "message": "Not Found" });
          return true;
      }
  }

  // POST /user/repos
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos' && req.method === 'POST') {
      const data = getJsonBody();
      if (!data || !data.name) { sendJson(res, 422, { "message": "name is required" }); return true; }
      const repo = ctx.store.createRepo(data.name, { description: data.description, private: !!data.private });
      if (!repo) { sendJson(res, 422, { "message": "repo already exists" }); return true; }
      sendJson(res, 201, formatRepo(repo, ctx.store));
      return true;
  }

  // GET /user/repos
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos' && req.method === 'GET') {
      const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') || '30', 10)));
      const page = Math.max(1, parseInt(query.get('page') || '1', 10));
      const repos = Array.from(ctx.store.repos.values()).sort((a,b) => a.id - b.id);
      const start = (page - 1) * perPage;
      const paginated = repos.slice(start, start + perPage);
      const next = start + perPage < repos.length ? `http://${req.headers.host}${req.url?.split('?')[0]}?per_page=${perPage}&page=${page + 1}` : null;
      sendJson(res, 200, paginated.map(r => formatRepo(r, ctx.store)), next ? { Link: `<${next}>; rel="next"` } : {});
      return true;
  }

  // GET /repos/{o}/{r}
  if (parts.length === 3 && parts[0] === 'repos' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      sendJson(res, 200, formatRepo(repo, ctx.store));
      return true;
  }

  // PATCH /repos/{o}/{r}
  if (parts.length === 3 && parts[0] === 'repos' && req.method === 'PATCH') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const data = getJsonBody();
      if (data && data.description) repo.description = data.description;
      repo.updatedAt = ctx.store.nowIso();
      sendJson(res, 200, formatRepo(repo, ctx.store));
      return true;
  }

  // DELETE /repos/{o}/{r}
  if (parts.length === 3 && parts[0] === 'repos' && req.method === 'DELETE') {
      if (!ctx.store.deleteRepo(parts[2])) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      res.writeHead(204, { 'X-GitHub-Request-Id': ctx.reqId });
      res.end();
      return true;
  }

  // Contents PUT /repos/{o}/{r}/contents/{path...}
  if (parts.length >= 5 && parts[0] === 'repos' && parts[3] === 'contents' && req.method === 'PUT') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const path = parts.slice(4).join('/');
      const data = getJsonBody();
      if (!data || !data.message || !data.content) { sendJson(res, 422, { "message": "message and content are required" }); return true; }
      const content = Buffer.from(data.content, 'base64');
      const branchName = data.branch || query.get('branch') || repo.defaultBranch;
      let oldTip = repo.refs.get('refs/heads/' + branchName) || repo.refs.get('refs/heads/' + repo.defaultBranch);
      const files = oldTip ? git.flattenTree(repo.objects, git.parseCommit(repo.objects.get(oldTip)!.data).tree) : new Map();
      const fileExisted = files.has(path);
      if (oldTip && data.sha) {
          if (files.get(path)?.oid !== data.sha) { sendJson(res, 409, { "message": "sha does not match" }); return true; }
      }
      const blobOid = git.sha1Object('blob', content);
      repo.objects.set(blobOid, { type: 'blob', data: content });
      files.set(path, { oid: blobOid, mode: '100644' });
      const newTreeOid = git.buildTreeFromFiles(repo.objects, new Map(Array.from(files.entries()).map(([p, f]) => [p, repo.objects.get(f.oid)!.data])));
      const commit = git.buildCommit({ tree: newTreeOid, parents: oldTip ? [oldTip] : [], message: data.message, ts: ctx.store.nowSec() });
      const commitOid = git.sha1Object('commit', commit);
      repo.objects.set(commitOid, { type: 'commit', data: commit });
      repo.refs.set('refs/heads/' + branchName, commitOid);
      repo.updatedAt = repo.pushedAt = ctx.store.nowIso();
      sendJson(res, fileExisted ? 200 : 201, {
          content: { name: path.split('/').pop(), path, sha: blobOid, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitOid, message: data.message }
      });
      return true;
  }
  
  // Contents DELETE /repos/{o}/{r}/contents/{path...}
  if (parts.length >= 5 && parts[0] === 'repos' && parts[3] === 'contents' && req.method === 'DELETE') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const path = parts.slice(4).join('/');
      const data = getJsonBody();
      if (!data || !data.message) { sendJson(res, 422, { "message": "message is required" }); return true; }
      const branchName = data.branch || query.get('branch') || repo.defaultBranch;
      const oldTip = repo.refs.get('refs/heads/' + branchName);
      if (oldTip && data.sha) {
          const oldFiles = git.flattenTree(repo.objects, git.parseCommit(repo.objects.get(oldTip)!.data).tree);
          if (oldFiles.get(path)?.oid !== data.sha) { sendJson(res, 409, { "message": "sha does not match" }); return true; }
      }
      const files = oldTip ? git.flattenTree(repo.objects, git.parseCommit(repo.objects.get(oldTip)!.data).tree) : new Map();
      if (!files.has(path)) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      files.delete(path);
      const newTreeOid = git.buildTreeFromFiles(repo.objects, new Map(Array.from(files.entries()).map(([p, f]) => [p, repo.objects.get(f.oid)!.data])));
      const commit = git.buildCommit({ tree: newTreeOid, parents: oldTip ? [oldTip] : [], message: data.message, ts: ctx.store.nowSec() });
      const commitOid = git.sha1Object('commit', commit);
      repo.objects.set(commitOid, { type: 'commit', data: commit });
      repo.refs.set('refs/heads/' + branchName, commitOid);
      repo.updatedAt = repo.pushedAt = ctx.store.nowIso();
      sendJson(res, 200, {
          commit: { sha: commitOid, message: data.message }
      });
      return true;
  }
  
  // GET /repos/{o}/{r}/contents/{path...}
  if (parts.length >= 3 && parts[0] === 'repos' && parts[3] === 'contents' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const path = parts.slice(4).join('/');
      const ref = query.get('ref') || repo.defaultBranch;
      const tip = repo.refs.get('refs/heads/' + ref) || ref;
      const rootTreeOid = repo.objects.has(tip) && repo.objects.get(tip)!.type === 'commit' ? git.parseCommit(repo.objects.get(tip)!.data).tree : tip;
      
      function getTreeAt(treeOid: string, path: string): { type: 'file' | 'dir', oid: string } | null {
          if (path === '') return { type: 'dir', oid: treeOid };
          const parts = path.split('/');
          let currentTreeOid = treeOid;
          for (let i = 0; i < parts.length; i++) {
              const obj = repo.objects.get(currentTreeOid);
              if (!obj || obj.type !== 'tree') return null;
              const entries = git.parseTree(obj.data);
              const entry = entries.find(e => e.name === parts[i]);
              if (!entry) return null;
              if (i === parts.length - 1) return { type: entry.mode === '40000' ? 'dir' : 'file', oid: entry.oid };
              currentTreeOid = entry.oid;
          }
          return null;
      }
      
      const target = getTreeAt(rootTreeOid, path);
      if (!target) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      
      if (target.type === 'file') {
          const blob = repo.objects.get(target.oid);
          sendJson(res, 200, { type: 'file', encoding: 'base64', name: path.split('/').pop(), path, sha: target.oid, size: blob!.data.length, content: blob!.data.toString('base64'), url: '', download_url: '' });
      } else {
          const obj = repo.objects.get(target.oid);
          const entries = git.parseTree(obj!.data);
          sendJson(res, 200, entries.map(e => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: path === '' ? e.name : path + '/' + e.name, sha: e.oid })));
      }
      return true;
  }

  // POST /repos/{o}/{r}/labels
  if (parts.length === 4 && parts[0] === 'repos' && parts[3] === 'labels' && req.method === 'POST') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const data = getJsonBody();
      if (!data || !data.name) { sendJson(res, 422, { "message": "name is required" }); return true; }
      const label = { id: repo.nextLabelId++, name: data.name, color: data.color || 'ffffff', description: data.description || '' };
      repo.labels.set(label.name, label);
      sendJson(res, 201, formatLabel(label));
      return true;
  }
  // GET /repos/{o}/{r}/labels
  if (parts.length === 4 && parts[0] === 'repos' && parts[3] === 'labels' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      sendJson(res, 200, Array.from(repo.labels.values()).map(formatLabel));
      return true;
  }
  // POST /repos/{o}/{r}/issues
  if (parts.length === 4 && parts[0] === 'repos' && parts[3] === 'issues' && req.method === 'POST') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const data = getJsonBody();
      if (!data || !data.title) { sendJson(res, 422, { "message": "title is required" }); return true; }
      const labels: any[] = [];
      if (data.labels) {
          for (const name of data.labels) {
              const label = repo.labels.get(name);
              if (!label) { sendJson(res, 422, { "message": 'unknown label: ' + name }); return true; }
              labels.push(label);
          }
      }
      const issue = { id: repo.nextNumber, nodeId: ctx.store.globalId('Issue', repo.id, repo.nextNumber), number: repo.nextNumber++, title: data.title, body: data.body || '', state: 'open', labels, userLogin: ctx.store.ownerLogin(), createdAt: ctx.store.nowIso(), updatedAt: ctx.store.nowIso(), closedAt: null, comments: [] };
      repo.issues.push(issue);
      sendJson(res, 201, formatIssue(issue, parts[1], parts[2]));
      return true;
  }
  // GET /repos/{o}/{r}/issues
  if (parts.length === 4 && parts[0] === 'repos' && parts[3] === 'issues' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      let issues = repo.issues;
      const state = query.get('state') || 'open';
      if (state !== 'all') issues = issues.filter(i => i.state === state);
      const sort = query.get('sort') || 'created';
      const direction = query.get('direction') || 'desc';
      if (sort === 'created') {
          issues.sort((a, b) => {
              const da = new Date(a.createdAt).getTime();
              const db = new Date(b.createdAt).getTime();
              return direction === 'asc' ? da - db : db - da;
          });
      }
      const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') || '30', 10)));
      const page = Math.max(1, parseInt(query.get('page') || '1', 10));
      const start = (page - 1) * perPage;
      const paginated = issues.slice(start, start + perPage);
      const next = start + perPage < issues.length ? `http://${req.headers.host}${req.url?.split('?')[0]}?state=${state}&sort=${sort}&direction=${direction}&per_page=${perPage}&page=${page + 1}` : null;
      sendJson(res, 200, paginated.map(i => formatIssue(i, parts[1], parts[2])), next ? { Link: `<${next}>; rel="next"` } : {});
      return true;
  }
  // GET /repos/{o}/{r}/issues/{n}
  if (parts.length === 5 && parts[0] === 'repos' && parts[3] === 'issues' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const issue = repo.issues.find(i => i.number === parseInt(parts[4]));
      if (!issue) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      sendJson(res, 200, formatIssue(issue, parts[1], parts[2]));
      return true;
  }
  // PATCH /repos/{o}/{r}/issues/{n}
  if (parts.length === 5 && parts[0] === 'repos' && parts[3] === 'issues' && req.method === 'PATCH') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const issue = repo.issues.find(i => i.number === parseInt(parts[4]));
      if (!issue) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const data = getJsonBody();
      if (data.title) issue.title = data.title;
      if (data.body) issue.body = data.body;
      if (data.state) {
          issue.state = data.state;
          issue.closedAt = data.state === 'closed' ? ctx.store.nowIso() : null;
      }
      issue.updatedAt = ctx.store.nowIso();
      sendJson(res, 200, formatIssue(issue, parts[1], parts[2]));
      return true;
  }
  // POST /repos/{o}/{r}/issues/{n}/comments
  if (parts.length === 6 && parts[0] === 'repos' && parts[3] === 'issues' && parts[5] === 'comments' && req.method === 'POST') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const issue = repo.issues.find(i => i.number === parseInt(parts[4]));
      if (!issue) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const data = getJsonBody();
      if (!data || !data.body) { sendJson(res, 422, { "message": "body is required" }); return true; }
      const id = repo.nextCommentId++;
      const comment = { id: id, nodeId: ctx.store.globalId('IssueComment', id), body: data.body, userLogin: ctx.store.ownerLogin(), createdAt: ctx.store.nowIso(), updatedAt: ctx.store.nowIso() };
      issue.comments.push(comment);
      sendJson(res, 201, formatComment(comment, parts[1], parts[2], issue.number));
      return true;
  }
  // GET /repos/{o}/{r}/issues/{n}/comments
  if (parts.length === 6 && parts[0] === 'repos' && parts[3] === 'issues' && parts[5] === 'comments' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const issue = repo.issues.find(i => i.number === parseInt(parts[4]));
      if (!issue) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      sendJson(res, 200, issue.comments.map(c => formatComment(c, parts[1], parts[2], issue.number)));
      return true;
  }
  // POST /repos/{o}/{r}/pulls
  if (parts.length === 4 && parts[0] === 'repos' && parts[3] === 'pulls' && req.method === 'POST') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const data = getJsonBody();
      if (!data || !data.title || !data.head) { sendJson(res, 422, { "message": "title and head are required" }); return true; }
      const base = data.base || repo.defaultBranch;
      if (!repo.refs.has('refs/heads/' + data.head) || !repo.refs.has('refs/heads/' + base)) { sendJson(res, 404, { "message": 'Not Found' }); return true; }
      const pull = { id: repo.nextNumber, nodeId: ctx.store.globalId('PullRequest', repo.id, repo.nextNumber), number: repo.nextNumber++, title: data.title, body: data.body || '', state: 'open', headRef: data.head, baseRef: base, headSha: repo.refs.get('refs/heads/' + data.head)!, baseSha: repo.refs.get('refs/heads/' + base)!, merged: false, mergedAt: null, mergeCommitSha: null, userLogin: ctx.store.ownerLogin(), createdAt: ctx.store.nowIso(), updatedAt: ctx.store.nowIso() };
      repo.pulls.push(pull);
      sendJson(res, 201, formatPull(pull, parts[1], parts[2]));
      return true;
  }
  // GET /repos/{o}/{r}/pulls
  if (parts.length === 4 && parts[0] === 'repos' && parts[3] === 'pulls' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      let pulls = repo.pulls;
      const state = query.get('state') || 'open';
      if (state !== 'all') pulls = pulls.filter(p => p.state === state);
      const perPage = Math.max(1, Math.min(100, parseInt(query.get('per_page') || '30', 10)));
      const page = Math.max(1, parseInt(query.get('page') || '1', 10));
      const start = (page - 1) * perPage;
      const paginated = pulls.slice(start, start + perPage);
      const next = start + perPage < pulls.length ? `http://${req.headers.host}${req.url?.split('?')[0]}?state=${state}&per_page=${perPage}&page=${page + 1}` : null;
      sendJson(res, 200, paginated.map(p => formatPull(p, parts[1], parts[2])), next ? { Link: `<${next}>; rel="next"` } : {});
      return true;
  }
  // GET /repos/{o}/{r}/pulls/{n}
  if (parts.length === 5 && parts[0] === 'repos' && parts[3] === 'pulls' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const pull = repo.pulls.find(p => p.number === parseInt(parts[4]));
      if (!pull) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      sendJson(res, 200, formatPull(pull, parts[1], parts[2]));
      return true;
  }
  // GET /repos/{o}/{r}/pulls/{n}/files
  if (parts.length === 6 && parts[0] === 'repos' && parts[3] === 'pulls' && parts[5] === 'files' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const pull = repo.pulls.find(p => p.number === parseInt(parts[4]));
      if (!pull) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const baseSha = repo.refs.get('refs/heads/' + pull.baseRef)!;
      const mergeBase = git.findMergeBase(repo.objects, baseSha, pull.headSha);
      const baseTree = mergeBase ? git.parseCommit(repo.objects.get(mergeBase)!.data).tree : null;
      const headTree = git.parseCommit(repo.objects.get(pull.headSha)!.data).tree;
      const diff = git.diffTrees(repo.objects, baseTree, headTree);
      sendJson(res, 200, diff.map(d => ({ filename: d.filename, status: d.status, additions: d.additions, deletions: d.deletions, changes: d.changes, patch: '' })));
      return true;
  }
  // PUT /repos/{o}/{r}/pulls/{n}/merge
  if (parts.length === 6 && parts[0] === 'repos' && parts[3] === 'pulls' && parts[5] === 'merge' && req.method === 'PUT') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const pull = repo.pulls.find(p => p.number === parseInt(parts[4]));
      if (!pull) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      if (pull.merged) { sendJson(res, 409, { "message": "already merged" }); return true; }
      const data = getJsonBody();
      if (data && data.merge_method && data.merge_method !== 'squash') { sendJson(res, 405, { "message": "method not allowed" }); return true; }
      const baseSha = repo.refs.get('refs/heads/' + pull.baseRef)!;
      const result = git.computeMerge(repo.objects, baseSha, pull.headSha);
      if (result.conflict) { sendJson(res, 405, { "message": "conflict" }); return true; }
      const commit = git.buildCommit({ tree: result.treeOid!, parents: [baseSha], message: pull.title, ts: ctx.store.nowSec() });
      const commitOid = git.sha1Object('commit', commit);
      repo.objects.set(commitOid, { type: 'commit', data: commit });
      repo.refs.set('refs/heads/' + pull.baseRef, commitOid);
      pull.merged = true;
      pull.mergedAt = ctx.store.nowIso();
      pull.mergeCommitSha = commitOid;
      pull.baseSha = baseSha;
      pull.state = 'closed';
      sendJson(res, 200, { sha: commitOid, merged: true, message: pull.title });
      return true;
  }
  // GET /repos/{o}/{r}/pulls/{n}/merge
  if (parts.length === 6 && parts[0] === 'repos' && parts[3] === 'pulls' && parts[5] === 'merge' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const pull = repo.pulls.find(p => p.number === parseInt(parts[4]));
      if (!pull) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      if (pull.merged) { res.writeHead(204, { 'X-GitHub-Request-Id': ctx.reqId }); res.end(); }
      else { sendJson(res, 404, { "message": "Not merged" }); }
      return true;
  }
  // GET /repos/{o}/{r}/branches
  if (parts.length === 4 && parts[0] === 'repos' && parts[3] === 'branches' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const branches = Array.from(repo.refs.keys()).filter(r => r.startsWith('refs/heads/')).map(r => r.substring(11));
      branches.sort();
      sendJson(res, 200, branches.map(b => formatBranch(b, repo.refs.get('refs/heads/' + b)!)));
      return true;
  }
  // GET /repos/{o}/{r}/branches/{branch}
  if (parts.length === 5 && parts[0] === 'repos' && parts[3] === 'branches' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const branchRef = 'refs/heads/' + parts[4];
      if (!repo.refs.has(branchRef)) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      sendJson(res, 200, formatBranch(parts[4], repo.refs.get(branchRef)!));
      return true;
  }
  // POST /repos/{o}/{r}/git/refs
  if (parts.length === 5 && parts[0] === 'repos' && parts[3] === 'git' && parts[4] === 'refs' && req.method === 'POST') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const data = getJsonBody();
      if (!data || !data.ref || !data.sha) { sendJson(res, 422, { "message": "ref and sha are required" }); return true; }
      if (!data.ref.startsWith('refs/heads/')) { sendJson(res, 422, { "message": "ref must start with refs/heads/" }); return true; }
      if (repo.refs.has(data.ref)) { sendJson(res, 422, { "message": "already exists" }); return true; }
      const obj = repo.objects.get(data.sha);
      if (!obj || obj.type !== 'commit') { sendJson(res, 422, { "message": "sha not a commit or does not exist" }); return true; }
      repo.refs.set(data.ref, data.sha);
      sendJson(res, 201, formatRef(data.ref, data.sha));
      return true;
  }
  // GET /repos/{o}/{r}/git/refs/heads/{branch}
  if (parts.length === 7 && parts[0] === 'repos' && parts[3] === 'git' && parts[4] === 'refs' && parts[5] === 'heads' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const branchRef = 'refs/heads/' + parts[6];
      if (!repo.refs.has(branchRef)) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      sendJson(res, 200, formatRef(branchRef, repo.refs.get(branchRef)!));
      return true;
  }
  // GET /repos/{o}/{r}/commits
  if (parts.length === 4 && parts[0] === 'repos' && parts[3] === 'commits' && req.method === 'GET') {
      const repo = ctx.store.getRepo(parts[2]);
      if (!repo) { sendJson(res, 404, { "message": "Not Found" }); return true; }
      const sha = query.get('sha') || repo.defaultBranch;
      const tipOid = repo.refs.get('refs/heads/' + sha) || sha;
      
      const commits = new Map<string, any>();
      const queue = [tipOid];
      while (queue.length > 0) {
          const oid = queue.shift()!;
          if (commits.has(oid)) continue;
          const obj = repo.objects.get(oid);
          if (!obj || obj.type !== 'commit') continue;
          const commitData = git.parseCommit(obj.data);
          commits.set(oid, formatCommit(oid, commitData));
          queue.push(...commitData.parents);
      }
      const sorted = Array.from(commits.values()).sort((a, b) => new Date(b.commit.author.date).getTime() - new Date(a.commit.author.date).getTime());
      sendJson(res, 200, sorted);
      return true;
  }

  return false;
}

function formatLabel(label: any): any {
    return { id: label.id, name: label.name, color: label.color, description: label.description };
}

function formatIssue(issue: any, owner: string, repo: string): any {
    return {
        id: issue.id,
        node_id: issue.nodeId,
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map(formatLabel),
        user: { login: issue.userLogin, id: 1, type: "User" },
        created_at: issue.createdAt,
        updated_at: issue.updatedAt,
        closed_at: issue.closedAt,
        html_url: `https://example.com/${owner}/${repo}/issues/${issue.number}`
    };
}

function formatComment(comment: any, owner: string, repo: string, issueNumber: number): any {
    return {
        id: comment.id,
        node_id: comment.nodeId,
        body: comment.body,
        user: { login: comment.userLogin, id: 1, type: "User" },
        created_at: comment.createdAt,
        updated_at: comment.updatedAt,
        html_url: `https://example.com/${owner}/${repo}/issues/${issueNumber}#issuecomment-${comment.id}`
    };
}

function formatPull(pull: any, owner: string, repo: string): any {
    return {
        id: pull.id,
        node_id: pull.nodeId,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.headRef, sha: pull.headSha },
        base: { ref: pull.baseRef, sha: pull.baseSha },
        merged: pull.merged,
        merged_at: pull.mergedAt,
        merge_commit_sha: pull.mergeCommitSha,
        user: { login: pull.userLogin, id: 1, type: "User" },
        created_at: pull.createdAt,
        updated_at: pull.updatedAt,
        html_url: `https://example.com/${owner}/${repo}/pull/${pull.number}`
    };
}

function formatBranch(branchName: string, commitSha: string): any {
    return { name: branchName, commit: { sha: commitSha, url: '' } };
}

function formatRef(refName: string, sha: string): any {
    return { ref: refName, object: { sha, type: 'commit', url: '' } };
}

function formatCommit(sha: string, commitData: any): any {
    return { sha, commit: { message: commitData.message, author: { name: 'Author', email: 'author@example.com', date: commitData.authorDate } }, url: '' };
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
