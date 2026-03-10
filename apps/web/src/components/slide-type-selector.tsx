'use client';

import { Layout, BarChart2, HelpCircle, CheckSquare } from 'lucide-react';

interface SlideTypeSelectorProps {
    onSelect: (type: string) => void;
    disabled?: boolean;
}

export function SlideTypeSelector({ onSelect, disabled = false }: SlideTypeSelectorProps) {
    const types = [
        { id: 'static', label: 'Static Slide', icon: Layout, description: 'Text, images, and basic content' },
        { id: 'multiple-choice', label: 'Multiple Choice', icon: CheckSquare, description: 'Collect opinions or check knowledge' },
        { id: 'poll', label: 'Live Poll', icon: BarChart2, description: 'Real-time voting and graphs' },
        { id: 'quiz', label: 'Quiz Question', icon: HelpCircle, description: 'Timed questions with points' },
        { id: 'qa', label: 'Q&A Session', icon: HelpCircle, description: 'Let students ask and upvote questions' },
        { id: 'leaderboard', label: 'Leaderboard', icon: BarChart2, description: 'Show top scoring students' },
    ];

    return (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {types.map((type, index) => (
                <div
                    key={type.id}
                    className={`group relative overflow-hidden rounded-xl border border-slate-200 bg-white p-6 transition-all duration-300 animate-scale-in ${
                        disabled
                            ? 'cursor-not-allowed opacity-60'
                            : 'cursor-pointer hover:-translate-y-1 hover:shadow-xl hover:shadow-blue-100 hover:border-blue-300'
                    }`}
                    onClick={() => {
                        if (!disabled) onSelect(type.id);
                    }}
                    style={{ animationDelay: `${index * 75}ms` }}
                >
                    <div className="absolute inset-0 bg-gradient-to-br from-blue-50 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
                    <div className="relative z-10 flex flex-col items-center text-center space-y-4">
                        <div className="p-4 bg-slate-50 rounded-2xl group-hover:bg-white group-hover:shadow-md transition-all duration-300 ring-1 ring-slate-100 group-hover:ring-blue-200">
                            <type.icon className="w-8 h-8 text-slate-600 group-hover:text-blue-600 group-hover:scale-110 transition-all" />
                        </div>
                        <div>
                            <h3 className="font-bold text-slate-900 group-hover:text-blue-700 transition-colors">{type.label}</h3>
                            <p className="text-xs text-slate-500 mt-1 leading-relaxed">{type.description}</p>
                        </div>
                    </div>
                </div>
            ))}
        </div>
    );
}
