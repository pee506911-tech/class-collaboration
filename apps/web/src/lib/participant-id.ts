export type ParticipantRole = 'staff' | 'student' | 'projector';

export interface ParticipantIdStorage {
    get: (key: string) => string | null;
    set: (key: string, value: string) => void;
}

export function generateParticipantId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }

    return (
        Math.random().toString(36).substring(2, 15) +
        Math.random().toString(36).substring(2, 15)
    );
}

function normalizeStudentParticipantId(participantId: string): string {
    return participantId.substring(0, 36);
}

function normalizeStoredParticipantId(participantId: string | null): string | null {
    if (!participantId) return null;

    const trimmed = participantId.trim();
    if (!trimmed) return null;

    return trimmed;
}

export function getOrCreateParticipantId(
    role: ParticipantRole,
    sessionId: string,
    storage: ParticipantIdStorage,
    randomId: () => string = generateParticipantId
): string {
    if (role === 'student') {
        const studentKey = `studentParticipantId_${sessionId}`;
        const existingStudentId = normalizeStoredParticipantId(storage.get(studentKey));

        if (existingStudentId) {
            return normalizeStudentParticipantId(existingStudentId);
        }

        const studentId = normalizeStudentParticipantId(randomId());
        storage.set(studentKey, studentId);
        return studentId;
    }

    const existingParticipantId = normalizeStoredParticipantId(storage.get('participantId'));
    if (existingParticipantId) {
        return existingParticipantId;
    }

    const participantId = randomId();
    storage.set('participantId', participantId);
    return participantId;
}
