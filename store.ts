import { Buffer } from 'node:buffer';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export type GitObject = { type: ObjType; data: Buffer };

export type Label = { id: number; name: string; color: string; description: string };

export type CommentRec = { id: number; nodeId: string; body: string; userLogin: string; createdAt: string; updatedAt: string };

export type IssueRec = { id: number; nodeId: string; number: number; title: string; body: string; state: 'open' | 'closed'; labels: Label[]; userLogin: string; createdAt: string; updatedAt: string; closedAt: string | null; comments: CommentRec[] };

export type PullRec = { id: number; nodeId: string; number: number; title: string; body: string; state: 'open' | 'closed'; headRef: string; baseRef: string; headSha: string; baseSha: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; userLogin: string; createdAt: string; updatedAt: string };

export type RepoRec = { id: number; nodeId: string; name: string; description: string; private: boolean; defaultBranch: string; createdAt: string; updatedAt: string; pushedAt: string; labels: Map<string, Label>; issues: IssueRec[]; pulls: PullRec[]; nextNumber: number; nextCommentId: number; nextLabelId: number; objects: Map<string, GitObject>; refs: Map<string, string> };

export class Store {
  viewerLogin: string | null;
  token: string;
  seq: number;
  nextRepoId: number;
  repos: Map<string, RepoRec>;

  constructor(token: string) {
    this.token = token;
    this.viewerLogin = null;
    this.seq = 0;
    this.nextRepoId = 1;
    this.repos = new Map();
  }

  nowIso(): string {
    const time = new Date(Date.UTC(2025, 0, 1) + this.seq * 1000);
    this.seq++;
    return time.toISOString();
  }

  nowSec(): number {
    const time = 1735689600 + this.seq;
    this.seq++;
    return time;
  }

  learnOwner(login: string): void {
    if (this.viewerLogin === null) {
      this.viewerLogin = login;
    }
  }

  ownerLogin(fallback?: string): string {
    return this.viewerLogin ?? fallback ?? 'viewer';
  }

  globalId(kind: string, ...parts: (string | number)[]): string {
    const s = `${kind}:${parts.join(':')}`;
    return Buffer.from(s, 'utf8').toString('base64url');
  }

  decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
    try {
      const s = Buffer.from(id, 'base64url').toString('utf8');
      const parts = s.split(':');
      if (parts.length < 2) return null;
      return { kind: parts[0], parts: parts.slice(1) };
    } catch {
      return null;
    }
  }

  createRepo(name: string, opts: { description?: string; private?: boolean }): RepoRec | null {
    if (this.repos.has(name)) return null;
    const id = this.nextRepoId++;
    const now = this.nowIso();
    const repo: RepoRec = {
      id,
      nodeId: this.globalId('Repository', id),
      name,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      pushedAt: now,
      labels: new Map(),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
      nextLabelId: 1,
      objects: new Map(),
      refs: new Map(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): RepoRec | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }
}
