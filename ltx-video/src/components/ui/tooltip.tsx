import React from 'react'
import { cn } from '@/lib/utils'

interface TooltipProps {
  content: React.ReactNode
  children: React.ReactNode
  side?: 'top' | 'bottom' | 'left' | 'right'
  className?: string
}

const sideClasses: Record<NonNullable<TooltipProps['side']>, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
}

/**
 * Lightweight tooltip with a 250ms show delay and instant hide.
 * Wrap any icon-only button with <Tooltip content="Label"> to get a styled tooltip.
 */
export function Tooltip({ content, children, side = 'top', className }: TooltipProps) {
  return (
    <div className={cn('relative group/tooltip inline-flex', className)}>
      {children}
      <div
        className={cn(
          'absolute z-[9999] px-2.5 py-1.5',
          'bg-white text-zinc-800 text-xs font-medium',
          'rounded-md shadow-lg whitespace-nowrap pointer-events-none',
          'opacity-0 transition-opacity duration-150',
          // 250ms delay on hover-in, instant on hover-out
          'group-hover/tooltip:opacity-100 group-hover/tooltip:delay-[250ms]',
          sideClasses[side],
        )}
      >
        {content}
      </div>
    </div>
  )
}
