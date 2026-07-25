/**
 * Hosted-hub Outlook calendar — a plain-JS port of the local connector
 * (apps/teams-bot/src/lib/CalendarConnector.ts). Same deliberate scope:
 * delegated Calendars.Read only, read-only, sign-in and token handling
 * through Microsoft's own auth library (@azure/msal-node) — no
 * hand-rolled OAuth.
 *
 * MULTI-ACCOUNT: the MSAL cache holds every account that has signed in
 * ("Add another Outlook" on the homepage). Meetings are fetched from ALL
 * of them and merged into one pick-list, each tagged with the account it
 * came from. Anyone who can open this cockpit sees the merged view —
 * per-person access control stays a parked later phase.
 *
 * Configuration (Railway service variables on the COCKPIT service):
 *   MS_CLIENT_ID / MS_CLIENT_SECRET  — the same Entra app as local
 *                                      (MICROSOFT_* spellings also accepted)
 *   MS_REDIRECT_URI                  — optional; when unset the redirect URI
 *                                      is derived from the incoming request
 *                                      (https://<cockpit-host>/auth/callback),
 *                                      which is right on Railway with zero
 *                                      config. WHATEVER it resolves to must
 *                                      be registered on the Entra app as a
 *                                      Web redirect URI.
 *
 * The token cache is ONE plain file, calendar-token.json next to the
 * process (ZEUS_CAL_TOKEN_FILE overrides). Railway wipes the filesystem on
 * redeploy — same caveat as records/: mount a volume and point the
 * override at it to keep the sign-in across deploys. If the file is lost,
 * nothing breaks: the briefing screen shows "Connect calendar" again.
 *
 * The msal dependency is loaded lazily: if it isn't installed (an old
 * build, a bare `node server.js` without npm install), the calendar simply
 * reports configured:false and the cockpit behaves exactly as before.
 */
const fs = require('fs');
const path = require('path');

const GRAPH_SCOPES = ['Calendars.Read'];

const tokenFile = () =>
    process.env.ZEUS_CAL_TOKEN_FILE
    // On Railway, RECORDS_DIR points at the mounted volume — keeping the
    // token there means the Outlook connection survives redeploys instead
    // of silently dropping on every deploy.
    || (process.env.RECORDS_DIR ? path.join(process.env.RECORDS_DIR, 'calendar-token.json') : null)
    || path.join(process.cwd(), 'calendar-token.json');

/** Which account feeds the meeting pick-list: 'all' or one username.
 *  Lives beside the token file so the choice survives redeploys too. */
const prefsFile = () => path.join(path.dirname(tokenFile()), 'calendar-prefs.json');
const readSelected = () => {
    try {
        return String(JSON.parse(fs.readFileSync(prefsFile(), 'utf8')).selected || 'all');
    } catch {
        return 'all';
    }
};
const writeSelected = (selected) => {
    try {
        fs.writeFileSync(prefsFile(), JSON.stringify({ selected }), { mode: 0o600 });
    } catch (error) {
        console.error('Could not persist the calendar selection:', error);
    }
};

let msal = null;
try {
    msal = require('@azure/msal-node');
} catch {
    /* not installed — the calendar stays off, everything else works */
}

const clientId = process.env.MS_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID || '';
const clientSecret = process.env.MS_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET || '';

/** MSAL cache <-> the token file — what makes the login survive restarts. */
const fileCachePlugin = {
    async beforeCacheAccess(context) {
        try {
            context.tokenCache.deserialize(fs.readFileSync(tokenFile(), 'utf8'));
        } catch { /* no file yet — first run or disconnected */ }
    },
    async afterCacheAccess(context) {
        if (context.cacheHasChanged) {
            try {
                fs.writeFileSync(tokenFile(), context.tokenCache.serialize(), { mode: 0o600 });
            } catch (error) {
                console.error('Could not persist the calendar token:', error);
            }
        }
    },
};

const app = (msal && clientId && clientSecret)
    ? new msal.ConfidentialClientApplication({
        auth: {
            clientId,
            clientSecret,
            // 'common' = personal Microsoft accounts AND work accounts.
            authority: 'https://login.microsoftonline.com/common',
        },
        cache: { cachePlugin: fileCachePlugin },
    })
    : null; // not configured — the UI simply never shows the calendar

