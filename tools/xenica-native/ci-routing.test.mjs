import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const workflow=readFileSync(new URL('../../.github/workflows/build-test.yml',import.meta.url),'utf8');
function excluded(text,base){
 const section=text.match(/^  pull_request:\n([\s\S]*?)^  merge_group:/m)?.[1]??'';
 const branches=[...section.matchAll(/^      - (.+)$/gm)].map(x=>x[1]);
 return branches.includes(base);
}
test('只有Xenica指定stable目标PR使用Infra产品验证',()=>{
 assert.equal(excluded(workflow,'xenica/stable-0.27.4'),true);
 for(const base of ['canary','beta','stable','v0.27.x','xenica/another-branch'])assert.equal(excluded(workflow,base),false);
 assert.match(workflow,/^  push:\n    branches:\n      - canary\n      - beta\n      - stable/m);
 assert.match(workflow,/^  merge_group:/m);
});
test('路由不伪造成功检查、不跳过整个仓库CI、不向候选暴露root runner',()=>{
 assert.doesNotMatch(workflow,/\[skip ci\]|self-hosted|continue-on-error:\s*true/);
 assert.match(workflow,/^  analyze:/m);assert.match(workflow,/^  lint:/m);
});
