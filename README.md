Hi guys, I created this calendar sharing application because it was getting hard for me to catch up with my friends lol. 
If you want to constantly share your schedule with a partner or close friends, use Calendar share and maintain  your privacy as well. 

Share only **when** you are busy with someone via a link they can add to **Google Calendar** or **Apple Calendar** without showing **any** of your real event titles, locations, notes, or attendees. Subscribers only see generic **“Busy”** blocks during those times.

### Option A — Connect iCloud (constant updates)
1. You create an **app-specific password** at [appleid.apple.com](https://appleid.apple.com) (your normal Apple ID password is **not** used here).
2. You enter your Apple ID and that app password in CalendarShare (self-hosted). The server uses Apple’s **CalDAV** API to read your iCloud calendars.
3. The server **discards** all sensitive fields and keeps only **start/end** busy intervals (same as the `.ics` path). It stores your app password **encrypted** on disk (you must set `CREDENTIAL_ENCRYPTION_KEY`).
4. A background job **re-fetches** your calendars every **3 minutes** by default (change with `ICLOUD_SYNC_INTERVAL_SEC`). When you add or change an event in Apple Calendar, subscribers see it after the next sync plus their app’s own refresh delay.

### Option B — Upload `.ics` (download the calendar locally then upload)
1. **Export** a calendar from the Apple Calendar app as `.ics`.
2. **Upload** it to CalendarShare. The server extracts busy times once per upload.
3. Send the **subscribe link** to the other person.

**Trust:** iCloud sync means this server holds credentials to your calendar account (encrypted). Only run on hardware and networks you trust. Prefer the `.ics` path if you don't want any server to store Apple access tokens/passwords.

## What this app will store
- A random **public token** (in the subscribe URL).
- A secret **manage key** (update the feed, trigger sync, or remove iCloud binding).
- For each share: **start time**, **end time** and whether the block is **all‑day**.

If iCloud sync is enabled, it also stores your **Apple ID** (plain text for login) and the **app-specific password** (AES-256-GCM ciphertext).
It does **not** store original summaries, descriptions, locations, invitees, or URLs from calendar events.

## Run locally
You need [Node.js](https://nodejs.org/) 18 or newer.
**iCloud sync requires a 32-byte encryption key** (64 hex characters). Generate once and keep it stable so existing stored passwords keep working:

```bash
openssl rand -hex 32
```

```bash
cd calendarshare
npm install
export CREDENTIAL_ENCRYPTION_KEY="<paste 64 hex chars here>"
npm start
```

Open [http://localhost:3000](http://localhost:3000). The database file is `data/calendarshare.db`.

Without `CREDENTIAL_ENCRYPTION_KEY`, **iCloud connect** will fail with an error; **manual `.ics` upload** still works.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port (default: `3000`). |
| `PUBLIC_BASE_URL` | Full public origin **without** a trailing slash, e.g. `https://cal.example.com`. If set, API responses use this host (e.g. behind a reverse proxy). **Use HTTPS in production** for Google Calendar “From URL”. |
| `CREDENTIAL_ENCRYPTION_KEY` | **Required for iCloud.** 64 hex characters (32 bytes). Encrypts app-specific passwords at rest. |
| `ICLOUD_SYNC_INTERVAL_SEC` | Seconds between automatic iCloud pulls for all linked shares (default: `180`). |

Example:

```bash
CREDENTIAL_ENCRYPTION_KEY=... \
PUBLIC_BASE_URL=https://calendar.example.com \
PORT=8080 \
npm start
```

## App-specific password (Apple)

1. Go to [appleid.apple.com](https://appleid.apple.com) → sign in.
2. **Security** → **App-Specific Passwords** → generate one (e.g. label it “CalendarShare”).
3. Copy the password Apple shows **once** and paste it into CalendarShare.  
   Use that value—not your iCloud account password.

## Using the web UI
### iCloud

1. Set `CREDENTIAL_ENCRYPTION_KEY` and start the server.
2. Under **Connect iCloud**, enter Apple ID, app-specific password, and optionally calendar name fragments (comma-separated) to limit which iCloud calendars are merged into “busy” (leave blank for all).
3. To attach iCloud to a share you already created (e.g. via `.ics` first), paste that share’s **manage key** in the optional field, then submit.
4. Save the **manage key** and send only the **subscribe URL** to the other person.
5. Use **Sync now** in the results section if you do not want to wait for the next interval.

### Manual `.ics`

1. Export from Apple Calendar on a Mac (**Control‑click** calendar → **Export**), or use another source of standard `.ics` files.
2. Upload on the site. To refresh the same link later, enable **Update existing share** and paste your manage key.

### On iPhone / iPad (export only)

Apple does not offer a full-account export like on macOS. Easiest path: calendars sync to iCloud → use **Connect iCloud** on this server, or export on a **Mac**.

## They subscribe — Google Calendar

Google needs a **public HTTPS** URL. Deploy CalendarShare and set `PUBLIC_BASE_URL`.

1. In Google Calendar: **Other calendars** → **+** → **From URL**.
2. Paste the **HTTPS** subscribe link.

Google refreshes subscribed calendars on its own schedule (often every few hours).

## They subscribe — Apple Calendar

### Mac

**File → New Calendar Subscription…** → paste the `https://…` or `webcal://…` URL.

### iPhone / iPad

**Settings → Calendar → Accounts → Add Account → Other → Add Subscribed Calendar**.

## Stop iCloud sync for a share

Remove the stored binding (busy blocks already published stay until you overwrite via `.ics` or reconnect):

```http
DELETE /api/sync/icloud
Content-Type: application/json

{"manageKey":"<your manage key>"}
```

(or `?manageKey=` on the query string)

## Security and expectations

- Anyone with the **subscribe link** sees your **busy/free pattern**, not event titles. Do not share the link publicly if that matters.
- **iCloud:** you are trusting this process with an app-specific password. Use **only** app-specific passwords, rotate them in Apple ID settings if the host is ever compromised, and prefer self-hosting.
- Subscriber updates are not real-time: **polling interval** on this server plus **polling** in Google/Apple.
- Manual `.ics` uploads **replace** busy data immediately; the next **iCloud** sync will replace again if that share is linked to iCloud.

## API (for scripts)

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/shares/icloud` | JSON: `appleId`, `appPassword`, optional `calendarNames` (string array), optional `manageKey`. Creates or updates share + iCloud binding. |
| `DELETE` | `/api/sync/icloud` | Body or query: `manageKey`. Removes iCloud binding. |
| `GET` | `/api/sync/status?manageKey=` | Last sync time / last error for iCloud binding. |
| `POST` | `/api/sync/icloud/trigger` | JSON: `manageKey`. Run iCloud pull immediately. |
| `POST` | `/api/shares` | `multipart/form-data` field `calendar` (`.ics` file). |
| `PUT` | `/api/shares` | Same + `manageKey`. |
| `GET` | `/calendar/<token>.ics` | Redacted feed. |