/** The redirect URI Microsoft sends the owner back to after sign-in. */
let lastAuthRedirectUri = null; // what the auth URL actually used — the exchange MUST match it
const redirectUriFor = (req) => {
    const fromEnv = process.env.MS_REDIRECT_URI || process.env.MICROSOFT_REDIRECT_URI;
    if (fromEnv) return fromEnv;
    // Railway terminates TLS upstream — trust its forwarded headers first.
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
    return `${proto}://${host}/auth/callback`;
};

/** configured = env credentials present; connected = at least one signed-in account */
const status = async () => {
    if (!app) {
        return { configured: false, connected: false, account: null, accounts: [], selected: 'all' };
    }
    const accounts = (await app.getTokenCache().getAllAccounts()).map((a) => a.username);
    // A selection pointing at a disconnected account silently falls back to 'all'.
    const stored = readSelected();
    const selected = accounts.includes(stored) ? stored : 'all';
    return {
        configured: true,
        connected: accounts.length > 0,
        // Kept for older UI strings: every connected account, human-joined.
        account: accounts.length ? accounts.join(' + ') : null,
        accounts,
        selected,
    };
};

/** The dropdown's choice: 'all' or one signed-in username. */
const setSelected = async (choice) => {
    if (!app) throw new Error('Calendar is not configured.');
    const accounts = (await app.getTokenCache().getAllAccounts()).map((a) => a.username);
    const selected = accounts.includes(choice) ? choice : 'all';
    writeSelected(selected);
    console.log(`CALENDAR SOURCE >>> ${selected === 'all' ? 'all calendars' : selected}`);
    return selected;
};

/** Signs one account out (its tokens are dropped from the cache). */
const removeAccount = async (username) => {
    if (!app) throw new Error('Calendar is not configured.');
    const cache = app.getTokenCache();
    const account = (await cache.getAllAccounts()).find((a) => a.username === username);
    if (!account) throw new Error(`${username} is not connected.`);
    await cache.removeAccount(account);
    if (readSelected() === username) writeSelected('all');
    console.log(`CALENDAR DISCONNECTED >>> ${username}`);
};

/** Where "Connect calendar" sends the owner: Microsoft's own sign-in page */
const authUrl = async (req) => {
    if (!app) throw new Error('Calendar is not configured (MS_CLIENT_ID / MS_CLIENT_SECRET missing).');
    lastAuthRedirectUri = redirectUriFor(req);
    console.log(`CALENDAR AUTH >>> redirect URI in play: ${lastAuthRedirectUri}`);
    // select_account: without it Microsoft silently reuses the browser's
    // signed-in account — a second person could never add THEIR calendar.
    return app.getAuthCodeUrl({ scopes: GRAPH_SCOPES, redirectUri: lastAuthRedirectUri, prompt: 'select_account' });
};

/** Finishes the sign-in; MSAL stores the token (incl. refresh) in the file cache */
const handleCallback = async (req, code) => {
    if (!app) throw new Error('Calendar is not configured.');
    // The exchange must present the EXACT URI the auth URL used — prefer
    // what authUrl remembered over re-deriving from this request's headers.
    const redirectUri = lastAuthRedirectUri || redirectUriFor(req);
    const result = await app.acquireTokenByCode({ code, scopes: GRAPH_SCOPES, redirectUri });
    const account = (result.account && result.account.username) || '';
    console.log(`CALENDAR CONNECTED >>> ${account || '(unknown account)'}`);
    return account;
};

/** A silently-refreshed access token for ONE account, or null when it can't refresh */
const accessTokenFor = async (account) => {
    try {
        const result = await app.acquireTokenSilent({ account, scopes: GRAPH_SCOPES });
        return (result && result.accessToken) || null;
    } catch (error) {
        console.error(`Calendar token refresh failed for ${account.username} (reconnect from the homepage):`, error);
        return null;
    }
};

/**
 * The next two weeks of meetings (max 25 per account), soonest first,
 * merged across EVERY signed-in account — each tagged with the account
 * it came from. Events without a Teams join link come back with
 * joinUrl: null so the UI can grey them out. A meeting both accounts
 * were invited to appears once (deduped by its join link).
 */
