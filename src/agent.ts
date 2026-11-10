import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CONFIG, Config } from './config.js';
import { category, NoticeText } from './extraction.js';

export const intent = z.object({
  action: z.enum(['summary', 'register', 'unknown']),
  period: z.enum(['today', 'yesterday', 'week', 'month', 'last_month', 'all', 'inherit']).nullable(),
  category: category.nullable(),
  date: z.iso.date().nullable(),
});

@Injectable()
export class Agent {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  extract(notice: NoticeText) {
    return this.invoke('mailgasto-private-extract', { provider: notice.provider, text: notice.text });
  }

  understand(text: string, hasContext: boolean) {
    return this.invoke('mailgasto-private-intent', { text, hasContext });
  }

  private async invoke(route: string, body: object) {
    if (!this.config.N8N_AGENT_URL) throw new Error('n8n is not configured');
    const response = await fetch(this.config.N8N_AGENT_URL.replace(/\/+$/, '') + '/' + route, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.N8N_AGENT_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', 'X-MailGasto-Agent': this.config.N8N_AGENT_KEY },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error('n8n request failed');
    const result = z.object({ result: z.unknown().optional(), failed: z.boolean().optional() }).parse(await response.json());
    if (result.failed || result.result == null) throw new Error('n8n returned no result');
    return result.result;
  }
}
