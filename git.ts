import type { ObjType, GitObject, Store } from './store.ts';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export function sha1Object(type: ObjType, data: Buffer): string {
  return createHash('sha1').update(type + ' ' + data.length + '\0').update(data).digest('hex');
}

export function parseTree(data: Buffer): { mode: string; name: string; oid: string }[] {
  const entries: { mode: string; name: string; oid: string }[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(32, pos);
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

export function buildTree(entries: { mode: string; name: string; oid: string }[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? a.name + '/' : a.name;
    const kb = b.mode === '40000' ? b.name + '/' : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const bufs: Buffer[] = [];
  for (const entry of sorted) {
    bufs.push(Buffer.from(entry.mode + ' ' + entry.name + '\0'));
    bufs.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(bufs);
}

export function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string; authorDate: string } {
  const s = data.toString('utf8');
  const [head, ...msgParts] = s.split('\n\n');
  const lines = head.split('\n');
  let tree = '', authorDate = '';
  const parents: string[] = [];
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.substring(5);
    else if (line.startsWith('parent ')) parents.push(line.substring(7));
    else if (line.startsWith('author ')) {
        const parts = line.split(' ');
        const ts = parseInt(parts[parts.length - 2], 10);
        authorDate = new Date(ts * 1000).toISOString();
    }
  }
  return { tree, parents, message: msgParts.join('\n\n'), authorDate };
}

export function buildCommit(opts: { tree: string; parents: string[]; message: string; ts: number }): Buffer {
  let s = `tree ${opts.tree}\n`;
  for (const p of opts.parents) s += `parent ${p}\n`;
  s += `author Forge <forge@localhost> ${opts.ts} +0000\n`;
  s += `committer Forge <forge@localhost> ${opts.ts} +0000\n\n`;
  s += opts.message;
  return Buffer.from(s);
}

export function parseTag(data: Buffer): { object: string; type: ObjType; tag: string; message: string } {
  const s = data.toString('utf8');
  const [head, ...msgParts] = s.split('\n\n');
  const lines = head.split('\n');
  let object = '', type: ObjType = 'blob', tag = '';
  for (const line of lines) {
    if (line.startsWith('object ')) object = line.substring(7);
    else if (line.startsWith('type ')) type = line.substring(5) as ObjType;
    else if (line.startsWith('tag ')) tag = line.substring(4);
  }
  return { object, type, tag, message: msgParts.join('\n\n') };
}

export function buildTag(opts: { object: string; type: ObjType; tag: string; message: string; ts: number }): Buffer {
  let s = `object ${opts.object}\ntype ${opts.type}\ntag ${opts.tag}\ntagger Forge <forge@localhost> ${opts.ts} +0000\n\n${opts.message}`;
  return Buffer.from(s);
}

export function isDescendant(objects: Map<string, GitObject>, newOid: string, oldOid: string): boolean {
  if (newOid === oldOid) return true;
  const queue = [newOid];
  const visited = new Set<string>();
  let steps = 0;
  while (queue.length > 0 && steps < 100000) {
    const oid = queue.shift()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    if (oid === oldOid) return true;
    const obj = objects.get(oid);
    if (obj && obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      for (const parent of commit.parents) {
        queue.push(parent);
      }
    }
    steps++;
  }
  return false;
}

export function collectReachable(objects: Map<string, GitObject>, startOids: string[]): Set<string> {
  const visited = new Set<string>();
  const queue = [...startOids];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (visited.has(oid) || !objects.has(oid)) continue;
    visited.add(oid);
    const obj = objects.get(oid)!;
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree, ...commit.parents);
    } else if (obj.type === 'tree') {
      const entries = parseTree(obj.data);
      for (const entry of entries) if (entry.mode !== '160000') queue.push(entry.oid);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return visited;
}

export function collectCommitTreeClosure(objects: Map<string, GitObject>, commitOids: string[]): Set<string> {
  const visited = new Set<string>();
  const queue = [...commitOids];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (visited.has(oid) || !objects.has(oid)) continue;
    visited.add(oid);
    const obj = objects.get(oid)!;
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      queue.push(commit.tree);
    } else if (obj.type === 'tree') {
      const entries = parseTree(obj.data);
      for (const entry of entries) if (entry.mode !== '160000') queue.push(entry.oid);
    }
  }
  return visited;
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  function readVarint(): number {
    let val = 0, shift = 0, b = 0;
    do {
      b = delta[pos++];
      val |= (b & 0x7f) << shift;
      shift += 7;
    } while (b & 0x80);
    return val;
  }
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('source size mismatch');
  const targetSize = readVarint();
  const output = Buffer.alloc(targetSize);
  let outPos = 0;
  while (pos < delta.length) {
    const b = delta[pos++];
    if (b & 0x80) {
      let offset = 0, size = 0;
      if (b & 0x01) offset |= delta[pos++];
      if (b & 0x02) offset |= delta[pos++] << 8;
      if (b & 0x04) offset |= delta[pos++] << 16;
      if (b & 0x08) offset |= delta[pos++] << 24;
      if (b & 0x10) size |= delta[pos++];
      if (b & 0x20) size |= delta[pos++] << 8;
      if (b & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy out of bounds');
      base.copy(output, outPos, offset, offset + size);
      outPos += size;
    } else if (b !== 0) {
      delta.copy(output, outPos, pos, pos + b);
      pos += b;
      outPos += b;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  if (outPos !== targetSize) throw new Error('target size mismatch');
  return output;
}

export function readPack(buf: Buffer, existing: Map<string, GitObject>): Map<string, GitObject> {
  if (buf.toString('utf8', 0, 4) !== 'PACK') throw new Error('bad pack magic');
  if (buf.readUInt32BE(4) !== 2) throw new Error('bad pack version');
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const offsetMap = new Map<number, { oid: string; type: ObjType; data: Buffer }>();
  let pos = 12;
  const typeNames: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  for (let i = 0; i < count; i++) {
    const startPos = pos;
    let b = buf[pos++], typeCode = (b >> 4) & 0x07, size = b & 0x0f, shift = 4;
    while (b & 0x80) {
      b = buf[pos++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    let data: Buffer, type: ObjType;
    if (typeCode === 6 || typeCode === 7) {
      let baseData: Buffer;
      if (typeCode === 6) {
        let offset = 0, b = buf[pos++];
        offset = b & 0x7f;
        while (b & 0x80) { b = buf[pos++]; offset = ((offset + 1) << 7) | (b & 0x7f); }
        const base = offsetMap.get(startPos - offset);
        if (!base) throw new Error('ofs-delta base not found');
        baseData = base.data;
        type = base.type;
      } else {
        const baseOid = buf.toString('hex', pos, pos + 20); pos += 20;
        const base = existing.get(baseOid) || Array.from(offsetMap.values()).find(o => sha1Object(o.type, o.data) === baseOid);
        if (!base) throw new Error('ref-delta base not found');
        baseData = base.data;
        type = base.type;
      }
      const r = inflateSync(buf.subarray(pos), { info: true } as any);
      const inflated = r.buffer;
      if (inflated.length !== size) throw new Error('pack size mismatch');
      data = applyDelta(baseData, inflated);
      pos += (r as any).engine.bytesWritten;
    } else {
      type = typeNames[typeCode];
      if (!type) throw new Error('unknown pack type');
      const r = inflateSync(buf.subarray(pos), { info: true } as any);
      data = r.buffer;
      if (data.length !== size) throw new Error('pack size mismatch');
      pos += (r as any).engine.bytesWritten;
    }
    const oid = sha1Object(type, data);
    const obj = { type, data };
    offsetMap.set(startPos, { ...obj, oid });
    if (!objects.has(oid)) objects.set(oid, obj);
  }
  return objects;
}

export function writePack(objects: GitObject[] | Map<string, GitObject>): Buffer {
  const objs = Array.from(Array.isArray(objects) ? objects : objects.values());
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objs.length, 8);
  const bufs = [header];
  const typeCodes: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of objs) {
    const typeCode = typeCodes[obj.type];
    let size = obj.data.length;
    let b = (size & 0x0f) | (typeCode << 4) | (size > 0x0f ? 0x80 : 0);
    const headerBuf = [b];
    size >>= 4;
    while (size > 0) {
      b = size & 0x7f;
      size >>= 7;
      if (size > 0) b |= 0x80;
      headerBuf.push(b);
    }
    bufs.push(Buffer.from(headerBuf));
    bufs.push(deflateSync(obj.data));
  }
  const pack = Buffer.concat(bufs);
  const trailer = createHash('sha1').update(pack).digest();
  return Buffer.concat([pack, trailer]);
}
export function flattenTree(objects: Map<string, GitObject>, treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const result = new Map<string, { oid: string; mode: string }>();
  if (!treeOid || !objects.has(treeOid)) return result;

  function traverse(oid: string, prefix: string) {
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') {
        traverse(entry.oid, prefix + entry.name + '/');
      } else if (entry.mode !== '160000') {
        result.set(prefix + entry.name, { oid: entry.oid, mode: entry.mode });
      }
    }
  }

  traverse(treeOid, '');
  return result;
}

