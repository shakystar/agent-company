import { createHash } from 'node:crypto';
import { z } from 'zod';
import { learningEvidenceSchema, type LearningReview } from '../shared/learning.ts';
import { growthReplayProposalSchema } from '../shared/growth.ts';
import type { ExecutionInput, ExecutionResult } from '../shared/types.ts';

const evidence = z.array(learningEvidenceSchema).min(1).max(5);
export const learningOutputSchema = z.object({
  reason: z.string().trim().min(1).max(4000), evidence: z.array(learningEvidenceSchema).max(30),
  memories: z.array(z.object({kind:z.enum(['fact','preference','procedure']),title:z.string().trim().min(1).max(200),content:z.string().trim().min(1).max(50_000),evidence}).strict()).max(30),
  skills: z.array(z.object({name:z.string().trim().min(1).max(100),description:z.string().max(2000),content:z.string().trim().min(1).max(100_000),replay:growthReplayProposalSchema.nullable(),evidence}).strict()).max(10),
  inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative(),
}).strict();
export interface LearningSource { id: string; text: string }
const memoryHash = (m:{kind:string;title:string;content:string})=>createHash('sha256').update(JSON.stringify([m.kind,m.title,m.content])).digest('hex');
export function learningInput(input: ExecutionInput, task: Pick<ExecutionResult,'result'|'artifacts'|'memories'> & {skills:unknown[]}, steering: string[]) {
  // Bounded copies only. Full content binds the fingerprint even when displayed sources are truncated.
  const source:LearningSource[]=[{id:'result',text:task.result},{id:'request',text:input.run.prompt},
    ...task.artifacts.map((a,i)=>({id:`artifact:${i}`,text:a.content})),...steering.map((text,i)=>({id:`steering:${i}`,text})).reverse()];
  const inputHash=createHash('sha256').update(JSON.stringify({runId:input.run.id,source,memories:input.memories,skills:input.skills,proposals:{memories:task.memories,skills:task.skills}})).digest('hex');
  let remaining=64_000;
  const sources=source.slice(0,40).map(s=>{const text=s.text.slice(0,Math.min(remaining,s.id.startsWith('artifact:')?4000:12_000));remaining-=text.length;return {...s,text};}).filter(s=>s.text.length);
  return {inputHash,sources,existingMemoryHashes:input.memories.map(memoryHash),existingMemories:input.memories.map(({kind,title,content})=>({kind,title,content:content.slice(0,2000)})).slice(0,50),
    existingSkills:input.skills.map(({name,description})=>({name,description})).slice(0,30),
    proposedMemories:task.memories,proposedSkills:task.skills, replay:input.growthReplay??null};
}
export function validateLearning(output:unknown, frozen:ReturnType<typeof learningInput>) {
  const result=learningOutputSchema.parse(output);
  for(const item of [...result.evidence,...result.memories.flatMap(m=>m.evidence),...result.skills.flatMap(s=>s.evidence)]) {
    if(!frozen.sources.some(s=>s.id===item.sourceId&&s.text.includes(item.quote)))throw new Error('학습 제안의 인용 근거가 고정 작업 자료와 일치하지 않습니다.');
  }
  const memories=result.memories.filter(m=>!frozen.existingMemoryHashes.includes(memoryHash(m)));
  if(new Set(memories.map(m=>`${m.kind}:${m.title}`)).size!==memories.length||new Set(result.skills.map(s=>s.name)).size!==result.skills.length)throw new Error('학습 제안에 중복된 기억 또는 스킬 이름이 있습니다.');
  const review:LearningReview={inputHash:frozen.inputHash,status:'reviewed',reason:result.reason,
    evidence:[...result.evidence,...memories.flatMap(m=>m.evidence),...result.skills.flatMap(s=>s.evidence)].filter((v,i,all)=>all.findIndex(a=>a.sourceId===v.sourceId&&a.quote===v.quote)===i).slice(0,30),
    memoryCount:memories.length,skillCount:result.skills.length,completedAt:new Date().toISOString()};
  return {review,memories:memories.map(({evidence:_,...m})=>m),skills:result.skills.map(({evidence:_,...s})=>s),inputTokens:result.inputTokens,outputTokens:result.outputTokens};
}
