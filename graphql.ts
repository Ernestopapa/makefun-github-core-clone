import type { Store } from './store.ts';
import { Buffer } from 'node:buffer';
import * as git from './git.ts';

type Token = { type: string; value: string };

function tokenize(query: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < query.length) {
    if (/\s/.test(query[pos])) { pos++; continue; }
    if (query.startsWith('...', pos)) { tokens.push({ type: 'PUNCT', value: '...' }); pos += 3; continue; }
    if (/[\{\}\(\)\[\]:!@$=,\.]/.test(query[pos])) { tokens.push({ type: 'PUNCT', value: query[pos] }); pos++; continue; }
    if (query[pos] === '"') {
      let s = ""; pos++;
      while (pos < query.length && query[pos] !== '"') s += query[pos++];
      tokens.push({ type: 'STRING', value: s }); pos++; continue;
    }
    if (/[0-9]/.test(query[pos])) {
      let s = ""; while (pos < query.length && /[0-9]/.test(query[pos])) s += query[pos++];
      tokens.push({ type: 'INT', value: s }); continue;
    }
    if (/[A-Za-z_]/.test(query[pos])) {
      let s = ""; while (pos < query.length && /[A-Za-z0-9_]/.test(query[pos])) s += query[pos++];
      tokens.push({ type: 'NAME', value: s }); continue;
    }
    throw new Error(`Unexpected character at ${pos}: ${query[pos]}`);
  }
  return tokens;
}

class Parser {
  tokens: Token[];
  pos = 0;
  fragments = new Map<string, any>();
  constructor(tokens: Token[]) { this.tokens = tokens; }
  peek() { return this.tokens[this.pos]; }
  eat(val?: string) {
    if (!val || (this.peek()?.value === val)) { return this.tokens[this.pos++]; }
    return null;
  }
  parse() {
    const definitions = [];
    while (this.pos < this.tokens.length) {
      if (this.peek().value === 'fragment') {
        this.eat('fragment'); const name = this.eat()!.value; this.eat('on'); const type = this.eat()!.value;
        this.fragments.set(name, { type, selections: this.parseSelectionSet() });
      } else {
        definitions.push(this.parseOperation());
      }
    }
    return definitions;
  }
  parseOperation() {
    let type = 'query', name = null;
    if (this.peek().value === 'query' || this.peek().value === 'mutation') type = this.eat()!.value;
    if (this.peek().type === 'NAME') name = this.eat()!.value;
    let variables = [];
    if (this.eat('(')) {
      while (this.peek().value !== ')') {
        if (this.eat(',')) continue;
        const name = this.eat()!.value; this.eat(':'); this.parseType();
        if (this.eat('=')) this.parseValue();
      }
      this.eat(')');
    }
    return { type, name, variables, selections: this.parseSelectionSet() };
  }
  parseSelectionSet(): any[] {
    this.eat('{'); const selections = [];
    while (this.peek()?.value !== '}') {
      if (this.eat('...')) {
        if (this.eat('on')) selections.push({ kind: 'inlineFragment', type: this.eat()!.value, selections: this.parseSelectionSet() });
        else selections.push({ kind: 'fragmentSpread', name: this.eat()!.value });
      } else {
        let alias = null, name = this.eat()!.value;
        if (this.eat(':')) { alias = name; name = this.eat()!.value; }
        let args: any = {};
        if (this.eat('(')) {
          while (this.peek().value !== ')') {
            if (this.eat(',')) continue;
            const argName = this.eat()!.value; this.eat(':'); args[argName] = this.parseValue();
          }
          this.eat(')');
        }
        while (this.peek().value === '@') { this.eat('@'); this.eat(); if (this.eat('(')) { this.parseValue(); this.eat(')'); } }
        selections.push({ kind: 'field', alias, name, args, selections: this.peek()?.value === '{' ? this.parseSelectionSet() : null });
      }
    }
    this.eat('}'); return selections;
  }
  parseType(): any {
    if (this.eat('[')) { const t = this.parseType(); this.eat(']'); return { kind: 'list', type: t }; }
    const name = this.eat()!.value;
    if (this.eat('!')) return { kind: 'nonNull', type: name };
    return name;
  }
  parseValue(): any {
    const t = this.peek();
    if (t.type === 'STRING') return this.eat()!.value;
    if (t.type === 'INT') return parseInt(this.eat()!.value, 10);
    if (t.value === 'true') { this.eat(); return true; }
    if (t.value === 'false') { this.eat(); return false; }
    if (t.value === 'null') { this.eat(); return null; }
    if (t.value === '$') { this.eat('$'); return { kind: 'variable', name: this.eat()!.value }; }
    if (t.type === 'NAME') return { kind: 'enum', value: this.eat()!.value };
    if (this.eat('{')) { const obj: any = {}; while (this.peek().value !== '}') { if (this.eat(',')) continue; const n = this.eat()!.value; this.eat(':'); obj[n] = this.parseValue(); } this.eat('}'); return obj; }
    if (this.eat('[')) { const arr = []; while (this.peek().value !== ']') { if (this.eat(',')) continue; arr.push(this.parseValue()); } this.eat(']'); return arr; }
    return null;
  }
}

