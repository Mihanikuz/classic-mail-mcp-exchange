import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EwsMailService } from '../src/ews.js';

const account = {
  id: 'work',
  email: 'user@example.com',
  username: 'user@example.com',
  password: 'p@ss"w<rd',
  imapHost: 'mail.example.com',
  smtpHost: 'mail.example.com',
};
const wrap = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>${body}</s:Body></s:Envelope>`;
const folderXml = (
  id: string,
  parent: string,
  name: string,
  total: number,
  unread: number,
  cls = 'IPF.Note',
) =>
  `<t:Folder><t:FolderId Id="${id}" ChangeKey="x"/><t:ParentFolderId Id="${parent}" ChangeKey="y"/><t:FolderClass>${cls}</t:FolderClass><t:DisplayName>${name}</t:DisplayName><t:TotalCount>${total}</t:TotalCount><t:ChildFolderCount>0</t:ChildFolderCount><t:UnreadCount>${unread}</t:UnreadCount></t:Folder>`;
const mime = Buffer.from(
  [
    'From: =?UTF-8?B?0JjQstCw0L0=?= <ivan@example.com>',
    'To: user@example.com',
    'Subject: =?UTF-8?B?0J7RgtGH0LXRgg==?=',
    'Date: Thu, 22 Oct 2026 10:00:00 +0300',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    'Привет, отчёт во вложении.',
    '--b1',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 test').toString('base64'),
    '--b1--',
    '',
  ].join('\r\n'),
).toString('base64');

function mockFetch(log: string[]) {
  return (async (_url: string, init: RequestInit) => {
    const body = String(init.body);
    log.push(body);
    assert.equal(
      (init.headers as Record<string, string>).Authorization,
      'Basic ' + Buffer.from('user@example.com:p@ss"w<rd').toString('base64'),
    );
    let xml = '';
    if (body.includes('<m:FindFolder'))
      xml = `<m:FindFolderResponse><m:ResponseMessages><m:FindFolderResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:RootFolder TotalItemsInView="4" IncludesLastItemInRange="true"><t:Folders>${
        folderXml('INBOX1', 'ROOT', 'Входящие', 12449, 56) +
        folderXml('SUB1', 'INBOX1', 'Проекты &amp; Задачи', 10, 1) +
        folderXml('CAL', 'ROOT', 'Календарь', 5, 0, 'IPF.Appointment') +
        folderXml('SENT', 'ROOT', 'Отправленные', 300, 0)
      }</t:Folders></m:RootFolder></m:FindFolderResponseMessage></m:ResponseMessages></m:FindFolderResponse>`;
    else if (body.includes('<m:GetFolder'))
      xml = `<m:GetFolderResponse><m:ResponseMessages>
        <m:GetFolderResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Folders><t:Folder><t:FolderId Id="INBOX1"/></t:Folder></m:Folders></m:GetFolderResponseMessage>
        <m:GetFolderResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Folders><t:Folder><t:FolderId Id="SENT"/></t:Folder></m:Folders></m:GetFolderResponseMessage>
        <m:GetFolderResponseMessage ResponseClass="Error"><m:MessageText>x</m:MessageText><m:ResponseCode>ErrorFolderNotFound</m:ResponseCode></m:GetFolderResponseMessage>
        </m:ResponseMessages></m:GetFolderResponse>`;
    else if (body.includes('<m:FindItem')) {
      const msg = (id: string, subj: string, from: string, read: boolean) =>
        `<t:Message><t:ItemId Id="${id}" ChangeKey="c"/><t:Subject>${subj}</t:Subject><t:DateTimeReceived>2026-10-22T07:00:00Z</t:DateTimeReceived><t:Size>2048</t:Size><t:HasAttachments>true</t:HasAttachments><t:DisplayTo>Михаил</t:DisplayTo><t:Importance>Normal</t:Importance><t:From><t:Mailbox><t:Name>${from}</t:Name><t:EmailAddress>${from.toLowerCase()}@example.com</t:EmailAddress><t:RoutingType>SMTP</t:RoutingType></t:Mailbox></t:From><t:IsRead>${read}</t:IsRead></t:Message>`;
      xml = `<m:FindItemResponse><m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:RootFolder IndexingOffset="2" TotalItemsInView="2" IncludesLastItemInRange="true"><t:Items>${
        msg('AAMk1', 'Отчёт', 'Ivan', false) + msg('AAMk2', 'Счёт &lt;№5&gt;', 'Petr', true)
      }</t:Items></m:RootFolder></m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse>`;
    } else if (body.includes('IncludeMimeContent'))
      xml = `<m:GetItemResponse><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items><t:Message><t:MimeContent CharacterSet="UTF-8">${mime}</t:MimeContent><t:ItemId Id="AAMk1"/></t:Message></m:Items></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse>`;
    else if (body.includes('<m:GetItem'))
      xml = `<m:GetItemResponse><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items><t:Message><t:ItemId Id="AAMk1"/><t:ParentFolderId Id="INBOX1"/><t:Size>2048</t:Size><t:IsRead>false</t:IsRead></t:Message></m:Items></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse>`;
    return new Response(wrap(xml), { status: 200 });
  }) as unknown as typeof fetch;
}

test('EWS folders, search, read and attachment', async () => {
  const log: string[] = [];
  const svc = new EwsMailService([account as any], mockFetch(log));
  const folders = await svc.listFolders('work');
  assert.deepEqual(
    folders.folders.map((f) => [f.path, f.specialUse, f.status.messages, f.status.unseen]),
    [
      ['Входящие', 'inbox', 12449, 56],
      ['Входящие/Проекты & Задачи', undefined, 10, 1],
      ['Отправленные', 'sentitems', 300, 0],
    ],
  );

  const r = await svc.search('work', 'INBOX', { since: new Date('2026-10-18'), seen: false }, 25);
  const find = log.find((b) => b.includes('<m:FindItem'))!;
  assert.match(find, /<t:FolderId Id="INBOX1"\/>/);
  assert.match(
    find,
    /IsGreaterThanOrEqualTo><t:FieldURI FieldURI="item:DateTimeReceived"\/><t:FieldURIOrConstant><t:Constant Value="2026-10-18T00:00:00.000Z"/,
  );
  assert.match(find, /message:IsRead"\/><t:FieldURIOrConstant><t:Constant Value="false"/);
  assert.equal(r.messages.length, 2);
  assert.equal(r.messages[0].subject, 'Отчёт');
  assert.equal(r.messages[0].unread, true);
  assert.equal(r.messages[1].subject, 'Счёт <№5>');
  assert.deepEqual(r.messages[0].from, [{ name: 'Ivan', address: 'ivan@example.com' }]);
  assert.equal(r.nextBeforeUid, null);

  const filtered = await svc.search('work', 'Входящие/Проекты & Задачи', { from: 'petr' }, 25);
  assert.deepEqual(
    filtered.messages.map((m) => m.subject),
    ['Счёт <№5>'],
  );
  assert.match(log.at(-1)!, /<t:FolderId Id="SUB1"\/>/);

  const m = await svc.read('work', r.messages[0].id);
  assert.equal(m.subject, 'Отчет');
  assert.equal(m.from, '"Иван" <ivan@example.com>');
  assert.match(m.text, /отчёт во вложении/);
  assert.equal(m.unread, true);
  assert.deepEqual(
    m.attachments.map((a) => a.filename),
    ['report.pdf'],
  );
  const att = await svc.attachment('work', r.messages[0].id, 0);
  assert.equal(Buffer.from(att.base64, 'base64').toString(), '%PDF-1.4 test');
  assert.ok(!log.some((b) => /UpdateItem|DeleteItem|SendItem|CreateItem|MoveItem/.test(b)));
  const v = await svc.verify('work');
  assert.equal(v.ews, true);
});

test('EWS rejects bad ids, unknown folders and reports auth errors', async () => {
  const svc = new EwsMailService([account as any], mockFetch([]));
  await assert.rejects(svc.read('work', 'not*valid'), /Invalid message ID/);
  const other = Buffer.from(JSON.stringify({ account: 'x', item: 'A' })).toString('base64url');
  await assert.rejects(svc.read('work', other), /another account/);
  await assert.rejects(svc.search('work', 'Нет такой', {}, 5), /Folder not found/);
  const denied = new EwsMailService(
    [account as any],
    (async () => new Response('', { status: 401 })) as unknown as typeof fetch,
  );
  await assert.rejects(denied.listFolders('work'), /rejected the mailbox credentials/);
  const err = new EwsMailService(
    [account as any],
    (async () =>
      new Response(
        wrap(
          '<m:FindFolderResponseMessage ResponseClass="Error"><m:MessageText>secret detail</m:MessageText><m:ResponseCode>ErrorAccessDenied</m:ResponseCode></m:FindFolderResponseMessage>',
        ),
        { status: 500 },
      )) as unknown as typeof fetch,
  );
  await assert.rejects(err.listFolders('work'), /Exchange error: ErrorAccessDenied/);
});

test('EWS paging keeps server order across mixed item types', async () => {
  // 7 items, newest first; #3 and #5 are meeting items.
  const all = Array.from({ length: 7 }, (_, i) => {
    const tag = i === 2 ? 'MeetingResponse' : i === 4 ? 'MeetingRequest' : 'Message';
    return `<t:${tag}><t:ItemId Id="ID${i}" ChangeKey="c"/><t:Subject>S${i}</t:Subject><t:DateTimeReceived>2026-10-2${7 - i}T00:00:00Z</t:DateTimeReceived><t:IsRead>true</t:IsRead></t:${tag}>`;
  });
  const fetchMock = (async (_u: string, init: RequestInit) => {
    const body = String(init.body);
    let xml = '';
    if (body.includes('<m:FindFolder'))
      xml = `<m:RootFolder IncludesLastItemInRange="true"><t:Folders>${folderXml('INBOX1', 'ROOT', 'Входящие', 7, 0)}</t:Folders></m:RootFolder>`;
    else if (body.includes('<m:GetFolder'))
      xml = `<m:GetFolderResponseMessage ResponseClass="Success"><m:Folders><t:Folder><t:FolderId Id="INBOX1"/></t:Folder></m:Folders></m:GetFolderResponseMessage>`;
    else {
      const max = Number(/MaxEntriesReturned="(\d+)"/.exec(body)![1]);
      const off = Number(/Offset="(\d+)"/.exec(body)![1]);
      const page = all.slice(off, off + max);
      xml = `<m:FindItemResponseMessage ResponseClass="Success"><m:RootFolder IndexingOffset="${off + page.length}" IncludesLastItemInRange="${off + page.length >= all.length}"><t:Items>${page.join('')}</t:Items></m:RootFolder></m:FindItemResponseMessage>`;
    }
    return new Response(wrap(xml), { status: 200 });
  }) as unknown as typeof fetch;
  const svc = new EwsMailService([account as any], fetchMock);
  const seen: string[] = [];
  let cursor: number | undefined;
  for (let i = 0; i < 10; i++) {
    const r = await svc.search('work', 'INBOX', {}, 3, cursor);
    seen.push(...r.messages.map((m) => m.subject!));
    if (r.nextBeforeUid === null) break;
    cursor = r.nextBeforeUid;
  }
  assert.deepEqual(seen, ['S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6']);
});
