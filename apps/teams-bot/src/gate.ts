/**
 * Zeus prototype launcher.
 *
 * Usage:  npx tsx apps/teams-bot/src/gate.ts <teams-meeting-url>
 *
 * Phase 3 flow: starts the cockpit at http://localhost:4300 and WAITS.
 * The owner types her brief there (meeting name, 1-3 conditions, optional
 * context) and clicks "Send agent into the meeting" — only then does a
 * VISIBLE Chrome window open and join the meeting as "Zeus bot" with
 * camera and mic off. The window stays open until you press Ctrl+C in
 * the terminal.
 */
import 'dotenv/config';
import { chromium, Browser } from 'playwright';
import { randomUUID } from 'crypto';
import { JoinProcedure } from './procedures/join-procedure';
import { ChatProcedure } from './procedures/chat-procedure';
import { CaptionsProcedure } from './procedures/captions-procedure';
import { Nudger, LineDecision } from './lib/Nudger';
import { CockpitServer, TranscriptRecord } from './lib/CockpitServer';
import { MeetingRecord } from './lib/MeetingRecord';
import { conditions, applyBrief } from './conditions';

/** The cockpit's local address: http://localhost:4300 */
const COCKPIT_PORT = 4300;

/** Auto-shutdown: how long the meeting can be lost (not in-meeting/lobby)
 *  after the bot was in, before we call it over — same as the cloud bot. */
const MEETING_LOST_MS = 90000;
/** Auto-shutdown: leave once this far past the scheduled end, whatever happens */
const OVERTIME_LIMIT_MINUTES = 60;

/**
 * Phase 5: THE greeting the bot posts to the meeting chat when it joins.
 * One place on purpose — change the wording here (it becomes configurable
 * from the briefing screen in a later phase). {owner} comes from the brief.
 */
const greetingFor = (ownerName: string) => ownerName
    ? `Hi, I'm ${ownerName}'s meeting assistant. I'll help keep us on track.`
    : `Hi, I'm the meeting assistant. I'll help keep us on track.`;

const meetingUrl = process.argv[2];
if (!meetingUrl) {
    console.error('Usage: npx tsx apps/teams-bot/src/gate.ts <teams-meeting-url>');
    process.exit(1);
}