export function handleGraphql(req: any, res: any, ctx: { store: Store; reqId: string }, body: Buffer, sendJson: (res: any, status: number, obj: any, extraHeaders?: Record<string, string>) => void): boolean {
  let requestData: any;
  try { requestData = JSON.parse(body.toString('utf8')); }
  catch { sendJson(res, 400, { "message": "Invalid JSON" }); return true; }
  const operations = Array.isArray(requestData) ? requestData : [requestData];
  const results = operations.map(op => {
    if (!op || typeof op.query !== 'string') return { data: null, errors: [{ message: "query is required" }] };
    try {
      const ast = new Parser(tokenize(op.query)).parse();
      const results = ast.map(a => ({ data: execute(a, op.variables || {}, ctx) }));
      return results.length === 1 ? results[0] : results;
    } catch (e: any) { return { data: null, errors: [{ message: e.message }] }; }
  });
  sendJson(res, 200, Array.isArray(requestData) ? results : results[0]);
  return true;
}

function execute(ast: any, variables: any, ctx: { store: Store }): any {
  function getArg(val: any): any {
    if (Array.isArray(val)) return val.map(getArg);
    if (val && typeof val === 'object') {
      if (val.kind === 'variable') return variables[val.name];
      if (val.kind === 'enum') return val.value;
      return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, getArg(v)]));
    }
    return val;
  }
  const KNOWN_FIELDS: Record<string, Set<string>> = {
    Query: new Set(['viewer', 'repository', 'node', '__type', '__schema', 'createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
    Viewer: new Set(['login']),
    Repository: new Set(['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests']),
    Issue: new Set(['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'comments']),
    PullRequest: new Set(['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'mergedAt', 'mergeCommit', 'files', 'author', 'createdAt', 'updatedAt']),
    CreateIssuePayload: new Set(['issue']),
    CloseIssuePayload: new Set(['issue']),
    CreatePullRequestPayload: new Set(['pullRequest']),
    MergePullRequestPayload: new Set(['pullRequest']),
    AddCommentPayload: new Set(['commentEdge']),
    CommentEdge: new Set(['node']),
    IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
    PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
    LabelConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
    IssueCommentConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
    FileConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
    Edge: new Set(['node', 'cursor']),
    PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
    Commit: new Set(['oid']),
    Ref: new Set(['name']),
    User: new Set(['login']),
    Label: new Set(['name']),
    IssueComment: new Set(['id', 'body']),
    File: new Set(['path']),
    Type: new Set(['name', 'kind', 'fields', 'enumValues']),
    TypeField: new Set(['name', 'type']),
    TypeRef: new Set(['name', 'kind']),
    EnumValue: new Set(['name']),
    Schema: new Set(['types']),
  };
  function resolve(obj: any, type: string, selections: any[]): any {
    if (!obj) return null;
    if (Array.isArray(obj)) return obj.map(o => resolve(o, type, selections));
    const typename = obj.__typename || type;
    const result: any = { __typename: typename };
    for (const sel of selections) {
      if (sel.kind === 'field') {
        const val = resolveField(obj, typename, sel.name, sel.args);
        result[sel.alias || sel.name] = sel.selections ? resolve(val, getFieldType(typename, sel.name), sel.selections) : val;
      } else if (sel.kind === 'inlineFragment') {
        if (typename === sel.type) Object.assign(result, resolve(obj, typename, sel.selections));
      } else if (sel.kind === 'fragmentSpread') {
        const frag = (ast as any).fragments?.get(sel.name) || (ast.fragments && ast.fragments.get(sel.name));
        if (frag) Object.assign(result, resolve(obj, frag.type, frag.selections));
      }
    }
    return result;
  }
  function resolveField(obj: any, type: string, field: string, args: any): any {
    if (field === '__typename') return type;
    if (field === 'id') return obj.nodeId;
    if (field === 'databaseId') return obj.id;
    if (type !== 'Query' && type !== 'Viewer' && type !== 'Repository' && type !== 'Issue' && type !== 'PullRequest' && !KNOWN_FIELDS[type]?.has(field) && field !== '__typename') {
      // Allow if known, otherwise check
    } else if (type !== 'Query' && !KNOWN_FIELDS[type]?.has(field) && field !== '__typename') {
        throw new Error(`Cannot query field "${field}" on type "${type}".`);
    }
    if (type === 'Query') {
      if (field === 'viewer') return { login: ctx.store.ownerLogin() };
      if (field === 'repository') {
        const owner = getArg(args.owner);
        const repoName = getArg(args.name);
        ctx.store.learnOwner(owner);
        if (owner !== ctx.store.ownerLogin()) return null;
        const repo = ctx.store.getRepo(repoName);
        return repo ? { ...repo, __typename: 'Repository', nameWithOwner: `${owner}/${repo.name}`, owner: { login: owner } } : null;
      }
      if (field === 'node') {
        const id = getArg(args.id);
        const decoded = ctx.store.decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
           const repo = Array.from(ctx.store.repos.values()).find(r => r.id === parseInt(decoded.parts[0], 10));
           return repo ? { ...repo, __typename: 'Repository', nameWithOwner: `${ctx.store.ownerLogin()}/${repo.name}`, owner: { login: ctx.store.ownerLogin() } } : null;
        }
        if (decoded.kind === 'Issue') {
            const repo = Array.from(ctx.store.repos.values()).find(r => r.id === parseInt(decoded.parts[0], 10));
            const issue = repo?.issues.find(i => i.number === parseInt(decoded.parts[1], 10));
            return issue ? { ...issue, __typename: 'Issue' } : null;
        }
        if (decoded.kind === 'PullRequest') {
            const repo = Array.from(ctx.store.repos.values()).find(r => r.id === parseInt(decoded.parts[0], 10));
            const pr = repo?.pulls.find(p => p.number === parseInt(decoded.parts[1], 10));
            return pr ? { ...pr, __typename: 'PullRequest', __objects: repo.objects } : null;
        }
        return null;
      }
      if (field === 'createIssue') {
          const input = getArg(args.input);
          const parts = ctx.store.decodeGlobalId(input.repositoryId)?.parts;
          if (!parts) throw Object.assign(new Error('repository not found'), { fieldError: { field: 'createIssue', message: 'repository not found' } });
          const repo = Array.from(ctx.store.repos.values()).find(r => r.id === parseInt(parts[0], 10));
          if (!repo) throw Object.assign(new Error('repository not found'), { fieldError: { field: 'createIssue', message: 'repository not found' } });
          const issue = { id: repo.nextNumber, nodeId: ctx.store.globalId('Issue', repo.id, repo.nextNumber), number: repo.nextNumber++, title: input.title, body: input.body ?? '', state: 'open', labels: [], userLogin: ctx.store.ownerLogin(), createdAt: ctx.store.nowIso(), updatedAt: ctx.store.nowIso(), closedAt: null, comments: [] };
          repo.issues.push(issue);
          return { __typename: 'CreateIssuePayload', issue: { ...issue, __typename: 'Issue' } };
      }
      if (field === 'closeIssue') {
          const input = getArg(args.input);
          const parts = ctx.store.decodeGlobalId(input.issueId)?.parts;
          if (!parts) throw Object.assign(new Error('issue not found'), { fieldError: { field: 'closeIssue', message: 'issue not found' } });
          const repo = Array.from(ctx.store.repos.values()).find(r => r.id === parseInt(parts[0], 10));
          const issue = repo?.issues.find(i => i.number === parseInt(parts[1], 10));
          if (!issue) throw Object.assign(new Error('issue not found'), { fieldError: { field: 'closeIssue', message: 'issue not found' } });
          issue.state = 'closed'; issue.closedAt = ctx.store.nowIso();
          return { __typename: 'CloseIssuePayload', issue: { ...issue, __typename: 'Issue' } };
      }
      if (field === 'createPullRequest') {
          const input = getArg(args.input);
          const parts = ctx.store.decodeGlobalId(input.repositoryId)?.parts;
          if (!parts) throw Object.assign(new Error('repository not found'), { fieldError: { field: 'createPullRequest', message: 'repository not found' } });
          const repo = Array.from(ctx.store.repos.values()).find(r => r.id === parseInt(parts[0], 10));
          if (!repo || !repo.refs.has('refs/heads/' + input.baseRefName) || !repo.refs.has('refs/heads/' + input.headRefName)) throw Object.assign(new Error('branch not found'), { fieldError: { field: 'createPullRequest', message: 'branch not found' } });
          const pr = { id: repo.pulls.length + 1, nodeId: ctx.store.globalId('PullRequest', repo.id, repo.pulls.length + 1), number: repo.pulls.length + 1, title: input.title, body: input.body ?? '', state: 'open', headRef: input.headRefName, baseRef: input.baseRefName, headSha: repo.refs.get('refs/heads/' + input.headRefName)!, baseSha: repo.refs.get('refs/heads/' + input.baseRefName)!, merged: false, mergedAt: null, mergeCommitSha: null, userLogin: ctx.store.ownerLogin(), createdAt: ctx.store.nowIso(), updatedAt: ctx.store.nowIso() };
          repo.pulls.push(pr);
          return { __typename: 'CreatePullRequestPayload', pullRequest: { ...pr, __typename: 'PullRequest', __objects: repo.objects } };
      }
      if (field === 'mergePullRequest') {
          const input = getArg(args.input);
          const parts = ctx.store.decodeGlobalId(input.pullRequestId)?.parts;
          if (!parts) throw Object.assign(new Error('pull request not found'), { fieldError: { field: 'mergePullRequest', message: 'pull request not found' } });
          const repo = Array.from(ctx.store.repos.values()).find(r => r.id === parseInt(parts[0], 10));
          const pr = repo?.pulls.find(p => p.number === parseInt(parts[1], 10));
          if (!pr || pr.state === 'closed') throw Object.assign(new Error('pull request not found'), { fieldError: { field: 'mergePullRequest', message: 'pull request not found' } });
          if (input.mergeMethod !== 'SQUASH') throw Object.assign(new Error('merge method not supported'), { fieldError: { field: 'mergePullRequest', message: 'merge method not supported' } });
          const mergeResult = git.computeMerge(repo.objects, repo.refs.get('refs/heads/' + pr.baseRef)!, pr.headSha);
          if (mergeResult.conflict) throw Object.assign(new Error('merge conflict'), { fieldError: { field: 'mergePullRequest', message: 'merge conflict' } });
          const commit = git.buildCommit({ tree: mergeResult.treeOid!, parents: [repo.refs.get('refs/heads/' + pr.baseRef)!], message: pr.title, ts: ctx.store.nowSec() });
          const commitOid = git.sha1Object('commit', commit);
          repo.objects.set(commitOid, { type: 'commit', data: commit });
          repo.refs.set('refs/heads/' + pr.baseRef, commitOid);
          pr.state = 'closed'; pr.merged = true; pr.mergedAt = ctx.store.nowIso(); pr.mergeCommitSha = commitOid;
          return { __typename: 'MergePullRequestPayload', pullRequest: { ...pr, __typename: 'PullRequest', __objects: repo.objects } };
      }
      if (field === 'addComment') {
          const input = getArg(args.input);
          const parts = ctx.store.decodeGlobalId(input.subjectId)?.parts;
          if (!parts || parts.length < 2) throw Object.assign(new Error('issue not found'), { fieldError: { field: 'addComment', message: 'issue not found' } });
          const repo = Array.from(ctx.store.repos.values()).find(r => r.id === parseInt(parts[0], 10));
          const issue = repo?.issues.find(i => i.number === parseInt(parts[1], 10));
          if (!issue) throw Object.assign(new Error('issue not found'), { fieldError: { field: 'addComment', message: 'issue not found' } });
          const commentId = repo.nextCommentId++;
          const comment = { id: commentId, nodeId: ctx.store.globalId('IssueComment', repo.id, commentId), body: input.body, userLogin: ctx.store.ownerLogin(), createdAt: ctx.store.nowIso(), updatedAt: ctx.store.nowIso() };
          issue.comments.push(comment);
          return { __typename: 'AddCommentPayload', commentEdge: { __typename: 'CommentEdge', node: { ...comment, __typename: 'IssueComment' } } };
      }
      if (field === '__type') {
        const name = getArg(args.name);
        if (name === 'Issue') return { name: 'Issue', kind: 'OBJECT', fields: [{ name: 'id', type: { name: 'ID', kind: 'SCALAR' } }, { name: 'number', type: { name: 'Int', kind: 'SCALAR' } }, { name: 'title', type: { name: 'String', kind: 'SCALAR' } }, { name: 'body', type: { name: 'String', kind: 'SCALAR' } }, { name: 'state', type: { name: 'String', kind: 'SCALAR' } }, { name: 'createdAt', type: { name: 'String', kind: 'SCALAR' } }, { name: 'updatedAt', type: { name: 'String', kind: 'SCALAR' } }, { name: 'closedAt', type: { name: 'String', kind: 'SCALAR' } }, { name: 'author', type: { name: 'User', kind: 'OBJECT' } }, { name: 'labels', type: { name: 'LabelConnection', kind: 'OBJECT' } }, { name: 'comments', type: { name: 'IssueCommentConnection', kind: 'OBJECT' } }], enumValues: [] };
        if (name === 'PullRequest') return { name: 'PullRequest', kind: 'OBJECT', fields: [{ name: 'id', type: { name: 'ID', kind: 'SCALAR' } }, { name: 'number', type: { name: 'Int', kind: 'SCALAR' } }, { name: 'title', type: { name: 'String', kind: 'SCALAR' } }, { name: 'body', type: { name: 'String', kind: 'SCALAR' } }, { name: 'state', type: { name: 'String', kind: 'SCALAR' } }, { name: 'headRefName', type: { name: 'String', kind: 'SCALAR' } }, { name: 'baseRefName', type: { name: 'String', kind: 'SCALAR' } }, { name: 'mergeable', type: { name: 'String', kind: 'SCALAR' } }, { name: 'merged', type: { name: 'Boolean', kind: 'SCALAR' } }, { name: 'mergedAt', type: { name: 'String', kind: 'SCALAR' } }, { name: 'mergeCommit', type: { name: 'Commit', kind: 'OBJECT' } }, { name: 'files', type: { name: 'FileConnection', kind: 'OBJECT' } }, { name: 'author', type: { name: 'User', kind: 'OBJECT' } }, { name: 'createdAt', type: { name: 'String', kind: 'SCALAR' } }, { name: 'updatedAt', type: { name: 'String', kind: 'SCALAR' } }], enumValues: [] };
        if (name === 'Repository') return { name: 'Repository', kind: 'OBJECT', fields: [{ name: 'id', type: { name: 'ID', kind: 'SCALAR' } }, { name: 'databaseId', type: { name: 'Int', kind: 'SCALAR' } }, { name: 'name', type: { name: 'String', kind: 'SCALAR' } }, { name: 'nameWithOwner', type: { name: 'String', kind: 'SCALAR' } }, { name: 'owner', type: { name: 'User', kind: 'OBJECT' } }, { name: 'defaultBranchRef', type: { name: 'Ref', kind: 'OBJECT' } }, { name: 'viewerPermission', type: { name: 'String', kind: 'SCALAR' } }, { name: 'hasIssuesEnabled', type: { name: 'Boolean', kind: 'SCALAR' } }, { name: 'issue', type: { name: 'Issue', kind: 'OBJECT' } }, { name: 'issues', type: { name: 'IssueConnection', kind: 'OBJECT' } }, { name: 'pullRequest', type: { name: 'PullRequest', kind: 'OBJECT' } }, { name: 'pullRequests', type: { name: 'PullRequestConnection', kind: 'OBJECT' } }], enumValues: [] };
        if (name === 'SearchType') return { name: 'SearchType', kind: 'ENUM', fields: [], enumValues: [{ name: 'ISSUE' }, { name: 'REPOSITORY' }, { name: 'USER' }] };
        return null;
      }
      if (field === '__schema') return { types: [] };
      if (!KNOWN_FIELDS['Query']?.has(field) && field !== '__typename') throw new Error(`Cannot query field "${field}" on type "Query".`);
    }
    if (type === 'Repository') {
        if (field === 'name') return obj.name;
        if (field === 'nameWithOwner') return obj.nameWithOwner;
        if (field === 'owner') return obj.owner;
        if (field === 'defaultBranchRef') return obj.defaultBranch ? { name: obj.defaultBranch } : null;
        if (field === 'viewerPermission') return 'ADMIN';
        if (field === 'hasIssuesEnabled') return true;
        if (field === 'issue') return obj.issues.find((i: any) => i.number === getArg(args.number)) || null;
        if (field === 'pullRequest') {
             const pr = obj.pulls.find((p: any) => p.number === getArg(args.number));
             return pr ? { ...pr, __typename: 'PullRequest', __objects: obj.objects } : null;
        }
        if (field === 'issues') {
            const first = getArg(args.first) || 10;
            const after = getArg(args.after);
            const states = getArg(args.states) || ['OPEN', 'CLOSED'];
            const orderBy = getArg(args.orderBy) || { field: 'CREATED_AT', direction: 'DESC' };
            let issues = obj.issues.filter((i: any) => states.includes(i.state.toUpperCase()));
            if (orderBy.field === 'CREATED_AT') {
                issues.sort((a: any, b: any) => (orderBy.direction === 'DESC' ? b.number - a.number : a.number - b.number));
            }
            if (after) {
                const afterId = parseInt(Buffer.from(after, 'base64').toString().split(':')[1], 10);
                if (orderBy.direction === 'DESC') {
                    issues = issues.filter((i: any) => i.number < afterId);
                } else {
                    issues = issues.filter((i: any) => i.number > afterId);
                }
            }
            const nodes = issues.slice(0, first);
            const edges = nodes.map((node: any) => ({ node, cursor: Buffer.from(`cursor:${node.number}`).toString('base64'), __typename: 'Edge' }));
            return { nodes, edges, pageInfo: { hasNextPage: issues.length > first, hasPreviousPage: !!after, startCursor: edges[0]?.cursor || null, endCursor: edges[edges.length - 1]?.cursor || null, __typename: 'PageInfo' }, totalCount: issues.length, __typename: 'IssueConnection' };
        }
        if (field === 'pullRequests') {
            const first = getArg(args.first) || 10;
            const after = getArg(args.after);
            let pulls = obj.pulls;
            if (after) {
                const afterId = parseInt(Buffer.from(after, 'base64').toString().split(':')[1], 10);
                pulls = pulls.filter((p: any) => p.number > afterId);
            }
            const nodes = pulls.slice(0, first);
            const nodesWithObj = nodes.map(n => ({...n, __objects: obj.objects}));
            const edges = nodesWithObj.map((node: any) => ({ node, cursor: Buffer.from(`cursor:${node.number}`).toString('base64'), __typename: 'Edge' }));
            return { nodes: nodesWithObj, edges, pageInfo: { hasNextPage: pulls.length > first, hasPreviousPage: !!after, startCursor: edges[0]?.cursor || null, endCursor: edges[edges.length - 1]?.cursor || null, __typename: 'PageInfo' }, totalCount: pulls.length, __typename: 'PullRequestConnection' };
        }
    }
    if (type === 'Issue') {
        if (field === 'state') return obj.state === 'open' ? 'OPEN' : 'CLOSED';
        if (field === 'author') return { login: obj.userLogin, __typename: 'User' };
        if (field === 'labels') return { nodes: obj.labels.map((l: any) => ({ name: l.name, __typename: 'Label' })), __typename: 'LabelConnection' };
        if (field === 'comments') return { nodes: obj.comments.map((c: any) => ({ id: c.nodeId, body: c.body, __typename: 'IssueComment' })), __typename: 'IssueCommentConnection' };
    }
    if (type === 'PullRequest') {
        if (field === 'state') return obj.merged ? 'MERGED' : (obj.state === 'open' ? 'OPEN' : 'CLOSED');
        if (field === 'headRefName') return obj.headRef;
        if (field === 'baseRefName') return obj.baseRef;
        if (field === 'mergeable') {
            if (!obj.headSha || !obj.baseSha) return 'UNKNOWN';
            const merge = git.computeMerge(obj.__objects, obj.baseSha, obj.headSha);
            return merge.conflict ? 'CONFLICTING' : 'MERGEABLE';
        }
        if (field === 'merged') return obj.merged;
        if (field === 'mergedAt') return obj.mergedAt;
        if (field === 'mergeCommit') return obj.mergeCommitSha ? { oid: obj.mergeCommitSha, __typename: 'Commit' } : null;
        if (field === 'files') {
            const mergeBase = git.findMergeBase(obj.__objects, obj.baseSha, obj.headSha);
            if (!mergeBase) return { nodes: [] };
            const baseTree = git.parseCommit(obj.__objects.get(mergeBase).data).tree;
            const headTree = git.parseCommit(obj.__objects.get(obj.headSha).data).tree;
            const diffs = git.diffTrees(obj.__objects, baseTree, headTree);
            return { nodes: diffs.map((d: any) => ({ path: d.filename, __typename: 'File' })), __typename: 'FileConnection' };
        }
        if (field === 'author') return { login: obj.userLogin, __typename: 'User' };
    }
    return obj[field];
  }
  function getFieldType(type: string, field: string): string {
    if (type === 'Query') {
        if (field === 'viewer') return 'Viewer';
        if (field === 'repository') return 'Repository';
        if (field === 'node') return 'Node';
        if (field === 'createIssue') return 'CreateIssuePayload';
        if (field === 'closeIssue') return 'CloseIssuePayload';
        if (field === 'createPullRequest') return 'CreatePullRequestPayload';
        if (field === 'mergePullRequest') return 'MergePullRequestPayload';
        if (field === 'addComment') return 'AddCommentPayload';
        if (field === '__type') return 'Type';
        if (field === '__schema') return 'Schema';
    }
    if (type === 'Repository') {
        if (field === 'owner') return 'User';
        if (field === 'defaultBranchRef') return 'Ref';
        if (field === 'issue') return 'Issue';
        if (field === 'issues') return 'IssueConnection';
        if (field === 'pullRequest') return 'PullRequest';
        if (field === 'pullRequests') return 'PullRequestConnection';
    }
    if (type === 'Issue') {
        if (field === 'author') return 'User';
        if (field === 'labels') return 'LabelConnection';
        if (field === 'comments') return 'IssueCommentConnection';
    }
    if (type === 'PullRequest') {
        if (field === 'author') return 'User';
        if (field === 'mergeCommit') return 'Commit';
        if (field === 'files') return 'FileConnection';
    }
    if (type === 'IssueConnection' || type === 'PullRequestConnection' || type === 'LabelConnection' || type === 'IssueCommentConnection' || type === 'FileConnection') {
        if (field === 'nodes') {
            if (type === 'IssueConnection') return 'Issue';
            if (type === 'PullRequestConnection') return 'PullRequest';
            if (type === 'LabelConnection') return 'Label';
            if (type === 'IssueCommentConnection') return 'IssueComment';
            if (type === 'FileConnection') return 'File';
        }
        if (field === 'edges') return 'Edge';
        if (field === 'pageInfo') return 'PageInfo';
    }
    if (type === 'Edge') {
        if (field === 'node') return 'Node';
    }
    return 'String';
  }
  try {
    return resolve({ __typename: 'Query' }, 'Query', ast.selections);
  } catch (e: any) {
    if (e.fieldError) {
      return { data: { [e.fieldError.field]: null }, errors: [{ message: e.fieldError.message }] };
    }
    throw e;
  }
}
