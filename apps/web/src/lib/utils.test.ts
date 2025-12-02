import { describe, it, expect } from 'vitest'
import { cn } from './utils'

describe('cn utility', () => {
    it('should merge class names correctly', () => {
        const result = cn('bg-red-500', 'text-white')
        expect(result).toBe('bg-red-500 text-white')
    })

    it('should handle conditional classes', () => {
        const result = cn('bg-red-500', true && 'text-white', false && 'hidden')
        expect(result).toBe('bg-red-500 text-white')
    })

    it('should merge tailwind classes correctly (override)', () => {
        const result = cn('bg-red-500', 'bg-blue-500')
        expect(result).toBe('bg-blue-500')
    })
})
