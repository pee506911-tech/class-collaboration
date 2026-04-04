import { useCallback, useEffect, useRef } from 'react';

function areFieldValuesEqual<T extends Record<string, unknown>>(left: T, right: T) {
    const leftKeys = Object.keys(left) as Array<keyof T>;
    const rightKeys = Object.keys(right) as Array<keyof T>;

    if (leftKeys.length !== rightKeys.length) {
        return false;
    }

    return leftKeys.every((key) => Object.is(left[key], right[key]));
}

interface BufferedSlideContentOptions<T extends Record<string, unknown>> {
    content: T;
    onChange: (content: T) => void;
    onBlur?: () => void;
    readCurrentContent: () => T;
    syncInputs: (content: T) => void;
    idleMs?: number;
}

export function useBufferedSlideContent<T extends Record<string, unknown>>({
    content,
    onChange,
    onBlur,
    readCurrentContent,
    syncInputs,
    idleMs = 2000,
}: BufferedSlideContentOptions<T>) {
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastEmittedRef = useRef(content);

    const clearPendingCapture = useCallback(() => {
        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
    }, []);

    const emitChange = useCallback(() => {
        const nextContent = readCurrentContent();

        if (areFieldValuesEqual(lastEmittedRef.current, nextContent)) {
            return nextContent;
        }

        lastEmittedRef.current = nextContent;
        onChange(nextContent);
        return nextContent;
    }, [onChange, readCurrentContent]);

    const scheduleBufferedChange = useCallback(() => {
        clearPendingCapture();
        timerRef.current = setTimeout(() => {
            emitChange();
            timerRef.current = null;
        }, idleMs);
    }, [clearPendingCapture, emitChange, idleMs]);

    const flushBufferedChange = useCallback(() => {
        clearPendingCapture();
        emitChange();
        onBlur?.();
    }, [clearPendingCapture, emitChange, onBlur]);

    useEffect(() => {
        clearPendingCapture();
        lastEmittedRef.current = content;
        syncInputs(content);
    }, [clearPendingCapture, content, syncInputs]);

    useEffect(() => () => {
        clearPendingCapture();
    }, [clearPendingCapture]);

    return {
        scheduleBufferedChange,
        flushBufferedChange,
    };
}
