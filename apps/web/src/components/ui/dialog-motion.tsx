'use client';

import * as React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface MotionDialogProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    description?: string;
    children: React.ReactNode;
    className?: string;
}

/**
 * Internal component that uses framer-motion.
 * This is dynamically imported from dialog.tsx to keep framer-motion
 * out of the initial bundle.
 */
export default function MotionDialog({ isOpen, onClose, title, description, children, className }: MotionDialogProps) {
    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={onClose}
                        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 transition-all"
                    />

                    {/* Dialog Content */}
                    <div className="fixed inset-0 flex items-center justify-center z-50 p-4 pointer-events-none">
                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            transition={{ duration: 0.2, ease: "easeOut" }}
                            className={cn(
                                "bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden pointer-events-auto border border-slate-100",
                                className
                            )}
                        >
                            <div className="flex items-center justify-between p-6 border-b border-slate-100">
                                <div>
                                    <h2 className="text-xl font-bold text-slate-900">{title}</h2>
                                    {description && (
                                        <p className="text-sm text-slate-500 mt-1">{description}</p>
                                    )}
                                </div>
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={onClose}
                                    className="h-8 w-8 rounded-full hover:bg-slate-100 text-slate-400 hover:text-slate-600"
                                >
                                    <X className="w-4 h-4" />
                                </Button>
                            </div>
                            <div className="p-6">
                                {children}
                            </div>
                        </motion.div>
                    </div>
                </>
            )}
        </AnimatePresence>
    );
}
