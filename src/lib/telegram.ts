/**
 * Telegram Bot API helpers
 * Uses the token from TELEGRAM_BOT_TOKEN env var.
 */

const BASE = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

async function call(method: string, body: object) {
  const res = await fetch(`${BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) console.error(`Telegram [${method}]:`, json);
  return json;
}

// ─── Inline keyboard types ────────────────────────────────────────────────────

export interface InlineButton {
  text: string;
  callback_data?: string;
  pay?: boolean;            // marks a "Pay" button on invoice messages
}

export type InlineKeyboard = InlineButton[][];

// ─── Message helpers ──────────────────────────────────────────────────────────

export async function sendMessage(
  chatId: number,
  text: string,
  parseMode = "HTML",
  replyMarkup?: { inline_keyboard: InlineKeyboard }
) {
  return call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: parseMode,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });
}

/** Convenience: send a message with a single row of inline buttons */
export async function sendMessageWithButtons(
  chatId: number,
  text: string,
  buttons: InlineButton[],
  parseMode = "HTML"
) {
  return sendMessage(chatId, text, parseMode, {
    inline_keyboard: [buttons],
  });
}

// ─── Invoice helpers ──────────────────────────────────────────────────────────

export async function sendInvoice(
  chatId: number,
  title: string,
  description: string,
  payload: string,
  starAmount: number
) {
  return call("sendInvoice", {
    chat_id: chatId,
    title,
    description,
    payload,
    currency: "XTR",
    prices: [{ label: title, amount: starAmount }],
    provider_token: "",
  });
}

// ─── Callback query ───────────────────────────────────────────────────────────

/** Acknowledge an inline button press (must be called within 10 s) */
export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  showAlert = false
) {
  return call("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text, show_alert: showAlert } : {}),
  });
}

// ─── Checkout helpers ─────────────────────────────────────────────────────────

export async function answerPreCheckoutQuery(
  preCheckoutQueryId: string,
  ok: boolean,
  errorMessage?: string
) {
  return call("answerPreCheckoutQuery", {
    pre_checkout_query_id: preCheckoutQueryId,
    ok,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  });
}

// ─── Webhook setup ────────────────────────────────────────────────────────────

export async function setWebhook(url: string, secret: string) {
  return call("setWebhook", {
    url,
    secret_token: secret,
    allowed_updates: ["message", "pre_checkout_query", "callback_query"],
  });
}
