/**
 * ═══════════════════════════════════════════════════════════════════
 *  The agent's meeting brief.
 *
 *  Phase 3: conditions are NO LONGER edited here. They start empty and
 *  are filled in from the "Brief your agent" screen at
 *  http://localhost:4300 — whatever you type there is what the agent
 *  drives. The bot waits for the brief before joining the meeting.
 * ═══════════════════════════════════════════════════════════════════
 */
export const conditions: Condition[] = [];

/** Maximum conditions the owner can brief the agent with */
export const MAX_CONDITIONS = 3;

/**
 * Replaces the conditions with the owner's typed brief. Mutates the
 * shared array IN PLACE — the Nudger and CockpitServer both hold a
 * reference to it, so it must never be reassigned.
 */
export const applyBrief = (labels: string[]) => {
    conditions.length = 0;
    labels.slice(0, MAX_CONDITIONS).forEach((label, index) => {
        conditions.push({ id: `c${index}`, label, status: 'open', nudges: 0 });
    });
};

/** One meeting outcome the agent is responsible for closing. */
export type Condition = {
    /** Short nickname used in logs and API calls (c0/c1/c2) */
    id: string;
    /** The goal in plain English, exactly as the owner typed it */
    label: string;
    /** 'open' until the room clearly settles it, then 'closed' */
    status: 'open' | 'closed';
    /** How many times the agent has nudged the room about it */
    nudges: number;
    /** Filled in by the bot when it closes: who settled it and what they said */
    note?: string;
};
