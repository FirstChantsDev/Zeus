import fs from 'fs';
import path from 'path';
import {
    ConfidentialClientApplication,
    ICachePlugin,
    TokenCacheContext,
} from '@azure/msal-node';

/**
 * CalendarConnector — read-only access to the owner's Outlook calendar via
 * the official Microsoft Graph API, so briefing never needs a pasted link.
 *
 * Scope decisions (deliberate):
 *   - SINGLE OWNER. One Microsoft account; the token cache holds one login.
 *   - READ-ONLY. Delegated `Calendars.Read` and nothing else — we never
 *     write to the calendar, never read email.
 *   - Sign-in and token handling go through Microsoft's own auth library
 *     (@azure/msal-node) — no hand-rolled OAuth.
 *
 * Configuration (server-side secrets, .env only, never committed):
 *   MS_CLIENT_ID / MS_CLIENT_SECRET — from the Entra app registration
 *   MS_REDIRECT_URI — optional; defaults to http://localhost:4300/auth/callback
 *
 * THE ONE PIECE OF STATE THAT OUTLIVES THE PROCESS: the sign-in token.
 * MSAL's cache (access + refresh token) is persisted to ONE plain
 * server-side file — calendar-token.json at the repo root (override with
 * ZEUS_CAL_TOKEN_FILE), chmod 600, gitignored. Not a database on purpose.
 * If the file is deleted: nothing breaks — the calendar shows as
 * disconnected and the owner clicks "Connect calendar" again. That's the
 * whole recovery procedure.
 */

/** One upcoming meeting, ready for the briefing pick-list */
export type UpcomingMeeting = {
    id: string;
    subject: string;
    /** ISO start/end, UTC */
    start: string;
    end: string;
    durationMinutes: number;
    /** The Teams join link — null when the event has none (greyed out in the UI) */
    joinUrl: string | null;
};

/** What the cockpit needs from a calendar — the harness fakes this shape */
export interface CalendarLike {
    status(): Promise<{ configured: boolean, connected: boolean, account: string | null }>;
    authUrl(): Promise<string>;
    handleCallback(code: string): Promise<string>; // returns the signed-in account name
    upcomingMeetings(): Promise<UpcomingMeeting[]>;
}

const GRAPH_SCOPES = ['Calendars.Read'];

const tokenFile = (): string =>
    process.env.ZEUS_CAL_TOKEN_FILE || path.join(process.cwd(), 'calendar-token.json');

/** MSAL cache <-> the token file. This is what makes the login survive restarts. */
const fileCachePlugin: ICachePlugin = {
    async beforeCacheAccess(context: TokenCacheContext) {
        try {
            context.tokenCache.deserialize(fs.readFileSync(tokenFile(), 'utf8'));
        } catch { /* no file yet — first run or disconnected */ }
    },
    async afterCacheAccess(context: TokenCacheContext) {
        if (context.cacheHasChanged) {
            try {
                fs.writeFileSync(tokenFile(), context.tokenCache.serialize(), { mode: 0o600 });
            } catch (error) {
                console.error('Could not persist the calendar token:', error);
            }
        }
    },
};

export class CalendarConnector implements CalendarLike {
    private readonly clientId = process.env.MS_CLIENT_ID ?? '';
    private readonly clientSecret = process.env.MS_CLIENT_SECRET ?? '';
    private readonly redirectUri = process.env.MS_REDIRECT_URI || 'http://localhost:4300/auth/callback';
    private readonly msal: ConfidentialClientApplication | null;

    constructor() {
        this.msal = (this.clientId && this.clientSecret)
            ? new ConfidentialClientApplication({
                auth: {
                    clientId: this.clientId,
                    clientSecret: this.clientSecret,
                    // 'common' = personal Microsoft accounts AND work accounts.
                    // Tested against a personal account; corporate tenants may
                    // additionally require admin consent (documented in NOTES).
                    authority: 'https://login.microsoftonline.com/common',
                },
                cache: { cachePlugin: fileCachePlugin },
            })
            : null; // not configured — the UI simply never shows the calendar
    }

    /** configured = env credentials present; connected = a signed-in account exists */
    public async status() {
        if (!this.msal) {
            return { configured: false, connected: false, account: null };
        }
        const accounts = await this.msal.getTokenCache().getAllAccounts();
        const account = accounts[0] ?? null;
        return { configured: true, connected: Boolean(account), account: account?.username ?? null };
    }

    /** Where "Connect calendar" sends the owner: Microsoft's own sign-in page */
    public async authUrl(): Promise<string> {
        if (!this.msal) throw new Error('Calendar is not configured (MS_CLIENT_ID / MS_CLIENT_SECRET missing).');
        return this.msal.getAuthCodeUrl({ scopes: GRAPH_SCOPES, redirectUri: this.redirectUri });
    }

    /** Finishes the sign-in; MSAL stores the token (incl. refresh) in the file cache */
    public async handleCallback(code: string): Promise<string> {
        if (!this.msal) throw new Error('Calendar is not configured.');
        const result = await this.msal.acquireTokenByCode({ code, scopes: GRAPH_SCOPES, redirectUri: this.redirectUri });
        console.log(`CALENDAR CONNECTED >>> ${result.account?.username ?? '(unknown account)'}`);
        return result.account?.username ?? '';
    }

    /** A silently-refreshed access token, or null when not connected */
    private async accessToken(): Promise<string | null> {
        if (!this.msal) return null;
        const accounts = await this.msal.getTokenCache().getAllAccounts();
        if (!accounts[0]) return null;
        try {
            const result = await this.msal.acquireTokenSilent({ account: accounts[0], scopes: GRAPH_SCOPES });
            return result?.accessToken ?? null;
        } catch (error) {
            console.error('Calendar token refresh failed (reconnect from the briefing screen):', error);
            return null;
        }
    }

    /**
     * The owner's next two weeks of meetings (max 25), soonest first.
     * Events without a Teams join link come back with joinUrl: null so the
     * UI can grey them out. Uses /me/calendarView so recurring meetings
     * appear as their actual occurrences.
     */
    public async upcomingMeetings(): Promise<UpcomingMeeting[]> {
        const token = await this.accessToken();
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
                // Graph returns start/end in this zone; UTC keeps parsing simple.
                prefer: 'outlook.timezone="UTC"',
            },
        });
        if (!response.ok) {
            const body = await response.text().catch(() => '(no body)');
            throw new Error(`Graph answered ${response.status}: ${body.slice(0, 300)}`);
        }
        const data = await response.json() as {
            value?: Array<{
                id?: string,
                subject?: string,
                start?: { dateTime?: string },
                end?: { dateTime?: string },
                onlineMeeting?: { joinUrl?: string } | null,
            }>,
        };
        return (data.value ?? []).map((event) => {
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
        });
    }
}
