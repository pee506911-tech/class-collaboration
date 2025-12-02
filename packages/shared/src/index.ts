import { z } from 'zod';

export const SlideTypeSchema = z.enum([
    'static',
    'poll',
    'multiple-choice',
    'quiz',
    'wordcloud',
    'rating',
    'ranking',
    'qa',
    'leaderboard'
]);

export const StaticSlideContentSchema = z.object({
    title: z.string(),
    body: z.string(),
});

export const PollOptionSchema = z.object({
    id: z.string(),
    text: z.string(),
});

export const PollSlideContentSchema = z.object({
    question: z.string(),
    options: z.array(PollOptionSchema),
    chartType: z.enum(['bar', 'pie']).default('bar'),
    limitSubmissions: z.boolean().default(true),
});

export const MultipleChoiceSlideContentSchema = z.object({
    question: z.string(),
    options: z.array(PollOptionSchema),
    allowMultipleSelection: z.boolean().default(false),
    limitSubmissions: z.boolean().default(true),
});

export const StateUpdatePayloadSchema = z.object({
    currentSlideId: z.string().optional(),
    isPresentationActive: z.boolean().optional(),
    isBlackout: z.boolean().optional(),
    showResults: z.boolean().optional(),
});

export const QASlideContentSchema = z.object({
    title: z.string(),
    description: z.string().optional(),
});

export type StaticSlideContent = z.infer<typeof StaticSlideContentSchema>;
export type PollSlideContent = z.infer<typeof PollSlideContentSchema>;
export type MultipleChoiceSlideContent = z.infer<typeof MultipleChoiceSlideContentSchema>;
export type QASlideContent = z.infer<typeof QASlideContentSchema>;

export const QuizOptionSchema = z.object({
    id: z.string(),
    text: z.string(),
    isCorrect: z.boolean(),
});

export const QuizSlideContentSchema = z.object({
    question: z.string(),
    options: z.array(QuizOptionSchema),
    points: z.number().default(1000),
    timerDuration: z.number().default(30), // seconds
    limitSubmissions: z.boolean().default(true),
});

export type QuizSlideContent = z.infer<typeof QuizSlideContentSchema>;

export const LeaderboardSlideContentSchema = z.object({
    title: z.string().default("Leaderboard"),
});

export type LeaderboardSlideContent = z.infer<typeof LeaderboardSlideContentSchema>;

export const SlideSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    type: SlideTypeSchema,
    content: z.any(), // We keep this loose for now to avoid complex union parsing on the boundary, but UI will cast it
    orderIndex: z.number(),
    isHidden: z.boolean().optional(),
});

export const SessionStatusSchema = z.enum(['draft', 'published', 'archived']);

export const SessionSchema = z.object({
    id: z.string(),
    title: z.string(),
    status: SessionStatusSchema,
    shareToken: z.string().optional(),
    allowQuestions: z.boolean().optional(),
    requireName: z.boolean().optional(),
    isPresentationActive: z.boolean().optional(),
    createdAt: z.string(), // ISO date
    updatedAt: z.string(),
    slideCount: z.number().optional(), // Included in list view
});

export const ParticipantSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    name: z.string(),
    joinedAt: z.string(),
});

export const InteractionSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    slideId: z.string(),
    participantId: z.string(),
    data: z.any(),
    createdAt: z.string(),
});

export const QuestionSchema = z.object({
    id: z.string(),
    sessionId: z.string(),
    participantId: z.string(),
    content: z.string(),
    upvotes: z.number(),
    isApproved: z.boolean(),
    createdAt: z.string(),
});

export type Slide = z.infer<typeof SlideSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type Participant = z.infer<typeof ParticipantSchema>;
export type Interaction = z.infer<typeof InteractionSchema>;
export type Question = z.infer<typeof QuestionSchema>;

export const UserSchema = z.object({
    id: z.string(),
    email: z.string().email(),
    name: z.string(),
    role: z.enum(['staff', 'student']),
});

export type User = z.infer<typeof UserSchema>;

export type ApiResponse<T> = {
    data: T;
    error: string | null;
    success: boolean;
};

export interface LoginResponse {
    success: boolean;
    token: string;
    user: User;
}

// WebSocket Messages

export type WSMessageType = 'JOIN_SESSION' | 'STATE_UPDATE' | 'SET_SLIDE' | 'SYNC_TIME' | 'SUBMIT_VOTE' | 'VOTE_UPDATE' | 'SUBMIT_ANSWER' | 'IM_LOST' | 'LOST_UPDATE' | 'SUBMIT_QUESTION' | 'UPVOTE_QUESTION' | 'QA_UPDATE' | 'PARTICIPANT_COUNT_UPDATE' | 'EDIT_QUESTION';

export interface WSMessage {
    type: WSMessageType;
    payload: any;
}

export interface JoinSessionPayload {
    sessionId: string;
    role: 'staff' | 'student' | 'projector';
    participantId?: string; // For students
}

export interface StateUpdatePayload {
    sessionId?: string;
    currentSlideId?: string | null;
    isResultsVisible?: boolean;
    isPresentationActive?: boolean;
    isBlackout?: boolean;
    showResults?: boolean;
    lostCount?: number;
    questions?: Question[];
}

export interface SetSlidePayload {
    slideId: string;
}

export interface SubmitVotePayload {
    slideId: string;
    optionId: string;
}

export interface VoteUpdatePayload {
    slideId: string;
    results: Record<string, number>; // optionId -> count
}

export interface SubmitAnswerPayload {
    slideId: string;
    answer: string; // optionId
    timeRemaining: number; // seconds
}

export interface ImLostPayload {
    status: boolean; // true = lost, false = found
}

export interface SyncTimePayload {
    serverTime: number;
    startTime: number;
}

export interface SubmitQuestionPayload {
    content: string;
}

export interface UpvoteQuestionPayload {
    questionId: string;
}

export interface QAUpdatePayload {
    questions: Question[];
}
