import { describe, expect, it, vi } from 'vitest';
import { getOrCreateParticipantId, type ParticipantIdStorage } from './participant-id';

function createMemoryStorage(initial: Record<string, string> = {}): ParticipantIdStorage {
    const values = new Map(Object.entries(initial));

    return {
        get: (key: string) => values.get(key) ?? null,
        set: (key: string, value: string) => {
            values.set(key, value);
        },
    };
}

describe('participant id generation', () => {
    it('keeps student ids session-scoped and stable within a browser', () => {
        const storage = createMemoryStorage();
        const randomId = vi.fn()
            .mockReturnValueOnce('student-alpha')
            .mockReturnValueOnce('student-beta');

        const first = getOrCreateParticipantId('student', 'session-1', storage, randomId);
        const second = getOrCreateParticipantId('student', 'session-1', storage, randomId);
        const third = getOrCreateParticipantId('student', 'session-2', storage, randomId);

        expect(first).toBe('student-alpha');
        expect(second).toBe('student-alpha');
        expect(third).toBe('student-beta');
        expect(randomId).toHaveBeenCalledTimes(2);
    });

    it('keeps staff ids shared across sessions in the same browser', () => {
        const storage = createMemoryStorage();
        const randomId = vi.fn().mockReturnValue('staff-uuid');

        const first = getOrCreateParticipantId('staff', 'session-1', storage, randomId);
        const second = getOrCreateParticipantId('staff', 'session-2', storage, randomId);

        expect(first).toBe('staff-uuid');
        expect(second).toBe('staff-uuid');
        expect(randomId).toHaveBeenCalledTimes(1);
    });

    it('generates unique student ids for 100 independent browsers on the same network', () => {
        const ids = new Set<string>();

        for (let i = 0; i < 100; i += 1) {
            const storage = createMemoryStorage();
            const expectedId = `student-${String(i).padStart(3, '0')}`;

            const participantId = getOrCreateParticipantId(
                'student',
                'session-classroom',
                storage,
                () => expectedId
            );

            expect(participantId).toBe(expectedId);
            ids.add(participantId);
        }

        expect(ids.size).toBe(100);
    });

    it('regenerates when stored participant ids are blank or whitespace', () => {
        const storage = createMemoryStorage({
            studentParticipantId_session1: '   ',
            participantId: '\n\t',
        });
        const randomId = vi.fn()
            .mockReturnValueOnce('student-recovered')
            .mockReturnValueOnce('staff-recovered');

        const studentId = getOrCreateParticipantId('student', 'session1', storage, randomId);
        const staffId = getOrCreateParticipantId('staff', 'session1', storage, randomId);

        expect(studentId).toBe('student-recovered');
        expect(staffId).toBe('staff-recovered');
        expect(randomId).toHaveBeenCalledTimes(2);
    });

    it('prefers the session-scoped student id without disturbing a legacy generic id', () => {
        const storage = createMemoryStorage({
            participantId: 'legacy-participant',
            studentParticipantId_session1: 'student-session-id',
        });
        const randomId = vi.fn();

        const studentId = getOrCreateParticipantId('student', 'session1', storage, randomId);

        expect(studentId).toBe('student-session-id');
        expect(storage.get('participantId')).toBe('legacy-participant');
        expect(storage.get('studentParticipantId_session1')).toBe('student-session-id');
        expect(randomId).not.toHaveBeenCalled();
    });
});
