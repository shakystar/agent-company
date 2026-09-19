import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { assertContinuationMessage, existingMessage, type ContinuationReceipt } from '../scripts/continue-studio-github.ts';
import { sendConversationSchema, type ConversationMessage } from '../shared/conversations.ts';

const hash = (content: string) => createHash('sha256').update(content).digest('hex');
function fixture(content = '승인된 GitHub 후속 작업입니다.\n\n마지막 브리프 줄입니다.\n') {
  const record: ContinuationReceipt & { status: 'uncertain' } = { content, contentSha256: hash(content), idempotencyKey: randomUUID(), conversationId: randomUUID(),
    agentIds: { research: randomUUID(), design: randomUUID(), development: randomUUID(), quality: randomUUID() }, messageId: null, status: 'uncertain' };
  const payload = sendConversationSchema.parse({ content, mode: 'task', recipientAgentId: record.agentIds.development, idempotencyKey: record.idempotencyKey });
  const message: ConversationMessage = { id: randomUUID(), conversationId: record.conversationId, senderAgentId: null, content: payload.content,
    mode: payload.mode, replyToId: null, sourceRunId: null, idempotencyKey: payload.idempotencyKey,
    deliveries: [{ agentId: record.agentIds.development, runId: null, steeringIndex: null, status: 'pending' }], createdAt: '2026-09-09T00:00:00.000Z' };
  return { record, message, payload };
}

test('a trailing brief newline does not misclassify a successful canonical POST response as uncertain', () => {
  const { record, message, payload } = fixture();
  assert.ok(record.content.endsWith('\n')); assert.notEqual(record.content, payload.content); assert.equal(message.content, payload.content);
  const original = structuredClone(record);
  assertContinuationMessage(message, record);
  assert.deepEqual(record, original, 'Verification must not rewrite raw content, hash, key or status');
});

test('an uncertain receipt recovers the same stored message without changing its raw intent or message key', () => {
  const { record, message } = fixture(); const original = structuredClone(record);
  assert.equal(existingMessage({ conversationMessages: [message] }, record), message);
  assert.deepEqual(record, original); assert.equal(record.status, 'uncertain');
  assert.equal(record.contentSha256, hash(record.content)); assert.equal(record.messageId, null);
});

test('expected normalization is exactly the shared schema trim and preserves internal whitespace and unicode', () => {
  const { record, message } = fixture('\uFEFF \t\n첫째  줄\r\n\r\n둘째\t줄 한글🙂\n \u00a0');
  assert.equal(message.content, '첫째  줄\r\n\r\n둘째\t줄 한글🙂');
  assertContinuationMessage(message, record);
  for (const content of [message.content.replace('  ', ' '), message.content.replace(/\r\n/g, '\n'), `${message.content}\n`, ` ${message.content}`, `${message.content}추가 지시`]) {
    assert.throws(() => assertContinuationMessage({ ...message, content }, record));
  }
});

test('normalization does not weaken identity, recipient, sender, mode or pinned-message checks', () => {
  const { record, message } = fixture();
  const changes: Array<Partial<ConversationMessage>> = [
    { idempotencyKey: randomUUID() }, { conversationId: randomUUID() }, { senderAgentId: record.agentIds.development }, { mode: 'discuss' },
    { deliveries: [] }, { deliveries: [...message.deliveries, { ...message.deliveries[0], agentId: record.agentIds.quality }] },
    { deliveries: [{ ...message.deliveries[0], agentId: record.agentIds.quality }] }, { id: 'not-a-uuid' },
  ];
  for (const change of changes) assert.throws(() => assertContinuationMessage({ ...message, ...change }, record));
  assert.throws(() => assertContinuationMessage(message, { ...record, messageId: randomUUID() }));
  assert.doesNotThrow(() => assertContinuationMessage(message, { ...record, messageId: message.id }));
});

test('raw evidence hash and canonical content bounds remain mandatory', () => {
  const { record, message } = fixture();
  assert.throws(() => assertContinuationMessage(message, { ...record, content: `${record.content}\n` }), /해시/);
  assert.throws(() => assertContinuationMessage(message, { ...record, contentSha256: '0'.repeat(64) }), /해시/);
  for (const content of [' \t\n ', 'x'.repeat(20_001)]) {
    assert.throws(() => assertContinuationMessage(message, { ...record, content, contentSha256: hash(content) }));
  }
});

test('missing or duplicate stored receipts cannot manufacture a successful recovery', () => {
  const { record, message } = fixture();
  assert.equal(existingMessage({ conversationMessages: [] }, record), null);
  assert.equal(existingMessage({ conversationMessages: [{ ...message, idempotencyKey: randomUUID() }] }, record), null);
  assert.throws(() => existingMessage({ conversationMessages: [message, { ...message, id: randomUUID() }] }, record), /중복/);
  assert.throws(() => existingMessage({ conversationMessages: [{ ...message, content: `${message.content} 변경` }] }, record));
});
