import { describe, expect, it } from 'vitest';
import { TutorRequests } from '../src/tutorRequests';
import { FakeTransport, waitFor } from './fakes';

describe('tutor_request -> tutor_result', () => {
  it('answers each pending request once; errors become ok=false results', async () => {
    const t = new FakeTransport();
    const tr = new TutorRequests(t, { shear_feedback: async p => ({ reply: `ok ${(p as { n: number }).n}` }) }, () => {});
    const row = { id: 1n, sessionId: 1n, kind: 'shear_feedback', payload: '{"n":2}', status: 'pending' };
    tr.onRequest(row);
    tr.onRequest(row);
    tr.onRequest({ ...row, id: 2n, kind: 'unknown' });
    tr.onRequest({ ...row, id: 3n, status: 'done' });
    await waitFor(() => t.of('submitTutorResult').length === 2);
    expect([...t.of('submitTutorResult')].sort((a, b) => Number(a.requestId) - Number(b.requestId))).toEqual([
      { requestId: 1n, ok: true, result: '{"reply":"ok 2"}' },
      { requestId: 2n, ok: false, result: 'unsupported tutor request unknown' },
    ]);
  });
});
