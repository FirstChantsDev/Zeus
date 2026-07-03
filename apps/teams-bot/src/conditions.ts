/**
 * ═══════════════════════════════════════════════════════════════════
 *  EDIT ME — this is the agent's meeting brief.
 *
 *  These are the outcomes the agent drives the meeting toward. It will
 *  listen for each one being settled, and nudge the room when one is
 *  being ignored. To change the brief, edit the lines below:
 *
 *    - label:  the goal in plain English, as it appears on the cockpit.
 *    - id:     a short one-word nickname (lowercase, no spaces).
 *
 *  You can add or remove lines. Always leave status: 'open' and
 *  nudges: 0 — the bot updates those itself while the meeting runs.
 * ═══════════════════════════════════════════════════════════════════
 */
export const conditions: Condition[] = [
    { id: 'budget', label: 'Budget confirmed',      status: 'open', nudges: 0 },
    { id: 'date',   label: 'Launch date locked',    status: 'open', nudges: 0 },
    { id: 'metric', label: 'Success metric agreed', status: 'open', nudges: 0 },
];

/** One meeting outcome the agent is responsible for closing. */
export type Condition = {
    /** Short one-word nickname used in logs and API calls */
    id: string;
    /** The goal in plain English */
    label: string;
    /** 'open' until the room clearly settles it, then 'closed' */
    status: 'open' | 'closed';
    /** How many times the agent has nudged the room about it */
    nudges: number;
    /** Filled in by the bot when it closes: who settled it and what they said */
    note?: string;
};
