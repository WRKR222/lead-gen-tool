# Domain Authentication Setup (SPF, DKIM, DMARC)

Do this before sending any real volume. Without all three records, most
inboxes will spam-fold you regardless of content quality.

## 1. SPF (Sender Policy Framework)

Add a TXT record on your sending domain/subdomain listing which servers
are allowed to send as you. If you're using a transactional/SMTP provider
(SendGrid, Postmark, AWS SES, Mailgun, etc.), they'll give you the exact
`include:` value - use theirs instead of guessing.

```
Type: TXT
Host: outreach.yourcompany.com   (or @ if sending from root domain)
Value: v=spf1 include:_spf.yourprovider.com ~all
```

Only one SPF record per domain/subdomain is allowed - if you already have
one, merge the `include:` values instead of adding a second record.

## 2. DKIM (DomainKeys Identified Mail)

Your SMTP/ESP provider generates the actual DKIM key pair and gives you a
CNAME or TXT record to add - it's provider-specific, so follow their
dashboard instructions exactly. It generally looks like:

```
Type: CNAME
Host: selector1._domainkey.outreach.yourcompany.com
Value: selector1-outreach-yourcompany-com.dkim.yourprovider.com
```

## 3. DMARC

Add after SPF and DKIM are working. Start in monitor-only mode (`p=none`)
for 1-2 weeks to see reports without risking legitimate mail being
rejected, then tighten.

```
Type: TXT
Host: _dmarc.outreach.yourcompany.com
Value: v=DMARC1; p=none; rua=mailto:dmarc-reports@yourcompany.com; pct=100
```

Once reports look clean (no unexpected failures), move to:
```
v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@yourcompany.com; pct=100
```

## 4. Verify

- https://mxtoolbox.com/SuperTool.aspx - check SPF/DKIM/DMARC on any domain
- https://www.mail-tester.com - send a test email, get a spam-likelihood score
- Google Postmaster Tools (postmaster.google.com) - ongoing reputation monitoring for domains sending to Gmail recipients

## 5. Point this app at the right domain

Set `FROM_EMAIL` in `.env` to an address on the authenticated subdomain
(e.g. `outreach@yourcompany.com`, not your personal/root work email), and
make sure your SMTP credentials (`SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`) are
for that same provider/domain.
