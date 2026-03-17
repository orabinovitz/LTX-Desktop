import { useState, useCallback } from "react";
import { ArrowRight, SkipForward, MessageCircleQuestion } from "lucide-react";
import type {
  ClarificationQuestion,
  ClarificationAnswer,
} from "@/types/clarification";

interface ClarificationViewProps {
  questions: ClarificationQuestion[];
  onSubmit: (answers: ClarificationAnswer[]) => void;
}

export function ClarificationView({
  questions,
  onSubmit,
}: ClarificationViewProps) {
  const [answers, setAnswers] = useState<Map<string, ClarificationAnswer>>(
    () =>
      new Map(
        questions.map((q) => [
          q.id,
          {
            question_id: q.id,
            selected_option_id: null,
            custom_answer: null,
            skipped: false,
          },
        ]),
      ),
  );

  const [customInputVisible, setCustomInputVisible] = useState<Set<string>>(
    new Set(),
  );

  const updateAnswer = useCallback(
    (questionId: string, update: Partial<ClarificationAnswer>) => {
      setAnswers((prev) => {
        const next = new Map(prev);
        const existing = next.get(questionId);
        if (existing) {
          next.set(questionId, { ...existing, ...update });
        }
        return next;
      });
    },
    [],
  );

  const selectOption = useCallback(
    (questionId: string, optionId: string) => {
      updateAnswer(questionId, {
        selected_option_id: optionId,
        custom_answer: null,
        skipped: false,
      });
      setCustomInputVisible((prev) => {
        const next = new Set(prev);
        next.delete(questionId);
        return next;
      });
    },
    [updateAnswer],
  );

  const toggleCustomInput = useCallback((questionId: string) => {
    setCustomInputVisible((prev) => {
      const next = new Set(prev);
      if (next.has(questionId)) {
        next.delete(questionId);
      } else {
        next.add(questionId);
      }
      return next;
    });
    setAnswers((prev) => {
      const next = new Map(prev);
      const existing = next.get(questionId);
      if (existing) {
        next.set(questionId, {
          ...existing,
          selected_option_id: null,
          skipped: false,
        });
      }
      return next;
    });
  }, []);

  const skipQuestion = useCallback(
    (questionId: string) => {
      updateAnswer(questionId, {
        selected_option_id: null,
        custom_answer: null,
        skipped: true,
      });
      setCustomInputVisible((prev) => {
        const next = new Set(prev);
        next.delete(questionId);
        return next;
      });
    },
    [updateAnswer],
  );

  const handleSubmit = useCallback(() => {
    onSubmit(Array.from(answers.values()));
  }, [answers, onSubmit]);

  const handleSkipAll = useCallback(() => {
    const skippedAnswers: ClarificationAnswer[] = questions.map((q) => ({
      question_id: q.id,
      selected_option_id: null,
      custom_answer: null,
      skipped: true,
    }));
    onSubmit(skippedAnswers);
  }, [questions, onSubmit]);

  const hasAnyAnswer = Array.from(answers.values()).some(
    (a) => !a.skipped && (a.selected_option_id || a.custom_answer),
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-1.5">
        <MessageCircleQuestion className="h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
        <p className="text-[11px] font-semibold text-amber-400/90">
          A few questions before I start:
        </p>
      </div>

      {questions.map((q, idx) => {
        const answer = answers.get(q.id);
        const isSkipped = answer?.skipped ?? false;
        const showCustom = customInputVisible.has(q.id);

        return (
          <div
            key={q.id}
            className={`rounded-lg border px-3 py-2.5 transition-colors ${
              isSkipped
                ? "border-zinc-800 bg-zinc-900/50 opacity-60"
                : "border-zinc-700/60 bg-zinc-800/50"
            }`}
          >
            <div className="mb-2 flex items-start justify-between gap-2">
              <p className="text-[11px] font-medium text-zinc-200">
                <span className="mr-1.5 text-zinc-500">{idx + 1}.</span>
                {q.question}
              </p>
              <button
                onClick={() => skipQuestion(q.id)}
                className={`flex-shrink-0 text-[10px] transition-colors ${
                  isSkipped
                    ? "text-zinc-500"
                    : "text-zinc-500 hover:text-zinc-300"
                }`}
                title="Skip this question"
              >
                {isSkipped ? "Skipped" : "Skip"}
              </button>
            </div>

            {!isSkipped && (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {q.options.map((opt) => (
                    <button
                      key={opt.id}
                      onClick={() => selectOption(q.id, opt.id)}
                      className={`rounded-md px-2.5 py-1 text-[10px] transition-all ${
                        answer?.selected_option_id === opt.id
                          ? "bg-blue-600 text-white"
                          : "bg-zinc-700/70 text-zinc-300 hover:bg-zinc-700"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}

                  {q.allow_custom && (
                    <button
                      onClick={() => toggleCustomInput(q.id)}
                      className={`rounded-md px-2.5 py-1 text-[10px] transition-all ${
                        showCustom
                          ? "bg-zinc-600 text-zinc-200"
                          : "bg-zinc-700/40 text-zinc-500 hover:bg-zinc-700/70 hover:text-zinc-300"
                      }`}
                    >
                      Other...
                    </button>
                  )}
                </div>

                {showCustom && (
                  <input
                    type="text"
                    value={answer?.custom_answer ?? ""}
                    onChange={(e) =>
                      updateAnswer(q.id, {
                        custom_answer: e.target.value.slice(0, 500),
                        selected_option_id: null,
                        skipped: false,
                      })
                    }
                    onKeyDown={(e) => e.stopPropagation()}
                    placeholder="Type your answer..."
                    className="mt-2 w-full rounded-md border border-zinc-600 bg-zinc-800 px-2.5 py-1.5 text-[11px] text-zinc-200 placeholder-zinc-500 outline-none focus:border-blue-500"
                    maxLength={500}
                    autoFocus
                  />
                )}
              </>
            )}
          </div>
        );
      })}

      <div className="flex items-center justify-between pt-1">
        <button
          onClick={handleSkipAll}
          className="flex items-center gap-1 text-[10px] text-zinc-500 transition-colors hover:text-zinc-300"
        >
          <SkipForward className="h-3 w-3" />
          Skip all & execute
        </button>

        <button
          onClick={handleSubmit}
          disabled={!hasAnyAnswer}
          className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          Continue
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
