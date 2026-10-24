/**
 * How long the commands of one assistant turn may run. A line has a minute; once one has run out
 * of it, a narrower form of the same slow line is likely slow too, so the next lines have seconds,
 * and after a second line runs out no more run this turn: the model answers from what it has.
 */

/** How long a line may run while none has run out of time this turn. */
export const COMMAND_SECONDS = 60;
/** How long a line may run once one has run out of time this turn. */
export const AFTER_SLOW_SECONDS = 10;
/** Lines that may run out of time in one turn before no more run. */
const SLOW_LINES = 2;

export class CommandClock {
  #slow = 0;

  /** How long the next line may run, or undefined when no more lines run this turn. */
  get limitMs(): number | undefined {
    if (this.#slow >= SLOW_LINES) return undefined;
    return (this.#slow ? AFTER_SLOW_SECONDS : COMMAND_SECONDS) * 1000;
  }

  /** What the model hears about a line that ran out of `limitMs`; it counts towards the turn's. */
  timedOut(): string {
    const seconds = this.#slow ? AFTER_SLOW_SECONDS : COMMAND_SECONDS;
    this.#slow++;
    return this.#slow >= SLOW_LINES
      ? `stopped after ${seconds} s: too slow, and no more commands run this turn. Answer from what you have, and say what took too long`
      : `stopped after ${seconds} s: too slow. A narrower form of a slow line is slow too; the next lines have ${AFTER_SLOW_SECONDS} s. Bound it (-maxdepth, a --limit, a search instead of find) or answer without it`;
  }

  /** What the model hears about a line not run since the turn's slow lines are spent. */
  get refused(): string {
    return `not run: ${SLOW_LINES} commands ran out of time this turn, so no more run. Answer from what you have, and say what took too long`;
  }
}
