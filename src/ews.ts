// Read-only Exchange Web Services backend. Same tool contract as MailService read tools.
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import { accountSchema, folderSchema, type Account } from './config.js';
import { MailError, LIMITS, CONTENT_TRUST } from './mail.js';

type Fetch = typeof fetch;
type Folder = {
  id: string;
  parent: string;
  name: string;
  path: string;
  total: number;
  unread: number;
};
const ITEM_TYPES =
  'Message|MeetingRequest|MeetingResponse|MeetingCancellation|MeetingMessage|PostItem|Task|Contact|DistributionList|CalendarItem|Item';
const ITEM_RE = new RegExp(`<t:(${ITEM_TYPES})(?:\\s[^>]*)?>([\\s\\S]*?)</t:\\1>`, 'g');
const WELL_KNOWN = ['inbox', 'sentitems', 'drafts', 'deleteditems', 'junkemail', 'outbox'] as const;

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!,
  );
const unesc = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
const clip = (s: unknown, max = 1000) => (typeof s === 'string' ? s.slice(0, max) : undefined);
function blocks(xml: string, name: string) {
  return [
    ...xml.matchAll(new RegExp(`<[a-z]+:${name}(?:\\s[^>]*)?>([\\s\\S]*?)</[a-z]+:${name}>`, 'g')),
  ].map((m) => m[1]);
}
function text(xml: string, name: string) {
  const m = new RegExp(`<[a-z]+:${name}(?:\\s[^>]*)?>([\\s\\S]*?)</[a-z]+:${name}>`).exec(xml);
  return m ? unesc(m[1]) : undefined;
}
function attr(xml: string, el: string, a: string) {
  const m = new RegExp(`<[a-z]+:${el}\\s[^>]*?\\b${a}="([^"]*)"`).exec(xml);
  return m ? unesc(m[1]) : undefined;
}

const refSchema = z.object({ account: z.string(), item: z.string().min(1).max(1400) });
function encodeId(account: string, item: string) {
  return Buffer.from(JSON.stringify({ account, item })).toString('base64url');
}
function decodeId(id: string, account: string) {
  try {
    if (id.length > 2000 || !/^[A-Za-z0-9_-]+$/.test(id)) throw new MailError('Invalid message ID');
    const r = refSchema.parse(JSON.parse(Buffer.from(id, 'base64url').toString()));
    if (r.account !== account) throw new MailError('Message belongs to another account');
    return r.item;
  } catch (e) {
    if (e instanceof MailError) throw e;
    throw new MailError('Invalid message ID');
  }
}

