import * as http from 'node:http';
import { Buffer } from 'node:buffer';
import { Store } from './store.ts';
import { handleGit } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export function createApp(): http.Server {
  const store = new Store(process.env.MAKEFUN_SHOP_TOKEN ?? '');
  let reqCounter = 0;

  function sendJson(res: http.ServerResponse, status: number, obj: any, extraHeaders?: Record<string, string>) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-GitHub-Request-Id', `req-${++reqCounter}`);
    if (extraHeaders) {
        for (const [name, value] of Object.entries(extraHeaders)) {
            res.setHeader(name, value);
        }
    }
    res.statusCode = status;
    res.end(JSON.stringify(obj));
  }

  const server = http.createServer(async (req, res) => {
    if (req.url === '/healthz' && req.method === 'GET') {
      res.setHeader('X-GitHub-Request-Id', `req-${++reqCounter}`);
      res.statusCode = 200;
      res.end(JSON.stringify({ "ok": true }));
      return;
    }

    const auth = req.headers['authorization'];
    if (!auth || auth !== `Bearer ${store.token}`) {
      sendJson(res, 401, { "message": "Requires authentication" });
      return;
    }

    let body = Buffer.alloc(0);
    try {
      for await (const chunk of req) {
        body = Buffer.concat([body, chunk]);
        if (body.length > 64 * 1024 * 1024) {
          sendJson(res, 413, { "message": "Payload too large" });
          return;
        }
      }
    } catch (e) {
      sendJson(res, 400, { "message": "Malformed body" });
      return;
    }

    const url = new URL(req.url ?? '', `http://${req.headers.host}`);
    let path: string;
    try { path = decodeURIComponent(url.pathname.replace(/\/+$/, '') || '/'); }
    catch { sendJson(res, 400, { "message": "Invalid path" }); return; }

    const ctx = { store, reqId: `req-${++reqCounter}` };

    if (path === '/api/graphql' && req.method === 'POST') {
      if (handleGraphql(req, res, ctx, body, sendJson)) return;
      sendJson(res, 404, { "message": "Not Found" });
      return;
    }
    if (path === '/mcp' && req.method === 'POST') {
      if (handleMcp(req, res, ctx, body, sendJson)) return;
      sendJson(res, 404, { "message": "Not Found" });
      return;
    }
    if (path === '/api/v3' && req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('X-GitHub-Request-Id', ctx.reqId);
      res.setHeader('X-OAuth-Scopes', 'repo, read:org');
      res.statusCode = 200;
      res.end(JSON.stringify({}));
      return;
    }
    if (path === '/api/v3/meta' && req.method === 'GET') {
      sendJson(res, 200, { "installed_version": "1.0.0" });
      return;
    }
    if (path === '/api/v3/user' && req.method === 'GET') {
      sendJson(res, 200, { "login": store.ownerLogin() });
      return;
    }
    if (path.startsWith('/api/v3')) {
      const parts = path.substring('/api/v3'.length).split('/').filter(Boolean);
      if (handleRest(req, res, ctx, parts, body, url.searchParams, sendJson)) return;
      sendJson(res, 404, { "message": "Not Found" });
      return;
    }

    const gitMatch = path.match(/^\/([^\/]+)\/([^\/]+)\.git(\/.*)?$/);
    if (gitMatch) {
      const owner = gitMatch[1];
      const repoName = gitMatch[2];
      const restPath = gitMatch[3] ?? '';
      
      if (store.viewerLogin !== null && owner !== store.viewerLogin) { sendJson(res, 404, { "message": "Not Found" }); return; }
      store.learnOwner(owner);
      
      if (handleGit(req, res, ctx, owner, repoName, restPath, body)) {
        return;
      }
    }

    sendJson(res, 404, { "message": "Not Found" });
  });

  return server;
}
