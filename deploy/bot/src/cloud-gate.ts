/**
 * Zeus cloud bot — Phase 6, Milestone 3.
 *
 * The hosted twin of apps/teams-bot/src/gate.ts. Instead of serving its own
 * cockpit, it talks to the hosted cockpit server (the hub) over HTTPS:
 *
 *   1. Polls GET /bot/brief until someone briefs an agent on the website.
 *   2. Joins that meeting and runs the exact same procedures as local
 *      (join, greeting, captions, Nudger decisions).
 *   3. Pushes its state (board, transcript, nudges, mentions) to the hub
 *      every couple of seconds — the website renders from those pushes —
 *      and collects any queued steers in the same breath.
 *   4. When the meeting ends, resets the hub (fresh briefing screen) and
 *      goes back to polling. One shared bot, one meeting at a time.
 *
 * Safety: MAX_DAILY_DECISIONS caps the number of paid API calls per
 * calendar day (UTC). The kill switch is Railway's Stop button on this
 * service — documented in NOTES.md.
 *
 * Env: HUB_URL, BOT_TOKEN, ANTHROPIC_API_KEY, MAX_DAILY_DECISIONS (500)
 */
import { chromium, Browser } from 'playwright';
import { randomUUID } from 'crypto';
import { JoinProcedure } from '../../../apps/teams-bot/src/procedures/join-procedure';
import { ChatProcedure } from '../../../apps/teams-bot/src/procedures/chat-procedure';
import { CaptionsProcedure } from '../../../apps/teams-bot/src/procedures/captions-procedure';
import { Nudger, TimeState } from '../../../apps/teams-bot/src/lib/Nudger';
import { Condition } from '../../../apps/teams-bot/src/conditions';

const HUB_URL = (process.env.HUB_URL ?? '').replace(/\/$/, '');
const BOT_TOKEN = process.env.BOT_TOKEN ?? '';
const API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const MAX_DAILY_DECISIONS = Number(process.env.MAX_DAILY_DECISIONS) || 500;

/** How long the meeting can be lost (not in-meeting/lobby) before we call it over */
const MEETING_LOST_MS = 90000;
/** Hard stop: leave once this far past the scheduled end, whatever happens */
const OVERTIME_LIMIT_MINUTES = 60;

if (!HUB_URL || !BOT_TOKEN || !API_KEY) {
    console.error('cloud-gate needs HUB_URL, BOT_TOKEN and ANTHROPIC_API_KEY set.');
    process.exit(1);
}

/** Same one-place greeting as gate.ts */
const greetingFor = (ownerName: string) => ownerName
    ? `Hi, I'm ${ownerName}'s meeting assistant. I'll help keep us on track.`
    : `Hi, I'm the meeting assistant. I'll help keep us on track.`;

type BriefFromHub = {
    /** Phase 7c: which drawer of hub state this meeting lives in */
    meetingId: string;
    meetingName: string;
    labels: string[];
    context: string;
    lengthMinutes: number;
    ownerName: string;
    meetingUrl: string;
};

/**
 * ================================================
 * The hub client — every call carries the shared secret
 * ================================================
 */
const hub = {
    async call(pathname: string, options: { method?: string, body?: unknown } = {}): Promise<Record<string, unknown> | null> {
        try {
            const response = await fetch(`${HUB_URL}${pathname}`, {
                method: options.method ?? 'GET',
                headers: {
                    'x-bot-token': BOT_TOKEN,
                    'content-type': 'application/json',
                },
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
            });
            if (!response.ok) {
                console.error(`hub ${pathname} answered ${response.status}`);
                return null;
            }
            return await response.json() as Record<string, unknown>;
        } catch (error) {
            console.error(`hub ${pathname} unreachable:`, error instanceof Error ? error.message : error);
            return null;
        }
    },
    async getBrief(): Promise<BriefFromHub | null> {
        const answer = await this.call('/bot/brief');
        return (answer && answer.brief) ? answer.brief as BriefFromHub : null;
    },
    /** Pushes one meeting's snapshot; returns any steers queued for it on the website */
    async pushState(meetingId: string, snapshot: object): Promise<string[]> {
        const answer = await this.call(`/bot/state/${meetingId}`, { method: 'POST', body: snapshot });
        return (answer && Array.isArray(answer.steers)) ? answer.steers as string[] : [];
    },
    async reset(meetingId: string): Promise<void> {
        await this.call(`/bot/reset/${meetingId}`, { method: 'POST' });
    },
};

