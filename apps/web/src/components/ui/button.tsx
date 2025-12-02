import * as React from "react"
import { cn } from "@/lib/utils"

const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost' | 'destructive' | 'secondary' | 'success', size?: 'default' | 'sm' | 'lg' | 'icon' }>(
    ({ className, variant = 'default', size = 'default', ...props }, ref) => {
        const variants = {
            default: "bg-blue-600 text-white hover:bg-blue-700 shadow-sm shadow-blue-600/10 hover:shadow-md hover:shadow-blue-600/20 active:scale-[0.98]",
            outline: "border border-slate-200 bg-white hover:bg-slate-50 hover:border-slate-300 text-slate-900 active:scale-[0.98]",
            ghost: "hover:bg-slate-100 text-slate-700 hover:text-slate-900 active:scale-[0.98]",
            destructive: "bg-red-500 text-white hover:bg-red-600 shadow-sm shadow-red-500/10 hover:shadow-md hover:shadow-red-500/20 active:scale-[0.98]",
            secondary: "bg-slate-100 text-slate-900 hover:bg-slate-200 active:scale-[0.98]",
            success: "bg-green-600 text-white hover:bg-green-700 shadow-sm shadow-green-600/10 hover:shadow-md hover:shadow-green-600/20 active:scale-[0.98]",
        }
        const sizes = {
            default: "h-10 px-4 py-2",
            sm: "h-9 rounded-md px-3 text-sm",
            lg: "h-11 rounded-lg px-8 text-base font-semibold",
            icon: "h-10 w-10",
        }
        return (
            <button
                className={cn(
                    "inline-flex items-center justify-center whitespace-nowrap rounded-lg text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed",
                    variants[variant],
                    sizes[size],
                    className
                )}
                ref={ref}
                {...props}
            />
        )
    }
)
Button.displayName = "Button"

export { Button }
