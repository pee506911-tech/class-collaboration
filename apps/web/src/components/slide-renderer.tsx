'use client';

import { Slide, PollSlideContent, StaticSlideContent, QuizSlideContent, QASlideContent, MultipleChoiceSlideContent } from 'shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useWebSocket } from '@/lib/websocket';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import confetti from 'canvas-confetti';
import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface SlideProps {
    slide: Slide;
    role: 'staff' | 'student' | 'projector';
    isPreview?: boolean;
}

function StaticSlide({ slide, isPreview }: SlideProps) {
    const content = slide.content as StaticSlideContent;
    return (
        <Card className="w-full h-full flex flex-col justify-center items-center p-8 text-center">
            <h1 className="text-4xl font-bold mb-6">{content.title}</h1>
            <p className="text-xl text-slate-600">{content.body}</p>
        </Card>
    );
}

function PollSlide({ slide, role, isPreview }: SlideProps) {
    const { sendMessage, voteResults } = useWebSocket();
    const content = slide.content as PollSlideContent;
    const [hasSubmitted, setHasSubmitted] = useState(false);
    const [selectedOption, setSelectedOption] = useState<string | null>(null);

    useEffect(() => {
        if (role === 'student' && content.limitSubmissions !== false && !isPreview) {
            const voted = localStorage.getItem(`voted_${slide.id}`);
            const votedOption = localStorage.getItem(`voted_option_${slide.id}`);
            if (voted) {
                setHasSubmitted(true);
                if (votedOption) setSelectedOption(votedOption);
            }
        }
    }, [slide.id, role, content.limitSubmissions, isPreview]);

    const handleSelect = (optionId: string) => {
        if (hasSubmitted) return;
        setSelectedOption(optionId);
    };

    const handleSubmit = () => {
        if (!selectedOption || hasSubmitted) return;

        sendMessage('SUBMIT_VOTE', { slideId: slide.id, optionId: selectedOption });

        if (content.limitSubmissions !== false) {
            localStorage.setItem(`voted_${slide.id}`, 'true');
            localStorage.setItem(`voted_option_${slide.id}`, selectedOption);
            setHasSubmitted(true);
        }
    };

    // Student View: Voting Buttons
    if (role === 'student') {
        return (
            <Card className="w-full h-full flex flex-col p-8">
                <CardHeader>
                    <CardTitle className="text-2xl font-bold mb-2 question-text">{content.question}</CardTitle>
                    {hasSubmitted && (
                        <div className="text-green-600 font-medium flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
                            <span className="w-2 h-2 rounded-full bg-green-600" />
                            Answer Submitted
                        </div>
                    )}
                </CardHeader>
                <CardContent className="flex-1 flex flex-col gap-3 overflow-y-auto">
                    {(content.options || []).map((option, index) => (
                        <div
                            key={option.id}
                            onClick={() => handleSelect(option.id)}
                            className={`p-4 rounded-xl border-2 transition-all flex items-center gap-4 relative overflow-hidden ${selectedOption === option.id
                                ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-sm'
                                : hasSubmitted
                                    ? 'border-slate-100 text-slate-400 bg-slate-50'
                                    : 'border-slate-200 hover:border-blue-200 hover:bg-slate-50 cursor-pointer'
                                } ${hasSubmitted && selectedOption !== option.id ? 'opacity-60' : ''}`}
                        >
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 font-bold transition-colors ${selectedOption === option.id
                                ? 'border-blue-500 bg-blue-500 text-white'
                                : hasSubmitted
                                    ? 'border-slate-200 text-slate-300'
                                    : 'border-slate-300 text-slate-500'
                                }`}>
                                {String.fromCharCode(65 + index)}
                            </div>
                            <span className="text-lg font-medium poll-option-text flex-1">{option.text}</span>

                            {selectedOption === option.id && hasSubmitted && (
                                <span className="text-xs font-bold uppercase tracking-wider text-blue-600 bg-blue-100 px-2 py-1 rounded-full">
                                    Your Answer
                                </span>
                            )}
                        </div>
                    ))}
                </CardContent>
                <div className="mt-6 pt-4 border-t flex justify-end">
                    {!hasSubmitted ? (
                        <Button
                            size="lg"
                            onClick={handleSubmit}
                            disabled={!selectedOption}
                            className="w-full md:w-auto"
                        >
                            Submit Answer
                        </Button>
                    ) : (
                        <div className="text-center w-full text-slate-500 text-sm italic">
                            Waiting for results to be revealed...
                        </div>
                    )}
                </div>
            </Card>
        );
    }

    // Staff/Projector View: Results Chart
    const results = voteResults?.[slide.id] || {};
    const options = content.options || [];
    const chartData = options.map(o => ({
        name: o.text,
        votes: results[o.id] || 0
    }));

    return (
        <Card className="w-full h-full flex flex-col p-6">
            <CardHeader>
                <CardTitle className="text-3xl text-center mb-8 question-text">{content.question}</CardTitle>
            </CardHeader>
            <CardContent className="flex-1">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                        <XAxis dataKey="name" />
                        <YAxis />
                        <Tooltip />
                        <Bar dataKey="votes" fill="#2563eb" />
                    </BarChart>
                </ResponsiveContainer>
            </CardContent>
        </Card>
    );
}

function QuizSlide({ slide, role, isPreview }: SlideProps) {
    const { sendMessage, state, voteResults, slideStartTime, serverTimeOffset } = useWebSocket();
    const content = slide.content as QuizSlideContent;
    const [selectedOption, setSelectedOption] = useState<string | null>(null);
    const [timeLeft, setTimeLeft] = useState(content.timerDuration);

    useEffect(() => {
        if (!slideStartTime) {
            // If no start time from server, maybe we just started locally or it's not active
            // For now, just show full duration if not started
            return;
        }

        const interval = setInterval(() => {
            // Calculate elapsed time based on server time offset
            // serverTime = Date.now() + serverTimeOffset
            // elapsed = serverTime - slideStartTime
            const currentServerTime = Date.now() + (serverTimeOffset || 0);
            const elapsed = (currentServerTime - slideStartTime) / 1000;
            const remaining = Math.max(0, content.timerDuration - elapsed);

            setTimeLeft(Math.floor(remaining));
            if (remaining <= 0) clearInterval(interval);
        }, 100);
        return () => clearInterval(interval);
    }, [slideStartTime, serverTimeOffset, content.timerDuration]);

    useEffect(() => {
        if (role === 'student' && !isPreview) {
            const votedOption = localStorage.getItem(`voted_option_${slide.id}`);
            if (votedOption) setSelectedOption(votedOption);
        }
    }, [slide.id, role, isPreview]);

    const handleVote = (optionId: string) => {
        if (selectedOption) return;
        setSelectedOption(optionId);
        const timeRemaining = timeLeft;
        sendMessage('SUBMIT_ANSWER', { slideId: slide.id, answer: optionId, timeRemaining });

        localStorage.setItem(`voted_option_${slide.id}`, optionId);

        const option = (content.options || []).find(o => o.id === optionId);
        if (option?.isCorrect) {
            confetti({
                particleCount: 100,
                spread: 70,
                origin: { y: 0.6 }
            });
        }
    };

    return (
        <Card className="w-full h-full flex flex-col p-6">
            <CardHeader>
                <CardTitle className="text-2xl text-center mb-4 question-text">{content.question}</CardTitle>
                <div className="text-center text-xl font-bold text-blue-600">
                    Time Left: {timeLeft}s
                </div>
            </CardHeader>
            <CardContent className="flex-1 flex flex-col gap-4 justify-center">
                {(content.options || []).map((option) => (
                    <Button
                        key={option.id}
                        className={`h-16 text-lg poll-option-text ${state?.isResultsVisible && option.isCorrect ? 'bg-green-500 hover:bg-green-600 text-white' :
                            state?.isResultsVisible && !option.isCorrect && selectedOption === option.id ? 'bg-red-500 hover:bg-red-600 text-white' :
                                selectedOption === option.id ? 'bg-blue-500 text-white' : ''
                            }`}
                        variant="outline"
                        onClick={() => handleVote(option.id)}
                        disabled={!!selectedOption || timeLeft <= 0 || role === 'projector'}
                    >
                        {option.text}
                        {state?.isResultsVisible && (
                            <span className="ml-2 text-sm">
                                ({voteResults?.[slide.id]?.[option.id] || 0})
                            </span>
                        )}
                    </Button>
                ))}
            </CardContent>
        </Card>
    );
}

function QASlide({ slide, role, isPreview }: SlideProps) {
    const { sendMessage, questions } = useWebSocket();
    const [newQuestion, setNewQuestion] = useState('');
    const content = slide.content as QASlideContent;

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (!newQuestion.trim()) return;
        sendMessage('SUBMIT_QUESTION', { content: newQuestion, slideId: slide.id });
        setNewQuestion('');
    };

    const handleUpvote = (id: string) => {
        sendMessage('UPVOTE_QUESTION', { questionId: id });
    };

    const sortedQuestions = [...(questions || [])]
        .filter((q: any) => q.slideId === slide.id)
        .sort((a, b) => b.upvotes - a.upvotes);

    return (
        <Card className="w-full h-full flex flex-col p-6">
            <CardHeader>
                <CardTitle className="text-3xl text-center mb-2 question-text">{content.title}</CardTitle>
                {content.description && <p className="text-center text-slate-500">{content.description}</p>}
            </CardHeader>
            <CardContent className="flex-1 flex flex-col overflow-hidden">
                <div className="flex-1 overflow-y-auto space-y-4 mb-4 pr-2">
                    {sortedQuestions.length === 0 ? (
                        <div className="text-center text-slate-400 mt-10">No questions yet. Be the first to ask!</div>
                    ) : (
                        sortedQuestions.map((q: any) => (
                            <div key={q.id} className="bg-slate-50 p-4 rounded-lg flex justify-between items-start border">
                                <div className="text-lg question-text">{q.content}</div>
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="flex flex-col items-center h-auto py-2 hover:bg-blue-50 hover:text-blue-600"
                                    onClick={() => handleUpvote(q.id)}
                                    disabled={role === 'projector'}
                                >
                                    <span className="text-xl">▲</span>
                                    <span className="font-bold">{q.upvotes}</span>
                                </Button>
                            </div>
                        ))
                    )}
                </div>

                {role === 'student' && (
                    <form onSubmit={handleSubmit} className="flex gap-2 mt-auto pt-4 border-t">
                        <input
                            type="text"
                            value={newQuestion}
                            onChange={(e) => setNewQuestion(e.target.value)}
                            placeholder="Type your question..."
                            className="flex-1 px-4 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                        <Button type="submit">Ask</Button>
                    </form>
                )}
            </CardContent>
        </Card>
    );
}

function LeaderboardSlide() {
    return (
        <Card className="w-full h-full flex flex-col justify-center items-center p-8 text-center">
            <h1 className="text-4xl font-bold mb-6">Leaderboard</h1>
            <p className="text-xl text-slate-600">Top scores coming soon...</p>
        </Card>
    );
}

function MultipleChoiceSlide({ slide, role, isPreview }: SlideProps) {
    const { sendMessage, voteResults } = useWebSocket();
    const content = slide.content as MultipleChoiceSlideContent;
    const [selectedOptions, setSelectedOptions] = useState<string[]>([]);
    const [submitted, setSubmitted] = useState(false);

    useEffect(() => {
        if (role === 'student' && content.limitSubmissions !== false && !isPreview) {
            const voted = localStorage.getItem(`voted_${slide.id}`);
            const votedOptions = localStorage.getItem(`voted_options_${slide.id}`);
            if (voted) {
                setSubmitted(true);
                if (votedOptions) {
                    try {
                        setSelectedOptions(JSON.parse(votedOptions));
                    } catch (e) {
                        console.error('Failed to parse voted options', e);
                    }
                }
            }
        }
    }, [slide.id, role, content.limitSubmissions, isPreview]);

    const handleSelect = (optionId: string) => {
        if (role !== 'student' || submitted) return;

        let newSelection;
        if (content.allowMultipleSelection) {
            newSelection = selectedOptions.includes(optionId)
                ? selectedOptions.filter(id => id !== optionId)
                : [...selectedOptions, optionId];
        } else {
            newSelection = [optionId];
        }
        setSelectedOptions(newSelection);
    };

    const handleSubmit = () => {
        if (selectedOptions.length === 0) return;

        sendMessage('SUBMIT_VOTE', { slideId: slide.id, optionIds: selectedOptions });

        if (content.limitSubmissions !== false) {
            localStorage.setItem(`voted_${slide.id}`, 'true');
            localStorage.setItem(`voted_options_${slide.id}`, JSON.stringify(selectedOptions));
        }
        setSubmitted(true);
    };

    // Student View
    if (role === 'student') {
        return (
            <Card className="w-full h-full flex flex-col p-8">
                <CardHeader>
                    <CardTitle className="text-2xl font-bold mb-2 question-text">{content.question}</CardTitle>
                    {submitted && (
                        <div className="text-green-600 font-medium flex items-center gap-2 animate-in fade-in slide-in-from-top-2">
                            <span className="w-2 h-2 rounded-full bg-green-600" />
                            Answer Submitted
                        </div>
                    )}
                </CardHeader>
                <CardContent className="flex-1 flex flex-col gap-3 overflow-y-auto">
                    {(content.options || []).map((option, index) => (
                        <div
                            key={option.id}
                            onClick={() => handleSelect(option.id)}
                            className={`p-4 rounded-xl border-2 transition-all flex items-center gap-4 relative overflow-hidden ${selectedOptions.includes(option.id)
                                ? 'border-blue-500 bg-blue-50 text-blue-700 shadow-sm'
                                : submitted
                                    ? 'border-slate-100 text-slate-400 bg-slate-50'
                                    : 'border-slate-200 hover:border-blue-200 hover:bg-slate-50 cursor-pointer'
                                } ${submitted && !selectedOptions.includes(option.id) ? 'opacity-60' : ''}`}
                        >
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 font-bold transition-colors ${selectedOptions.includes(option.id)
                                ? 'border-blue-500 bg-blue-500 text-white'
                                : submitted
                                    ? 'border-slate-200 text-slate-300'
                                    : 'border-slate-300 text-slate-500'
                                }`}>
                                {String.fromCharCode(65 + index)}
                            </div>
                            <span className="text-lg font-medium poll-option-text flex-1">{option.text}</span>

                            {selectedOptions.includes(option.id) && submitted && (
                                <span className="text-xs font-bold uppercase tracking-wider text-blue-600 bg-blue-100 px-2 py-1 rounded-full">
                                    Your Answer
                                </span>
                            )}
                        </div>
                    ))}
                </CardContent>
                <div className="mt-6 pt-4 border-t flex justify-end">
                    {!submitted ? (
                        <Button
                            size="lg"
                            onClick={handleSubmit}
                            disabled={selectedOptions.length === 0}
                            className="w-full md:w-auto"
                        >
                            Submit Answer
                        </Button>
                    ) : (
                        <div className="text-center w-full text-slate-500 text-sm italic">
                            Waiting for results to be revealed...
                        </div>
                    )}
                </div>
            </Card>
        );
    }

    // Staff/Projector View: Results Chart
    const results = voteResults?.[slide.id] || {};
    const options = content.options || [];
    const chartData = options.map(o => ({
        name: o.text,
        votes: results[o.id] || 0
    }));

    return (
        <Card className="w-full h-full flex flex-col p-6">
            <CardHeader>
                <CardTitle className="text-3xl text-center mb-8 question-text">{content.question}</CardTitle>
            </CardHeader>
            <CardContent className="flex-1">
                <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData} layout="vertical">
                        <XAxis type="number" />
                        <YAxis dataKey="name" type="category" width={150} />
                        <Tooltip />
                        <Bar dataKey="votes" fill="#8b5cf6" radius={[0, 4, 4, 0]} />
                    </BarChart>
                </ResponsiveContainer>
            </CardContent>
        </Card>
    );
}

export function SlideRenderer({ slide, role, isPreview }: SlideProps) {
    return (
        <AnimatePresence mode="wait">
            <motion.div
                key={slide.id}
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                transition={{ duration: 0.3, ease: "easeInOut" }}
                className="w-full h-full"
            >
                {(() => {
                    switch (slide.type) {
                        case 'static':
                            return <StaticSlide slide={slide} role={role} isPreview={isPreview} />;
                        case 'poll':
                            return <PollSlide slide={slide} role={role} isPreview={isPreview} />;
                        case 'multiple-choice':
                            return <MultipleChoiceSlide slide={slide} role={role} isPreview={isPreview} />;
                        case 'quiz':
                            return <QuizSlide slide={slide} role={role} isPreview={isPreview} />;
                        case 'qa':
                            return <QASlide slide={slide} role={role} isPreview={isPreview} />;
                        case 'leaderboard':
                            return <LeaderboardSlide />;
                        default:
                            return <div>Unsupported slide type: {slide.type}</div>;
                    }
                })()}
            </motion.div>
        </AnimatePresence>
    );
}