/**
 * ================================================
 * The usage cap — paid API calls per UTC day
 * ================================================
 */
let capDay = new Date().toISOString().slice(0, 10);
let decisionsToday = 0;
let capAnnounced = false;
const underCap = (): boolean => {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== capDay) {
        capDay = today;
        decisionsToday = 0;
        capAnnounced = false;
    }
    if (decisionsToday >= MAX_DAILY_DECISIONS) {
        if (!capAnnounced) {
            capAnnounced = true;
            console.error(`USAGE CAP HIT >>> ${MAX_DAILY_DECISIONS} decisions today — no more API calls until tomorrow (UTC).`);
        }
        return false;
    }
    decisionsToday++;
    return true;
};

/**
 * ================================================
 * One meeting, end to end
 * ================================================
 */
const runMeeting = async (brief: BriefFromHub) => {
    const botId = randomUUID();
    console.log(`\n=== Cloud bot briefed (${brief.meetingId}): "${brief.meetingName}" — ${brief.labels.join(' | ')} ===\n`);

    // Phase 7c: this meeting's OWN conditions and its OWN brain — nothing is
    // shared between meetings, so boards can never cross-contaminate.
    const conditions: Condition[] = brief.labels.map((label, index) => ({
        id: `c${index}`, label, status: 'open', nudges: 0,
    }));
    const nudger = new Nudger({ botId, apiKey: API_KEY, conditions });
    nudger.setContext(brief.context);
    nudger.setOwner(brief.ownerName);

    // The hub-side state this bot owns for the duration of the meeting.
    const transcript: Array<{ speaker: string, text: string, ts: string, hit: boolean }> = [];
    const nudges: Array<{ text: string, conditionId: string | null, steered: boolean, at: string }> = [];
    const mentions: Array<{ speaker: string, quote: string, at: string }> = [];
    let meetingStatus: 'connecting' | 'lobby' | 'in-meeting' | 'unknown' = 'connecting';
    let meetingJoinedAt: string | null = null;

    const timeState = (): TimeState => {
        if (!meetingJoinedAt) {
            return { scheduledMinutes: brief.lengthMinutes, remainingMinutes: null };
        }
        const elapsed = (Date.now() - Date.parse(meetingJoinedAt)) / 60000;
        return { scheduledMinutes: brief.lengthMinutes, remainingMinutes: brief.lengthMinutes - elapsed };
    };

    let browser: Browser | null = null;
    let nudgeQueue: Promise<void> = Promise.resolve();

    try {
        browser = await chromium.launch({
            headless: false, // headed on the container's virtual screen (xvfb)
            args: [
                '--use-fake-ui-for-media-stream',
                '--use-fake-device-for-media-stream',
                '--no-sandbox',              // required inside the container
                '--disable-dev-shm-usage',   // container shared memory is tiny; use disk instead
                '--disable-blink-features=AutomationControlled', // don't announce "I am a robot"
            ],
        });
        const context = await browser.newContext({
            viewport: { width: 1600, height: 900 },
            // The Windows Chrome identity is deliberate and PROVEN: it works
            // locally and reached the lobby from the cloud. The "honest"
            // Linux identity regressed — the Teams launcher hides the
            // continue-on-web button from Linux visitors.
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        });
        const page = await context.newPage();

        const join = new JoinProcedure({ botId, page });
        const chat = new ChatProcedure({ botId, page });

        try {
            await join.startMeetingLauncherFlow({ meetingUrl: brief.meetingUrl });
            await join.joinMeetingLobbyFlow();
        } catch (error) {
            // Before giving up, put Teams' own words in the log — the page
            // usually says exactly why it refused (unsupported browser,
            // sign-in required, meeting not found...).
            const title = await page.title().catch(() => '(no title — page/browser may be dead)');
            const bodyText = await page.evaluate(`(document.body && document.body.innerText || '').slice(0, 400)`).catch(() => '(unreadable — page/browser may be dead)') as string;
            console.log(`JOIN FAILED — PAGE TITLE >>> ${title}`);
            console.log(`JOIN FAILED — PAGE SAYS >>> ${bodyText.replace(/\s+/g, ' ').trim()}`);
            throw error;
        }
        console.log('=== Cloud bot: join clicked, watching status ===');

        // Push state + collect steers every 2 seconds, independent of the
        // slower status loop below.
        const pusher = setInterval(() => {
            void (async () => {
                const steers = await hub.pushState(brief.meetingId, { meetingStatus, meetingJoinedAt, conditions, nudges, transcript, mentions });
                for (const instruction of steers) {
                    console.log(`STEER from hub >>> ${instruction}`);
                    nudgeQueue = nudgeQueue
                        .then(async () => {
                            if (!underCap()) return;
                            const directive = await nudger.executeSteer(instruction, transcript.slice(-10), timeState());
                            if (!directive) return;
                            console.log(`STEERED MESSAGE >>> ${directive.text}`);
                            nudges.push({ text: directive.text, conditionId: directive.conditionId, steered: true, at: new Date().toISOString() });
                            await chat.sendMessage(directive.text);
                        })
                        .catch((error) => console.error('Steer pipeline error:', error));
                }
            })();
        }, 2000);

        let lastState = '';
        let lostSince: number | null = null;
        let chatMessagePosted = false;
        let captionsStarted = false;
        const joinAttemptStartedAt = Date.now();

        try {
            while (true) {
                let state = 'unknown';
                if (await join.isInMeeting({})) {
                    state = 'in-meeting';
                } else if (await join.isInMeetingLobby({})) {
                    state = 'lobby';
                }
                meetingStatus = state === 'in-meeting' ? 'in-meeting' : state === 'lobby' ? 'lobby' : 'unknown';
                if (state === 'in-meeting' && !meetingJoinedAt) {
                    meetingJoinedAt = new Date().toISOString();
                }
                if (state !== lastState) {
                    console.log(`>>> STATUS: ${state} <<<`);
                    lastState = state;
                    // Diagnosis: when Teams drops us somewhere unrecognised,
                    // log what the page actually says — its own words explain
                    // rejections better than our guesses.
                    if (state === 'unknown') {
                        // NOTE: raw string, not a function — tsx rewrites
                        // functions with helpers that don't exist in the page
                        // (same trap documented in captions-procedure.ts).
                        const title = await page.title().catch(() => '(no title — page/browser may be dead)');
                        const bodyText = await page.evaluate(`(document.body && document.body.innerText || '').slice(0, 400)`).catch(() => '(unreadable — page/browser may be dead)') as string;
                        console.log(`PAGE SAYS >>> title: ${title}`);
                        console.log(`PAGE SAYS >>> ${bodyText.replace(/\s+/g, ' ').trim()}`);
                    }
                }

                // Meeting-over detection: we were in, and now we've been lost
                // for a while — or we are absurdly far past the scheduled end.
                if (meetingJoinedAt && state !== 'in-meeting') {
                    lostSince = lostSince ?? Date.now();
                    if (Date.now() - lostSince >= MEETING_LOST_MS) {
                        console.log('=== Meeting appears to be over (lost for 90s) — wrapping up. ===');
                        break;
                    }
                } else {
                    lostSince = null;
                }
                const remaining = timeState().remainingMinutes;
                if (remaining !== null && remaining < -OVERTIME_LIMIT_MINUTES) {
                    console.log('=== Hard overtime limit reached — leaving the meeting. ===');
                    break;
                }
                // Never admitted at all? Give up after a while so the website
                // isn't stuck "busy" on a meeting that never started.
                if (!meetingJoinedAt && Date.now() - joinAttemptStartedAt > 6 * 60000) {
                    console.log('=== Not admitted within 6 minutes — giving up and freeing the cockpit. ===');
                    break;
                }

                if (state === 'in-meeting' && !chatMessagePosted) {
                    chatMessagePosted = true;
                    await page.waitForTimeout(3000);
                    const posted = await chat.sendMessageReliably(greetingFor(brief.ownerName));
                    console.log(posted ? '>>> Greeting posted. <<<' : '>>> Greeting failed after retries — carrying on. <<<');
                }

                if (state === 'in-meeting' && chatMessagePosted && !captionsStarted) {
                    captionsStarted = true;
                    try {
                        const captions = new CaptionsProcedure({
                            botId,
                            page,
                            onFinishedLine: (line) => {
                                const record = { ...line, hit: false };
                                transcript.push(record);
                                if (transcript.length > 200) transcript.shift();
                                nudgeQueue = nudgeQueue
                                    .then(async () => {
                                        if (!underCap()) return;
                                        const decision = await nudger.decide({ transcript: transcript.slice(-40), time: timeState() });
                                        if (decision.resolvedIds.length > 0) {
                                            record.hit = true;
                                        }
                                        if (decision.mention) {
                                            console.log(`MENTION >>> ${decision.mention.speaker}: "${decision.mention.quote}"`);
                                            mentions.push({ ...decision.mention, at: new Date().toISOString() });
                                        }
                                        if (decision.nudge) {
                                            console.log(`NUDGE >>> (${decision.nudge.conditionId}) ${decision.nudge.text}`);
                                            nudges.push({ text: decision.nudge.text, conditionId: decision.nudge.conditionId, steered: false, at: new Date().toISOString() });
                                            await chat.sendMessage(decision.nudge.text);
                                        }
                                    })
                                    .catch((error) => console.error('Nudge pipeline error:', error));
                            },
                        });
                        await captions.enableCaptionsFlow();
                        await captions.subscribeToCaptions();
                        console.log('>>> Live captions ON. <<<');
                    } catch (error) {
                        console.error('>>> PROBLEM: could not start captions <<<', error);
                    }
                }

                await page.waitForTimeout(5000);
            }
        } finally {
            clearInterval(pusher);
        }
    } finally {
        if (browser) {
            await browser.close().catch(() => { /* already gone */ });
        }
        await hub.reset(brief.meetingId);
        console.log(`=== Cloud bot: meeting ${brief.meetingId} cleaned up. ===\n`);
    }
};

