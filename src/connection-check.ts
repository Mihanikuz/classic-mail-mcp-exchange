import { ImapFlow } from 'imapflow';
import type { Account } from './config.js';
import nodemailer from 'nodemailer';
import { imapOptions, smtpOptions } from './mail.js';

export function safeFailure(error: unknown): string {
  const e = error as { code?: string; authenticationFailed?: boolean; responseCode?: number };
  if (e?.authenticationFailed || e?.code === 'EAUTH' || e?.responseCode === 535)
    return 'authentication_rejected';
  if (['ETIMEDOUT', 'ETIMEOUT'].includes(e?.code ?? '')) return 'timeout';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(e?.code ?? '')) return 'dns_error';
  if (['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH'].includes(e?.code ?? ''))
    return 'connection_error';
  if (
    [
      'CERT_HAS_EXPIRED',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'ERR_TLS_CERT_ALTNAME_INVALID',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    ].includes(e?.code ?? '')
  )
    return 'certificate_error';
  return 'check_failed';
}

/** Independent IMAP and SMTP authentication checks. No mail content is fetched or changed. */
export async function checkAccount(a: Account) {
  const results: Array<{ account: string; protocol: string; ok: boolean; reason?: string }> = [];
  const imap = new ImapFlow(imapOptions(a));
  imap.on('error', () => {});
  try {
    await imap.connect();
    results.push({ account: a.id, protocol: 'imap', ok: true });
  } catch (e) {
    results.push({ account: a.id, protocol: 'imap', ok: false, reason: safeFailure(e) });
  } finally {
    try {
      await imap.logout();
    } catch {
      imap.close();
    }
  }
  const smtp = nodemailer.createTransport(smtpOptions(a));
  try {
    await smtp.verify();
    results.push({ account: a.id, protocol: 'smtp', ok: true });
  } catch (e) {
    results.push({ account: a.id, protocol: 'smtp', ok: false, reason: safeFailure(e) });
  } finally {
    smtp.close();
  }
  return results;
}
