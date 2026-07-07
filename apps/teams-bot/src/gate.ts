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
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';
import { JoinProcedure } from './procedures/join-procedure';
import { ChatProcedure } from './procedures/chat-procedure';
import { CaptionsProcedure } from './procedures/captions-procedure';
import { Nudger } from './lib/Nudger';
import { CockpitServer } from './lib/CockpitServer';
import { conditions, applyBrief } from './conditions';

/** The cockpit's local address: http://localhost:4300 */
const COCKPIT_PORT = 4300;

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
        // Phase 3: the briefing screen submitted — fill the shared conditions
        // array with the owner's typed labels and let the join flow proceed.
        onSetup: (brief) => {
            applyBrief(brief.labels);
            nudger?.setContext(brief.context);
            nudger?.setOwner(brief.ownerName); // Phase 5: lets the agent flag "the room needs you"
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
                    await chatNow.sendMessage(directive.text);
                })
                .catch((error) => {
                    console.error('Steer pipeline error:', error);
                });
        },
    });
    cockpit.start();

    // Phase 3 sequencing: brief first, THEN the agent walks in.
    console.log(`\n=== Zeus: waiting for your brief. Open http://localhost:${COCKPIT_PORT}, type your conditions, and send the agent in. ===\n`);
    await briefed;

    console.log('\n=== Zeus bot: brief received — opening the meeting link... ===\n');
    const browser = await chromium.launch({
        headless: false,   // hard requirement: always visible
        channel: 'chrome', // Playwright's bundled Chromium won't start on this PC; use installed Chrome
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
    while (true) {
        let state = 'unknown';
        if (await join.isInMeeting({})) {
            state = 'in-meeting';
        } else if (await join.isInMeetingLobby({})) {
            state = 'lobby';
        }

        // Keep the cockpit header honest about where the agent is.
        cockpit.setMeetingStatus(state === 'in-meeting' ? 'in-meeting' : state === 'lobby' ? 'lobby' : 'unknown');

        if (state !== lastState) {
            if (state === 'lobby') {
                console.log('\n>>> STATUS: In the waiting room (lobby). Waiting to be admitted. <<<\n');
            } else if (state === 'in-meeting') {
                inMeetingSince = Date.now();
                console.log('\n>>> STATUS: Admitted! Zeus bot is now IN the meeting. <<<\n');
            } else {
                console.log('\n>>> STATUS: Not in lobby or meeting (page may still be loading, or the call ended). <<<\n');
            }
            lastState = state;
        }

        // Once admitted, post one hello message to chat.
        if (state === 'in-meeting' && !chatMessagePosted) {
            chatMessagePosted = true; // only try once, even if it fails
            await page.waitForTimeout(3000); // let the meeting UI settle first
            try {
                await chat.sendMessage('hello from Zeus bot');
                console.log('\n>>> STATUS: Posted test message to the meeting chat. <<<\n');
            } catch (error) {
                console.error('\n>>> PROBLEM: Could not post to the meeting chat. <<<\n', error);
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
                                if (decision.resolvedIds.length > 0) {
                                    transcriptRecord.hit = true; // this line closed a condition — cockpit shows it in jade
                                }
                                // Phase 5: the room just said it needs the owner.
                                if (decision.mention) {
                                    console.log(`MENTION >>> ${decision.mention.speaker}: "${decision.mention.quote}"`);
                                    cockpit.addMention(decision.mention);
                                }
                                if (decision.nudge) {
                                    console.log(`NUDGE >>> (${decision.nudge.conditionId}) ${decision.nudge.text}`);
                                    cockpit.addNudge({ text: decision.nudge.text, conditionId: decision.nudge.conditionId });
                                    await chat!.sendMessage(decision.nudge.text);
                                }
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
