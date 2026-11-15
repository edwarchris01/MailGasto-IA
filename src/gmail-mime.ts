import { convert } from 'html-to-text';
import { simpleParser } from 'mailparser';
import { hasGmailSenderAuthentication } from './mail-rules.js';

const maxTextSize = 30_000;

export async function readGmailMime(raw: Buffer, labels: string[], snippet = '', includeReceiptPdf = false) {
  const mime = await simpleParser(raw, {
    skipImageLinks: true, skipTextToHtml: true, skipHtmlToText: true,
  });
  const from = mime.from?.value.length === 1 ? (mime.from.value[0].address ?? '').slice(0, 320) : '';
  const subject = (mime.subject ?? '').slice(0, 1000);
  const gmail = mime.headerLines.find(({ key, line }) => key === 'authentication-results' &&
    /^authentication-results:\s*mx\.google\.com\s*;/i.test(line));
  const authenticated = hasGmailSenderAuthentication(gmail?.line, from);
  const text = (mime.text ?? '').replace(/\r\n?/g, '\n').slice(0, maxTextSize);
  const html = mime.html ? convert(mime.html, {
    wordwrap: false, limits: { maxInputLength: 1_500_000, maxDepth: 100 },
    selectors: [{ selector: 'img', format: 'skip' }, { selector: 'a', options: { ignoreHref: true } }],
  }).slice(0, maxTextSize) : '';
  const bodies = [...new Set([text, html].filter(value => value.trim()))];
  if (!bodies.length && snippet.trim()) bodies.push(snippet.slice(0, 500));
  const rawLabels = mime.headers.get('x-gmail-labels');
  return {
    email: { labels, from, subject, text: bodies[0] ?? '' },
    alternative: bodies[1],
    authenticated,
    messageId: mime.messageId,
    headerDate: mime.date,
    exportedLabels: typeof rawLabels === 'string' ? rawLabels : '',
    hasAttachments: mime.attachments.some(item =>
      item.contentDisposition !== 'inline' && (item.filename || item.contentType === 'application/pdf')),
    rapiCreditReceiptPdf: includeReceiptPdf && authenticated && from.toLowerCase() === 'micredito@rapicredit.com'
      ? mime.attachments.filter(item => item.contentDisposition !== 'inline' &&
        item.contentType === 'application/pdf' && /^recibocaja(?:[_ -].*)?\.pdf$/i.test(item.filename ?? '') &&
        item.content.length <= 512 * 1024 && item.content.subarray(0, 5).toString('ascii') === '%PDF-')
        .map(item => item.content)
      : [],
  };
}
