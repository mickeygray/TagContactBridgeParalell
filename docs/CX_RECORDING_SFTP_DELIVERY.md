# RingCX Recording SFTP Delivery

This is the current test path for RingCX recording delivery without polling the
recording API.

## Important URL Rule

`tag-webhook.ngrok.app` is an HTTPS tunnel and cannot be used as an SFTP
destination. SFTP is raw TCP over SSH, so RingCX must be pointed at an ngrok TCP
address such as:

```text
Server: 8.tcp.us-cal-1.ngrok.io
Port:   14094
```

If this TCP address changes, update the RingCX recording destination. For a real
production setup, reserve a TCP address in ngrok and use that reserved
server/port.

## Current Local Receiver

The disposable local receiver is:

```powershell
node scripts\run-cx-recording-sftp-test-server.js --port 2222
```

It listens on `127.0.0.1:2222` and writes uploaded files to:

```text
C:\Users\micke\Desktop\cx-recordings\inbox
```

Credentials are stored locally in:

```text
runtime\cx-recording-sftp-test\credentials.json
```

Do not commit or paste that password into docs.

## RingCX Destination Fields

Use this shape in RingCX recording delivery destination:

```text
Protocol / type: SFTP
Server:          8.tcp.us-cal-1.ngrok.io
Port:            14094
User ID:         rcx-delivery
Password:        from runtime\cx-recording-sftp-test\credentials.json
Root directory:  /
```

`Destination Directory` can be `/` for the test. If RingCX requires a tokenized
path, keep it under `/`, for example:

```text
/callrecordings/#CALL_YEAR#/#AGENT_NAME#/files
```

The receiver will create subfolders as needed.

## Health Check

Run:

```powershell
npm run cx-recordings:sftp:check
```

This verifies:

- local SFTP listener on port `2222`
- ngrok TCP tunnel to that port
- local SFTP auth/list
- public TCP SFTP auth/list
- newest inbox files
- newest receiver events

## Bring-Up

Run:

```powershell
npm run cx-recordings:sftp:start
```

The starter makes sure the SFTP receiver is running, then checks for an existing
ngrok TCP tunnel. If there is no TCP tunnel and no reserved URL is supplied, it
starts a temporary `ngrok tcp 2222` tunnel.

For a reserved TCP address:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-cx-recording-sftp-test.ps1 -NgrokUrl "8.tcp.us-cal-1.ngrok.io:14094"
```

If ngrok rejects the address with `ERR_NGROK_307`, that server/port is not
reserved on the current ngrok account/region.

## Inbound File Processing

After RingCX uploads a recording, it should appear in:

```text
C:\Users\micke\Desktop\cx-recordings\inbox
```

The inbox drain processes files by:

1. Extracting the first 30-digit UII / telephony session id from the filename.
2. Matching `CallLog.telephonySessionId`.
3. Uploading the audio to Google Drive.
4. Stamping `CallLog.recordingArchive`.
5. Moving the source file to `processed/<YYYY-MM-DD>/`, or `unknown/` if no
   UII/call log match exists.

One manual tick:

```powershell
npm run cx-recordings:inbox-drain
```

Continuous local loop:

```powershell
npm run cx-recordings:inbox-drain:loop
```

Dry-run:

```powershell
node scripts\run-cx-recording-inbox-drain-loop.js --once --dry-run
```

The drain is currently a local/Windows-side helper. It is not yet installed as a
service, and it is separate from the Linux live app.