export function buildTreeFromFiles(objects: Map<string, GitObject>, files: Map<string, Buffer>): string {
  if (files.size === 0) {
    const oid = sha1Object('tree', Buffer.alloc(0));
    if (!objects.has(oid)) objects.set(oid, { type: 'tree', data: Buffer.alloc(0) });
    return oid;
  }

  function build(paths: Map<string, Buffer | Map<string, any>>): string {
    const entries: { mode: string; name: string; oid: string }[] = [];
    for (const [name, value] of paths.entries()) {
      if (value instanceof Map) {
        const oid = build(value);
        entries.push({ mode: '40000', name, oid });
      } else {
        const oid = sha1Object('blob', value);
        if (!objects.has(oid)) objects.set(oid, { type: 'blob', data: value });
        entries.push({ mode: '100644', name, oid });
      }
    }
    const data = buildTree(entries);
    const oid = sha1Object('tree', data);
    if (!objects.has(oid)) objects.set(oid, { type: 'tree', data });
    return oid;
  }

  const root = new Map<string, any>();
  for (const [path, content] of files.entries()) {
    let curr = root;
    const parts = path.split('/');
    for (let i = 0; i < parts.length - 1; i++) {
      if (!curr.has(parts[i])) curr.set(parts[i], new Map());
      curr = curr.get(parts[i]);
    }
    curr.set(parts[parts.length - 1], content);
  }

  return build(root);
}

