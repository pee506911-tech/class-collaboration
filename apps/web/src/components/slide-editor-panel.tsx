import { Slide } from 'shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { X, Plus, GripVertical, Trash2, Settings, Type, List, Clock, Trophy } from 'lucide-react';
import { DragDropContext, Droppable, Draggable, DropResult } from '@hello-pangea/dnd';
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useState, useEffect } from 'react';

interface SlideEditorPanelProps {
    slide: Slide;
    onUpdate: (content: any) => void;
    onSave: () => void;
}

export function SlideEditorPanel({ slide, onUpdate, onSave }: SlideEditorPanelProps) {
    const content = slide.content;
    const [localQuestion, setLocalQuestion] = useState(content.question || content.title || '');

    useEffect(() => {
        setLocalQuestion(content.question || content.title || '');
    }, [content.question, content.title]);

    const updateField = (field: string, value: any) => {
        onUpdate({ ...content, [field]: value });
    };

    const handleOptionChange = (id: string, text: string) => {
        const newOptions = content.options.map((o: any) =>
            o.id === id ? { ...o, text } : o
        );
        updateField('options', newOptions);
    };

    const addOption = () => {
        const newOption = { id: Math.random().toString(36).substr(2, 9), text: `Option ${content.options.length + 1}` };
        if (slide.type === 'quiz') {
            (newOption as any).isCorrect = false;
        }
        updateField('options', [...(content.options || []), newOption]);
    };

    const removeOption = (id: string) => {
        updateField('options', content.options.filter((o: any) => o.id !== id));
    };

    const onDragEnd = (result: DropResult) => {
        if (!result.destination) return;
        const items = Array.from(content.options || []);
        const [reorderedItem] = items.splice(result.source.index, 1);
        items.splice(result.destination.index, 0, reorderedItem);
        updateField('options', items);
    };

    return (
        <div className="h-full flex flex-col bg-slate-50">
            <div className="p-4 border-b bg-white">
                <h2 className="font-semibold text-lg flex items-center gap-2">
                    {slide.type === 'poll' && <List className="w-5 h-5 text-blue-500" />}
                    {slide.type === 'quiz' && <Trophy className="w-5 h-5 text-yellow-500" />}
                    {slide.type === 'static' && <Type className="w-5 h-5 text-slate-500" />}
                    Edit Slide
                </h2>
            </div>

            <Tabs defaultValue="content" className="flex-1 flex flex-col overflow-hidden">
                <div className="px-4 pt-2 bg-white border-b">
                    <TabsList className="w-full justify-start h-9 bg-transparent p-0">
                        <TabsTrigger value="content" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 data-[state=active]:shadow-none rounded-none px-4 pb-2">Content</TabsTrigger>
                        <TabsTrigger value="settings" className="data-[state=active]:border-b-2 data-[state=active]:border-blue-600 data-[state=active]:shadow-none rounded-none px-4 pb-2">Settings</TabsTrigger>
                    </TabsList>
                </div>

                <div className="flex-1 overflow-y-auto p-4 custom-scrollbar">
                    <TabsContent value="content" className="space-y-6 mt-0">
                        <div className="space-y-3">
                            <label className="text-sm font-medium text-slate-700">
                                {slide.type === 'static' ? 'Title' : 'Question'}
                            </label>
                            <Input
                                value={localQuestion}
                                onChange={(e) => setLocalQuestion(e.target.value)}
                                onBlur={() => updateField(content.question !== undefined ? 'question' : 'title', localQuestion)}
                                placeholder="Enter your question or title"
                                className="text-lg font-medium px-4 py-3 h-auto"
                            />
                        </div>

                        {slide.type === 'static' && (
                            <div className="space-y-3">
                                <label className="text-sm font-medium text-slate-700">Body Content</label>
                                <textarea
                                    value={content.body || ''}
                                    onChange={(e) => updateField('body', e.target.value)}
                                    placeholder="Enter slide content (Markdown supported)"
                                    className="w-full min-h-[300px] p-4 border rounded-lg text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                                />
                            </div>
                        )}

                        {(slide.type === 'poll' || slide.type === 'multiple-choice' || slide.type === 'quiz') && (
                            <div className="space-y-4">
                                <div className="flex justify-between items-center">
                                    <label className="text-sm font-medium text-slate-700">Answer Options</label>
                                    <span className="text-xs text-slate-400">{content.options?.length || 0} options</span>
                                </div>

                                <DragDropContext onDragEnd={onDragEnd}>
                                    <Droppable droppableId="options">
                                        {(provided) => (
                                            <div {...provided.droppableProps} ref={provided.innerRef} className="space-y-2">
                                                {(content.options || []).map((option: any, index: number) => (
                                                    <Draggable key={option.id} draggableId={option.id} index={index}>
                                                        {(provided, snapshot) => (
                                                            <div
                                                                ref={provided.innerRef}
                                                                {...provided.draggableProps}
                                                                className={`flex items-center gap-2 bg-white p-2 rounded-lg border group transition-all ${snapshot.isDragging ? 'shadow-lg ring-2 ring-blue-500 z-50' : 'hover:border-blue-300'}`}
                                                            >
                                                                <div {...provided.dragHandleProps} className="text-slate-300 cursor-grab hover:text-slate-600 p-1">
                                                                    <GripVertical className="w-4 h-4" />
                                                                </div>
                                                                <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${option.isCorrect ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'}`}>
                                                                    {String.fromCharCode(65 + index)}
                                                                </div>
                                                                <Input
                                                                    value={option.text}
                                                                    onChange={(e) => handleOptionChange(option.id, e.target.value)}
                                                                    className="flex-1 border-0 focus-visible:ring-0 px-2 h-8"
                                                                    placeholder={`Option ${index + 1}`}
                                                                />
                                                                {slide.type === 'quiz' && (
                                                                    <Button
                                                                        variant="ghost"
                                                                        size="sm"
                                                                        onClick={() => {
                                                                            const newOptions = content.options.map((o: any) => ({
                                                                                ...o,
                                                                                isCorrect: o.id === option.id
                                                                            }));
                                                                            updateField('options', newOptions);
                                                                        }}
                                                                        className={`h-7 px-2 text-xs ${option.isCorrect ? "bg-green-100 text-green-700 hover:bg-green-200" : "text-slate-400 hover:text-slate-600"}`}
                                                                    >
                                                                        {option.isCorrect ? "Correct Answer" : "Mark Correct"}
                                                                    </Button>
                                                                )}
                                                                <Button variant="ghost" size="icon" onClick={() => removeOption(option.id)} className="h-7 w-7 text-slate-300 hover:text-red-500 hover:bg-red-50">
                                                                    <Trash2 className="w-4 h-4" />
                                                                </Button>
                                                            </div>
                                                        )}
                                                    </Draggable>
                                                ))}
                                                {provided.placeholder}
                                            </div>
                                        )}
                                    </Droppable>
                                </DragDropContext>

                                <Button variant="outline" onClick={addOption} className="w-full border-dashed text-slate-500 hover:text-blue-600 hover:border-blue-400 hover:bg-blue-50">
                                    <Plus className="w-4 h-4 mr-2" /> Add Option
                                </Button>
                            </div>
                        )}
                    </TabsContent>

                    <TabsContent value="settings" className="space-y-6 mt-0">
                        {slide.type === 'quiz' && (
                            <div className="space-y-4 bg-white p-4 rounded-lg border">
                                <h3 className="font-medium flex items-center gap-2 text-slate-800">
                                    <Clock className="w-4 h-4" /> Timer & Points
                                </h3>
                                <div className="grid grid-cols-2 gap-4">
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium text-slate-500">Duration (seconds)</label>
                                        <Input
                                            type="number"
                                            value={content.timerDuration || 30}
                                            onChange={(e) => updateField('timerDuration', parseInt(e.target.value))}
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-xs font-medium text-slate-500">Points</label>
                                        <Input
                                            type="number"
                                            value={content.points || 1000}
                                            onChange={(e) => updateField('points', parseInt(e.target.value))}
                                        />
                                    </div>
                                </div>
                            </div>
                        )}

                        {(slide.type === 'poll' || slide.type === 'multiple-choice' || slide.type === 'quiz') && (
                            <div className="space-y-4 bg-white p-4 rounded-lg border">
                                <h3 className="font-medium flex items-center gap-2 text-slate-800">
                                    <Settings className="w-4 h-4" /> Configuration
                                </h3>

                                {slide.type === 'poll' && (
                                    <div className="space-y-3 pb-4 border-b border-slate-100">
                                        <label className="text-sm text-slate-600">Chart Visualization</label>
                                        <div className="flex gap-2">
                                            <Button
                                                variant={content.chartType === 'bar' ? 'default' : 'outline'}
                                                onClick={() => updateField('chartType', 'bar')}
                                                size="sm"
                                                className="flex-1"
                                            >
                                                Bar Chart
                                            </Button>
                                            <Button
                                                variant={content.chartType === 'pie' ? 'default' : 'outline'}
                                                onClick={() => updateField('chartType', 'pie')}
                                                size="sm"
                                                className="flex-1"
                                            >
                                                Pie Chart
                                            </Button>
                                        </div>
                                    </div>
                                )}

                                <div className="space-y-3">
                                    {slide.type === 'multiple-choice' && (
                                        <div className="flex items-center justify-between">
                                            <div className="space-y-0.5">
                                                <label className="text-sm font-medium text-slate-700">Allow Multiple Selection</label>
                                                <p className="text-xs text-slate-500">Students can select more than one option.</p>
                                            </div>
                                            <input
                                                type="checkbox"
                                                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                                checked={content.allowMultipleSelection || false}
                                                onChange={(e) => updateField('allowMultipleSelection', e.target.checked)}
                                            />
                                        </div>
                                    )}

                                    <div className="flex items-center justify-between">
                                        <div className="space-y-0.5">
                                            <label className="text-sm font-medium text-slate-700">Limit to One Submission</label>
                                            <p className="text-xs text-slate-500">Prevent students from changing their answer.</p>
                                        </div>
                                        <input
                                            type="checkbox"
                                            className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                            checked={content.limitSubmissions !== false}
                                            onChange={(e) => updateField('limitSubmissions', e.target.checked)}
                                        />
                                    </div>
                                </div>
                            </div>
                        )}
                    </TabsContent>
                </div>
            </Tabs>

            <div className="p-4 border-t bg-white">
                <Button onClick={onSave} className="w-full bg-slate-900 hover:bg-slate-800">Save Changes</Button>
            </div>
        </div>
    );
}
