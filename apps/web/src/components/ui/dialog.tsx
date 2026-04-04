'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Dynamic import for framer-motion - only loaded when dialog is opened
// Reduces initial bundle by ~30KB gzipped
const MotionDialog = dynamic(() => import('./dialog-motion'), { ssr: false });

interface DialogProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    description?: string;
    children: React.ReactNode;
    className?: string;
}

export function Dialog({ isOpen, onClose, title, description, children, className }: DialogProps) {
    // Close on escape key
    React.useEffect(() => {
        const handleEscape = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        if (isOpen) {
            document.addEventListener('keydown', handleEscape);
            document.body.style.overflow = 'hidden';
        }
        return () => {
            document.removeEventListener('keydown', handleEscape);
            document.body.style.overflow = 'unset';
        };
    }, [isOpen, onClose]);

    // Use dynamic import to lazy-load framer-motion only when dialog opens
    return <MotionDialog isOpen={isOpen} onClose={onClose} title={title} description={description} className={className}>{children}</MotionDialog>;
}

interface DialogFooterProps {
    children: React.ReactNode;
    className?: string;
}

export function DialogFooter({ children, className }: DialogFooterProps) {
    return (
        <div className={cn("flex flex-col-reverse sm:flex-row sm:justify-end gap-3 mt-6", className)}>
            {children}
        </div>
    );
}
