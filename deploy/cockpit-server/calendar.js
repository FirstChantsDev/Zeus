/**
 * Hosted-hub Outlook calendar — a plain-JS port of the local connector
 * (apps/teams-bot/src/lib/CalendarConnector.ts). Same deliberate scope:
 * SINGLE OWNER, delegated Calendars.Read only, read-only, sign-in and
 * token handling through Microsoft's own auth library (@azure/msal-node)
 * — no hand-rolled OAuth.
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
    process.env.ZEUS_CAL_TOKEN_FILE || path.join(process.cwd(), 'calendar-token.json');

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

/** configured = env credentials present; connected = a signed-in account exists */
const status = async () => {
    if (!app) {
        return { configured: false, connected: false, account: null };
    }
    const accounts = await app.getTokenCache().getAllAccounts();
    const account = accounts[0] ?? null;
    return { configured: true, connected: Boolean(account), account: account ? account.username : null };
};

/** Where "Connect calendar" sends the owner: Microsoft's own sign-in page */
const authUrl = async (req) => {
    if (!app) throw new Error('Calendar is not configured (MS_CLIENT_ID / MS_CLIENT_SECRET missing).');
    lastAuthRedirectUri = redirectUriFor(req);
    console.log(`CALENDAR AUTH >>> redirect URI in play: ${lastAuthRedirectUri}`);
    return app.getAuthCodeUrl({ scopes: GRAPH_SCOPES, redirectUri: lastAuthRedirectUri });
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

/** A silently-refreshed access token, or null when not connected */
const accessToken = async () => {
    if (!app) return null;
    const accounts = await app.getTokenCache().getAllAccounts();
    if (!accounts[0]) return null;
    try {
        const result = await app.acquireTokenSilent({ account: accounts[0], scopes: GRAPH_SCOPES });
        return (result && result.accessToken) || null;
    } catch (error) {
        console.error('Calendar token refresh failed (reconnect from the briefing screen):', error);
        return null;
    }
};

/**
 * The owner's next two weeks of meetings (max 25), soonest first — the
 * same Graph call as the local connector. Events without a Teams join
 * link come back with joinUrl: null so the UI can grey them out.
 */
const upcomingMeetings = async () => {
    const token = await accessToken();
    if (!token) throw new Error('Calendar is not connected.');
    const now = new Date();
    const horizon = new Date(now.getTime() + 14 * 24 * 3600_000);
    const url = 'https://graph.microsoft.com/v1.0/me/calendarView'
        + `?startDateTime=${encodeURIComponent(now.toISOString())}`
        + `&endDateTime=${encodeURIComponent(horizon.toISOString())}`
        + '&$orderby=start/dateTime&$top=25'
        + '&$select=subject,start,end,isOnlineMeeting,onlineMeeting';
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
    return (data.value ?? []).map((event) => toMeeting(event));
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
 * Returns null when the event was cancelled or deleted.
 */
const getEvent = async (id) => {
    const token = await accessToken();
    if (!token) throw new Error('Calendar is not connected.');
    const url = `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`
        + '?$select=subject,start,end,isCancelled,isOnlineMeeting,onlineMeeting';
    const response = await fetch(url, {
        headers: { authorization: `Bearer ${token}`, prefer: 'outlook.timezone="UTC"' },
    });
    if (response.status === 404) return null;
    if (!response.ok) {
        const body = await response.text().catch(() => '(no body)');
        throw new Error(`Graph answered ${response.status}: ${body.slice(0, 300)}`);
    }
    const event = await response.json();
    if (event.isCancelled) return null;
    return toMeeting({ ...event, id });
};

module.exports = { status, authUrl, handleCallback, upcomingMeetings, getEvent };
