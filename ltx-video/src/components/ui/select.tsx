import * as React from "react";
import { cn } from "@/lib/utils";
import { ChevronDown } from "lucide-react";

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  badge?: string;
}

const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, label, badge, children, ...props }, ref) => {
    return (
      <div className="relative">
        {label && (
          <label className="mb-2 flex h-4 items-center gap-2 text-[12px] font-semibold uppercase leading-4 text-zinc-500">
            {label}
            {badge && (
              <span className="rounded border border-zinc-600 bg-zinc-700 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-zinc-300">
                {badge}
              </span>
            )}
          </label>
        )}
        <div className="relative">
          <select
            className={cn(
              "flex h-10 w-full appearance-none rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white",
              "focus:border-zinc-500 focus:outline-none focus:ring-1 focus:ring-zinc-500",
              "disabled:cursor-not-allowed disabled:opacity-50",
              "cursor-pointer pr-8",
              "[&>option:disabled]:text-zinc-500 [&>option]:bg-zinc-800 [&>option]:text-white",
              className,
            )}
            ref={ref}
            {...props}
          >
            {children}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-400" />
        </div>
      </div>
    );
  },
);
Select.displayName = "Select";

export { Select };
