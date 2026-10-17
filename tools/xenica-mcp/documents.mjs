import { createHash, createHmac } from 'node:crypto';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

import * as Y from 'yjs';

const native = createRequire(import.meta.url)(
  process.env.AFFINE_NATIVE_PATH || '/app/dist/server-native.x64.node'
);
export const hash = value => createHash('sha256').update(value).digest('hex');
export function decode(binary) {
  const doc = new Y.Doc();
  if (binary?.length) Y.applyUpdate(doc, binary);
  return doc;
}
export function revision(binary) {
  const doc = decode(binary);
  try {
    return hash(Y.encodeStateAsUpdate(doc));
  } finally {
    doc.destroy();
  }
}
export function supportedDocument(binary) {
  const doc = decode(binary);
  try {
    const blocks = doc.getMap('blocks');
    const allowed = new Set([
      'affine:page',
      'affine:surface',
      'affine:note',
      'affine:paragraph',
      'affine:list',
      'affine:code',
      'affine:divider',
    ]);
    let notes = 0,
      pages = 0;
    for (const block of blocks.values()) {
      if (!(block instanceof Y.Map))
        throw new Error('UNSUPPORTED_DOCUMENT: unknown block encoding');
      const flavour = block.get('sys:flavour');
      if (!allowed.has(flavour))
        throw new Error(
          'UNSUPPORTED_DOCUMENT: preserve image, database, math, embed and canvas blocks; edit them in AFFiNE'
        );
      if (flavour === 'affine:page') pages++;
      if (flavour === 'affine:note') notes++;
      if (flavour === 'affine:surface') {
        let elements = block.get('elements') ?? block.get('prop:elements');
        if (
          elements instanceof Y.Map &&
          elements.get('type') === '$blocksuite:internal:native$'
        )
          elements = elements.get('value');
        const count =
          elements instanceof Y.Map
            ? elements.size
            : elements && typeof elements === 'object'
              ? Object.keys(elements).length
              : elements
                ? 1
                : 0;
        if (count || block.get('sys:children')?.length)
          throw new Error(
            'UNSUPPORTED_DOCUMENT: canvas elements are protected'
          );
      }
      for (const text of [block.get('prop:text'), block.get('prop:title')]) {
        if (
          text instanceof Y.Text &&
          text
            .toDelta()
            .some(
              part =>
                typeof part.insert !== 'string' ||
                Object.keys(part.attributes || {}).some(
                  key =>
                    ![
                      'bold',
                      'italic',
                      'code',
                      'strike',
                      'underline',
                      'link',
                    ].includes(key)
                )
            )
        )
          throw new Error(
            'UNSUPPORTED_DOCUMENT: rich inline data is protected'
          );
      }
    }
    if (pages !== 1 || notes > 1)
      throw new Error(
        'UNSUPPORTED_DOCUMENT: multi-note or unknown document layout is protected'
      );
  } finally {
    doc.destroy();
  }
}
function hasUpdate(binary, update) {
  const doc = decode(binary);
  try {
    const before = revision(Y.encodeStateAsUpdate(doc));
    Y.applyUpdate(doc, update);
    return before === revision(Y.encodeStateAsUpdate(doc));
  } finally {
    doc.destroy();
  }
}
export class Documents {
  constructor(
    transport,
    { workspace, secret, statePath, publicUrl, maxDocs = 1000 }
  ) {
    this.transport = transport;
    this.workspace = workspace;
    this.secret = secret;
    this.publicUrl = publicUrl;
    this.maxDocs = maxDocs;
    this.chain = Promise.resolve();
    this.db = new DatabaseSync(statePath);
    this.db.exec(
      'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; CREATE TABLE IF NOT EXISTS writes(key TEXT PRIMARY KEY,request_hash TEXT,plan TEXT,result TEXT); CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,time TEXT,actor TEXT,tool TEXT,doc TEXT,outcome TEXT);'
    );
  }
  id(docId) {
    if (
      typeof docId !== 'string' ||
      !docId ||
      docId.length > 128 ||
      docId === this.workspace ||
      docId.startsWith('db$') ||
      docId.startsWith('userdata$')
    )
      throw new Error('INVALID_DOC_ID: system documents are unavailable');
    return docId;
  }
  async list() {
    const root = decode(await this.transport.load(this.workspace));
    try {
      const pages = root.getMap('meta').get('pages');
      return pages instanceof Y.Array
        ? pages
            .toArray()
            .filter(
              p =>
                p instanceof Y.Map &&
                !p.get('trash') &&
                !p.get('trashed') &&
                !p.get('deleted')
            )
            .map(p => ({ docId: p.get('id'), title: p.get('title') || '' }))
            .filter(p => {
              try {
                this.id(p.docId);
                return true;
              } catch {
                return false;
              }
            })
        : [];
    } finally {
      root.destroy();
    }
  }
  async read(docId) {
    this.id(docId);
    if (!(await this.list()).some(p => p.docId === docId))
      throw new Error('NOT_FOUND_OR_DENIED');
    const binary = await this.transport.load(docId);
    if (!binary.length) throw new Error('NOT_FOUND_OR_DENIED');
    const parsed = native.parseDocToMarkdown(
      binary,
      docId,
      false,
      '/workspace/' + this.workspace
    );
    return {
      docId,
      title: parsed.title,
      content: parsed.markdown,
      revision: revision(binary),
      url: this.publicUrl + '/workspace/' + this.workspace + '/' + docId,
      unsupportedBlocks: [
        ...(parsed.knownUnsupportedBlocks || []),
        ...(parsed.unknownBlocks || []),
      ],
    };
  }
  async search(query, limit = 10) {
    const pages = await this.list();
    if (pages.length > this.maxDocs)
      throw new Error(
        'SEARCH_CAPACITY: narrow workspace or configure indexed search; no partial search is reported as complete'
      );
    const needle = query.normalize('NFKC').toLocaleLowerCase(),
      hits = [];
    for (const page of pages) {
      try {
        const document = await this.read(page.docId),
          text = (document.title + '\n' + document.content).normalize('NFKC'),
          i = text.toLocaleLowerCase().indexOf(needle);
        if (i >= 0)
          hits.push({
            docId: page.docId,
            title: document.title,
            excerpt: text.slice(Math.max(0, i - 100), i + 400),
            url: document.url,
          });
      } catch (e) {
        if (e.message !== 'NOT_FOUND_OR_DENIED') throw e;
      }
      if (hits.length >= limit) break;
    }
    return { hits, mode: 'permission-checked live document scan', limit };
  }
  write(tool, args, actor = 'operator') {
    const run = this.chain
      .catch(() => {})
      .then(() => this.perform(tool, args, actor));
    this.chain = run;
    return run;
  }
  async perform(tool, args, actor) {
    const key = hash(actor + '\0' + args.idempotency_key),
      requestHash = hash(JSON.stringify({ tool, args }));
    const existing = this.db
      .prepare('SELECT * FROM writes WHERE key=?')
      .get(key);
    if (existing && existing.request_hash !== requestHash)
      throw new Error(
        'IDEMPOTENCY_CONFLICT: use a new key for a different request'
      );
    if (existing?.result)
      return { ...JSON.parse(existing.result), replayed: true };
    try {
      let plan = existing
        ? JSON.parse(existing.plan)
        : await this.plan(tool, args, key);
      if (!existing)
        this.db
          .prepare('INSERT INTO writes VALUES(?,?,?,NULL)')
          .run(key, requestHash, JSON.stringify(plan));
      for (const step of plan.steps) {
        const current = await this.transport.load(step.docId),
          update = Buffer.from(step.update, 'base64');
        if (!hasUpdate(current, update)) {
          if (revision(current) !== step.before)
            throw new Error(
              'REVISION_CONFLICT: content changed; read again and use a new idempotency key'
            );
          await this.transport.push(step.docId, update);
          if (!hasUpdate(await this.transport.load(step.docId), update))
            throw new Error(
              'WRITE_UNCONFIRMED: retry with the same idempotency key'
            );
        }
      }
      const result = { success: true, ...(await this.read(plan.docId)) };
      this.db
        .prepare('UPDATE writes SET result=? WHERE key=?')
        .run(JSON.stringify(result), key);
      this.audit(actor, tool, plan.docId, 'success');
      return result;
    } catch (error) {
      this.audit(actor, tool, args.docId || '', error.message.split(':')[0]);
      throw error;
    }
  }
  audit(actor, tool, doc, outcome) {
    this.db
      .prepare(
        'INSERT INTO audit(time,actor,tool,doc,outcome) VALUES(?,?,?,?,?)'
      )
      .run(
        new Date().toISOString(),
        hash(actor).slice(0, 16),
        tool,
        doc,
        outcome
      );
  }
  async plan(tool, args, key) {
    const steps = [];
    const add = async (docId, update) => {
      const before = await this.transport.load(docId);
      steps.push({
        docId,
        before: revision(before),
        update: Buffer.from(update(before)).toString('base64'),
      });
    };
    if (tool === 'create_document') {
      const docId =
        'mcp_' +
        createHmac('sha256', this.secret)
          .update(key)
          .digest('base64url')
          .slice(0, 21);
      const binary = native.createDocWithMarkdown(
        args.title,
        args.content,
        docId
      );
      steps.push({
        docId,
        before: revision(Buffer.alloc(0)),
        update: Buffer.from(binary).toString('base64'),
      });
      await add(this.workspace, before =>
        native.addDocToRootDoc(before, docId, args.title)
      );
      return { docId, steps };
    }
    this.id(args.docId);
    if (!(await this.list()).some(p => p.docId === args.docId))
      throw new Error('NOT_FOUND_OR_DENIED');
    const binary = await this.transport.load(args.docId);
    if (revision(binary) !== args.expected_revision)
      throw new Error('REVISION_CONFLICT: read document again before editing');
    if (tool === 'update_document') {
      supportedDocument(binary);
      steps.push({
        docId: args.docId,
        before: revision(binary),
        update: Buffer.from(
          native.updateDocWithMarkdown(binary, args.content, args.docId)
        ).toString('base64'),
      });
    } else if (tool === 'update_document_meta') {
      steps.push({
        docId: args.docId,
        before: revision(binary),
        update: Buffer.from(
          native.updateDocTitle(binary, args.title, args.docId)
        ).toString('base64'),
      });
      await add(this.workspace, before =>
        native.updateRootDocMetaTitle(before, args.docId, args.title)
      );
    } else throw new Error('UNKNOWN_TOOL');
    return { docId: args.docId, steps };
  }
  close() {
    this.db.close();
  }
}
export { native };
