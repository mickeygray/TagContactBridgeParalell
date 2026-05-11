# Drive Audio Player

This is a tiny Google Apps Script web app that lists playable audio files from the recording dump folders and gives you a simple in-browser playlist player.

## What It Does

- lets you switch between `OG`, `AS`, and `CS`
- loads every playable file in that folder
- plays the file with a normal HTML audio player
- gives next/previous controls
- opens the current file in Drive when needed

## Setup

1. Create a new standalone Apps Script project.
2. Add these files to the project:
   - `Code.gs`
   - `Index.html`
   - `appsscript.json`
3. In Apps Script, open `Project Settings`.
4. Under `Script Properties`, add:
   - `OG_RECORDING_DUMP_FOLDER_ID`
   - `AS_RECORDING_DUMP_FOLDER_ID`
   - `CS_RECORDING_DUMP_FOLDER_ID`
   - `CALL_GRADER_OPTIONS` (optional, comma-separated human graders)
5. Paste the Drive folder IDs you already use for the recording archive.

### Current Folder IDs

Use these exact values:

```text
OG_RECORDING_DUMP_FOLDER_ID=1Pkc3jpJ6MPHgDrWQR7WQachiX5LP7QuS
AS_RECORDING_DUMP_FOLDER_ID=1YAIp7saPCsHEQhL9JhV41jufGaNyfKxq
CS_RECORDING_DUMP_FOLDER_ID=1pfPH2QpxoqZBL7huit2r7Y_pD__ATKzP
CALL_GRADER_OPTIONS=M Anderson,J Pineda,M Gray,B Allen,J Wallace,A Banks
```

### Fastest Copy/Paste Path

1. Go to [script.new](https://script.new)
2. Replace the default `Code.gs` with the contents of:
   - `ops/drive-audio-player-apps-script/Code.gs`
3. Add a new HTML file named `Index` and paste:
   - `ops/drive-audio-player-apps-script/Index.html`
4. Open `Project Settings` and turn on `Show "appsscript.json" manifest file in editor`
5. Replace the manifest with:
   - `ops/drive-audio-player-apps-script/appsscript.json`
6. Add the Script Properties shown above
7. Save everything

## Deploy

1. Click `Deploy` -> `New deployment`
2. Choose `Web app`
3. Execute as:
   - `User accessing the web app`
4. Who has access:
   - whichever audience matches your team setup
5. Deploy and open the URL

### Recommended Deployment Choice

- `Execute as`: `User accessing the web app`
- `Who has access`: your team / anyone in your workspace who needs to listen

That keeps playback happening in the browser as the signed-in user instead of trying to proxy audio through some separate server identity.

## Mobile playback (`?mode=audio`)

The default Drive `/preview` iframe doesn't render usable audio
controls on phones (X-Frame-Options blocks the iframe + the
redirect chain Drive uses kills auth tokens mid-stream). The player
also supports a native HTML5 `<audio>` mode that streams bytes
through the Parallel control-plane's signed-URL proxy.

Mode selection (last-write-wins):
1. `?mode=audio` or `?mode=iframe` URL parameter
2. `cx-player-mode` localStorage value (set by clicking the toggle button)
3. Auto-detect: small viewport / mobile UA → `audio`, else `iframe`

To enable the audio mode:
1. Stand up the Parallel control-plane with `RECORDING_PLAYBACK_SIGNING_SECRET` set in `.env`
2. Run `npm run dev:public` (or `npm run dev` + `npm run dev:ngrok` separately) to expose it via ngrok
3. Add these Script Properties to the Apps Script project:
   - `PLAYBACK_PROXY_BASE_URL` = `https://tagcontactbridge.ngrok.app` (or whatever your public host is)
   - `RECORDING_PLAYBACK_SIGNING_SECRET` = same hex value as in the parallel `.env`

The Apps Script mints a 10-minute HMAC-signed URL per track. The
proxy verifies the signature, fetches bytes from Drive with the
service account credentials, and streams them back with `Range`
support. Audio element handles seek/scrub natively + lock-screen
controls light up on iOS/Android.

## Notes

- This player reads straight from Drive and does not duplicate the audio.
- If Drive refuses to stream some files cleanly, the `Open In Drive` button still gives the native fallback.
- The player currently sorts by most recently updated first.
- Human grades are stored in shared Script Properties keyed by Drive file ID, which keeps this first pass fully inside Apps Script until the webhook stack takes it over later.
