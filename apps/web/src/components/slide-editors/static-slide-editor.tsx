import { useCallback, useMemo, useRef } from 'react';

import { Input } from '@/components/ui/input';
import { useBufferedSlideContent } from './use-buffered-slide-content';

interface StaticSlideEditorProps {
    content: { title?: string; body?: string };
    onChange: (content: { title: string; body: string }) => void;
    onBlur?: () => void;
    disabled: boolean;
}

export function StaticSlideEditor({ content, onChange, onBlur, disabled }: StaticSlideEditorProps) {
    const title = content.title || '';
    const body = content.body || '';
    const titleRef = useRef<HTMLInputElement | null>(null);
    const bodyRef = useRef<HTMLTextAreaElement | null>(null);

    const readCurrentContent = useCallback(() => ({
        title: titleRef.current?.value ?? '',
        body: bodyRef.current?.value ?? '',
    }), []);

    const syncInputs = useCallback((nextContent: { title?: string; body?: string }) => {
        if (titleRef.current && titleRef.current.value !== (nextContent.title || '')) {
            titleRef.current.value = nextContent.title || '';
        }

        if (bodyRef.current && bodyRef.current.value !== (nextContent.body || '')) {
            bodyRef.current.value = nextContent.body || '';
        }
    }, []);

    const bufferedContent = useMemo(() => ({ title, body }), [body, title]);

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
                <label className="text-sm font-medium text-slate-700">Title</label>
                <Input
                    defaultValue={title}
                    ref={titleRef}
                    disabled={disabled}
                    onChange={scheduleBufferedChange}
                    onBlur={flushBufferedChange}
                    placeholder="Enter your question or title"
                    className="text-lg font-medium px-4 py-3 h-auto"
                />
            </div>

            <div className="space-y-3">
                <label className="text-sm font-medium text-slate-700">Body Content</label>
                <textarea
                    defaultValue={body}
                    ref={bodyRef}
                    disabled={disabled}
                    onChange={scheduleBufferedChange}
                    onBlur={flushBufferedChange}
                    placeholder="Enter slide content (Markdown supported)"
                    className="w-full min-h-[300px] p-4 border rounded-lg text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
            </div>
        </div>
    );
}
