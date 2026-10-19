// Shared shapes for the agent's AskUserQuestion dialog (onUserDialog bridge).
// Kept out of ipc-contract.ts so the contract only references them.

export interface UserQuestionOption {
  label: string
  description: string
}

export interface UserQuestion {
  question: string
  header: string
  multiSelect: boolean
  options: UserQuestionOption[]
}

/** The user's answer to one question: the selected option labels (or "Other" free text). */
export interface UserQuestionAnswer {
  header: string
  selected: string[]
}

/** A pending question the agent asked, rendered by the conversation pane. */
export interface UserQuestionRequest {
  requestId: string
  threadId: string
  questions: UserQuestion[]
}

/** Parked questions were cancelled (the user sent a message instead of answering,
 *  #692) — the conversation pane drops the matching cards. */
export interface UserDialogCancel {
  threadId: string
  requestIds: string[]
}