const upcomingMeetings = async () => {
    if (!app) throw new Error('Calendar is not connected.');
    let accounts = await app.getTokenCache().getAllAccounts();
    if (accounts.length === 0) throw new Error('Calendar is not connected.');
    // The homepage dropdown narrows the pick-list to one calendar.
    const selected = readSelected();
    if (accounts.some((a) => a.username === selected)) {
        accounts = accounts.filter((a) => a.username === selected);
    }
    const now = new Date();
    const horizon = new Date(now.getTime() + 14 * 24 * 3600_000);
    const url = 'https://graph.microsoft.com/v1.0/me/calendarView'
        + `?startDateTime=${encodeURIComponent(now.toISOString())}`
        + `&endDateTime=${encodeURIComponent(horizon.toISOString())}`
        + '&$orderby=start/dateTime&$top=25'
        + '&$select=subject,start,end,isOnlineMeeting,onlineMeeting';

    const merged = [];
    let anySucceeded = false;
    let lastError = null;
    for (const account of accounts) {
        const token = await accessTokenFor(account);
        if (!token) { lastError = new Error(`Sign-in for ${account.username} has expired.`); continue; }
        try {
            const response = await fetch(url, {
                headers: {
                    authorization: `Bearer ${token}`,
                    prefer: 'outlook.timezone="UTC"', // Graph answers in UTC — parsing stays simple
                },
            });
            if (!response.ok) {
                const body = await response.text().catch(() => '(no body)');
                throw new Error(`Graph answered ${response.status}: ${body.slice(0, 300)}`);
            }
            const data = await response.json();
            for (const event of data.value ?? []) {
                merged.push({ ...toMeeting(event), account: account.username });
            }
            anySucceeded = true;
        } catch (error) {
            // One broken account must not blank the other's calendar.
            console.error(`Calendar fetch failed for ${account.username}:`, error instanceof Error ? error.message : error);
            lastError = error;
        }
    }
    if (!anySucceeded) throw lastError ?? new Error('Calendar is not connected.');

    // Same meeting on both calendars = one entry (the join link is the identity).
    const seen = new Set();
    const unique = merged.filter((m) => {
        if (!m.joinUrl) return true;
        if (seen.has(m.joinUrl)) return false;
        seen.add(m.joinUrl);
        return true;
    });
    return unique.sort((a, b) => a.start.localeCompare(b.start));
};

/** Graph event -> the pick-list shape (shared by the list and by-id fetches) */
const toMeeting = (event) => {
    const start = event.start?.dateTime ? `${event.start.dateTime}Z`.replace(/Z+$/, 'Z') : '';
    const end = event.end?.dateTime ? `${event.end.dateTime}Z`.replace(/Z+$/, 'Z') : '';
    const duration = (start && end)
        ? Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 60000))
        : 30;
    return {
        id: event.id ?? '',
        subject: event.subject || 'Untitled meeting',
        start,
        end,
        durationMinutes: duration,
        joinUrl: event.onlineMeeting?.joinUrl ?? null,
    };
};

/**
 * One event by id — the live truth for a meeting a waiting agent tracks.
 * Returns null when the event was cancelled or deleted. Event ids live in
 * ONE mailbox, so every signed-in account is tried until one knows it.
 */
const getEvent = async (id) => {
    if (!app) throw new Error('Calendar is not connected.');
    const accounts = await app.getTokenCache().getAllAccounts();
    if (accounts.length === 0) throw new Error('Calendar is not connected.');
    const url = `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`
        + '?$select=subject,start,end,isCancelled,isOnlineMeeting,onlineMeeting';
    let lastError = null;
    let anyAnswered = false;
    for (const account of accounts) {
        const token = await accessTokenFor(account);
        if (!token) { lastError = new Error(`Sign-in for ${account.username} has expired.`); continue; }
        const response = await fetch(url, {
            headers: { authorization: `Bearer ${token}`, prefer: 'outlook.timezone="UTC"' },
        });
        if (response.status === 404) { anyAnswered = true; continue; } // not this mailbox — try the next
        if (!response.ok) {
            const body = await response.text().catch(() => '(no body)');
            lastError = new Error(`Graph answered ${response.status}: ${body.slice(0, 300)}`);
            continue;
        }
        const event = await response.json();
        if (event.isCancelled) return null;
        return { ...toMeeting({ ...event, id }), account: account.username };
    }
    // Every mailbox said 404 = the event is genuinely gone (cancelled).
    if (anyAnswered) return null;
    throw lastError ?? new Error('Calendar is not connected.');
};

module.exports = { status, authUrl, handleCallback, upcomingMeetings, getEvent, setSelected, removeAccount };
