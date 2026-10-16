import test from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {Documents,native,revision,decode,supportedDocument} from '../documents.mjs';
import {validate} from '../server.mjs';
const workspace='test-workspace';
class MemoryTransport {
 constructor() {this.docs=new Map();this.failRoot=false;const root=new Y.Doc();root.getMap('meta').set('pages',new Y.Array());this.docs.set(workspace,Buffer.from(Y.encodeStateAsUpdate(root)));root.destroy();}
 async load(id){return this.docs.get(id)||Buffer.alloc(0);}
 async push(id,update){if(id===workspace&&this.failRoot){this.failRoot=false;throw Error('UPSTREAM_TIMEOUT');}const doc=decode(await this.load(id));Y.applyUpdate(doc,update);this.docs.set(id,Buffer.from(Y.encodeStateAsUpdate(doc)));doc.destroy();}
}
function fixture(){const transport=new MemoryTransport(),docs=new Documents(transport,{workspace,secret:'unit-test-only',statePath:':memory:',publicUrl:'https://example.test'});return {transport,docs};}
const create=(docs,key='create-key-1')=>docs.write('create_document',{title:'中文标题',content:'第一段 **加粗**\n\n- 测试',idempotency_key:key},'test-client');
test('native document roundtrip, title and body; metadata registration is visible',async()=>{
 const {docs}=fixture();try{
 const made=await create(docs);assert.equal(made.title,'中文标题');assert.match(made.content,/第一段/);assert.equal((await docs.list()).length,1);
 const updated=await docs.write('update_document',{docId:made.docId,content:'更新中文\n\n- [x] 完成',expected_revision:made.revision,idempotency_key:'update-key-1'},'test-client');
 assert.match(updated.content,/更新中文/);
 const renamed=await docs.write('update_document_meta',{docId:made.docId,title:'改名后',expected_revision:updated.revision,idempotency_key:'rename-key-1'},'test-client');
 assert.equal(renamed.title,'改名后');assert.equal((await docs.list())[0].title,'改名后');
 assert.equal((await docs.search('更新中文')).hits.length,1);
 }finally{docs.close();}
});
test('idempotent creation and differing replay arguments',async()=>{
 const {docs}=fixture();try{const made=await create(docs),again=await create(docs);assert.equal(again.docId,made.docId);assert.equal(again.replayed,true);assert.equal((await docs.list()).length,1);
 await assert.rejects(docs.write('create_document',{title:'不同内容',content:'x',idempotency_key:'create-key-1'},'test-client'),/IDEMPOTENCY_CONFLICT/);
 }finally{docs.close();}
});
test('uncertain create resumes without duplicate document after root failure',async()=>{
 const {docs,transport}=fixture();try{transport.failRoot=true;await assert.rejects(create(docs),/UPSTREAM_TIMEOUT/);const result=await create(docs);assert.equal((await docs.list()).length,1);assert.equal(transport.docs.size,2);assert.match(result.content,/第一段/);}finally{docs.close();}
});
test('stale update fails and later queued valid work still succeeds',async()=>{
 const {docs}=fixture();try{const made=await create(docs);
 await assert.rejects(docs.write('update_document',{docId:made.docId,content:'不能覆盖',expected_revision:'0'.repeat(64),idempotency_key:'stale-key-1'}),/REVISION_CONFLICT/);
 const result=await docs.write('update_document',{docId:made.docId,content:'成功写入',expected_revision:made.revision,idempotency_key:'fresh-key-1'});assert.match(result.content,/成功写入/);
 }finally{docs.close();}
});
test('system and unknown documents cannot be read or written',async()=>{
 const {docs}=fixture();try{for(const id of [workspace,'db$secrets','userdata$x'])await assert.rejects(docs.read(id),/INVALID_DOC_ID/);await assert.rejects(docs.read('unknown'),/NOT_FOUND_OR_DENIED/);}finally{docs.close();}
});
test('rich blocks protected; title-only changes preserve them',async()=>{
 const {docs,transport}=fixture();try{const made=await create(docs),doc=decode(await transport.load(made.docId));const image=new Y.Map();image.set('sys:flavour','affine:image');image.set('sys:id','protected-image');doc.getMap('blocks').set('protected-image',image);transport.docs.set(made.docId,Buffer.from(Y.encodeStateAsUpdate(doc)));doc.destroy();
 const before=await docs.read(made.docId);
 await assert.rejects(docs.write('update_document',{docId:made.docId,content:'不能丢图片',expected_revision:before.revision,idempotency_key:'protected-1'}),/UNSUPPORTED_DOCUMENT/);
 const renamed=await docs.write('update_document_meta',{docId:made.docId,title:'保留图片改名',expected_revision:before.revision,idempotency_key:'protected-2'});
 assert.equal(renamed.title,'保留图片改名');assert.ok(decode(await transport.load(made.docId)).getMap('blocks').has('protected-image'));
 }finally{docs.close();}
});
test('revision includes pure Yjs deletion; native independent edits merge',()=>{
 const binary=native.createDocWithMarkdown('t','第一段\n\n第二段','native-merge');
 const doc=decode(binary),r1=revision(binary);const first=[...doc.getMap('blocks').values()].find(x=>x.get('prop:text') instanceof Y.Text);first.get('prop:text').delete(0,1);assert.notEqual(revision(Y.encodeStateAsUpdate(doc)),r1);doc.destroy();
 const a=native.updateDocWithMarkdown(binary,'第一段已改\n\n第二段','native-merge'),b=native.updateDocWithMarkdown(binary,'第一段\n\n第二段已改','native-merge');
 const merged=decode(binary);Y.applyUpdate(merged,a);Y.applyUpdate(merged,b);const md=native.parseDocToMarkdown(Buffer.from(Y.encodeStateAsUpdate(merged)),'native-merge',false,'').markdown;assert.match(md,/第一段已改/);assert.match(md,/第二段已改/);merged.destroy();
});
test('schema rejects hidden extra parameters, invalid revisions and unsupported Markdown',()=>{
 assert.throws(()=>validate('read_document',{docId:'ok',workspaceId:'other'}),/INVALID_ARGUMENTS/);
 assert.throws(()=>validate('create_document',{title:'\n',content:'x',idempotency_key:'12345678'}),/INVALID_TITLE/);
 assert.throws(()=>validate('create_document',{title:'x',content:'![x](https://image.test/x)',idempotency_key:'12345678'}),/UNSUPPORTED_MARKDOWN/);
 assert.throws(()=>validate('doc_search',{query:'',limit:1}),/INVALID_ARGUMENTS/);
});
