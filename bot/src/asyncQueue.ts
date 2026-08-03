import { Telegraf } from "telegraf";

interface QueueItem {
  chatId: string | number;
  text: string;
  extra?: any;
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
}

export class TelegramAsyncQueue {
  private queue: QueueItem[] = [];
  private isProcessing = false;
  private bot: Telegraf;
  private delayMs: number;

  constructor(bot: Telegraf, delayMs = 40) {
    this.bot = bot;
    this.delayMs = delayMs;
  }

  public sendMessage(chatId: string | number, text: string, extra?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.queue.push({ chatId, text, extra, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      try {
        const res = await this.bot.telegram.sendMessage(item.chatId, item.text, {
          parse_mode: "HTML",
          ...item.extra,
        });
        item.resolve(res);
      } catch (error: any) {
        // Handle Telegram 429 Too Many Requests rate limits
        if (error?.response?.error_code === 429 || error?.code === 429) {
          const retryAfter = (error?.response?.parameters?.retry_after || 2) * 1000;
          console.warn(`[TelegramQueue] Rate limit hit (429). Retrying after ${retryAfter}ms...`);
          // Re-insert item at the top of queue
          this.queue.unshift(item);
          await new Promise((r) => setTimeout(r, retryAfter));
        } else {
          console.error(
            `[TelegramQueue] Error sending message to ${item.chatId}:`,
            error?.message || error
          );
          item.reject(error);
        }
      }

      await new Promise((r) => setTimeout(r, this.delayMs));
    }

    this.isProcessing = false;
  }
}
