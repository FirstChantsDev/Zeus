/**
 * GATE prototype launcher.
 *
 * Usage:  npx tsx apps/teams-bot/src/gate.ts <teams-meeting-url>
 *
 * Opens a VISIBLE Chrome window, joins the meeting as "Zeus bot" with camera
 * and mic off, and then sits there printing a plain-English status line
 * whenever its situation changes (lobby / in meeting / neither).
 * The window stays open until you press Ctrl+C in the terminal.
 */
import 'dotenv/config';
import { chromium } from 'playwright';
import { randomUUID } from 'crypto';
import { JoinProcedure } from './procedures/join-procedure';
import { ChatProcedure } from './procedures/chat-procedure';
import { CaptionsProcedure } from './procedures/captions-procedure';
import { Nudger } from './lib/Nudger';
import { CockpitServer } from './lib/CockpitServer';
import { conditions } from './conditions';

/** The cockpit's local address: http://localhost:4300 */
const COCKPIT_PORT = 4300;

const meetingUrl = process.argv[2];
if (!meetingUrl) {
    console.error('Usage: npx tsx apps/teams-bot/src/gate.ts <teams-meeting-url>');
    process.exit(1);
}

const main = async () => {
    const botId = randomUUID();

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
    const chat = new ChatProcedure({ botId, page });

    // Phase 2: the nudge brain drives the owner's pre-defined conditions
    // (see conditions.ts). Without an API key the bot still runs,
    // it just prints captions without ever posting nudges.
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const nudger = apiKey ? new Nudger({ botId, apiKey, conditions }) : null;
    if (!nudger) {
        console.log('NOTE: no ANTHROPIC_API_KEY found in .env — captions will print, but no nudges will be posted.');
    }

    // Everything the agent says — self-driven nudges and owner steers alike —
    // goes through one queue, one message at a time, in order.
    let nudgeQueue: Promise<void> = Promise.resolve();

    // Phase 3: the agent joins the meeting only after the owner submits the
    // briefing screen. This promise is the doorway it waits behind.
    let briefingDone!: () => void;
    const briefingReceived = new Promise<void>((resolve) => { briefingDone = resolve; });

    // Milestone 2: the owner's private cockpit — a tiny web server inside
    // this same process, serving the live board at http://localhost:4300.
    // Milestone 4: a steer typed there is carried out immediately — the agent
    // composes the message and posts it, no waiting for the next caption.
    const cockpit: CockpitServer = new CockpitServer({
        botId,
        conditions,
        port: COCKPIT_PORT,
        onCommand: (instruction) => {
            if (!nudger) {
                console.log('STEER ignored — no ANTHROPIC_API_KEY, the agent cannot compose messages.');
                return;
            }
            // Share the nudge queue so a steer never talks over a nudge in flight.
            nudgeQueue = nudgeQueue
                .then(async () => {
                    const directive = await nudger.executeSteer(instruction, cockpit.recentTranscript(10));
                    if (!directive) {
                        console.log('STEER >>> could not be turned into a message (see log above).');
                        return;
                    }
                    console.log(`STEERED MESSAGE >>> ${directive.text}`);
                    cockpit.addNudge({ text: directive.text, conditionId: directive.conditionId, steered: true });
                    await chat.sendMessage(directive.text);
                })
                .catch((error) => {
                    console.error('Steer pipeline error:', error);
                });
        },
        onSetup: ({ conditionLabels, context }) => {
            // Rebuild the shared conditions array in place — the Nudger and the
            // cockpit both hold references to this same array.
            conditions.length = 0;
            conditionLabels.forEach((label, index) => {
                conditions.push({ id: `c${index}`, label, status: 'open', nudges: 0 });
            });
            nudger?.setContext(context || null);
            console.log('Conditions the agent is driving toward:');
            for (const condition of conditions) {
                console.log(`  - ${condition.label}`);
            }
            briefingDone(); // opens the doorway below
        },
    });
    cockpit.start();

    console.log('\n=== Zeus bot: waiting for your briefing at http://localhost:4300 — it joins the meeting once you submit it. ===\n');
    await briefingReceived;

    console.log('\n=== GATE bot: opening the meeting link... ===\n');
    await join.startMeetingLauncherFlow({ meetingUrl });
    await join.joinMeetingLobbyFlow();

    console.log('\n=== GATE bot: join clicked. Watching status (Ctrl+C here to quit)... ===\n');

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
                console.log('\n>>> STATUS: Admitted! GATE bot is now IN the meeting. <<<\n');
            } else {
                console.log('\n>>> STATUS: Not in lobby or meeting (page may still be loading, or the call ended). <<<\n');
            }
            lastState = state;
        }

        // Milestone 3: once admitted, post one hard-coded test message to chat.
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

        // Milestone 4: turn on live captions and print finished lines.
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
                                const decision = await nudger.decide(line);
                                if (decision.resolvedIds.length > 0) {
                                    transcriptRecord.hit = true; // this line closed a condition — cockpit shows it in jade
                                }
                                if (decision.nudge) {
                                    console.log(`NUDGE >>> (${decision.nudge.conditionId}) ${decision.nudge.text}`);
                                    cockpit.addNudge({ text: decision.nudge.text, conditionId: decision.nudge.conditionId });
                                    await chat.sendMessage(decision.nudge.text);
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

        // Milestone 2 evidence: report a stable minute in the meeting.
        if (state === 'in-meeting' && inMeetingSince && Date.now() - inMeetingSince >= 60000) {
            console.log('>>> STATUS: Stable in meeting for 60+ seconds. <<<');
            inMeetingSince = null; // print this only once
        }

        await page.waitForTimeout(5000);
    }
};

main().catch((error) => {
    console.error('\n=== GATE bot hit a fatal error ===\n', error);
    process.exit(1);
});
