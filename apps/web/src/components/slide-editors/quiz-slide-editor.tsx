import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Clock, Settings } from 'lucide-react';

interface QuizSlideEditorProps {
    content: {
        question?: string;
        options?: Array<{ id: string; text: string; isCorrect: boolean }>;
        points?: number;
        timerDuration?: number;
        limitSubmissions?: boolean;
    };
    onChange: (content: any) => void;
    disabled: boolean;
}

export function QuizSlideEditor({ content, onChange, disabled }: QuizSlideEditorProps) {
    const question = content.question || '';
    const points = content.points || 1000;
    const timerDuration = content.timerDuration || 30;
    const limitSubmissions = content.limitSubmissions !== false;

    return (
        <div className="space-y-6">
            <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">Question</label>
                <Input
                    value={question}
                    disabled={disabled}
                    onChange={(e) => onChange({ ...content, question: e.target.value })}
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
                            value={timerDuration}
                            onChange={(e) => onChange({ ...content, timerDuration: parseInt(e.target.value, 10) })}
                        />
                    </div>
                    <div className="space-y-2">
                        <label className="text-xs font-medium text-slate-500">Points</label>
                        <Input
                            type="number"
                            disabled={disabled}
                            value={points}
                            onChange={(e) => onChange({ ...content, points: parseInt(e.target.value, 10) })}
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
