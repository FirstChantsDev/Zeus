/**
 * Throwaway smoke test for the Phase 3 briefing flow — not product code.
 * Starts the cockpit server unbriefed, wired like gate.ts, so the briefing
 * screen and POST /setup can be tested without a Teams meeting. Delete after use.
 */
import { CockpitServer } from './apps/teams-bot/src/lib/CockpitServer';
import { conditions } from './apps/teams-bot/src/conditions';

const cockpit = new CockpitServer({
    botId: '00000000-0000-0000-0000-000000000000',
    conditions,
    port: 4300,
    onCommand: (instruction) => console.log(`smoke onCommand fired with: ${instruction}`),
    onSetup: ({ meetingName, conditionLabels, context }) => {
        conditions.length = 0;
        conditionLabels.forEach((label, index) => {
            conditions.push({ id: `c${index}`, label, status: 'open', nudges: 0 });
        });
        console.log(`smoke onSetup fired: name=${meetingName} labels=${conditionLabels.join('|')} context=${context}`);
    },
});
cockpit.start();
console.log('Smoke cockpit running, unbriefed.');
