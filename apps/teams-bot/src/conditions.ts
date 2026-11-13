/**
 * ═══════════════════════════════════════════════════════════════════
 *  The agent's meeting brief.
 *
 *  Phase 3: conditions are NO LONGER edited here. They start empty and
 *  are filled in from the "Brief your agent" screen at
 *  http://localhost:4300 - whatever you type there is what the agent
 *  drives. The bot waits for the brief before joining the meeting.
 * ═══════════════════════════════════════════════════════════════════
 */
export const conditions: Condition[] = [];

/** Maximum conditions the owner can brief the agent with */
export const MAX_CONDITIONS = 5;

/**
 * Replaces the conditions with the owner's typed brief. Mutates the
 * shared array IN PLACE - the Nudger and CockpitServer both hold a
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
    /** 'open' until the room clearly settles it, then 'closed'.
     *  Phase 18: 'held' sits between the two - the room said yes, but with
     *  a condition attached ("approved, subject to legal"). A qualified yes
     *  is not a decision; it is held open until the condition is met. */
    status: 'open' | 'held' | 'closed';
    /** Phase 18: what a HELD condition is waiting on, in plain words
     *  ("legal checking the DPA wording"). Only set while status is 'held'. */
    heldOn?: string;
    /** How many times the agent has nudged the room about it */
    nudges: number;
    /** One-line reason shown on the card: how it closed, or where it stands */
    note?: string;
    /** Phase 4: the agent's fuller plain-English explanation of the current
     *  state - why it's still pending, or how it came together. Shown when
     *  the owner expands the card. Refreshed on every decision call. */
    why?: string;
    /** Phase 5: the verbatim transcript line(s) behind the current judgement -
     *  speaker + exact words, shown as the receipt in the expanded card.
     *  Freezes when the condition closes (closed conditions are never re-judged). */
    evidence?: Array<{ speaker: string, quote: string }>;
    /** Phase 18 M2: WHY the room chose this outcome - only ever what someone
     *  said out loud, never inferred. Not to be confused with `note` (the
     *  board's one-line status) or `why` (the agent's explanation of where
     *  the condition stands). */
    rationale?: string;
    /** The verbatim line the rationale came from */
    rationaleEvidence?: { speaker: string, quote: string };
    /** True once the agent has asked the room for the reason - it asks at
     *  most once per condition */
    rationaleAsked?: boolean;
};
