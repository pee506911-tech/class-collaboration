import { useState, useEffect } from 'react';
import { useWebSocket } from '@/lib/websocket';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Pencil, Check, X, ThumbsUp, MessageSquare } from 'lucide-react';
import { EmptyState } from '@/components/ui/loading';
import { Slide } from 'shared';

interface Question {
    id: string;
    content: string;
    upvotes: number;
    isApproved: boolean;
    createdAt: string;
}

export function QAManager({ onClose, slides = [] }: { onClose: () => void, slides?: Slide[] }) {
    const { questions: allQuestions, sendMessage } = useWebSocket();
    const [editingId, setEditingId] = useState<string | null>(null);
    const [editContent, setEditContent] = useState('');

    const questions = (allQuestions || []) as (Question & { slideId?: string })[];

    const handleEdit = (q: Question) => {
        setEditingId(q.id);
        setEditContent(q.content);
    };

    const handleSave = (id: string) => {
        sendMessage('EDIT_QUESTION', { questionId: id, content: editContent });
        setEditingId(null);
    };

    const handleCancel = () => {
        setEditingId(null);
        setEditContent('');
    };

    return (
        <Card className="w-full h-full flex flex-col shadow-2xl border-slate-200 animate-scale-in">
            <CardHeader className="flex flex-row items-center justify-between py-5 px-6 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-white">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center">
                        <MessageSquare className="w-5 h-5 text-blue-600" />
                    </div>
                    <div>
                        <CardTitle className="text-xl">Q&A Management</CardTitle>
                        <p className="text-sm text-slate-500 mt-0.5">{questions.length} {questions.length === 1 ? 'question' : 'questions'}</p>
                    </div>
                </div>
                <Button variant="ghost" size="icon" onClick={onClose} className="hover:bg-slate-100">
                    <X className="w-5 h-5" />
                </Button>
            </CardHeader>
            <CardContent className="flex-1 overflow-y-auto p-6 custom-scrollbar">
                {questions.length === 0 ? (
                    <EmptyState
                        icon={<MessageSquare className="w-16 h-16 text-slate-300" />}
                        title="No questions yet"
                        description="Questions from students will appear here. They can ask questions globally or on specific slides."
                    />
                ) : (
                    <div className="space-y-3">
                        {questions.map((q, index) => {
                            const slide = slides.find(s => s.id === q.slideId);
                            const slideIndex = slides.findIndex(s => s.id === q.slideId);
                            const slideLabel = slide ? `Slide ${slideIndex + 1}: ${slide.content.title || slide.content.question || 'Untitled'}` : 'Slide-Specific';

                            return (
                                <div
                                    key={q.id}
                                    className="p-4 border border-slate-200 rounded-xl bg-white hover:shadow-md hover:border-slate-300 transition-all duration-200 animate-slide-up"
                                    style={{ animationDelay: `${index * 50}ms` }}
                                >
                                    {editingId === q.id ? (
                                        <div className="space-y-3">
                                            <Input
                                                value={editContent}
                                                onChange={(e) => setEditContent(e.target.value)}
                                                autoFocus
                                                className="text-base"
                                                placeholder="Edit question..."
                                            />
                                            <div className="flex justify-end gap-2">
                                                <Button size="sm" variant="outline" onClick={handleCancel}>
                                                    Cancel
                                                </Button>
                                                <Button size="sm" onClick={() => handleSave(q.id)}>
                                                    <Check className="w-4 h-4 mr-1" />
                                                    Save
                                                </Button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="flex justify-between items-start gap-4">
                                            <div className="flex-1 min-w-0">
                                                <div className="flex items-center gap-2 mb-2">
                                                    {q.slideId ? (
                                                        <span className="px-2.5 py-1 rounded-lg bg-blue-50 text-blue-700 text-xs font-semibold border border-blue-100 max-w-[300px] truncate block" title={slideLabel}>
                                                            {slideLabel}
                                                        </span>
                                                    ) : (
                                                        <span className="px-2.5 py-1 rounded-lg bg-purple-50 text-purple-700 text-xs font-semibold border border-purple-100">
                                                            Global
                                                        </span>
                                                    )}
                                                </div>
                                                <p className="text-base text-slate-900 font-medium leading-relaxed break-words">{q.content}</p>
                                                <div className="flex items-center gap-4 mt-3 text-sm text-slate-500">
                                                    <span className="flex items-center gap-1.5 font-medium">
                                                        <ThumbsUp className="w-3.5 h-3.5 text-amber-500" />
                                                        <span className="text-slate-700">{q.upvotes}</span>
                                                    </span>
                                                    <span className="w-1 h-1 rounded-full bg-slate-300" />
                                                    <span>{new Date(q.createdAt).toLocaleTimeString()}</span>
                                                </div>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                onClick={() => handleEdit(q)}
                                                className="flex-shrink-0 hover:bg-blue-50 hover:text-blue-600"
                                            >
                                                <Pencil className="w-4 h-4" />
                                            </Button>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </CardContent>
        </Card>
    );
}