export class EwsMailService {
  private accounts: Account[];
  private active = 0;
  private folderCache = new Map<
    string,
    { at: number; folders: Folder[]; known: Record<string, string> }
  >();
  constructor(
    accounts: Account[],
    private doFetch: Fetch = fetch,
  ) {
    this.accounts = accounts.map((a) => accountSchema.parse(a));
  }
  private account(id: string) {
    const a = this.accounts.find((a) => a.id === id);
    if (!a) throw new MailError('Unknown account');
    return a;
  }
  listAccounts() {
    return this.accounts.map((a) => ({
      id: a.id,
      email: a.email,
      name: a.name,
      allowedFolders: a.allowedFolders ? [...a.allowedFolders] : [],
      allFolders: !a.allowedFolders,
    }));
  }
  private async call(a: Account, body: string, tolerant = false) {
    if (this.active >= 4) throw new MailError('Too many concurrent mail requests');
    this.active++;
    try {
      const envelope =
        '<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
        'xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" ' +
        'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">' +
        '<soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></soap:Header>' +
        `<soap:Body>${body}</soap:Body></soap:Envelope>`;
      let res: Response;
      try {
        res = await this.doFetch(`https://${a.imapHost}/EWS/Exchange.asmx`, {
          method: 'POST',
          headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            Authorization: 'Basic ' + Buffer.from(`${a.username}:${a.password}`).toString('base64'),
          },
          body: envelope,
          redirect: 'error',
          signal: AbortSignal.timeout(60000),
        });
      } catch {
        throw new MailError('Exchange server unreachable or timed out');
      }
      if (res.status === 401) throw new MailError('Exchange rejected the mailbox credentials');
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > LIMITS.message * 1.5) throw new MailError('Exchange response too large');
      const xml = await res.text();
      if (xml.length > LIMITS.message * 1.5) throw new MailError('Exchange response too large');
      if (!res.ok && !/ResponseClass=/.test(xml))
        throw new MailError(`Exchange HTTP error ${res.status}`);
      const bad = /ResponseClass="Error"[\s\S]*?<m:ResponseCode>([A-Za-z]+)<\/m:ResponseCode>/.exec(
        xml,
      );
      if (bad && !tolerant) throw new MailError(`Exchange error: ${bad[1]}`);
      return xml;
    } finally {
      this.active--;
    }
  }
  private async folders(account: string) {
    const cached = this.folderCache.get(account);
    if (cached && Date.now() - cached.at < 300000) return cached;
    const a = this.account(account);
    const props =
      '<t:AdditionalProperties><t:FieldURI FieldURI="folder:DisplayName"/><t:FieldURI FieldURI="folder:ParentFolderId"/>' +
      '<t:FieldURI FieldURI="folder:TotalCount"/><t:FieldURI FieldURI="folder:UnreadCount"/><t:FieldURI FieldURI="folder:FolderClass"/></t:AdditionalProperties>';
    const all: string[] = [];
    for (let offset = 0; offset < 5000; ) {
      const xml = await this.call(
        a,
        `<m:FindFolder Traversal="Deep"><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape>${props}</m:FolderShape>` +
          `<m:IndexedPageFolderView MaxEntriesReturned="500" Offset="${offset}" BasePoint="Beginning"/>` +
          '<m:ParentFolderIds><t:DistinguishedFolderId Id="msgfolderroot"/></m:ParentFolderIds></m:FindFolder>',
      );
      const page = blocks(xml, 'Folder');
      all.push(...page);
      if (/IncludesLastItemInRange="true"/.test(xml) || page.length === 0) break;
      offset += page.length;
    }
    const raw = all
      .filter((f) => {
        const cls = text(f, 'FolderClass');
        return !cls || cls === 'IPF.Note' || cls.startsWith('IPF.Note.');
      })
      .map((f) => ({
        id: attr(f, 'FolderId', 'Id') ?? '',
        parent: attr(f, 'ParentFolderId', 'Id') ?? '',
        name: text(f, 'DisplayName') ?? '',
        total: Number(text(f, 'TotalCount') ?? 0),
        unread: Number(text(f, 'UnreadCount') ?? 0),
      }))
      .filter((f) => f.id);
    const byId = new Map(raw.map((f) => [f.id, f]));
    const pathOf = (f: (typeof raw)[number], depth = 0): string => {
      const p = byId.get(f.parent);
      return p && depth < 20 ? `${pathOf(p, depth + 1)}/${f.name}` : f.name;
    };
    const folders: Folder[] = raw.map((f) => ({ ...f, path: pathOf(f) }));
    const knownXml = await this.call(
      a,
      '<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape><m:FolderIds>' +
        WELL_KNOWN.map((w) => `<t:DistinguishedFolderId Id="${w}"/>`).join('') +
        '</m:FolderIds></m:GetFolder>',
      true,
    ).catch(() => '');
    const known: Record<string, string> = {};
    blocks(knownXml, 'GetFolderResponseMessage').forEach((m, i) => {
      // Error responses carry no FolderId, so a present id means success for that entry.
      const id = attr(m, 'FolderId', 'Id');
      if (id) known[WELL_KNOWN[i]] = id;
    });
    const entry = { at: Date.now(), folders, known };
    this.folderCache.set(account, entry);
    return entry;
  }
  private async resolveFolder(account: string, folder: string) {
    if (!folderSchema.safeParse(folder).success) throw new MailError('Folder not allowed');
    const a = this.account(account);
    const { folders, known } = await this.folders(account);
    const wk = folder.toLowerCase() === 'inbox' ? 'inbox' : folder.toLowerCase();
    const f = known[wk]
      ? folders.find((x) => x.id === known[wk])
      : (folders.find((x) => x.path === folder) ??
        folders.find((x) => x.path.toLowerCase() === folder.toLowerCase()));
    const id = known[wk] ?? f?.id;
    if (!id) throw new MailError('Folder not found; use list_folders for valid paths');
    if (
      a.allowedFolders &&
      !(f && a.allowedFolders.includes(f.path)) &&
      !a.allowedFolders.includes(folder)
    )
      throw new MailError('Folder not allowed');
    return { id, path: f?.path ?? folder };
  }
  async listFolders(account: string) {
    const a = this.account(account);
    const { folders, known } = await this.folders(account);
    const special = Object.fromEntries(Object.entries(known).map(([k, v]) => [v, k]));
    const visible = folders.filter((f) => !a.allowedFolders || a.allowedFolders.includes(f.path));
    return {
      account,
      folders: visible.slice(0, 500).map((f) => ({
        path: f.path,
        name: f.name,
        specialUse: special[f.id],
        status: { messages: f.total, unseen: f.unread },
      })),
      truncated: visible.length > 500,
      note: 'Use "INBOX" or a folder path from this list as the folder argument.',
      contentTrust: CONTENT_TRUST,
    };
  }
  async search(
    account: string,
    folder: string,
    q: {
      text?: string;
      from?: string;
      to?: string;
      subject?: string;
      seen?: boolean;
      flagged?: boolean;
      since?: Date;
      before?: Date;
    },
    limit: number,
    beforeUid?: number,
  ) {
    z.number().int().min(1).max(50).parse(limit);
    const a = this.account(account);
    const f = await this.resolveFolder(account, folder);
    const conds: string[] = [];
    const field = (u: string) => `<t:FieldURI FieldURI="${u}"/>`;
    const cmp = (op: string, u: string, v: string) =>
      `<t:${op}>${field(u)}<t:FieldURIOrConstant><t:Constant Value="${esc(v)}"/></t:FieldURIOrConstant></t:${op}>`;
    const contains = (u: string, v: string) =>
      `<t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase">${field(u)}<t:Constant Value="${esc(v)}"/></t:Contains>`;
    if (q.since)
      conds.push(cmp('IsGreaterThanOrEqualTo', 'item:DateTimeReceived', q.since.toISOString()));
    if (q.before) conds.push(cmp('IsLessThan', 'item:DateTimeReceived', q.before.toISOString()));
    if (q.seen !== undefined) conds.push(cmp('IsEqualTo', 'message:IsRead', String(q.seen)));
    if (q.subject) conds.push(contains('item:Subject', q.subject));
    if (q.text) conds.push(contains('item:Body', q.text));
    const restriction = conds.length
      ? `<m:Restriction>${conds.length > 1 ? `<t:And>${conds.join('')}</t:And>` : conds[0]}</m:Restriction>`
      : '';
    const props =
      '<t:AdditionalProperties>' +
      [
        'item:Subject',
        'item:DateTimeReceived',
        'item:Size',
        'item:HasAttachments',
        'item:DisplayTo',
        'message:From',
        'message:IsRead',
        'item:Importance',
      ]
        .map(field)
        .join('') +
      '</t:AdditionalProperties>';
    const post = Boolean(q.from || q.to || q.flagged !== undefined);
    const lc = (s?: string) => (s ?? '').toLowerCase();
    let offset = beforeUid ?? 0;
    const out: ReturnType<typeof this.summary>[] = [];
    const seen = new Set<string>();
    let last = false,
      scanned = 0;
    while (out.length < limit && !last && scanned < (post ? 1000 : limit)) {
      const page = post ? 100 : limit - out.length;
      const xml = await this.call(
        a,
        `<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape>${props}</m:ItemShape>` +
          `<m:IndexedPageItemView MaxEntriesReturned="${page}" Offset="${offset}" BasePoint="Beginning"/>` +
          restriction +
          '<m:SortOrder><t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder></m:SortOrder>' +
          `<m:ParentFolderIds><t:FolderId Id="${esc(f.id)}"/></m:ParentFolderIds></m:FindItem>`,
      );
      // Every item type, in server order, so the offset stays aligned with Exchange's view.
      const items = [...xml.matchAll(ITEM_RE)].map((m) => m[2]);
      last = /IncludesLastItemInRange="true"/.test(xml) || items.length === 0;
      for (const it of items) {
        offset++;
        scanned++;
        const s = this.summary(account, f.path, it);
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        if (q.from && !lc(`${s.from[0]?.name} ${s.from[0]?.address}`).includes(lc(q.from)))
          continue;
        if (q.to && !lc(s.toDisplay).includes(lc(q.to))) continue;
        out.push(s);
        if (out.length >= limit) break;
      }
    }
    return {
      account,
      folder: f.path,
      messages: out,
      nextBeforeUid: last && out.length < limit ? null : offset,
      paging: 'nextBeforeUid is an offset for the next page; pass it back as beforeUid.',
      contentTrust: CONTENT_TRUST,
    };
  }
  private summary(account: string, folder: string, it: string) {
    const item = attr(it, 'ItemId', 'Id') ?? '';
    const fromBlock = blocks(it, 'From')[0] ?? '';
    return {
      id: encodeId(account, item),
      account,
      folder,
      subject: clip(text(it, 'Subject'), 500),
      from: fromBlock
        ? [
            {
              name: clip(text(fromBlock, 'Name'), 100),
              address: clip(text(fromBlock, 'EmailAddress'), 254),
            },
          ]
        : [],
      toDisplay: clip(text(it, 'DisplayTo'), 1000) ?? '',
      unread: text(it, 'IsRead') === 'false',
      hasAttachments: text(it, 'HasAttachments') === 'true',
      importance: text(it, 'Importance'),
      size: Number(text(it, 'Size') ?? 0),
      date: text(it, 'DateTimeReceived'),
    };
  }
  private async mime(account: string, id: string) {
    const a = this.account(account);
    const item = decodeId(id, account);
    const head = await this.call(
      a,
      '<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>' +
        '<t:FieldURI FieldURI="item:Size"/><t:FieldURI FieldURI="message:IsRead"/><t:FieldURI FieldURI="item:ParentFolderId"/>' +
        `</t:AdditionalProperties></m:ItemShape><m:ItemIds><t:ItemId Id="${esc(item)}"/></m:ItemIds></m:GetItem>`,
    );
    if (Number(text(head, 'Size') ?? 0) > LIMITS.message)
      throw new MailError('Message exceeds 8 MiB read limit');
    if (a.allowedFolders) {
      const parent = attr(head, 'ParentFolderId', 'Id');
      const { folders, known } = await this.folders(account);
      const f = folders.find((x) => x.id === parent);
      const okKnown = Object.entries(known).some(
        ([k, v]) => v === parent && a.allowedFolders!.includes(k),
      );
      if (!okKnown && !(f && a.allowedFolders.includes(f.path)))
        throw new MailError('Folder not allowed');
    }
    const xml = await this.call(
      a,
      '<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:IncludeMimeContent>true</t:IncludeMimeContent></m:ItemShape>' +
        `<m:ItemIds><t:ItemId Id="${esc(item)}"/></m:ItemIds></m:GetItem>`,
    );
    const b64 = text(xml, 'MimeContent');
    if (!b64) throw new MailError('Message not found');
    const raw = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
    if (raw.length > LIMITS.message) throw new MailError('Message exceeds read limit');
    return { raw, unread: text(head, 'IsRead') === 'false' };
  }
  async read(account: string, id: string) {
    const { raw, unread } = await this.mime(account, id);
    const m = await simpleParser(raw, {
      skipHtmlToText: false,
      skipTextToHtml: true,
      maxHtmlLengthToParse: LIMITS.message,
    });
    return {
      id,
      account,
      subject: clip(m.subject),
      from: clip(m.from?.text, 2000),
      to: clip(Array.isArray(m.to) ? m.to.map((v) => v.text).join(', ') : m.to?.text, 2000),
      cc: clip(Array.isArray(m.cc) ? m.cc.map((v) => v.text).join(', ') : m.cc?.text, 2000),
      date: m.date,
      unread,
      text: (m.text ?? '').slice(0, LIMITS.text),
      textTruncated: (m.text?.length ?? 0) > LIMITS.text,
      attachments: m.attachments.slice(0, 100).map((x, index) => ({
        index,
        filename: clip(x.filename, 255),
        contentType: clip(x.contentType, 255),
        size: x.size,
      })),
      attachmentsTruncated: m.attachments.length > 100,
      contentTrust: CONTENT_TRUST,
    };
  }
  async attachment(account: string, id: string, index: number, offset = 0) {
    z.number().int().min(0).max(99).parse(index);
    z.number().int().min(0).max(LIMITS.attachment).parse(offset);
    const { raw } = await this.mime(account, id);
    const m = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true });
    const x = m.attachments[index];
    if (!x) throw new MailError('Attachment not found');
    if (x.size > LIMITS.attachment) throw new MailError('Attachment exceeds 4 MiB download limit');
    if (offset > x.content.length) throw new MailError('Attachment offset out of range');
    const data = x.content.subarray(offset, offset + LIMITS.chunk),
      next = offset + data.length;
    return {
      id,
      account,
      index,
      filename: clip(x.filename, 255),
      contentType: clip(x.contentType, 255),
      size: x.content.length,
      offset,
      base64: data.toString('base64'),
      nextOffset: next < x.content.length ? next : null,
      contentTrust: CONTENT_TRUST,
    };
  }
  async verify(account: string) {
    this.folderCache.delete(account);
    const { folders } = await this.folders(account);
    return { ews: true, folders: folders.length, sent: false };
  }
}
