import type { Bot } from "grammy";

const TELEGRAM_DRAFT_MAX_CHARS = 4096;
const DEFAULT_THROTTLE_MS = 300;

/**
 * Sanitize draft text to prevent raw API errors from being shown in typing previews.
 * This is a final safety net - errors should be formatted earlier in the pipeline.
 */
function sanitizeDraftText(text: string): string {
  const trimmed = text.trim();

  // Pattern 1: HTTP status code errors (e.g., "400 Incorrect role information")
  if (/^\d{3}\s+/i.test(trimmed)) {
    console.warn("[Telegram/Draft] Blocked raw API error from draft preview:", trimmed.slice(0, 100));
    return "An error occurred. Please try again or use /new to start a fresh session.";
  }

  // Pattern 2: Role ordering errors that escaped earlier formatting
  if (/incorrect role information|roles must alternate/i.test(trimmed)) {
    return "Message ordering conflict - please try again. If this persists, use /new to start a fresh session.";
  }

  return text;
}

export type TelegramDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  stop: () => void;
};

export function createTelegramDraftStream(params: {
  api: Bot["api"];
  chatId: number;
  draftId: number;
  maxChars?: number;
  messageThreadId?: number;
  throttleMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): TelegramDraftStream {
  const maxChars = Math.min(params.maxChars ?? TELEGRAM_DRAFT_MAX_CHARS, TELEGRAM_DRAFT_MAX_CHARS);
  const throttleMs = Math.max(50, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const rawDraftId = Number.isFinite(params.draftId) ? Math.trunc(params.draftId) : 1;
  const draftId = rawDraftId === 0 ? 1 : Math.abs(rawDraftId);
  const chatId = params.chatId;
  const threadParams =
    typeof params.messageThreadId === "number"
      ? { message_thread_id: Math.trunc(params.messageThreadId) }
      : undefined;

  let lastSentText = "";
  let lastSentAt = 0;
  let pendingText = "";
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const sendDraft = async (text: string) => {
    if (stopped) return;
    const trimmed = text.trimEnd();
    if (!trimmed) return;
    if (trimmed.length > maxChars) {
      // Drafts are capped at 4096 chars. Stop streaming once we exceed the cap
      // so we don't keep sending failing updates or a truncated preview.
      stopped = true;
      params.warn?.(`telegram draft stream stopped (draft length ${trimmed.length} > ${maxChars})`);
      return;
    }

    const sanitized = sanitizeDraftText(trimmed);
    if (sanitized === lastSentText) return;
    lastSentText = sanitized;
    lastSentAt = Date.now();
    try {
      await params.api.sendMessageDraft(chatId, draftId, sanitized, threadParams);
    } catch (err) {
      stopped = true;
      params.warn?.(
        `telegram draft stream failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (inFlight) {
      schedule();
      return;
    }
    const text = pendingText;
    pendingText = "";
    if (!text.trim()) {
      if (pendingText) schedule();
      return;
    }
    inFlight = true;
    try {
      await sendDraft(text);
    } finally {
      inFlight = false;
    }
    if (pendingText) schedule();
  };

  const schedule = () => {
    if (timer) return;
    const delay = Math.max(0, throttleMs - (Date.now() - lastSentAt));
    timer = setTimeout(() => {
      void flush();
    }, delay);
  };

  const update = (text: string) => {
    if (stopped) return;
    pendingText = text;
    if (inFlight) {
      schedule();
      return;
    }
    if (!timer && Date.now() - lastSentAt >= throttleMs) {
      void flush();
      return;
    }
    schedule();
  };

  const stop = () => {
    stopped = true;
    pendingText = "";
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  params.log?.(
    `telegram draft stream ready (draftId=${draftId}, maxChars=${maxChars}, throttleMs=${throttleMs})`,
  );

  return { update, flush, stop };
}
