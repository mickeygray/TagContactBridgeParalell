# NCOA Mailbox Ingest

Purpose: watch `documents@taxadvocategroup.com` for NCOA CSV attachments, upload them through the existing NCOA Logics path, and email a completion summary.

## Security Shape

Use Gmail API access with `https://www.googleapis.com/auth/gmail.modify`, not a mailbox password. The worker can read and mark messages, but it cannot send mail from `documents@` because it does not request `gmail.send` or SMTP access.

Hashing a mailbox password in `.env` is not meaningful protection for unattended jobs. If the app can decrypt it, an attacker with code/env access can decrypt it too. Prefer one of these:

- OAuth refresh token for only `documents@` and only Gmail modify scope.
- Google Workspace service account with domain-wide delegation restricted to Gmail modify scope and subject `documents@taxadvocategroup.com`.

## Env

```env
NCOA_MAILBOX_ENABLED=false
NCOA_MAILBOX_DOMAIN=TAG
NCOA_MAILBOX_USER=documents@taxadvocategroup.com
NCOA_MAILBOX_NOTIFY_RECIPIENTS=mgray@taxadvocategroup.com
NCOA_MAILBOX_GMAIL_QUERY=is:unread has:attachment newer_than:14d
NCOA_MAILBOX_MAX_MESSAGES=10
NCOA_MAILBOX_ACCEPTED_EXTENSIONS=.csv,.txt
NCOA_MAILBOX_MARK_READ=true
NCOA_MAILBOX_ARCHIVE_PROCESSED=true
NCOA_MAILBOX_COMPLETE_ON_NO_UNREAD=false
NCOA_MAILBOX_ACTIVE_WEEKDAYS=1,2,3,4,5
NCOA_MAILBOX_TIMEZONE=America/Los_Angeles

# Option A: service account with domain-wide delegation
NCOA_MAILBOX_GOOGLE_AUTH_MODE=service_account
NCOA_MAILBOX_GOOGLE_SUBJECT=documents@taxadvocategroup.com
NCOA_MAILBOX_GOOGLE_CLIENT_EMAIL=...
NCOA_MAILBOX_GOOGLE_PRIVATE_KEY=...
NCOA_MAILBOX_GOOGLE_TOKEN_URI=https://oauth2.googleapis.com/token
NCOA_MAILBOX_GOOGLE_SCOPE=https://www.googleapis.com/auth/gmail.modify

# Option B: OAuth refresh token for documents@
NCOA_MAILBOX_GOOGLE_AUTH_MODE=refresh_token
NCOA_MAILBOX_GOOGLE_CLIENT_ID=...
NCOA_MAILBOX_GOOGLE_CLIENT_SECRET=...
NCOA_MAILBOX_GOOGLE_REFRESH_TOKEN=...
NCOA_MAILBOX_GOOGLE_TOKEN_URI=https://oauth2.googleapis.com/token
NCOA_MAILBOX_GOOGLE_SCOPE=https://www.googleapis.com/auth/gmail.modify
```

## Run

```powershell
npm run ncoa:mailbox -- --dry-run --skip-email --max-messages 1
npm run ncoa:mailbox
npm run ncoa:mailbox:loop
```

The worker dedupes by attachment content hash via `WorkflowRecord.dedupeKey`, so re-sent identical attachments should not double-upload.

When `NCOA_MAILBOX_ENABLED=true`, the normal hourly sweep checks the mailbox on weekdays until a file is processed for that Pacific business day. After a successful daily mailbox run, the hourly sweep self-skips until the next day.

Successful messages are marked read by default. With `NCOA_MAILBOX_ARCHIVE_PROCESSED=true`, they are also removed from the inbox but preserved in Gmail for audit/history. Messages with upload errors stay unread/inbox so the next hourly sweep can retry them.

If `NCOA_MAILBOX_COMPLETE_ON_NO_UNREAD=true`, the first hourly check that finds no unread matching messages records an empty daily completion marker. That prevents the hourly service from checking Gmail again until the next business day. Leave it `false` if NCOA files can land later in the day.
