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
import { Nudger, TimeState, LineDecision } from '../../../apps/teams-bot/src/lib/Nudger';
import { MeetingRecord } from '../../../apps/teams-bot/src/lib/MeetingRecord';
import { Condition, MAX_CONDITIONS } from '../../../apps/teams-bot/src/conditions';

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

/** A live board change queued on the website, applied by the bot (the state owner) */
type BoardEdit = { op: 'edit', id: string, label: string } | { op: 'add', label: string };

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
    /** Pushes one meeting's snapshot; returns any steers, board edits and kill request queued for it on the website */
    async pushState(meetingId: string, snapshot: object): Promise<{ steers: string[], edits: BoardEdit[], kill: boolean }> {
        const answer = await this.call(`/bot/state/${meetingId}`, { method: 'POST', body: snapshot });
        return {
            steers: (answer && Array.isArray(answer.steers)) ? answer.steers as string[] : [],
            edits: (answer && Array.isArray(answer.edits)) ? answer.edits as BoardEdit[] : [],
            kill: Boolean(answer && answer.kill),
        };
    },
    /** Hands the finished meeting's audit record to the hub, which persists it */
    async sendRecord(meetingId: string, record: object): Promise<void> {
        await this.call(`/bot/record/${meetingId}`, { method: 'POST', body: record });
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

    // The meeting's audit trail — events appended as they happen; the
    // finished record goes to the hub, which persists it to disk.
    const record = new MeetingRecord(brief.meetingId);
    record.briefed(brief);

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
    let endReason = 'the bot run ended unexpectedly';

    // Everything the brain concludes lands here — from caption lines AND
    // from immediate re-judgements after a board edit (line = null then).
    const handleDecision = async (
        decision: LineDecision,
        line: { hit: boolean } | null,
        chat: ChatProcedure,
    ) => {
        for (const id of decision.resolvedIds) {
            if (line) line.hit = true;
            const condition = conditions.find((c) => c.id === id);
            if (condition) {
                record.log('condition-closed', `Condition closed: "${condition.label}"${condition.note ? ` — ${condition.note}` : ''}`, {
                    id, label: condition.label, note: condition.note ?? null, evidence: condition.evidence ?? [],
                });
            }
        }
        if (decision.mention) {
            console.log(`MENTION >>> ${decision.mention.speaker}: "${decision.mention.quote}"`);
            mentions.push({ ...decision.mention, at: new Date().toISOString() });
            record.log('owner-mentioned', `${decision.mention.speaker} said the room needs the owner: "${decision.mention.quote}"`, { ...decision.mention });
        }
        if (decision.nudge) {
            console.log(`NUDGE >>> (${decision.nudge.conditionId}) ${decision.nudge.text}`);
            nudges.push({ text: decision.nudge.text, conditionId: decision.nudge.conditionId, steered: false, at: new Date().toISOString() });
            record.log('nudge-sent', `Nudge sent: ${decision.nudge.text}`, { conditionId: decision.nudge.conditionId, text: decision.nudge.text });
            await chat.sendMessage(decision.nudge.text);
        }
    };

    // Applies one board edit queued on the website. Same rules as the local
    // cockpit: editing a closed condition reopens it with a fresh slate.
    const applyBoardEdit = (edit: BoardEdit, chat: ChatProcedure) => {
        if (edit.op === 'edit') {
            const condition = conditions.find((c) => c.id === edit.id);
            if (!condition || condition.label === edit.label) return;
            const before = condition.label;
            const reopened = condition.status === 'closed';
            condition.label = edit.label;
            if (reopened) {
                condition.status = 'open';
                condition.nudges = 0;
                delete condition.note;
                delete condition.why;
                delete condition.evidence;
            }
            console.log(`CONDITION EDITED >>> ${condition.id}: "${before}" → "${edit.label}"${reopened ? ' (reopened)' : ''}`);
            record.log('condition-edited', `Condition ${condition.id} edited: "${before}" → "${edit.label}"${reopened ? ' (was closed — reopened for re-evaluation)' : ''}`, { id: condition.id, before, after: edit.label, reopened });
        } else {
            if (conditions.length >= MAX_CONDITIONS) return;
            const nextIndex = conditions.reduce((max, c) => {
                const n = /^c(\d+)$/.exec(c.id);
                return n ? Math.max(max, Number(n[1]) + 1) : max;
            }, conditions.length);
            const condition: Condition = { id: `c${nextIndex}`, label: edit.label, status: 'open', nudges: 0 };
            conditions.push(condition);
            console.log(`CONDITION ADDED >>> ${condition.id}: "${edit.label}"`);
            record.log('condition-added', `Condition added mid-call: "${edit.label}"`, { id: condition.id, label: edit.label });
        }
        // Re-judge the whole transcript so far right away — a condition the
        // room already settled before it was added closes immediately.
        if (transcript.length === 0) return;
        nudgeQueue = nudgeQueue
            .then(async () => {
                if (!underCap()) return;
                const decision = await nudger.decide({ transcript: transcript.slice(-40), time: timeState() });
                await handleDecision(decision, null, chat);
            })
            .catch((error) => console.error('Re-judge pipeline error:', error));
    };

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
        let killRequested = false;
        const pusher = setInterval(() => {
            void (async () => {
                const { steers, edits, kill } = await hub.pushState(brief.meetingId, { meetingStatus, meetingJoinedAt, conditions, nudges, transcript, mentions });
                if (kill && !killRequested) {
                    killRequested = true;
                    console.log('KILL from hub >>> the owner pressed Kill bot — wrapping this meeting up.');
                }
                for (const edit of edits) {
                    applyBoardEdit(edit, chat);
                }
                for (const instruction of steers) {
                    console.log(`STEER from hub >>> ${instruction}`);
                    record.log('steer-received', `Owner steer: "${instruction}"`, { instruction });
                    nudgeQueue = nudgeQueue
                        .then(async () => {
                            if (!underCap()) return;
                            const directive = await nudger.executeSteer(instruction, transcript.slice(-10), timeState());
                            if (!directive) return;
                            console.log(`STEERED MESSAGE >>> ${directive.text}`);
                            nudges.push({ text: directive.text, conditionId: directive.conditionId, steered: true, at: new Date().toISOString() });
                            record.log('nudge-sent', `Steered message sent: ${directive.text}`, { conditionId: directive.conditionId, text: directive.text, steered: true });
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
                // The cockpit's Kill bot button — checked first so it works
                // from the lobby too, exactly like the local kill switch.
                if (killRequested) {
                    endReason = 'shut down from the cockpit (Kill bot)';
                    record.log('meeting-ended', 'The owner pressed Kill bot in the cockpit — the agent left the meeting.', {});
                    break;
                }
                let state = 'unknown';
                if (await join.isInMeeting({})) {
                    state = 'in-meeting';
                } else if (await join.isInMeetingLobby({})) {
                    state = 'lobby';
                }
                meetingStatus = state === 'in-meeting' ? 'in-meeting' : state === 'lobby' ? 'lobby' : 'unknown';
                if (state === 'in-meeting' && !meetingJoinedAt) {
                    meetingJoinedAt = new Date().toISOString();
                    record.joined();
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
                        endReason = 'the meeting ended (out of the room for 90s)';
                        console.log('=== Meeting appears to be over (lost for 90s) — wrapping up. ===');
                        break;
                    }
                } else {
                    lostSince = null;
                }
                const remaining = timeState().remainingMinutes;
                if (remaining !== null && remaining < -OVERTIME_LIMIT_MINUTES) {
                    endReason = `hard overtime limit reached (${OVERTIME_LIMIT_MINUTES} min past the scheduled end)`;
                    console.log('=== Hard overtime limit reached — leaving the meeting. ===');
                    break;
                }
                // Never admitted at all? Give up after a while so the website
                // isn't stuck "busy" on a meeting that never started.
                if (!meetingJoinedAt && Date.now() - joinAttemptStartedAt > 6 * 60000) {
                    endReason = 'never admitted to the meeting (gave up after 6 minutes)';
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
                                const transcriptLine = { ...line, hit: false };
                                transcript.push(transcriptLine);
                                if (transcript.length > 200) transcript.shift();
                                record.sawSpeaker(line.speaker); // first appearance = participant event
                                nudgeQueue = nudgeQueue
                                    .then(async () => {
                                        if (!underCap()) return;
                                        const decision = await nudger.decide({ transcript: transcript.slice(-40), time: timeState() });
                                        await handleDecision(decision, transcriptLine, chat);
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
        // Persist the meeting's audit record via the hub BEFORE the reset
        // wipes the meeting's drawer. The summary is one more paid call,
        // so it counts against the daily cap and is skipped if over it.
        try {
            const nudgesWithFates = nudges.map((nudge, index) => {
                const condition = nudge.conditionId === null ? undefined : conditions.find((c) => c.id === nudge.conditionId);
                const status = nudge.conditionId === null ? 'sent'
                    : condition?.status === 'closed' ? 'landed'
                    : nudges.some((other, otherIndex) => otherIndex > index && other.conditionId === nudge.conditionId) ? 'ignored'
                    : 'waiting';
                return { ...nudge, conditionLabel: condition?.label ?? 'your steer', status };
            });
            let summary: string | null = null;
            if (transcript.length > 0 && underCap()) {
                console.log('Writing the meeting summary (one API call)...');
                summary = await nudger.summarise(record.summaryInput());
            }
            await hub.sendRecord(brief.meetingId, record.build({
                endReason,
                conditions: conditions.map((c) => ({ ...c })),
                nudges: nudgesWithFates,
                mentions,
                summary,
            }));
        } catch (error) {
            console.error('Could not persist the meeting record:', error);
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