const main = async () => {
    const botId = randomUUID();

    // Phase 3: conditions start EMPTY. The owner types them into the
    // briefing screen at http://localhost:4300; the agent drives whatever
    // she typed. Without an API key the bot still runs, it just prints
    // captions without ever posting nudges.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const nudger = apiKey ? new Nudger({ botId, apiKey, conditions }) : null;
    if (!nudger) {
        console.log('NOTE: no ANTHROPIC_API_KEY found in .env — captions will print, but no nudges will be posted.');
    }

    // The bot only walks into the meeting AFTER the brief is submitted:
    // this promise resolves the moment the cockpit accepts POST /setup.
    let briefSubmitted: () => void;
    const briefed = new Promise<void>((resolve) => { briefSubmitted = resolve; });

    // Created after the brief, when the browser opens and joins.
    let chat: ChatProcedure | null = null;
    let browser: Browser | null = null;

    // The meeting's audit trail — events are appended AS THEY HAPPEN and
    // the whole record is written to records/ when the meeting ends.
    const record = new MeetingRecord(botId.slice(0, 8));
    let wasBriefed = false;

    // One exit path for everything: the cockpit's Kill bot button, the
    // meeting ending, hard overtime, or Ctrl+C. Persists the meeting's
    // record (with a one-call summary), closes Chrome, stops the process.
    let shuttingDown = false;
    const shutdown = async (reason: string) => {
        if (shuttingDown) return; // e.g. kill button and auto-end racing
        shuttingDown = true;
        console.log(`\n=== Zeus bot shutting down: ${reason}. No further API calls after the record is saved. ===\n`);
        try {
            if (wasBriefed) {
                const snapshot = cockpit.snapshotForRecord();
                let summary: string | null = null;
                if (nudger && cockpit.recentTranscript(1).length > 0) {
                    console.log('Writing the meeting summary (one API call)...');
                    summary = await nudger.summarise(record.summaryInput());
                }
                record.save({ endReason: reason, ...snapshot, summary });
            }
        } catch (error) {
            console.error('Could not persist the meeting record:', error);
        }
        if (browser) {
            await browser.close().catch(() => { /* already gone */ });
        }
        process.exit(0);
    };
    process.on('SIGINT', () => { void shutdown('stopped from the terminal (Ctrl+C)'); });

    // Everything the brain concludes lands here — from live caption lines
    // AND from immediate re-judgements after a condition edit/addition.
    const handleDecision = async (decision: LineDecision, transcriptRecord: TranscriptRecord | null) => {
        for (const id of decision.resolvedIds) {
            if (transcriptRecord) {
                transcriptRecord.hit = true; // this line closed a condition — cockpit shows it in jade
            }
            const condition = conditions.find((c) => c.id === id);
            if (condition) {
                record.log('condition-closed', `Condition closed: "${condition.label}"${condition.note ? ` — ${condition.note}` : ''}`, {
                    id, label: condition.label, note: condition.note ?? null, evidence: condition.evidence ?? [],
                });
            }
        }
        // Phase 5: the room just said it needs the owner.
        if (decision.mention) {
            console.log(`MENTION >>> ${decision.mention.speaker}: "${decision.mention.quote}"`);
            cockpit.addMention(decision.mention);
            record.log('owner-mentioned', `${decision.mention.speaker} said the room needs the owner: "${decision.mention.quote}"`, { ...decision.mention });
        }
        if (decision.nudge) {
            console.log(`NUDGE >>> (${decision.nudge.conditionId}) ${decision.nudge.text}`);
            cockpit.addNudge({ text: decision.nudge.text, conditionId: decision.nudge.conditionId });
            record.log('nudge-sent', `Nudge sent: ${decision.nudge.text}`, { conditionId: decision.nudge.conditionId, text: decision.nudge.text });
            await chat!.sendMessage(decision.nudge.text);
        }
    };

    // Phase 5: the owner's name from the brief, for the greeting.
    let ownerName = '';

    // Everything the agent says — self-driven nudges and owner steers alike —
    // goes through one queue, one message at a time, in order.
    let nudgeQueue: Promise<void> = Promise.resolve();

    // The owner's private cockpit — a tiny web server inside this same
    // process, serving the briefing screen first and the live board after.
    // A steer typed there is carried out immediately — the agent composes
    // the message and posts it, no waiting for the next caption.
    const cockpit: CockpitServer = new CockpitServer({
        botId,
        conditions,
        port: COCKPIT_PORT,
        meetingUrl, // Phase 5: the cockpit's Join call button opens this link

        // Phase 3: the briefing screen submitted — fill the shared conditions
        // array with the owner's typed labels and let the join flow proceed.
        onSetup: (brief) => {
            applyBrief(brief.labels);
            nudger?.setContext(brief.context);
            nudger?.setOwner(brief.ownerName); // Phase 5: lets the agent flag "the room needs you"
            ownerName = brief.ownerName;       // Phase 5: personalises the greeting
            wasBriefed = true;
            record.briefed(brief);             // the audit trail starts here
            console.log(`\nBRIEFED >>> "${brief.meetingName}" (${brief.lengthMinutes} min) — the agent is driving:`);
            for (const condition of conditions) {
                console.log(`  - ${condition.label}`);
            }
            if (brief.context) {
                console.log(`  context: ${brief.context}`);
            }
            briefSubmitted();
        },
        onCommand: (instruction) => {
            if (!nudger) {
                console.log('STEER ignored — no ANTHROPIC_API_KEY, the agent cannot compose messages.');
                return;
            }
            record.log('steer-received', `Owner steer: "${instruction}"`, { instruction });
            // Share the nudge queue so a steer never talks over a nudge in flight.
            nudgeQueue = nudgeQueue
                .then(async () => {
                    const chatNow = chat;
                    if (!chatNow) {
                        console.log('STEER ignored — the agent has not opened the meeting yet.');
                        return;
                    }
                    const directive = await nudger.executeSteer(instruction, cockpit.recentTranscript(10), cockpit.timeState());
                    if (!directive) {
                        console.log('STEER >>> could not be turned into a message (see log above).');
                        return;
                    }
                    console.log(`STEERED MESSAGE >>> ${directive.text}`);
                    cockpit.addNudge({ text: directive.text, conditionId: directive.conditionId, steered: true });
                    record.log('nudge-sent', `Steered message sent: ${directive.text}`, { conditionId: directive.conditionId, text: directive.text, steered: true });
                    await chatNow.sendMessage(directive.text);
                })
                .catch((error) => {
                    console.error('Steer pipeline error:', error);
                });
        },
        // Live board edits from the cockpit: audit-log the change, then
        // immediately re-judge the WHOLE transcript so far — a condition
        // added after the room already settled it closes straight away.
        onConditionsChanged: (change) => {
            if (change.kind === 'edited') {
                record.log('condition-edited', `Condition ${change.id} edited: "${change.before}" → "${change.after}"${change.reopened ? ' (was closed — reopened for re-evaluation)' : ''}`, { ...change });
            } else {
                record.log('condition-added', `Condition added mid-call: "${change.label}"`, { ...change });
            }
            if (!nudger || !chat || cockpit.recentTranscript(1).length === 0) {
                return; // nothing said yet (or no API key) — the next caption picks it up
            }
            nudgeQueue = nudgeQueue
                .then(async () => {
                    const decision = await nudger.decide({
                        transcript: cockpit.recentTranscript(40),
                        time: cockpit.timeState(),
                    });
                    await handleDecision(decision, null);
                })
                .catch((error) => {
                    console.error('Re-judge pipeline error:', error);
                });
        },
        // The cockpit's Kill bot button — works any time, even before the
        // brief (kills the waiting process too).
        onShutdown: () => {
            void shutdown('the Kill bot button was pressed in the cockpit');
        },
    });
    cockpit.start();

    // Phase 3 sequencing: brief first, THEN the agent walks in.
    console.log(`\n=== Zeus: waiting for your brief. Open http://localhost:${COCKPIT_PORT}, type your conditions, and send the agent in. ===\n`);
    await briefed;

    console.log('\n=== Zeus bot: brief received — opening the meeting link... ===\n');
    // Which browser to drive. Locally this stays installed Google Chrome
    // ('chrome') because Playwright's bundled Chromium won't start on this
    // PC. The Docker container (Phase 6) has no Chrome — it sets
    // ZEUS_BROWSER_CHANNEL=bundled to use the image's bundled Chromium.
    // Default unchanged: without that setting, behaviour is exactly as before.
    const browserChannel = process.env.ZEUS_BROWSER_CHANNEL === 'bundled' ? undefined : 'chrome';
    browser = await chromium.launch({
        headless: false,   // hard requirement: always visible (the container provides a virtual screen)
        channel: browserChannel,
        args: [
            '--use-fake-ui-for-media-stream',     // auto-accept any mic/camera permission popup
            '--use-fake-device-for-media-stream', // hand Teams a fake mic/camera instead of real hardware
        ],
    });
    const context = await browser.newContext({
        viewport: { width: 1600, height: 900 }, // wide enough that Teams doesn't hide toolbar buttons in the More menu
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();

    const join = new JoinProcedure({ botId, page });
    chat = new ChatProcedure({ botId, page });

    await join.startMeetingLauncherFlow({ meetingUrl });
    await join.joinMeetingLobbyFlow();

    console.log('\n=== Zeus bot: join clicked. Watching status (Ctrl+C here to quit)... ===\n');

    let lastState = '';
    let inMeetingSince: number | null = null;
    let chatMessagePosted = false;
    let captionsStarted = false;
    let wasInMeeting = false;   // the bot made it into the room at least once
    let lostSince: number | null = null; // when the meeting stopped being visible
    while (true) {
        let state = 'unknown';
        if (await join.isInMeeting({})) {
            state = 'in-meeting';
        } else if (await join.isInMeetingLobby({})) {
            state = 'lobby';
        }

        // Keep the cockpit header honest about where the agent is.
        cockpit.setMeetingStatus(state === 'in-meeting' ? 'in-meeting' : state === 'lobby' ? 'lobby' : 'unknown');

        // Auto-shutdown, same rules as the cloud bot: once the bot has been
        // in the meeting, being lost for 90s means the call ended (or we
        // were removed) — kill the process instead of idling forever. And
        // whatever happens, never linger absurdly far past the scheduled end.
        if (state === 'in-meeting') {
            wasInMeeting = true;
            lostSince = null;
        } else if (wasInMeeting) {
            lostSince = lostSince ?? Date.now();
            if (Date.now() - lostSince >= MEETING_LOST_MS) {
                await shutdown('the meeting appears to be over (out of the room for 90s)');
            }
        }
        const remainingMinutes = cockpit.timeState().remainingMinutes;
        if (remainingMinutes !== null && remainingMinutes < -OVERTIME_LIMIT_MINUTES) {
            await shutdown(`hard overtime limit reached (${OVERTIME_LIMIT_MINUTES} min past the scheduled end)`);
        }

        if (state !== lastState) {
            if (state === 'lobby') {
                console.log('\n>>> STATUS: In the waiting room (lobby). Waiting to be admitted. <<<\n');
            } else if (state === 'in-meeting') {
                inMeetingSince = Date.now();
                record.joined(); // audit trail: the agent is in the room (first time only)
                console.log('\n>>> STATUS: Admitted! Zeus bot is now IN the meeting. <<<\n');
            } else {
                console.log('\n>>> STATUS: Not in lobby or meeting (page may still be loading, or the call ended). <<<\n');
            }
            lastState = state;
        }

        // Phase 5: once admitted, post the greeting — reliably. The send is
        // confirmed (the compose box must clear) and retried a few times,
        // because this message becomes customisable later and must not be
        // hit-or-miss.
        if (state === 'in-meeting' && !chatMessagePosted) {
            chatMessagePosted = true; // one greeting per meeting — retries live inside sendMessageReliably
            await page.waitForTimeout(3000); // let the meeting UI settle first
            const posted = await chat.sendMessageReliably(greetingFor(ownerName));
            if (posted) {
                console.log('\n>>> STATUS: Greeting posted to the meeting chat. <<<\n');
            } else {
                console.error('\n>>> PROBLEM: Greeting did not post after several attempts — carrying on without it. <<<\n');
            }
        }

        // Turn on live captions and print finished lines.
        if (state === 'in-meeting' && chatMessagePosted && !captionsStarted) {
            captionsStarted = true; // only try once, even if it fails
            try {
                const captions = new CaptionsProcedure({
                    botId,
                    page,
                    // Every finished caption line goes to the cockpit's
                    // transcript, then to the nudge brain.
                    onFinishedLine: (line) => {
                        const transcriptRecord = cockpit.addTranscriptLine(line);
                        record.sawSpeaker(line.speaker); // first appearance = participant event
                        if (!nudger) {
                            return;
                        }
                        nudgeQueue = nudgeQueue
                            .then(async () => {
                                // Phase 4: the brain judges a rolling window of the
                                // conversation (newest line included, added above),
                                // plus where the meeting stands against the clock.
                                const decision = await nudger.decide({
                                    transcript: cockpit.recentTranscript(40),
                                    time: cockpit.timeState(),
                                });
                                await handleDecision(decision, transcriptRecord);
                            })
                            .catch((error) => {
                                console.error('Nudge pipeline error:', error);
                            });
                    },
                });
                await captions.enableCaptionsFlow();
                await captions.subscribeToCaptions();
                console.log('\n>>> STATUS: Live captions are ON. Speak — finished lines print below as CAPTION >>> lines. <<<\n');
            } catch (error) {
                console.error('\n>>> PROBLEM: Could not turn on / read live captions. <<<\n', error);
            }
        }

        // Report a stable minute in the meeting.
        if (state === 'in-meeting' && inMeetingSince && Date.now() - inMeetingSince >= 60000) {
            console.log('>>> STATUS: Stable in meeting for 60+ seconds. <<<');
            inMeetingSince = null; // print this only once
        }

        await page.waitForTimeout(5000);
    }
};

main().catch((error) => {
    console.error('\n=== Zeus bot hit a fatal error ===\n', error);
    process.exit(1);
});
