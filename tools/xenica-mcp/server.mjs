import fs from 'node:fs';
import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {Documents} from './documents.mjs';
import {Transport} from './transport.mjs';
export const definitions=[
 ['list_documents','List documents','List accessible AFFiNE documents and IDs. Use this to discover document IDs before reading.',{},[]],
 ['doc_search','Search documents','Search live AFFiNE document titles and text, including Chinese. Returns bounded excerpts and document links.',{query:{type:'string',minLength:1,maxLength:2000},limit:{type:'integer',minimum:1,maximum:20}},['query']],
 ['read_document','Read document','Read an AFFiNE document. Returns content, URL and revision. Read before editing and pass this revision to write tools.',{docId:{type:'string',minLength:1,maxLength:128}},['docId']],
 ['create_document','Create document','Create an AFFiNE document with title and Markdown body. Use a unique idempotency_key; reuse exactly the same key and arguments after an uncertain result. Does not create image, database, math or canvas blocks.',{title:{type:'string',minLength:1,maxLength:500},content:{type:'string',maxLength:100000},idempotency_key:{type:'string',minLength:8,maxLength:128}},['title','content','idempotency_key']],
 ['update_document','Update document body','Update a simple AFFiNE document body using native CRDT differences. First read_document, preserve intended content and supply its revision. Refuses stale revisions and documents with unsupported rich blocks. Does not update title.',{docId:{type:'string',minLength:1,maxLength:128},content:{type:'string',maxLength:100000},expected_revision:{type:'string',pattern:'^[a-f0-9]{64}$'},idempotency_key:{type:'string',minLength:8,maxLength:128}},['docId','content','expected_revision','idempotency_key']],
 ['update_document_meta','Rename document','Change an AFFiNE document title while preserving its body. Read first; pass expected_revision. Updates sidebar metadata too.',{docId:{type:'string',minLength:1,maxLength:128},title:{type:'string',minLength:1,maxLength:500},expected_revision:{type:'string',pattern:'^[a-f0-9]{64}$'},idempotency_key:{type:'string',minLength:8,maxLength:128}},['docId','title','expected_revision','idempotency_key']]
].map(([name,title,description,properties,required])=>({name,title,description,inputSchema:{type:'object',properties,required,additionalProperties:false},annotations:{readOnlyHint:['list_documents','doc_search','read_document'].includes(name),destructiveHint:name==='update_document',idempotentHint:true,openWorldHint:false}}));
export function validate(name,args) {
 const def=definitions.find(t=>t.name===name);
 if(!def)throw Error('UNKNOWN_TOOL');
 if(!args||typeof args!=='object'||Array.isArray(args))throw Error('INVALID_ARGUMENTS');
 const schema=def.inputSchema;
 if(schema.required.some(k=>!(k in args))||Object.keys(args).some(k=>!(k in schema.properties)))throw Error('INVALID_ARGUMENTS');
 for(const [key,value]of Object.entries(args)) {
  const p=schema.properties[key];
  if(p.type==='string'&&(typeof value!=='string'||value.length<(p.minLength??0)||value.length>(p.maxLength??Infinity)||(p.pattern&&!new RegExp(p.pattern).test(value))))throw Error('INVALID_ARGUMENTS');
  if(p.type==='integer'&&(!Number.isInteger(value)||value<p.minimum||value>p.maximum))throw Error('INVALID_ARGUMENTS');
 }
 if('title'in args && (!args.title.trim()||/[\r\n\0]/.test(args.title)))throw Error('INVALID_TITLE');
 if('content'in args && /!\[[^\]]*\]\(|\$\$|^\|.*\|\s*$/m.test(args.content))throw Error('UNSUPPORTED_MARKDOWN: image, math and database/table insertion is unavailable');
 return args;
}
export function start(config) {
 const transport=new Transport(config),documents=new Documents(transport,{workspace:config.workspace_id,secret:config.bridge_secret,statePath:config.state_path||'/state/writes.sqlite3',publicUrl:config.public_url});
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Content-Type','application/json');
  const send=(status,data)=>{res.writeHead(status);res.end(JSON.stringify(data));};
  if(req.url==='/health'&&req.method==='GET')return send(200,{ok:true});
  const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+config.bridge_secret);
  if(a.length!==b.length||!timingSafeEqual(a,b))return send(401,{error:'unauthorized'});
  if(req.method!=='POST'||req.url!=='/rpc')return send(404,{error:'not_found'});
  try {
   let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>150000)throw Error('BODY_TOO_LARGE');}
   const data=JSON.parse(body);
   if(data.action==='tools')return send(200,{tools:definitions});
   const args=validate(data.tool,data.args??{}),actor=typeof data.actor==='string'?data.actor.slice(0,128):'unknown';
   let result;
   if(data.tool==='list_documents')result={documents:await documents.list()};
   else if(data.tool==='doc_search')result=await documents.search(args.query,args.limit);
   else if(data.tool==='read_document')result=await documents.read(args.docId);
   else result=await documents.write(data.tool,args,actor);
   send(200,{result});
  }catch(e){send(200,{error:e.message.includes('UPSTREAM')?e.message.split(':')[0]:e.message.slice(0,240)});}
 });
 server.listen(config.port||8892,'0.0.0.0');
 return {server,documents,transport};
}
if(process.argv[1]===new URL(import.meta.url).pathname) {
 const config=JSON.parse(fs.readFileSync(process.env.AFFINE_BRIDGE_CONFIG||'/private/bridge.json'));
 const app=start(config);
 const shutdown=()=>{app.server.close(()=>{app.transport.close();app.documents.close();process.exit(0);});};
 process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
}
