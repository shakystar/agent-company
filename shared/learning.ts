import { z } from 'zod';

export const learningEvidenceSchema = z.object({ sourceId: z.string().min(1).max(120), quote: z.string().trim().min(1).max(2000) }).strict();
export const learningReviewSchema = z.object({
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  status: z.enum(['reviewed', 'deferred']), reason: z.string().trim().min(1).max(4000),
  evidence: z.array(learningEvidenceSchema).max(30),
  memoryCount: z.number().int().min(0).max(30), skillCount: z.number().int().min(0).max(10),
  completedAt: z.iso.datetime(),
}).strict();
export type LearningReview = z.infer<typeof learningReviewSchema>;

export function validateLearningReviews(state: { runs: Array<{learningReview?: unknown}>;
  executionStates: Record<string,{previousResult?:{learningReview?:unknown};checkpoint?:{previousResult?:{learningReview?:unknown}}}> }) {
  const values=[...state.runs.map(run=>run.learningReview),...Object.values(state.executionStates).flatMap(ex=>[ex.previousResult?.learningReview,ex.checkpoint?.previousResult?.learningReview])];
  for(const value of values)if(value!==undefined)learningReviewSchema.parse(value);
}