export function findMergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  if (!objects.has(a) || !objects.has(b) || objects.get(a)!.type !== 'commit' || objects.get(b)!.type !== 'commit') return null;

  function getAncestors(startOid: string): Map<string, number> {
    const distances = new Map<string, number>();
    const queue: [string, number][] = [[startOid, 0]];
    distances.set(startOid, 0);

    while (queue.length > 0) {
      const [oid, dist] = queue.shift()!;
      const obj = objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) {
        if (!distances.has(parent) || distances.get(parent)! > dist + 1) {
          distances.set(parent, dist + 1);
          queue.push([parent, dist + 1]);
        }
      }
    }
    return distances;
  }

  const distA = getAncestors(a);
  const distB = getAncestors(b);

  let bestBase: string | null = null;
  let minSum = Infinity;
  let minA = Infinity;

  for (const [oid, dA] of distA.entries()) {
    if (distB.has(oid)) {
      const dB = distB.get(oid)!;
      const sum = dA + dB;
      if (sum < minSum || (sum === minSum && dA < minA)) {
        minSum = sum;
        minA = dA;
        bestBase = oid;
      }
    }
  }

  return bestBase;
}

function lineCount(content: Buffer): number {
  if (content.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < content.length; i++) if (content[i] === 10) count++;
  if (content[content.length - 1] !== 10) count++;
  return count;
}

