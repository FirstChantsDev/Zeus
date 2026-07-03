/**
 * ═══════════════════════════════════════════════════════════════════
 *  The agent's meeting brief — set from the briefing screen.
 *
 *  Phase 3: conditions are no longer hard-coded here. When the bot
 *  starts, this list is empty; it gets filled in when the owner types
 *  their conditions into the "Brief your agent" screen at
 *  http://localhost:4300 and clicks "Send agent into the meeting".
 *  The agent only joins the meeting after that happens.
 * ═══════════════════════════════════════════════════════════════════
 */
export const conditions: Condition[] = [];

/** One meeting outcome the agent is responsible for closing. */
export type Condition = {
    /** Short nickname used in logs and API calls (c0, c1, c2) */
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
