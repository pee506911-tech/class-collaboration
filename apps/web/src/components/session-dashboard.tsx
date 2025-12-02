'use client';

import { useEffect, useState, Fragment } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Users, MessageSquare, BarChart2, Clock, CheckCircle2, ChevronDown, ChevronUp, Trophy, TrendingUp } from 'lucide-react';
import { useWebSocket } from '@/lib/websocket';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell, LabelList } from 'recharts';
import { Button } from '@/components/ui/button';
import { LoadingState, EmptyState } from '@/components/ui/loading';

interface Interaction {
    name: string;
    answer: string;
    textAnswer?: string;
    answeredAt: string;
}

interface SlideStats {
    id: string;
    type: string;
    question?: string;
    options?: { id: string; text: string }[];
    votes?: Record<string, number>;
    interactions?: Interaction[];
}

interface Stats {
    participants: { id: string; name: string; joinedAt: string }[];
    slides: SlideStats[];
    questions: { id: string; content: string; upvotes: number; author: string; createdAt: string; slideId?: string }[];
}

const COLORS = ['#3b82f6', '#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#06b6d4', '#ec4899', '#84cc16'];

export function SessionDashboard({ sessionId, isPublic = false }: { sessionId: string; isPublic?: boolean }) {
    const [stats, setStats] = useState<Stats | null>(null);
    const [loading, setLoading] = useState(true);
    const [expandedSlides, setExpandedSlides] = useState<Set<string>>(new Set());
    const [filteredQuestions, setFilteredQuestions] = useState<Stats['questions'] | null>(null);
    const [lastFetchTime, setLastFetchTime] = useState(0);
    const { socket } = useWebSocket();

    const fetchStats = async (force = false) => {
        // Debounce: don't fetch more than once per 5 seconds unless forced
        const now = Date.now();
        if (!force && now - lastFetchTime < 5000) {
            return;
        }
        setLastFetchTime(now);

        if (!stats) setLoading(true);
        try {
            const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api';
            const endpoint = isPublic
                ? `${apiUrl}/sessions/public/${sessionId}/stats`
                : `${apiUrl}/sessions/${sessionId}/stats`;

            const headers: HeadersInit = {};
            if (!isPublic) {
                const token = localStorage.getItem('token');
                if (!token) {
                    // No token available, skip fetch for authenticated endpoint
                    console.warn('No auth token available for stats fetch');
                    setLoading(false);
                    return;
                }
                headers['Authorization'] = `Bearer ${token}`;
            }

            const res = await fetch(endpoint, { headers });
            if (res.ok) {
                const data = await res.json();
                setStats(data);
            } else if (res.status === 401) {
                console.warn('Unauthorized: token may be expired');
                // Don't spam console with errors, just set empty stats
                if (!stats) {
                    setStats({ participants: [], slides: [], questions: [] });
                }
            } else {
                console.error('Failed to fetch stats:', res.status);
                if (!stats) {
                    setStats({ participants: [], slides: [], questions: [] });
                }
            }
        } catch (error) {
            console.error('Failed to fetch stats:', error);
            if (!stats) {
                setStats({ participants: [], slides: [], questions: [] });
            }
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        // Initial fetch with force flag
        fetchStats(true);
        // Refresh every 30 seconds
        const interval = setInterval(() => fetchStats(true), 30000);
        return () => clearInterval(interval);
    }, [sessionId, isPublic]);

    // Listen to context state changes
    const { state, voteResults, questions, activeParticipants } = useWebSocket();

    useEffect(() => {
        // Debounced fetch on realtime updates (will be skipped if too frequent)
        fetchStats();
    }, [voteResults, questions, activeParticipants]);

    if (loading && !stats) return <LoadingState message="Loading analytics..." size="md" />;
    if (!stats) return (
        <div className="p-8">
            <EmptyState
                icon={<BarChart2 className="w-16 h-16 text-red-300" />}
                title="Failed to load stats"
                description="Unable to fetch session statistics. Please try again."
            />
        </div>
    );

    const totalVotes = stats.slides.reduce((acc, slide) => {
        if (!slide.votes) return acc;
        return acc + Object.values(slide.votes).reduce((a, b) => a + b, 0);
    }, 0);

    const toggleSlide = (slideId: string) => {
        const newExpanded = new Set(expandedSlides);
        if (newExpanded.has(slideId)) {
            newExpanded.delete(slideId);
        } else {
            newExpanded.add(slideId);
        }
        setExpandedSlides(newExpanded);
    };

    const getAnswerText = (slide: SlideStats, interaction: Interaction) => {
        if (slide.type === 'poll' || slide.type === 'quiz' || slide.type === 'multiple-choice') {
            const option = slide.options?.find(o => o.id === interaction.answer);
            if (option) {
                const optionIndex = slide.options?.findIndex(o => o.id === interaction.answer);
                const optionLetter = optionIndex !== undefined ? String.fromCharCode(65 + optionIndex) : '';
                return `${optionLetter}: ${option.text}`;
            }
            return interaction.answer || '-';
        }
        return interaction.textAnswer || interaction.answer || '-';
    };

    const getOptionDistribution = (slide: SlideStats) => {
        if (!slide.options || !slide.votes) return [];

        const distribution = slide.options.map((option, index) => {
            const count = slide.votes?.[option.id] || 0;
            const total = Object.values(slide.votes || {}).reduce((a, b) => a + b, 0);
            const percentage = total > 0 ? ((count / total) * 100).toFixed(1) : '0';

            return {
                id: option.id,
                label: `${String.fromCharCode(65 + index)}: ${option.text}`,
                shortLabel: String.fromCharCode(65 + index),
                text: option.text,
                count: count,
                percentage: parseFloat(percentage)
            };
        });

        return distribution.sort((a, b) => b.count - a.count);
    };

    const pollableSlides = stats.slides.filter(s => (s.type === 'poll' || s.type === 'quiz' || s.type === 'multiple-choice') && s.options);

    return (
        <div className="space-y-6 animate-fade-in">
            {/* Summary Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <Card className="border-l-4 border-l-blue-500">
                    <CardContent className="p-6">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium text-slate-600">Participants</p>
                                <h3 className="text-3xl font-bold text-slate-900 mt-1">{stats.participants.length}</h3>
                            </div>
                            <div className="p-3 bg-blue-100 rounded-lg">
                                <Users className="w-6 h-6 text-blue-600" />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Card className="border-l-4 border-l-purple-500">
                    <CardContent className="p-6">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium text-slate-600">Total Responses</p>
                                <h3 className="text-3xl font-bold text-slate-900 mt-1">{totalVotes}</h3>
                            </div>
                            <div className="p-3 bg-purple-100 rounded-lg">
                                <TrendingUp className="w-6 h-6 text-purple-600" />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Card className="border-l-4 border-l-green-500">
                    <CardContent className="p-6">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium text-slate-600">Questions</p>
                                <h3 className="text-3xl font-bold text-slate-900 mt-1">{pollableSlides.length}</h3>
                            </div>
                            <div className="p-3 bg-green-100 rounded-lg">
                                <BarChart2 className="w-6 h-6 text-green-600" />
                            </div>
                        </div>
                    </CardContent>
                </Card>

                <Card className="border-l-4 border-l-orange-500">
                    <CardContent className="p-6">
                        <div className="flex items-center justify-between">
                            <div>
                                <p className="text-sm font-medium text-slate-600">Q&A Posts</p>
                                <h3 className="text-3xl font-bold text-slate-900 mt-1">{stats.questions.length}</h3>
                            </div>
                            <div className="p-3 bg-orange-100 rounded-lg">
                                <MessageSquare className="w-6 h-6 text-orange-600" />
                            </div>
                        </div>
                    </CardContent>
                </Card>
            </div>

            {/* Main Content */}
            <Tabs defaultValue="questions" className="w-full">
                <TabsList className="grid w-full grid-cols-3 mb-6">
                    <TabsTrigger value="questions" className="text-base">
                        <BarChart2 className="w-4 h-4 mr-2" />
                        Question Analytics
                    </TabsTrigger>
                    <TabsTrigger value="qa" className="text-base">
                        <MessageSquare className="w-4 h-4 mr-2" />
                        Q&A Questions
                    </TabsTrigger>
                    <TabsTrigger value="participants" className="text-base">
                        <Users className="w-4 h-4 mr-2" />
                        Participants
                    </TabsTrigger>
                </TabsList>

                {/* Question Analytics Tab */}
                <TabsContent value="questions" className="space-y-4">
                    {pollableSlides.length === 0 ? (
                        <Card className="border-dashed">
                            <CardContent className="p-0">
                                <EmptyState
                                    icon={<BarChart2 className="w-16 h-16 text-slate-300" />}
                                    title="No questions available yet"
                                    description="Questions will appear here once you add poll or quiz slides to your session."
                                />
                            </CardContent>
                        </Card>
                    ) : (
                        <Card>
                            <CardHeader>
                                <CardTitle className="flex items-center gap-2">
                                    <BarChart2 className="w-5 h-5" />
                                    Question Analytics Overview
                                </CardTitle>
                                <CardDescription>Click any row to view detailed breakdown</CardDescription>
                            </CardHeader>
                            <CardContent className="p-0">
                                <div className="overflow-x-auto">
                                    <table className="w-full">
                                        <thead className="bg-slate-50 border-b-2 border-slate-200">
                                            <tr>
                                                <th className="text-left p-4 font-semibold text-slate-700 w-12">#</th>
                                                <th className="text-left p-4 font-semibold text-slate-700">Question</th>
                                                <th className="text-left p-4 font-semibold text-slate-700 w-32">Type</th>
                                                <th className="text-center p-4 font-semibold text-slate-700 w-32">Responses</th>
                                                <th className="text-left p-4 font-semibold text-slate-700">Top Answer</th>
                                                <th className="text-right p-4 font-semibold text-slate-700 w-20"></th>
                                            </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-200">
                                            {pollableSlides.map((slide, slideIndex) => {
                                                const distribution = getOptionDistribution(slide);
                                                const totalResponses = distribution.reduce((sum, d) => sum + d.count, 0);
                                                const isExpanded = expandedSlides.has(slide.id);
                                                const topAnswer = distribution[0];

                                                return (
                                                    <Fragment key={slide.id}>
                                                        {/* Table Row */}
                                                        <tr
                                                            key={slide.id}
                                                            onClick={() => toggleSlide(slide.id)}
                                                            className="hover:bg-slate-50 cursor-pointer transition-colors"
                                                        >
                                                            <td className="p-4">
                                                                <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-100 text-blue-700 font-bold text-sm">
                                                                    {slideIndex + 1}
                                                                </span>
                                                            </td>
                                                            <td className="p-4">
                                                                <div className="font-semibold text-slate-900 mb-1">
                                                                    {slide.question || 'Untitled Question'}
                                                                </div>
                                                                <div className="text-xs text-slate-500">
                                                                    {slide.options?.length || 0} options
                                                                </div>
                                                            </td>
                                                            <td className="p-4">
                                                                <span className="inline-flex px-3 py-1 rounded-full text-xs font-medium bg-slate-100 text-slate-700">
                                                                    {slide.type === 'multiple-choice' ? 'Multi Choice' :
                                                                        slide.type === 'quiz' ? 'Quiz' : 'Poll'}
                                                                </span>
                                                            </td>
                                                            <td className="p-4 text-center">
                                                                <div className="font-bold text-2xl text-slate-900">{totalResponses}</div>
                                                                <div className="text-xs text-slate-500">
                                                                    {totalResponses === 1 ? 'response' : 'responses'}
                                                                </div>
                                                            </td>
                                                            <td className="p-4">
                                                                {topAnswer && topAnswer.count > 0 ? (
                                                                    <div className="flex items-center gap-2">
                                                                        <Trophy className="w-4 h-4 text-amber-500 flex-shrink-0" />
                                                                        <div className="flex-1 min-w-0">
                                                                            <div className="font-semibold text-slate-900 truncate">
                                                                                {topAnswer.shortLabel}: {topAnswer.text}
                                                                            </div>
                                                                            <div className="text-xs text-slate-500">
                                                                                {topAnswer.count} votes ({topAnswer.percentage}%)
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                ) : (
                                                                    <span className="text-slate-400 text-sm">No responses yet</span>
                                                                )}
                                                            </td>
                                                            <td className="p-4 text-right">
                                                                <Button variant="ghost" size="sm">
                                                                    {isExpanded ? (
                                                                        <ChevronUp className="w-5 h-5" />
                                                                    ) : (
                                                                        <ChevronDown className="w-5 h-5" />
                                                                    )}
                                                                </Button>
                                                            </td>
                                                        </tr>

                                                        {/* Expanded Details Row */}
                                                        {isExpanded && (
                                                            <tr>
                                                                <td colSpan={6} className="p-0 bg-slate-50">
                                                                    <div className="p-6 space-y-6">
                                                                        {totalResponses === 0 ? (
                                                                            <div className="text-center py-8 text-slate-400">
                                                                                <p>No responses yet</p>
                                                                            </div>
                                                                        ) : (
                                                                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                                                                                {/* Left: Answer Distribution */}
                                                                                <div>
                                                                                    <h4 className="text-sm font-semibold text-slate-700 mb-4 uppercase tracking-wide flex items-center gap-2">
                                                                                        <BarChart2 className="w-4 h-4" />
                                                                                        Answer Distribution
                                                                                    </h4>
                                                                                    <div className="space-y-3">
                                                                                        {distribution.map((item, index) => (
                                                                                            <div key={item.id} className="bg-white p-3 rounded-lg border">
                                                                                                <div className="flex items-center justify-between mb-2">
                                                                                                    <div className="flex items-center gap-2 flex-1 min-w-0">
                                                                                                        <span
                                                                                                            className="w-7 h-7 rounded-md flex items-center justify-center text-white font-bold text-xs flex-shrink-0"
                                                                                                            style={{ backgroundColor: COLORS[index % COLORS.length] }}
                                                                                                        >
                                                                                                            {item.shortLabel}
                                                                                                        </span>
                                                                                                        <span className="text-sm font-medium text-slate-700 truncate">
                                                                                                            {item.text}
                                                                                                        </span>
                                                                                                    </div>
                                                                                                    <div className="flex items-center gap-2 flex-shrink-0">
                                                                                                        <span className="text-sm font-bold text-slate-900">
                                                                                                            {item.count}
                                                                                                        </span>
                                                                                                        <span className="text-xs font-semibold text-slate-600 w-12 text-right">
                                                                                                            {item.percentage}%
                                                                                                        </span>
                                                                                                    </div>
                                                                                                </div>
                                                                                                <div className="w-full bg-slate-200 rounded-full h-2">
                                                                                                    <div
                                                                                                        className="h-2 rounded-full transition-all duration-500"
                                                                                                        style={{
                                                                                                            width: `${item.percentage}%`,
                                                                                                            backgroundColor: COLORS[index % COLORS.length]
                                                                                                        }}
                                                                                                    />
                                                                                                </div>
                                                                                            </div>
                                                                                        ))}
                                                                                    </div>
                                                                                </div>

                                                                                {/* Right: Individual Responses */}
                                                                                <div>
                                                                                    {slide.interactions && slide.interactions.length > 0 && (
                                                                                        <Fragment>
                                                                                            <h4 className="text-sm font-semibold text-slate-700 mb-4 uppercase tracking-wide flex items-center gap-2">
                                                                                                <Users className="w-4 h-4" />
                                                                                                Individual Responses ({slide.interactions.length})
                                                                                            </h4>
                                                                                            <div className="bg-white border rounded-lg max-h-80 overflow-y-auto">
                                                                                                <table className="w-full text-sm">
                                                                                                    <thead className="bg-slate-50 sticky top-0 border-b">
                                                                                                        <tr>
                                                                                                            <th className="text-left p-2 font-semibold text-slate-600">Student</th>
                                                                                                            <th className="text-left p-2 font-semibold text-slate-600">Answer</th>
                                                                                                            <th className="text-right p-2 font-semibold text-slate-600">Time</th>
                                                                                                        </tr>
                                                                                                    </thead>
                                                                                                    <tbody className="divide-y">
                                                                                                        {slide.interactions.map((interaction, idx) => (
                                                                                                            <tr key={idx} className="hover:bg-slate-50">
                                                                                                                <td className="p-2">
                                                                                                                    <div className="flex items-center gap-2">
                                                                                                                        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-white font-semibold text-xs flex-shrink-0">
                                                                                                                            {interaction.name.substring(0, 2).toUpperCase()}
                                                                                                                        </div>
                                                                                                                        <span className="font-medium text-slate-900 truncate">
                                                                                                                            {interaction.name}
                                                                                                                        </span>
                                                                                                                    </div>
                                                                                                                </td>
                                                                                                                <td className="p-2">
                                                                                                                    <span className="inline-flex px-2 py-0.5 bg-blue-50 text-blue-900 rounded text-xs font-medium">
                                                                                                                        {getAnswerText(slide, interaction)}
                                                                                                                    </span>
                                                                                                                </td>
                                                                                                                <td className="p-2 text-right text-slate-500 text-xs whitespace-nowrap">
                                                                                                                    {new Date(interaction.answeredAt).toLocaleTimeString()}
                                                                                                                </td>
                                                                                                            </tr>
                                                                                                        ))}
                                                                                                    </tbody>
                                                                                                </table>
                                                                                            </div>
                                                                                        </Fragment>
                                                                                    )}
                                                                                </div>
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                </td>
                                                            </tr>
                                                        )}
                                                    </Fragment>
                                                );
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            </CardContent>
                        </Card>
                    )}
                </TabsContent>

                {/* Q&A Questions Tab */}
                <TabsContent value="qa" className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <MessageSquare className="w-5 h-5" />
                                Q&A Questions ({stats.questions.length})
                            </CardTitle>
                            <CardDescription>Student questions organized by slide/category</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {stats.questions.length === 0 ? (
                                <EmptyState
                                    icon={<MessageSquare className="w-12 h-12 text-slate-300" />}
                                    title="No questions yet"
                                    description="Questions from students will appear here."
                                />
                            ) : (
                                <div className="space-y-6">
                                    {/* Question Distribution Chart */}
                                    <div className="bg-slate-50 rounded-lg p-4 border">
                                        <h4 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
                                            <BarChart2 className="w-4 h-4" />
                                            Question Distribution
                                        </h4>
                                        {(() => {
                                            // Calculate data distribution first to determine height
                                            const distribution = new Map<string, { label: string; count: number; color: string }>();

                                            stats.questions.forEach((q) => {
                                                const slide = stats.slides.find(s => s.id === q.slideId);
                                                const slideIndex = stats.slides.findIndex(s => s.id === q.slideId);

                                                let key: string;
                                                let label: string;
                                                let color: string;

                                                if (q.slideId && slide) {
                                                    key = q.slideId;
                                                    const question = slide.question || `Slide ${slideIndex + 1}`;
                                                    label = `#${slideIndex + 1}: ${question.substring(0, 30)}${question.length > 30 ? '...' : ''}`;
                                                    color = '#3b82f6'; // blue
                                                } else {
                                                    key = 'overall';
                                                    label = '📚 Overall';
                                                    color = '#8b5cf6'; // purple
                                                }

                                                const existing = distribution.get(key);
                                                if (existing) {
                                                    existing.count++;
                                                } else {
                                                    distribution.set(key, { label, count: 1, color });
                                                }
                                            });

                                            const chartData = Array.from(distribution.values()).sort((a, b) => b.count - a.count);
                                            // Calculate dynamic height: 60px per bar + 40px padding, min 100px
                                            const chartHeight = Math.max(chartData.length * 60 + 40, 100);

                                            return (
                                                <ResponsiveContainer width="100%" height={chartHeight}>
                                                    <BarChart
                                                        layout="vertical"
                                                        data={chartData}
                                                        margin={{ top: 5, right: 30, left: 20, bottom: 5 }}
                                                    >
                                                        <XAxis type="number" hide />
                                                        <YAxis
                                                            dataKey="label"
                                                            type="category"
                                                            width={150}
                                                            tick={{ fontSize: 12 }}
                                                        />
                                                        <Tooltip cursor={{ fill: 'transparent' }} />
                                                        <Bar dataKey="count" radius={[0, 4, 4, 0]} barSize={32}>
                                                            {chartData.map((entry, index) => (
                                                                <Cell key={`cell-${index}`} fill={entry.color} />
                                                            ))}
                                                            <LabelList dataKey="count" position="right" style={{ fontSize: '12px', fontWeight: 'bold', fill: '#64748b' }} />
                                                        </Bar>
                                                    </BarChart>
                                                </ResponsiveContainer>
                                            );
                                        })()}
                                    </div>

                                    {/* Filter Dropdown */}
                                    <div className="space-y-2">
                                        <label className="text-sm font-semibold text-slate-700">Filter by Slide/Category</label>
                                        <select
                                            className="w-full p-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent outline-none text-sm bg-white"
                                            onChange={(e) => {
                                                const value = e.target.value;
                                                const filtered = value === 'all'
                                                    ? stats.questions
                                                    : stats.questions.filter(q => {
                                                        if (value === 'overall') return !q.slideId;
                                                        return q.slideId === value;
                                                    });
                                                // Store in component state
                                                setFilteredQuestions(filtered);
                                            }}
                                        >
                                            <option value="all">All Questions ({stats.questions.length})</option>
                                            <option value="overall">📚 Overall ({stats.questions.filter(q => !q.slideId).length})</option>
                                            {stats.slides.map((slide, index) => {
                                                const count = stats.questions.filter(q => q.slideId === slide.id).length;
                                                if (count === 0) return null;
                                                const question = slide.question || `Slide ${index + 1}`;
                                                return (
                                                    <option key={slide.id} value={slide.id}>
                                                        #{index + 1}: {question} ({count})
                                                    </option>
                                                );
                                            })}
                                        </select>
                                    </div>

                                    {/* Question List */}
                                    <div className="max-h-96 overflow-y-auto space-y-3">
                                        {(filteredQuestions || stats.questions).map((q) => {
                                            const slide = stats.slides.find(s => s.id === q.slideId);
                                            const slideIndex = stats.slides.findIndex(s => s.id === q.slideId);

                                            // Determine the label based on slide or category
                                            let slideLabel = '';
                                            let labelColor = '';

                                            if (q.slideId && slide) {
                                                // Specific slide - show slide number and question
                                                const question = slide.question || `Slide ${slideIndex + 1}`;
                                                slideLabel = `#${slideIndex + 1}: ${question}`;
                                                labelColor = 'bg-blue-100 text-blue-700';
                                            } else {
                                                // Check if it's Overall or Vibe (stored in database or inferred)
                                                // For now, we'll show "Overall" for null slideId
                                                // TODO: Backend should store category field
                                                slideLabel = '📚 Overall';
                                                labelColor = 'bg-purple-100 text-purple-700';
                                            }

                                            return (
                                                <div key={q.id} className="p-4 border rounded-lg bg-white hover:shadow-md transition-shadow">
                                                    <div className="flex justify-between items-start mb-2 gap-2">
                                                        <p className="font-medium text-slate-900">{q.content}</p>
                                                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap shrink-0 ${labelColor}`}>
                                                            {slideLabel}
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center justify-between text-xs text-slate-500">
                                                        <span className="font-medium">{q.author}</span>
                                                        <div className="flex items-center gap-3">
                                                            <span className="flex items-center gap-1 text-amber-600 font-semibold">
                                                                <Trophy className="w-3 h-3" />
                                                                {q.upvotes}
                                                            </span>
                                                            <span>{new Date(q.createdAt).toLocaleTimeString()}</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>

                {/* Participants Tab */}
                <TabsContent value="participants" className="space-y-4">
                    <Card>
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Users className="w-5 h-5" />
                                Participants ({stats.participants.length})
                            </CardTitle>
                            <CardDescription>All students who have joined this session</CardDescription>
                        </CardHeader>
                        <CardContent>
                            {stats.participants.length === 0 ? (
                                <EmptyState
                                    icon={<Users className="w-12 h-12 text-slate-300" />}
                                    title="No participants yet"
                                    description="Participants will appear here when they join the session."
                                />
                            ) : (
                                <div className="max-h-96 overflow-y-auto space-y-2">
                                    {stats.participants.map((p) => (
                                        <div key={p.id} className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors">
                                            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-purple-400 to-purple-600 flex items-center justify-center text-white font-bold shadow-sm">
                                                {p.name.substring(0, 2).toUpperCase()}
                                            </div>
                                            <div className="flex-1">
                                                <p className="font-semibold text-slate-900">{p.name}</p>
                                                <p className="text-xs text-slate-500 flex items-center gap-1">
                                                    <Clock className="w-3 h-3" />
                                                    Joined {new Date(p.joinedAt).toLocaleString()}
                                                </p>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    );
}
