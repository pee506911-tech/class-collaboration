import { useCallback, useMemo, useRef } from 'react';

import { Input } from '@/components/ui/input';
import { useBufferedSlideContent } from './use-buffered-slide-content';

interface MultipleChoiceSlideEditorProps {
    content: {
        question?: string;
        options?: Array<{ id: string; text: string }>;
        allowMultipleSelection?: boolean;
        limitSubmissions?: boolean;
    };
    onChange: (content: MultipleChoiceSlideEditorProps['content']) => void;
    onBlur?: () => void;
    disabled: boolean;
}

export function MultipleChoiceSlideEditor({ content, onChange, onBlur, disabled }: MultipleChoiceSlideEditorProps) {
    const question = content.question || '';
    const questionRef = useRef<HTMLInputElement | null>(null);
    const bufferedContent = useMemo(() => ({ ...content, question }), [content, question]);

    const readCurrentContent = useCallback(() => ({
        ...content,
        question: questionRef.current?.value ?? '',
    }), [content]);

    const syncInputs = useCallback((nextContent: MultipleChoiceSlideEditorProps['content']) => {
        if (questionRef.current && questionRef.current.value !== (nextContent.question || '')) {
            questionRef.current.value = nextContent.question || '';
        }
    }, []);

    const { scheduleBufferedChange, flushBufferedChange } = useBufferedSlideContent({
        content: bufferedContent,
        onChange,
        onBlur,
        readCurrentContent,
        syncInputs,
    });

    return (
        <div className="space-y-3">
            <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">Question</label>
                <Input
                    defaultValue={question}
                    ref={questionRef}
                    disabled={disabled}
                    onChange={scheduleBufferedChange}
                    onBlur={flushBufferedChange}
                    placeholder="Enter your question or title"
                    className="text-lg font-medium px-4 py-3 h-auto"
                />
            </div>
        </div>
    );
}
