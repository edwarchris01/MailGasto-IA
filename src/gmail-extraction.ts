import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { CONFIG, Config } from './config.js';
import { gmailClassifierPrompt } from './gmail-prompt.js';
import {
  bankProviders, candidate, categories, gmailBankSenders, gmailIgnoredLabels, gmailModelInput, gmailModelSchema, gmailReceivedDay,
  inspectGmailNotice, paymentMethods, readGmailModel, resolveGmailExtraction, SenderMap,
} from './mail-rules.js';

const response = z.object({
  status: z.literal('completed'),
  output: z.array(z.object({
    type: z.string(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
  })),
});
const sendersSchema = z.record(z.string().regex(/^(?:[a-z0-9._%+-]+)?@[a-z0-9.-]+\.[a-z]{2,}$/i), z.enum(bankProviders));
const instructions = gmailClassifierPrompt(categories, paymentMethods);

export type GmailEmail = { labels: string[]; from: string; subject: string; text: string };

@Injectable()
export class GmailExtraction {
  private readonly senders: SenderMap;

  constructor(@Inject(CONFIG) private readonly config: Config) {
    const configured = sendersSchema.parse(JSON.parse(config.BANK_SENDERS_JSON ?? '{}'));
    this.senders = { ...gmailBankSenders, ...Object.fromEntries(
      Object.entries(configured).map(([address, provider]) => [address.toLowerCase(), provider]),
    ) };
  }

  async classify(email: GmailEmail, useOpenAi: boolean, authenticated: boolean, receivedAt?: string) {
    const notice = gmailIgnoredLabels.some(label => email.labels.includes(label))
      ? null : candidate(email.from, email.subject, email.text, this.senders, authenticated,
        receivedAt ? gmailReceivedDay(receivedAt) : undefined);
    if (!notice) return { status: 'ignored' as const };
    const checked = inspectGmailNotice(notice);
    const local = resolveGmailExtraction(notice, null, true, checked);
    const key = this.config.OPENAI_API_KEY;
    if (!useOpenAi || !key || local.status !== 'pending' || 'avalCopy' in local || notice.unauthenticated ||
        checked.ownTransfer || checked.walletPayout || checked.needsCreditReview || checked.needsPurposeReview) {
      return { provider: notice.provider, forwarded: notice.forwarded, ...local };
    }

    let model: ReturnType<typeof readGmailModel> = null;
    try {
      const result = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model: this.config.OPENAI_GMAIL_MODEL, store: false, max_output_tokens: 900,
          instructions, input: JSON.stringify(gmailModelInput(notice, checked)),
          text: { format: {
            type: 'json_schema', name: 'gmail_movement', strict: true,
            schema: gmailModelSchema,
          } },
        }),
      });
      if (result.ok) {
        const data = response.parse(await result.json());
        const content = data.output.filter(item => item.type === 'message').flatMap(item => item.content ?? []);
        const json = content.find(item => item.type === 'output_text')?.text;
        if (json && !content.some(item => item.type === 'refusal')) model = readGmailModel(JSON.parse(json));
      } else {
        await result.body?.cancel();
        console.warn('OpenAI Gmail extraction HTTP ' + result.status);
      }
    } catch {
      console.warn('OpenAI Gmail extraction did not return a usable response');
    }
    return { provider: notice.provider, forwarded: notice.forwarded, ...resolveGmailExtraction(notice, model, true, checked) };
  }
}
