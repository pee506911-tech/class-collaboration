import { useCallback, useMemo, useRef } from 'react';

import { Input } from '@/components/ui/input';
import { Settings } from 'lucide-react';
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
    const allowMultipleSelection = content.allowMultipleSelection || false;
    const limitSubmissions = content.limitSubmissions !== false;
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
        <div className="space-y-6">
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

            <div className="space-y-4 bg-white p-4 rounded-lg border">
                <h3 className="font-medium flex items-center gap-2 text-slate-800">
                    <Settings className="w-4 h-4" /> Configuration
                </h3>

                <div className="space-y-3">
                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <label className="text-sm font-medium text-slate-700">Allow Multiple Selection</label>
                            <p className="text-xs text-slate-500">Students can select more than one option.</p>
                        </div>
                        <input
                            type="checkbox"
                            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            disabled={disabled}
                            checked={allowMultipleSelection}
                            onChange={(e) => onChange({ ...content, allowMultipleSelection: e.target.checked })}
                        />
                    </div>

                    <div className="flex items-center justify-between">
                        <div className="space-y-0.5">
                            <label className="text-sm font-medium text-slate-700">Limit to One Submission</label>
                            <p className="text-xs text-slate-500">Prevent students from changing their answer.</p>
                        </div>
                        <input
                            type="checkbox"
                            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            disabled={disabled}
                            checked={limitSubmissions}
                            onChange={(e) => onChange({ ...content, limitSubmissions: e.target.checked })}
                        />
                    </div>
                </div>
            </div>
        </div>
    );
}
