import { createHmac } from 'node:crypto';

// Preserve the Gmail namespace to match its existing protected references across channels.
export function operationFingerprint(reference: string, account: string, key: Buffer) {
  return createHmac('sha256', key).update('gmail-operation\0' + account + '\0' + reference).digest('hex');
}
