import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Button } from './button'
import React from 'react'

describe('Button Component', () => {
    it('should render correctly', () => {
        render(<Button>Click me</Button>)
        const button = screen.getByRole('button', { name: /click me/i })
        expect(button).toBeInTheDocument()
    })

    it('should handle click events', () => {
        const handleClick = vi.fn()
        render(<Button onClick={handleClick}>Click me</Button>)
        const button = screen.getByRole('button', { name: /click me/i })
        fireEvent.click(button)
        expect(handleClick).toHaveBeenCalledTimes(1)
    })

    it('should apply variant classes', () => {
        render(<Button variant="destructive">Delete</Button>)
        const button = screen.getByRole('button', { name: /delete/i })
        expect(button).toHaveClass('bg-red-500')
    })
})
