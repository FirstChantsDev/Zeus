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
});
cockpit.start();
cockpit.setMeetingStatus('in-meeting');

// Pretend the owner already briefed the agent.
const fakeSetup = async () => {
    await fetch('http://localhost:4300/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ meetingName: 'Pizza night planning', conditions: ['Budget agreed', 'Venue picked'], lengthMinutes: 30, ownerName: 'Calvin' }),
    });

    // Phase 5 M2: the room says it needs the owner.
    cockpit.addMention({ speaker: 'Sam', quote: "We can't order anything until Calvin confirms the card details" });

    // A closed condition with the verbatim receipt...
    conditions[0].status = 'closed';
    conditions[0].note = 'Calvin confirmed the £20,000 budget.';
    conditions[0].why = 'Calvin stated the figure directly and no one objected, so the budget stands agreed.';
    conditions[0].evidence = [{ speaker: 'Calvin', quote: 'The budget will be £20,000' }];

    // ...and an open one still without evidence.
    conditions[1].note = 'Not raised yet.';
    conditions[1].why = 'No one has mentioned the venue so far.';

    cockpit.addTranscriptLine({ speaker: 'Calvin', text: 'The budget will be £20,000', ts: new Date().toISOString() }).hit = true;
    console.log('Smoke cockpit ready with evidence data.');
};
fakeSetup().catch((error) => console.error('fakeSetup failed:', error));
