import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Settings } from 'lucide-react';

interface PollSlideEditorProps {
    content: {
        question?: string;
        options?: Array<{ id: string; text: string }>;
        chartType?: 'bar' | 'pie';
        limitSubmissions?: boolean;
    };
    onChange: (content: any) => void;
    disabled: boolean;
}

export function PollSlideEditor({ content, onChange, disabled }: PollSlideEditorProps) {
    const question = content.question || '';
    const chartType = content.chartType || 'bar';
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
                    <Settings className="w-4 h-4" /> Configuration
                </h3>

                <div className="space-y-3 pb-4 border-b border-slate-100">
                    <label className="text-sm text-slate-600">Chart Visualization</label>
                    <div className="flex gap-2">
                        <Button
                            variant={chartType === 'bar' ? 'default' : 'outline'}
                            disabled={disabled}
                            onClick={() => onChange({ ...content, chartType: 'bar' })}
                            size="sm"
                            className="flex-1"
                        >
                            Bar Chart
                        </Button>
                        <Button
                            variant={chartType === 'pie' ? 'default' : 'outline'}
                            disabled={disabled}
                            onClick={() => onChange({ ...content, chartType: 'pie' })}
                            size="sm"
                            className="flex-1"
                        >
                            Pie Chart
                        </Button>
                    </div>
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
    );
}
