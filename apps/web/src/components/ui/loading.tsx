'use client';

import { Loader2 } from 'lucide-react';

interface LoadingStateProps {
    message?: string;
    size?: 'sm' | 'md' | 'lg';
}

export function LoadingState({ message = 'Loading...', size = 'md' }: LoadingStateProps) {
    const sizes = {
        sm: 'w-6 h-6',
        md: 'w-12 h-12',
        lg: 'w-16 h-16'
    };

    const textSizes = {
        sm: 'text-sm',
        md: 'text-base',
        lg: 'text-lg'
    };

    return (
        <div className="flex flex-col items-center justify-center gap-4 p-8">
            <Loader2 className={`${sizes[size]} animate-spin text-blue-600`} />
            <p className={`${textSizes[size]} text-slate-500 font-medium`}>{message}</p>
        </div>
    );
}

interface EmptyStateProps {
    icon?: React.ReactNode;
    title: string;
    description?: string;
    action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
    return (
        <div className="empty-state">
            {icon && <div className="empty-state-icon">{icon}</div>}
            <h3 className="text-lg font-semibold text-slate-900 mb-2">{title}</h3>
            {description && <p className="text-slate-500 max-w-md mx-auto mb-4">{description}</p>}
            {action && <div className="mt-4">{action}</div>}
        </div>
    );
}

interface SkeletonProps {
    className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
    return <div className={`skeleton rounded-xl ${className}`} />;
}

export function CardSkeleton() {
    return (
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="space-y-4">
                <Skeleton className="h-4 w-20" />
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-10 w-full" />
            </div>
        </div>
    );
}
