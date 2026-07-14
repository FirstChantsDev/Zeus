/**
 * Throwaway smoke test for Phase 5 Milestone 1 (evidence quotes) — not
 * product code. Serves the cockpit with fake data: a closed condition
 * carrying verbatim evidence, so the expanded card can be checked without
 * a Teams meeting. Delete after use.
 */
import { CockpitServer } from './apps/teams-bot/src/lib/CockpitServer';
import { conditions, applyBrief } from './apps/teams-bot/src/conditions';

const cockpit = new CockpitServer({
    botId: '00000000-0000-0000-0000-000000000000',
    conditions,
    port: 4300,
    meetingUrl: 'https://teams.live.com/meet/0000000000000?p=FakeSmokeLink',
    onCommand: (instruction) => console.log(`smoke onCommand: ${instruction}`),
    onSetup: (brief) => {
        applyBrief(brief.labels);
        console.log(`smoke onSetup: ${brief.labels.join(' | ')}`);
    },
    onShutdown: () => {
        console.log('smoke onShutdown: kill button pressed — exiting.');
        process.exit(0);
    },
});
cockpit.start();
cockpit.setMeetingStatus('in-meeting');

// Pretend the owner already briefed the agent.
const fakeSetup = async () => {
    await fetch('http://localhost:4300/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meetingName: 'Pizza night planning', conditions: ['Budget agreed', 'Venue picked', 'Delivery time locked'], lengthMinutes: 30, ownerName: 'Calvin' }),
    });

    // Phase 5 M2: the room says it needs the owner.
    cockpit.addMention({ speaker: 'Sam', quote: "We can't order anything until Calvin confirms the card details" });

    // A closed condition with the verbatim receipt...
    conditions[0].status = 'closed';
    conditions[0].note = 'Calvin confirmed the £20,000 budget.';
    conditions[0].why = 'Calvin stated the figure directly and no one objected, so the budget stands agreed.';
    conditions[0].evidence = [{ speaker: 'Calvin', quote: 'The budget will be £20,000' }];

    // ...an open one still without evidence...
    conditions[1].note = 'Not raised yet.';
    conditions[1].why = 'No one has mentioned the venue so far.';

    // ...and a red one the room keeps dodging (2+ nudges = NEEDS YOU).
    conditions[2].nudges = 2;
    conditions[2].note = 'Nudged twice — the room keeps moving past it.';
    conditions[2].why = 'Sam and Maya keep deferring the delivery slot; nobody will own the decision.';

    // A feed's worth of nudges, newest first once rendered — enough rows
    // to check spacing, statuses, the steered style, and top clipping.
    cockpit.addNudge({ text: '[ZEUS] Before we drift — can we get the budget agreed? What figure are we approving?', conditionId: 'c0' });
    cockpit.addNudge({ text: '[ZEUS] One thing still open — delivery time. Can we pin it down?', conditionId: 'c2' });
    cockpit.addNudge({ text: '[ZEUS] Sam — the venue shortlist needs a decision before we lose the room.', conditionId: 'c1', steered: true });
    cockpit.addNudge({ text: '[ZEUS] Flagging again before we wrap — delivery time is still open. Can someone own it now?', conditionId: 'c2' });
    cockpit.addNudge({ text: '[ZEUS] Quick note from the agenda: lunch is moved to 1pm.', conditionId: null, steered: true });

    const lines: Array<[string, string, boolean?]> = [
        ['Maya', "Right, let's get going — where did we land after last week?"],
        ['Jordan', 'Good progress on our side, two options ready to show.'],
        ['Calvin', 'The budget will be £20,000', true],
        ['Sam', 'Great — and the toppings survey came back, pineapple is banned.'],
        ['Maya', "Let's take the delivery slot offline — next item."],
        ['Jordan', "I'll circulate the venue shortlist after this."],
        ['Sam', 'Anyone else watching the match tonight?'],
    ];
    for (const [speaker, text, hit] of lines) {
        cockpit.addTranscriptLine({ speaker, text, ts: new Date().toISOString() }).hit = Boolean(hit);
    }
    console.log('Smoke cockpit ready with full fake state.');
};
fakeSetup().catch((error) => console.error('fakeSetup failed:', error));