/**
 * ================================================
 * Forever: collect briefs while there's capacity; each meeting runs
 * concurrently in its own browser. One meeting crashing (its own
 * try/finally inside runMeeting) never touches the others.
 * ================================================
 */
const MAX_CONCURRENT_MEETINGS = Number(process.env.MAX_MEETINGS) || 3;
let activeMeetings = 0;

const main = async () => {
    console.log(`Zeus cloud bot up — hub: ${HUB_URL}, daily decision cap (ALL meetings combined): ${MAX_DAILY_DECISIONS}, max concurrent meetings: ${MAX_CONCURRENT_MEETINGS}`);
    while (true) {
        if (activeMeetings < MAX_CONCURRENT_MEETINGS) {
            const brief = await hub.getBrief();
            if (brief) {
                activeMeetings++;
                console.log(`>>> meetings running: ${activeMeetings}/${MAX_CONCURRENT_MEETINGS}`);
                void runMeeting(brief)
                    .catch(async (error) => {
                        console.error(`=== Meeting ${brief.meetingId} run failed ===`, error);
                        await hub.reset(brief.meetingId); // never leave the website stuck on a dead brief
                    })
                    .finally(() => {
                        activeMeetings--;
                        console.log(`>>> meetings running: ${activeMeetings}/${MAX_CONCURRENT_MEETINGS}`);
                    });
                continue; // check straight away whether another brief is waiting
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 5000));
    }
};

void main();
