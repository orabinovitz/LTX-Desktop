import React from 'react'
import { cn } from '@/lib/utils'

interface TooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}

const sideClasses: Record<NonNullable<TooltipProps['side']>, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
  left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
  right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
}

/**
 * Lightweight tooltip with a 500ms show delay (best practice) and instant hide.
 * Wrap any icon-only button with <Tooltip content="Label"> to get a styled tooltip.
 */
export function Tooltip({ content, children, side = 'top', className }: TooltipProps) {
  return (
    <div className={cn('relative group/tooltip inline-flex', className)}>
      {children}
      <div
        className={cn(
          'absolute z-[9999] px-2 py-1 bg-zinc-800 border border-zinc-700 rounded text-xs text-white whitespace-nowrap pointer-events-none',
          'opacity-0 transition-opacity duration-100',
          // Show delay: 500ms on hover-in, instant on hover-out
          'group-hover/tooltip:opacity-100 group-hover/tooltip:delay-500',
          sideClasses[side],
        )}
      >
        {content}
      </div>
    </div>
  )
}