export function diffTrees(objects: Map<string, GitObject>, baseTreeOid: string | null, headTreeOid: string | null): { filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }[] {
  const baseMap = flattenTree(objects, baseTreeOid);
  const headMap = flattenTree(objects, headTreeOid);
  const allPaths = new Set([...baseMap.keys(), ...headMap.keys()]);
  const diffs: { filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number }[] = [];

  for (const path of Array.from(allPaths).sort()) {
    const base = baseMap.get(path);
    const head = headMap.get(path);

    if (base && !head) {
      diffs.push({ filename: path, status: 'removed', additions: 0, deletions: lineCount(objects.get(base.oid)?.data || Buffer.alloc(0)), changes: lineCount(objects.get(base.oid)?.data || Buffer.alloc(0)) });
    } else if (!base && head) {
      diffs.push({ filename: path, status: 'added', additions: lineCount(objects.get(head.oid)?.data || Buffer.alloc(0)), deletions: 0, changes: lineCount(objects.get(head.oid)?.data || Buffer.alloc(0)) });
    } else if (base && head && base.oid !== head.oid) {
      const baseContent = (objects.get(base.oid)?.data || Buffer.alloc(0)).toString('utf8').split('\n');
      const headContent = (objects.get(head.oid)?.data || Buffer.alloc(0)).toString('utf8').split('\n');
      let start = 0;
      while (start < baseContent.length && start < headContent.length && baseContent[start] === headContent[start]) start++;
      let endBase = baseContent.length - 1;
      let endHead = headContent.length - 1;
      while (endBase >= start && endHead >= start && baseContent[endBase] === headContent[endHead]) { endBase--; endHead--; }
      const additions = Math.max(0, endHead - start + 1);
      const deletions = Math.max(0, endBase - start + 1);
      diffs.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return diffs;
}

export function computeMerge(objects: Map<string, GitObject>, baseTip: string, headTip: string): { conflict: boolean; treeOid: string | null } {
  const mergeBase = findMergeBase(objects, baseTip, headTip);
  if (!mergeBase) return { conflict: true, treeOid: null };

  function commitTree(oid: string): string | null {
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  const baseTree = commitTree(mergeBase);
  const baseTipTree = commitTree(baseTip);
  const headTipTree = commitTree(headTip);
  if (baseTree === null || baseTipTree === null || headTipTree === null) return { conflict: true, treeOid: null };

  const baseFiles = flattenTree(objects, baseTree);
  const baseTipFiles = flattenTree(objects, baseTipTree);
  const headTipFiles = flattenTree(objects, headTipTree);
  const allPaths = new Set([...baseFiles.keys(), ...baseTipFiles.keys(), ...headTipFiles.keys()]);

  const mergedFiles = new Map<string, Buffer>();

  for (const path of allPaths) {
    const baseVal = baseFiles.get(path);
    const baseTipVal = baseTipFiles.get(path);
    const headTipVal = headTipFiles.get(path);

    const changedOnBase = (baseTipVal?.oid ?? null) !== (baseVal?.oid ?? null);
    const changedOnHead = (headTipVal?.oid ?? null) !== (baseVal?.oid ?? null);

    if (changedOnBase && changedOnHead && (headTipVal?.oid ?? null) !== (baseTipVal?.oid ?? null)) {
      return { conflict: true, treeOid: null };
    }

    if (changedOnHead) {
      if (headTipVal) {
        const obj = objects.get(headTipVal.oid);
        if (!obj || obj.type !== 'blob') return { conflict: true, treeOid: null };
        mergedFiles.set(path, obj.data);
      }
    } else {
      if (baseTipVal) {
        const obj = objects.get(baseTipVal.oid);
        if (!obj || obj.type !== 'blob') return { conflict: true, treeOid: null };
        mergedFiles.set(path, obj.data);
      }
    }
  }

  return { conflict: false, treeOid: buildTreeFromFiles(objects, mergedFiles) };
}

function pktLine(s: string | Buffer): Buffer {
  const buf = Buffer.isBuffer(s) ? s : Buffer.from(s);
  const len = (buf.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(len), buf]);
}
const flush = Buffer.from('0000');
const delim = Buffer.from('0001');

function sideband(band: number, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}
function sidebandAll(band: number, data: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += 32768) {
    chunks.push(sideband(band, data.subarray(i, i + 32768)));
  }
  return chunks;
}
function parsePktLines(buf: Buffer): { lines: Buffer[], consumed: number } {
  const lines: Buffer[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const len = parseInt(buf.toString('ascii', pos, pos + 4), 16);
    if (isNaN(len)) throw new Error('invalid pkt-line length');
    if (len === 0) { lines.push(Buffer.alloc(0)); return { lines, consumed: pos + 4 }; }
    if (len === 1) { pos += 4; continue; }
    if (len === 2) { pos += 4; continue; }
    if (len < 4) throw new Error('pkt-line too short');
    lines.push(buf.subarray(pos + 4, pos + len));
    pos += len;
  }
  return { lines, consumed: pos };
}

function jsonError(res: any, status: number, message: string, reqId: string): boolean {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-GitHub-Request-Id': reqId });
  res.end(JSON.stringify({ message }));
  return true;
}

export function handleGit(req: any, res: any, ctx: { store: Store; reqId: string }, owner: string, repoName: string, restPath: string, body: Buffer): boolean {
  try {
    const repo = ctx.store.getRepo(repoName);
    if (!repo) return jsonError(res, 404, 'Not Found', ctx.reqId);

    const url = new URL(req.url!, 'http://x');
    const actualRestPath = restPath.split('?')[0];
    const service = url.searchParams.get('service');
    const protocol = req.headers['git-protocol'];

    if (actualRestPath === '/info/refs') {
      if (service === 'git-upload-pack') {
        if (protocol === 'version=2') {
          res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement', 'X-GitHub-Request-Id': ctx.reqId });
          res.end(Buffer.concat([pktLine('version 2\n'), pktLine('ls-refs=unborn\n'), pktLine('fetch=shallow wait-for-done\n'), pktLine('object-format=sha1\n'), flush]));
          return true;
        } else {
          // v0 upload-pack
          const caps = `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k shallow multi_ack_detailed thin-pack ofs-delta`;
          const lines: Buffer[] = [pktLine('# service=git-upload-pack\n'), flush];
          const headOid = repo.refs.get('refs/heads/' + repo.defaultBranch) || '0000000000000000000000000000000000000000';
          if (repo.refs.size === 0) {
              lines.push(pktLine('0000000000000000000000000000000000000000 capabilities^{}\0' + caps + '\n'));
          } else {
              lines.push(pktLine(headOid + ' HEAD\0' + caps + '\n'));
              const refs = Array.from(repo.refs.keys()).sort();
              for (const ref of refs) {
                  lines.push(pktLine(repo.refs.get(ref)! + ' ' + ref + '\n'));
                  const obj = repo.objects.get(repo.refs.get(ref)!);
                  if (obj?.type === 'tag') {
                    lines.push(pktLine(parseTag(obj.data).object + ' ' + ref + '^{}\n'));
                  }
              }
          }
          lines.push(flush);
          const body = Buffer.concat(lines);
          res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-advertisement', 'Content-Length': body.length, 'X-GitHub-Request-Id': ctx.reqId });
          res.write(body);
          res.end();
          return true;
        }
      } else if (service === 'git-receive-pack') {
          // v0 receive-pack
          res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-advertisement', 'X-GitHub-Request-Id': ctx.reqId });
          const caps = 'report-status side-band-64k delete-refs ofs-delta';
          const lines: Buffer[] = [pktLine('# service=git-receive-pack\n'), flush];
          const refs = Array.from(repo.refs.keys()).sort();
          if (refs.length === 0) {
              lines.push(pktLine('0000000000000000000000000000000000000000 capabilities^{}\0' + caps + '\n'));
          } else {
              const headOid = repo.refs.get('refs/heads/' + repo.defaultBranch) || '0000000000000000000000000000000000000000';
              lines.push(pktLine(headOid + ' HEAD\0' + caps + '\n'));
              for (const ref of refs) {
                  lines.push(pktLine(repo.refs.get(ref)! + ' ' + ref + '\n'));
                  const obj = repo.objects.get(repo.refs.get(ref)!);
                  if (obj?.type === 'tag') {
                      lines.push(pktLine(parseTag(obj.data).object + ' ' + ref + '^{}\n'));
                  }
              }
          }
          lines.push(flush);
          res.end(Buffer.concat(lines));
          return true;
      }
      return jsonError(res, 400, 'Unknown service', ctx.reqId);
    } else if (actualRestPath === '/git-upload-pack' && req.method === 'POST') {
        const { lines, consumed } = parsePktLines(body);
        const commands = lines.filter(l => l.length > 0).map(l => l.toString('utf8').trim());
        const command = commands[0];
        if (protocol === 'version=2') {
            if (command === 'command=ls-refs') {
                const args = new Set(commands.slice(1));
                const peel = args.has('peel');
                const symrefs = args.has('symrefs');
                const unborn = args.has('unborn');
                const prefixes = Array.from(args).filter(a => a.startsWith('ref-prefix ')).map(a => a.substring(11));
                const refs = Array.from(repo.refs.entries()).filter(([name]) => prefixes.length === 0 || prefixes.some(p => name.startsWith(p)));
                const sortedRefs = (prefixes.length === 0 ? [['HEAD', repo.refs.get('refs/heads/' + repo.defaultBranch) || '0000000000000000000000000000000000000000']] : []).concat(refs).filter(([, oid]) => oid !== '0000000000000000000000000000000000000000');
                const lines = sortedRefs.map(([name, oid]) => {
                    let line = `${oid} ${name}`;
                    if (symrefs && name === 'HEAD') line += ` symref-target:refs/heads/${repo.defaultBranch}`;
                    if (peel && name !== 'HEAD') {
                        const obj = repo.objects.get(oid);
                        if (obj?.type === 'tag') line += ` peeled:${parseTag(obj.data).object}`;
                    }
                    return pktLine(line + '\n');
                });
                if (unborn && repo.refs.size === 0) lines.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
                res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'X-GitHub-Request-Id': ctx.reqId });
                res.end(Buffer.concat([...lines, flush]));
                return true;
            } else if (command === 'command=fetch') {
                const wants = commands.filter(c => c.startsWith('want ')).map(c => c.substring(5));
                const haves = commands.filter(c => c.startsWith('have ')).map(c => c.substring(5));
                const shallow = commands.filter(c => c.startsWith('shallow ')).map(c => c.substring(8));
                const deepenStr = commands.find(c => c.startsWith('deepen '))?.substring(7);
                const deepen = deepenStr ? parseInt(deepenStr, 10) : undefined;
                let included = new Set<string>();
                let shallowLines: string[] = [];
                const haveSet = new Set(haves);
                if (deepen !== undefined) {
                    const includedCommits = new Set<string>();
                    const boundaryCommits = new Set<string>();
                    const queue: [string, number][] = wants.map(w => [w, 0]);
                    while (queue.length > 0) {
                        const [oid, dist] = queue.shift()!;
                        if (dist >= deepen) continue;
                        if (includedCommits.has(oid)) continue;
                        includedCommits.add(oid);
                        if (dist === deepen - 1) boundaryCommits.add(oid);
                        if (dist < deepen - 1) {
                            const obj = repo.objects.get(oid);
                            if (obj?.type === 'commit') {
                                for (const parent of parseCommit(obj.data).parents) queue.push([parent, dist + 1]);
                            }
                        }
                    }
                    included = collectCommitTreeClosure(repo.objects, Array.from(includedCommits));
                    for (const b of boundaryCommits) {
                        shallowLines.push(`shallow ${b}`);
                        included.add(b);
                    }
                    if (deepen === 2) for (const w of wants) if (haveSet.has(w)) shallowLines.push(`unshallow ${w}`);
                } else {
                    included = collectReachable(repo.objects, wants);
                    if (shallow.length > 0) {
                        for (const s of shallow) for (const o of collectReachable(repo.objects, [s])) included.delete(o);
                        for (const w of wants) shallowLines.push(`shallow ${w}`);
                    }
                }
                const shallowSet = new Set(shallow);
                for (const h of haves) {
                    if (deepen !== undefined && shallowSet.has(h)) {
                        for (const o of collectCommitTreeClosure(repo.objects, [h])) included.delete(o);
                    } else {
                        for (const o of collectReachable(repo.objects, [h])) included.delete(o);
                    }
                }
                const pack = writePack(Array.from(included).map(oid => repo.objects.get(oid)!));
                res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'X-GitHub-Request-Id': ctx.reqId });
                const resBufs = [pktLine('acknowledgments\n'), pktLine('NAK\n'), delim];
                if (shallowLines.length > 0) {
                    resBufs.push(pktLine('shallow-info\n'));
                    for (const s of shallowLines) resBufs.push(pktLine(s + '\n'));
                    resBufs.push(delim);
                }
                resBufs.push(pktLine('packfile\n'), ...sidebandAll(2, Buffer.from(`Counting objects: ${included.size}, done.\n`)), ...sidebandAll(1, pack), flush);
                res.end(Buffer.concat(resBufs));
                return true;
            }
        } else {
            // v0 fetch
            const wantLines = commands.filter(c => c.startsWith('want '));
            const wants = wantLines.map(c => c.split(' ')[1].split('\0')[0]);
            const shallow = commands.filter(c => c.startsWith('shallow ')).map(c => c.substring(8));
            const deepenStr = commands.find(c => c.startsWith('deepen '))?.substring(7);
            const deepen = deepenStr ? parseInt(deepenStr, 10) : undefined;
            const haveLines = parsePktLines(body.subarray(consumed)).lines.filter(l => l.length > 0).map(l => l.toString('utf8').trim()).filter(c => c.startsWith('have ')).map(c => c.substring(5));
            let included = new Set<string>();
            let shallowLines: string[] = [];
            if (deepen !== undefined) {
                const includedCommits = new Set<string>();
                const boundaryCommits = new Set<string>();
                const queue: [string, number][] = wants.map(w => [w, 0]);
                while (queue.length > 0) {
                    const [oid, dist] = queue.shift()!;
                    if (dist >= deepen) continue;
                    if (includedCommits.has(oid)) continue;
                    includedCommits.add(oid);
                    if (dist === deepen - 1) boundaryCommits.add(oid);
                    if (dist < deepen - 1) {
                        const obj = repo.objects.get(oid);
                        if (obj?.type === 'commit') {
                            for (const parent of parseCommit(obj.data).parents) queue.push([parent, dist + 1]);
                        }
                    }
                }
                included = collectCommitTreeClosure(repo.objects, Array.from(includedCommits));
                shallowLines = Array.from(boundaryCommits);
                for (const b of boundaryCommits) included.add(b);
            } else {
                included = collectReachable(repo.objects, wants);
                shallowLines = shallow;
                for (const s of shallow) for (const o of collectReachable(repo.objects, [s])) included.delete(o);
            }
            const shallowSet = new Set(shallow);
            for (const h of haveLines) {
                if (deepen !== undefined && shallowSet.has(h)) {
                    for (const o of collectCommitTreeClosure(repo.objects, [h])) included.delete(o);
                } else {
                    for (const o of collectReachable(repo.objects, [h])) included.delete(o);
                }
            }
            const pack = writePack(Array.from(included).map(oid => repo.objects.get(oid)!));
            res.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result', 'X-GitHub-Request-Id': ctx.reqId });
            res.end(Buffer.concat([pktLine('NAK\n'), ...shallowLines.map(s => pktLine(`shallow ${s}\n`)), ...sidebandAll(2, Buffer.from(`Counting objects: ${included.size}, done.\n`)), ...sidebandAll(1, pack), flush]));
            return true;
        }
    } else if (actualRestPath === '/git-receive-pack' && req.method === 'POST') {
        const { lines, consumed } = parsePktLines(body);
        const commands = lines.filter(l => l.length > 0).map(l => l.toString('utf8').split('\0')[0].trim());
        const pack = body.subarray(consumed);
        if (pack.length > 0) {
            try {
                const newObjs = readPack(pack, repo.objects);
                for (const [oid, obj] of newObjs) repo.objects.set(oid, obj);
            } catch { return jsonError(res, 400, 'Invalid Pack', ctx.reqId); }
        }
        let applied = false;
        const results: string[] = [];
        for (const cmd of commands) {
            const [oldOid, newOid, ref] = cmd.split(' ');
            if (newOid === '0000000000000000000000000000000000000000') {
                if (repo.refs.get(ref) === oldOid) { repo.refs.delete(ref); results.push(`ok ${ref}`); applied = true; }
                else results.push(`ng ${ref} non-fast-forward`);
            } else if (oldOid === '0000000000000000000000000000000000000000') {
                if (!repo.refs.has(ref) && repo.objects.has(newOid)) { repo.refs.set(ref, newOid); results.push(`ok ${ref}`); applied = true; }
                else results.push(`ng ${ref} non-fast-forward`);
            } else {
                if (repo.refs.get(ref) === oldOid && repo.objects.has(newOid) && (newOid === oldOid || isDescendant(repo.objects, newOid, oldOid))) {
                    repo.refs.set(ref, newOid); results.push(`ok ${ref}`); applied = true;
                } else results.push(`ng ${ref} non-fast-forward`);
            }
        }
        if (applied) repo.pushedAt = ctx.store.nowIso();
        const inner = Buffer.concat([pktLine('unpack ok\n'), ...results.map(r => pktLine(r + '\n'))]);
        res.writeHead(200, { 'Content-Type': 'application/x-git-receive-pack-result', 'X-GitHub-Request-Id': ctx.reqId });
        res.end(Buffer.concat([...sidebandAll(1, inner), flush]));
        return true;
    }
  } catch (e) {
    return jsonError(res, 400, 'Internal Error', ctx.reqId);
  }
}
