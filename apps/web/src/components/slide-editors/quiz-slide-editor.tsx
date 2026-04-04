import { useCallback, useMemo, useRef } from 'react';

import { Input } from '@/components/ui/input';
import { Clock, Settings } from 'lucide-react';
import { useBufferedSlideContent } from './use-buffered-slide-content';

interface QuizSlideEditorProps {
    content: {
        question?: string;
        options?: Array<{ id: string; text: string; isCorrect: boolean }>;
        points?: number;
        timerDuration?: number;
        limitSubmissions?: boolean;
    };
    onChange: (content: QuizSlideEditorProps['content']) => void;
    onBlur?: () => void;
    disabled: boolean;
}

export function QuizSlideEditor({ content, onChange, onBlur, disabled }: QuizSlideEditorProps) {
    const question = content.question || '';
    const points = content.points || 1000;
    const timerDuration = content.timerDuration || 30;
    const limitSubmissions = content.limitSubmissions !== false;
    const questionRef = useRef<HTMLInputElement | null>(null);
    const timerDurationRef = useRef<HTMLInputElement | null>(null);
    const pointsRef = useRef<HTMLInputElement | null>(null);
    const bufferedContent = useMemo(
        () => ({ ...content, question, points, timerDuration }),
        [content, points, question, timerDuration],
    );

    const parseNumber = useCallback((value: string | undefined, fallback: number) => {
        const parsed = Number.parseInt(value || '', 10);
        return Number.isNaN(parsed) ? fallback : parsed;
    }, []);

    const readCurrentContent = useCallback(() => ({
        ...content,
        question: questionRef.current?.value ?? '',
        timerDuration: parseNumber(timerDurationRef.current?.value, timerDuration),
        points: parseNumber(pointsRef.current?.value, points),
    }), [content, parseNumber, points, timerDuration]);

    const syncInputs = useCallback((nextContent: QuizSlideEditorProps['content']) => {
        if (questionRef.current && questionRef.current.value !== (nextContent.question || '')) {
            questionRef.current.value = nextContent.question || '';
        }

        const nextTimerDuration = String(nextContent.timerDuration || 30);
        if (timerDurationRef.current && timerDurationRef.current.value !== nextTimerDuration) {
            timerDurationRef.current.value = nextTimerDuration;
        }

        const nextPoints = String(nextContent.points || 1000);
        if (pointsRef.current && pointsRef.current.value !== nextPoints) {
            pointsRef.current.value = nextPoints;
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
                    <Clock className="w-4 h-4" /> Timer & Points
                </h3>
                <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-500">Duration (seconds)</label>
                        <Input
                            type="number"
                            disabled={disabled}
                            defaultValue={timerDuration}
                            ref={timerDurationRef}
                            onChange={scheduleBufferedChange}
                            onBlur={flushBufferedChange}
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-500">Points</label>
                        <Input
                            type="number"
                            disabled={disabled}
                            defaultValue={points}
                            ref={pointsRef}
                            onChange={scheduleBufferedChange}
                            onBlur={flushBufferedChange}
                        />
                    </div>
                </div>
            </div>

            <div className="space-y-4 bg-white p-4 rounded-lg border">
                <h3 className="font-medium flex items-center gap-2 text-slate-800">
                    <Settings className="w-4 h-4" /> Configuration
                </h3>
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
    );
}
