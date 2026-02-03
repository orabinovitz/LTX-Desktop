import * as React from 'react'
import { cn } from '@/lib/utils'

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  helperText?: string
  charCount?: number
  maxChars?: number
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, helperText, charCount, maxChars, ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="block text-xs font-medium text-muted-foreground mb-1.5 uppercase tracking-wide">
            {label}
          </label>
        )}
        <textarea
          className={cn(
            'flex min-h-[120px] w-full rounded-md border border-border bg-input px-3 py-2 text-sm text-foreground',
            'placeholder:text-muted-foreground',
            'focus:outline-none focus:ring-1 focus:ring-primary',
            'disabled:cursor-not-allowed disabled:opacity-50',
            'resize-none',
            className
          )}
          ref={ref}
          {...props}
        />
        <div className="flex justify-between mt-1.5">
          {helperText && (
            <span className="text-xs text-muted-foreground">{helperText}</span>
          )}
          {maxChars !== undefined && (
            <span className="text-xs text-muted-foreground ml-auto">
              {charCount ?? 0}/{maxChars}
            </span>
          )}
        </div>
      </div>
    )
  }
)
Textarea.displayName = 'Textarea'

export { Textarea }
