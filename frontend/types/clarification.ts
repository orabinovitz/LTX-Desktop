export interface ClarificationOption {
  id: string;
  label: string;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  options: ClarificationOption[];
  allow_custom: boolean;
}

export interface ClarifyResponse {
  needs_clarification: boolean;
  questions: ClarificationQuestion[];
}

export interface ClarificationAnswer {
  question_id: string;
  selected_option_id: string | null;
  custom_answer: string | null;
  skipped: boolean;
}

export interface ClarificationState {
  questions: ClarificationQuestion[];
  originalPrompt: string;
  displayPrompt: string;
}
