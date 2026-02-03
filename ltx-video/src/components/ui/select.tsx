import * as React from 'react'
import { cn } from '@/lib/utils'
import { ChevronDown } from 'lucide-react'

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, children, ...props }, ref) => {
    return (
      <div className="relative">
        {label && (
          <label className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">
            {label}
          </label>
        )}
        <div className="relative">
          <select
            className={cn(
              'flex h-9 w-full appearance-none rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground',
              'focus:outline-none focus:ring-1 focus:ring-primary',
              'disabled:cursor-not-allowed disabled:opacity-50',
              'pr-8',
              className
            )}
            ref={ref}
            {...props}
          >
            {children}
          </select>
          <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        </div>
      </div>
    )
  }
)
Select.displayName = 'Select'

export { Select }
