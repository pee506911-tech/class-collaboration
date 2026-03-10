import { StateUpdatePayload } from 'shared';

export function shouldApplyStateUpdate(
    currentState: StateUpdatePayload | null,
    incomingState: StateUpdatePayload
): boolean {
    const currentVersion = currentState?.stateVersion;
    const incomingVersion = incomingState.stateVersion;

    if (typeof currentVersion === 'number' && typeof incomingVersion === 'number') {
        return incomingVersion > currentVersion;
    }

    return true;
}
