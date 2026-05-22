export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress?: string;
}

export interface JiraStatus {
  name: string;
  statusCategory: { key: "new" | "indeterminate" | "done"; name: string };
}

export interface JiraSubtask {
  id: string;
  key: string;
  fields: {
    summary: string;
    status: JiraStatus;
    issuetype?: { name: string; subtask?: boolean };
  };
}

export interface JiraIssueFields {
  summary: string;
  status: JiraStatus;
  assignee: JiraUser | null;
  priority?: { name: string } | null;
  duedate?: string | null;
  issuetype?: { name: string; subtask?: boolean };
  updated?: string;
  created?: string;
  resolutiondate?: string | null;
  labels?: string[];
  subtasks?: JiraSubtask[];
  parent?: {
    id: string;
    key: string;
    fields?: { summary?: string; issuetype?: { name: string } };
  };
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: JiraIssueFields;
}

export interface JiraChangelogItem {
  field: string;
  fieldtype: string;
  from: string | null;
  fromString: string | null;
  to: string | null;
  toString: string | null;
}

export interface JiraChangelogEntry {
  id: string;
  author: JiraUser;
  created: string;
  items: JiraChangelogItem[];
}

export interface JiraSprint {
  id: number;
  name: string;
  state: "active" | "closed" | "future";
  startDate?: string;
  endDate?: string;
  boardId?: number;
}

export interface JiraBoard {
  id: number;
  name: string;
  type: string;
  location?: { projectKey?: string };
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface SprintDigestTask {
  key: string;
  summary: string;
  assignee: string;
  labels: string[];
  status: string;
  priority?: string;
  duedate?: string | null;
  blocked: boolean;
  hoursInProgress?: number | null;
  inProgressSince?: string | null;
  subtaskProgress?: { done: number; total: number } | null;
  issueType?: string;
  createdAt?: string | null;
}

export interface LeaderboardEntry {
  name: string;
  role?: string | null;
  hours: number;
  tasks: number;
  hasHours: boolean;
}

export interface ProjectDigest {
  projectKey: string;
  projectName: string;
  sprint: JiraSprint;
  dayNumber: number;
  totalDays: number;
  counts: { todo: number; inProgress: number; done: number; total: number };
  completedInWindow: SprintDigestTask[];
  todo: SprintDigestTask[];
  inProgress: SprintDigestTask[];
  doneAll: SprintDigestTask[];
  leaderboard: LeaderboardEntry[];
  windowSince: Date;
  windowUntil: Date;
  timezone: string;
  llmNote?: string | null;
  briefNotes?: { items: string[] } | null;
  scopeCreep?: ScopeCreepInfo | null;
}

export interface ScopeCreepAddedTask {
  task: SprintDigestTask;
  addedAt: string;
  bucket: "todo" | "inProgress" | "done";
  parentKey?: string;
  parentSummary?: string;
}

export interface ScopeCreepInfo {
  baselineTotal: number;
  added: ScopeCreepAddedTask[];
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  entities?: Array<{ type: string; offset: number; length: number }>;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}
