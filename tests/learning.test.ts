import test from 'node:test';
import assert from 'node:assert/strict';
import { learningInput, validateLearning } from '../server/learning.ts';
import type { ExecutionInput } from '../shared/types.ts';
import { validateLearningReviews } from '../shared/learning.ts';
const input={run:{id:'run',prompt:'request'},memories:[],skills:[]} as unknown as ExecutionInput;
const task={result:'observed result',artifacts:[{name:'proof',content:'actual artifact',mediaType:'text/plain'}],memories:[],skills:[]};
const empty={reason:'No reusable evidence.',evidence:[],memories:[],skills:[],inputTokens:3,outputTokens:1};
test('learning sources retain result and artifacts under long steering and bind full content',()=>{
  const frozen=learningInput({...input,run:{...input.run,prompt:'x'.repeat(12_000)}},task,Array(10).fill('a'.repeat(12_000)));
  assert.ok(frozen.sources.some(s=>s.id==='result'&&s.text==='observed result'));
  assert.ok(frozen.sources.some(s=>s.id==='artifact:0'&&s.text==='actual artifact'));
  assert.ok(frozen.sources.reduce((n,s)=>n+s.text.length,0)<=64_000);
  assert.notEqual(learningInput(input,task,['a']).inputHash,learningInput(input,task,['b']).inputHash);
});
test('empty review requires a reason; absent or fabricated evidence cannot publish proposals',()=>{
  const frozen=learningInput(input,task,[]);
  assert.equal(validateLearning(empty,frozen).review.status,'reviewed');
  assert.throws(()=>validateLearning({...empty,reason:' '},frozen));
  const memory={kind:'fact',title:'fact',content:'value',evidence:[]};
  assert.throws(()=>validateLearning({...empty,memories:[memory]},frozen));
  assert.throws(()=>validateLearning({...empty,memories:[{...memory,evidence:[{sourceId:'missing',quote:'value'}]}]},frozen));
});
test('full memory fingerprints deduplicate long content outside the displayed first fifty',()=>{
  const memory={kind:'procedure' as const,title:'same',content:'b'.repeat(4000)};
  const memories=Array.from({length:51},(_,i)=>({...memory,title:'other '+i})).concat([memory]) as ExecutionInput['memories'];
  const frozen=learningInput({...input,memories},task,[]);
  const output={...empty,memories:[{...memory,evidence:[{sourceId:'result',quote:'observed result'}]}]};
  const reviewed=validateLearning(output,frozen);assert.equal(reviewed.memories.length,0);assert.equal(reviewed.review.memoryCount,0);
});
test('conflicting duplicate names are rejected before persistence',()=>{
  const memory={kind:'procedure',title:'same',content:'content',evidence:[{sourceId:'result',quote:'observed result'}]};
  assert.throws(()=>validateLearning({...empty,memories:[memory,{...memory,content:'different'}]},learningInput(input,task,[])));
});
test('restored legacy states allow absent review but malformed run or checkpoint records are rejected',()=>{
  assert.doesNotThrow(()=>validateLearningReviews({runs:[{}],executionStates:{run:{}}}));
  assert.throws(()=>validateLearningReviews({runs:[{learningReview:{status:'reviewed',reason:'claimed'}}],executionStates:{}}));
  assert.throws(()=>validateLearningReviews({runs:[],executionStates:{run:{checkpoint:{previousResult:{learningReview:{evidence:'malformed'}}}}}}));
});
