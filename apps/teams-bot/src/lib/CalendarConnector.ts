import fs from 'fs';
import path from 'path';
import {
    AccountInfo,
    ConfidentialClientApplication,
    ICachePlugin,
    TokenCacheContext,
} from '@azure/msal-node';

/**
 * CalendarConnector — read-only access to the owner's Outlook calendar via
 * the official Microsoft Graph API, so briefing never needs a pasted link.
 *
 * Scope decisions (deliberate):
 *   - MULTI-ACCOUNT. Every Microsoft account that signs in ("Add another
 *     account") lands in the same MSAL cache; meetings are fetched from
 *     all of them and merged, each tagged with its account. Anyone who
 *     can open the cockpit sees the merged view — per-person access
 *     control is a parked later phase.
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
    /** Which signed-in account's calendar this came from */
    account?: string;
};

/** What the cockpit needs from a calendar — the harness fakes this shape */
export interface CalendarLike {
    status(): Promise<{ configured: boolean, connected: boolean, account: string | null, accounts: string[] }>;
    authUrl(): Promise<string>;
    handleCallback(code: string): Promise<string>; // returns the signed-in account name
    upcomingMeetings(): Promise<UpcomingMeeting[]>;
    /** One event by id — null when it was cancelled/deleted. Lets a waiting
     *  agent follow a meeting that gets MOVED (earlier or later). */
    getEvent(id: string): Promise<UpcomingMeeting | null>;
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
    // Both spellings accepted — MS_* and MICROSOFT_* — so the .env just works.
    private readonly clientId = process.env.MS_CLIENT_ID || process.env.MICROSOFT_CLIENT_ID || '';
    private readonly clientSecret = process.env.MS_CLIENT_SECRET || process.env.MICROSOFT_CLIENT_SECRET || '';
    private readonly redirectUri = process.env.MS_REDIRECT_URI || process.env.MICROSOFT_REDIRECT_URI || 'http://localhost:4300/auth/callback';
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

    /** configured = env credentials present; connected = at least one signed-in account */
    public async status() {
        if (!this.msal) {
            return { configured: false, connected: false, account: null, accounts: [] as string[] };
        }
        const accounts = (await this.msal.getTokenCache().getAllAccounts()).map((a) => a.username);
        return {
            configured: true,
            connected: accounts.length > 0,
            // Kept for older UI strings: every connected account, human-joined.
            account: accounts.length ? accounts.join(' + ') : null,
            accounts,
        };
    }

    /** Where "Connect calendar" sends the owner: Microsoft's own sign-in page */
    public async authUrl(): Promise<string> {
        if (!this.msal) throw new Error('Calendar is not configured (MS_CLIENT_ID / MS_CLIENT_SECRET missing).');
        // select_account: without it Microsoft silently reuses the browser's
        // signed-in account — a second person could never add THEIR calendar.
        return this.msal.getAuthCodeUrl({ scopes: GRAPH_SCOPES, redirectUri: this.redirectUri, prompt: 'select_account' });
    }

    /** Finishes the sign-in; MSAL stores the token (incl. refresh) in the file cache */
    public async handleCallback(code: string): Promise<string> {
        if (!this.msal) throw new Error('Calendar is not configured.');
        const result = await this.msal.acquireTokenByCode({ code, scopes: GRAPH_SCOPES, redirectUri: this.redirectUri });
        console.log(`CALENDAR CONNECTED >>> ${result.account?.username ?? '(unknown account)'}`);
        return result.account?.username ?? '';
    }

    /** A silently-refreshed access token for ONE account, or null when it can't refresh */
    private async accessTokenFor(account: AccountInfo): Promise<string | null> {
        if (!this.msal) return null;
        try {
            const result = await this.msal.acquireTokenSilent({ account, scopes: GRAPH_SCOPES });
            return result?.accessToken ?? null;
        } catch (error) {
            console.error(`Calendar token refresh failed for ${account.username} (reconnect from the homepage):`, error);
            return null;
        }
    }

    /**
     * The next two weeks of meetings (max 25 per account), soonest first,
     * merged across EVERY signed-in account — each tagged with the account
     * it came from. Events without a Teams join link come back with
     * joinUrl: null so the UI can grey them out. Uses /me/calendarView so
     * recurring meetings appear as their actual occurrences. A meeting both
     * accounts were invited to appears once (deduped by its join link).
     */
    public async upcomingMeetings(): Promise<UpcomingMeeting[]> {
        if (!this.msal) throw new Error('Calendar is not connected.');
        const accounts = await this.msal.getTokenCache().getAllAccounts();
        if (accounts.length === 0) throw new Error('Calendar is not connected.');
        const now = new Date();
        const horizon = new Date(now.getTime() + 14 * 24 * 3600_000);
        const url = 'https://graph.microsoft.com/v1.0/me/calendarView'
            + `?startDateTime=${encodeURIComponent(now.toISOString())}`
            + `&endDateTime=${encodeURIComponent(horizon.toISOString())}`
            + '&$orderby=start/dateTime&$top=25'
            + '&$select=subject,start,end,isOnlineMeeting,onlineMeeting';

        const merged: UpcomingMeeting[] = [];
        let anySucceeded = false;
        let lastError: unknown = null;
        for (const account of accounts) {
            const token = await this.accessTokenFor(account);
            if (!token) { lastError = new Error(`Sign-in for ${account.username} has expired.`); continue; }
            try {
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
                for (const event of data.value ?? []) {
                    merged.push({ ...CalendarConnector.toMeeting(event), account: account.username });
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
        const seen = new Set<string>();
        const unique = merged.filter((m) => {
            if (!m.joinUrl) return true;
            if (seen.has(m.joinUrl)) return false;
            seen.add(m.joinUrl);
            return true;
        });
        return unique.sort((a, b) => a.start.localeCompare(b.start));
    }

    /**
     * One event by id — the live truth for a meeting the agent is waiting
     * on. Returns null when the event was cancelled or deleted (Graph
     * answers 404, or marks it isCancelled). Event ids live in ONE
     * mailbox, so every signed-in account is tried until one knows it.
     */
    public async getEvent(id: string): Promise<UpcomingMeeting | null> {
        if (!this.msal) throw new Error('Calendar is not connected.');
        const accounts = await this.msal.getTokenCache().getAllAccounts();
        if (accounts.length === 0) throw new Error('Calendar is not connected.');
        const url = `https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(id)}`
            + '?$select=subject,start,end,isCancelled,isOnlineMeeting,onlineMeeting';
        let lastError: unknown = null;
        let anyAnswered = false;
        for (const account of accounts) {
            const token = await this.accessTokenFor(account);
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
            const event = await response.json() as Record<string, unknown> & { isCancelled?: boolean };
            if (event.isCancelled) return null;
            return { ...CalendarConnector.toMeeting({ ...event, id }), account: account.username };
        }
        // Every mailbox said 404 = the event is genuinely gone (cancelled).
        if (anyAnswered) return null;
        throw lastError ?? new Error('Calendar is not connected.');
    }

    /** Graph event -> the pick-list shape (shared by the list and by-id fetches) */
    private static toMeeting(event: {
        id?: string,
        subject?: string,
        start?: { dateTime?: string },
        end?: { dateTime?: string },
        onlineMeeting?: { joinUrl?: string } | null,
    }): UpcomingMeeting {
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
    }
}
