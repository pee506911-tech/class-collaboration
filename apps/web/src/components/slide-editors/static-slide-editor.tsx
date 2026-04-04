import { Input } from '@/components/ui/input';

interface StaticSlideEditorProps {
    content: { title?: string; body?: string };
    onChange: (content: { title: string; body: string }) => void;
    onBlur?: () => void;
    disabled: boolean;
}

export function StaticSlideEditor({ content, onChange, onBlur, disabled }: StaticSlideEditorProps) {
    const title = content.title || '';
    const body = content.body || '';

    const updateField = (field: 'title' | 'body', value: string) => {
        onChange({ title: field === 'title' ? value : content.title || '', body: field === 'body' ? value : content.body || '' });
    };

    return (
        <div className="space-y-6">
            <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">Title</label>
                <Input
                    value={title}
                    disabled={disabled}
                    onChange={(e) => updateField('title', e.target.value)}
                    onBlur={onBlur}
                    placeholder="Enter your question or title"
                    className="text-lg font-medium px-4 py-3 h-auto"
                />
            </div>

            <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">Body Content</label>
                <textarea
                    value={body}
                    disabled={disabled}
                    onChange={(e) => updateField('body', e.target.value)}
                    onBlur={onBlur}
                    placeholder="Enter slide content (Markdown supported)"
                    className="w-full min-h-[300px] p-4 border rounded-lg text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
            </div>
        </div>
    );
}
