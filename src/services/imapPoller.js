/**
 * Optional IMAP polling of the outreach mailbox, for teams sending from a
 * normal mailbox (Gmail/Workspace, Outlook/365, cPanel) with no inbound
 * webhook. New unread messages are fed to inboxService.processInbound and
 * marked read. Configure IMAP_HOST / IMAP_USER / IMAP_PASS (and optionally
 * IMAP_PORT, IMAP_SECURE, IMAP_MAILBOX, IMAP_WORKSPACE_ID).
 */
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { db } = require('../db/database');
const inbox = require('./inboxService');

let running = false;

function configured() {
  return !!(process.env.IMAP_HOST && process.env.IMAP_USER && process.env.IMAP_PASS);
}

function receivingWorkspace() {
  if (process.env.IMAP_WORKSPACE_ID) return process.env.IMAP_WORKSPACE_ID;
  const agency = db.prepare("SELECT id FROM companies WHERE kind = 'agency' ORDER BY created_at ASC LIMIT 1").get();
  return agency ? agency.id : null;
}

async function pollOnce() {
  if (!configured() || running) return { skipped: true };
  const workspaceId = receivingWorkspace();
  if (!workspaceId) return { skipped: true };
  running = true;
  const client = new ImapFlow({
    host: process.env.IMAP_HOST,
    port: Number(process.env.IMAP_PORT || 993),
    secure: process.env.IMAP_SECURE !== 'false',
    auth: { user: process.env.IMAP_USER, pass: process.env.IMAP_PASS },
    logger: false
  });
  let processed = 0;
  try {
    await client.connect();
    const lock = await client.getMailboxLock(process.env.IMAP_MAILBOX || 'INBOX');
    try {
      const since = new Date(Date.now() - 7 * 86400000);
      const uids = await client.search({ seen: false, since }, { uid: true }) || [];
      for (const uid of uids.slice(0, 50)) {
        const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        await inbox.processInbound(workspaceId, {
          from: parsed.from?.text, to: parsed.to?.text, subject: parsed.subject, text: parsed.text || '',
          messageId: parsed.messageId, inReplyTo: parsed.inReplyTo, receivedAt: parsed.date
        });
        await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
        processed++;
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (err) {
    console.warn(`[imapPoller] poll failed: ${err.message}`);
    try { await client.close(); } catch { /* already closed */ }
  } finally {
    running = false;
  }
  return { processed };
}

module.exports = { pollOnce, configured };
