// Turn photos: the image the learner sent with a turn goes into that turn's planner message only.
import { describe, expect, it } from 'vitest';
import { emptyCanvas } from '@tutor/teaching/presentation/contracts';
import { buildModelRequest, newLessonRecord } from '@tutor/teaching/teaching/lessonFlow';
import { miniLessonText, miniSession } from '../../teaching/test/fixtures';
import { done, FakeLlm, makeAgent, session, turn, waitFor } from './fakes';

const A = 1n;
const PHOTO = 'data:image/jpeg;base64,/9j/AAAA';

describe('turn photo', () => {
  it('adds an image block to the planner request of the turn it was sent with, not the next one', async () => {
    const llm = new FakeLlm([[{ type: 'text', delta: miniLessonText() }, done], [{ type: 'text', delta: miniLessonText() }, done]]);
    const { agent, transport } = makeAgent(llm, undefined, { replyMode: 'lesson' });
    transport.lessonRequest = buildModelRequest(newLessonRecord(miniSession), emptyCanvas(), 'req');
    const asked: number[] = [];
    Object.assign(transport, { getTurnImage: async (a: { sessionId: bigint; turnIdx: number }) => (asked.push(a.turnIdx), a.turnIdx === 0 ? PHOTO : '') });
    agent.onSession(session(A, { voice: false }));
    agent.onTurn({ ...turn(A, 0, 'what about this one?'), source: 'text', hasPhoto: true });
    await waitFor(() => transport.of('appendTutorTurn').length === 1, 3000);

    const system = llm.calls[0]!.messages[0]!;
    expect(system.role).toBe('system');
    expect(JSON.stringify(system.content)).not.toContain('image');
    const user = llm.calls[0]!.messages[1]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(Array.isArray(user)).toBe(true);
    expect(user.find(p => p.type === 'text' && /sent a photo with this turn: look at it/.test(p.text ?? ''))).toBeTruthy();
    expect(user.find(p => p.type === 'image_url')?.image_url?.url).toBe(PHOTO);
    expect(asked).toEqual([0]);

    agent.onTurn({ ...turn(A, 2, 'and next?'), source: 'text' });
    await waitFor(() => llm.calls.length === 2, 3000);
    expect(typeof llm.calls[1]!.messages[1]!.content).toBe('string');
    expect(asked).toEqual([0]);
  });
});
