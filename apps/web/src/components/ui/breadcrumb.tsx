import Link from "next/link"
import { ChevronRight, Home } from "lucide-react"

import { cn } from "@/lib/utils"

export interface BreadcrumbItem {
    label: string
    href?: string
}

interface BreadcrumbProps {
    items: BreadcrumbItem[]
    className?: string
}

export function Breadcrumb({ items, className }: BreadcrumbProps) {
    return (
        <nav aria-label="Breadcrumb" className={cn("flex items-center text-sm text-muted-foreground", className)}>
            <Link
                href="/"
                className="flex items-center hover:text-foreground transition-colors"
            >
                <Home className="h-4 w-4" />
                <span className="sr-only">Home</span>
            </Link>
            {items.map((item, index) => (
                <div key={index} className="flex items-center">
                    <ChevronRight className="h-4 w-4 mx-2" />
                    {item.href ? (
                        <Link
                            href={item.href}
                            className="hover:text-foreground transition-colors"
                        >
                            {item.label}
                        </Link>
                    ) : (
                        <span className="text-foreground font-medium">{item.label}</span>
                    )}
                </div>
            ))}
        </nav>
    )
}
