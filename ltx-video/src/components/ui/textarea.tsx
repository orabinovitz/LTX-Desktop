import * as React from "react";
import { cn } from "@/lib/utils";

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  helperText?: string;
  charCount?: number;
  maxChars?: number;
}

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, label, helperText, charCount, maxChars, ...props }, ref) => {
    return (
      <div className="w-full">
        {label && (
          <label className="mb-2 block text-[12px] font-semibold uppercase leading-4 text-zinc-500">
            {label}
          </label>
        )}
        <textarea
          className={cn(
            "flex min-h-[120px] w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-3 text-sm text-white",
            "placeholder:text-zinc-500",
            "focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500",
            "disabled:cursor-not-allowed disabled:opacity-50",
            "resize-y",
            className,
          )}
          ref={ref}
          {...props}
        />
        <div className="mt-2 flex justify-between">
          {helperText && (
            <span className="text-xs text-zinc-500">{helperText}</span>
          )}
          {maxChars !== undefined && (
            <span className="ml-auto text-xs text-zinc-500">
              {charCount ?? 0}/{maxChars}
            </span>
          )}
        </div>
      </div>
    );
  },
);
Textarea.displayName = "Textarea";

export { Textarea };
