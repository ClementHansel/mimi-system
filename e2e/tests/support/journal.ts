import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * A RUNNING LOG OF WHAT WORKED, for a simulation that must not stop at the
 * first broken thing.
 *
 * The `ops-*` specs answer "is this flow correct?" and rightly fail loudly on
 * the first bad assertion. `sim-company-day` asks a different question — "we
 * are about to run a company on this; which parts of it actually function?" —
 * and for THAT question, aborting on step three of ninety is the wrong answer.
 * A person reading the result needs the whole map, not the first hole in it.
 *
 * So every step here is wrapped: it runs, its outcome is recorded with the
 * actor and the phase, and the simulation carries on. A step whose
 * prerequisite failed is recorded `blocked` rather than `fail`, because
 * "receiving could not be tested — nothing was ever dispatched" and "receiving
 * is broken" are different findings and must not be summed together.
 *
 * Records are appended as JSON LINES to `$SIM_REPORT`. Line-per-record, not
 * one JSON document, so the file survives a crashed or killed run — which is
 * exactly when its contents matter most.
 */

export type StepStatus = 'pass' | 'fail' | 'blocked' | 'note';

export interface StepRecord {
  phase: string;
  actor: string;
  step: string;
  status: StepStatus;
  /** Failure message, or the interesting value a passing step produced. */
  detail?: string;
  ms: number;
  at: string;
}

const FILE = process.env.SIM_REPORT ?? '';

/** Everything this process recorded, for an end-of-run summary in the console. */
export const recorded: StepRecord[] = [];

function write(entry: StepRecord): void {
  recorded.push(entry);
  const line = `${entry.status.toUpperCase().padEnd(7)} ${entry.phase} › ${entry.actor} › ${entry.step}${
    entry.detail ? ` — ${entry.detail}` : ''
  }`;
  console.log(`[sim] ${line}`);
  if (!FILE) return;
  mkdirSync(dirname(FILE), { recursive: true });
  appendFileSync(FILE, `${JSON.stringify(entry)}\n`, 'utf8');
}

/** First line only, and trimmed: a Playwright timeout's full body is 30 lines of locator dump. */
function brief(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  return text.split('\n')[0].trim().slice(0, 300);
}

/**
 * One department's worth of steps, performed by one named person.
 *
 * `actor` is the JOB, not the username — a report that says "Kepala Gudang
 * could not dispatch" is read by the owner; one that says `gudang1` is read by
 * nobody.
 */
export class Journal {
  constructor(
    readonly phase: string,
    readonly actor: string,
  ) {}

  /** A different person, same phase. */
  as(actor: string): Journal {
    return new Journal(this.phase, actor);
  }

  /**
   * Runs `fn`, records the outcome, and NEVER throws.
   *
   * Returns what `fn` returned on success and `undefined` on failure, so a
   * caller can branch on whether the thing it needed actually happened:
   *
   *   const rr = await j.step('raises a request', () => …);
   *   if (!rr) return j.blocked('approves it', 'no request was created');
   */
  async step<T>(step: string, fn: () => Promise<T>): Promise<T | undefined> {
    const started = Date.now();
    try {
      const value = await fn();
      write({
        phase: this.phase,
        actor: this.actor,
        step,
        status: 'pass',
        detail: typeof value === 'string' && value ? value : undefined,
        ms: Date.now() - started,
        at: new Date().toISOString(),
      });
      return value;
    } catch (err) {
      write({
        phase: this.phase,
        actor: this.actor,
        step,
        status: 'fail',
        detail: brief(err),
        ms: Date.now() - started,
        at: new Date().toISOString(),
      });
      return undefined;
    }
  }

  /** Could not be attempted, and why — distinct from "was attempted and failed". */
  blocked(step: string, why: string): void {
    write({
      phase: this.phase,
      actor: this.actor,
      step,
      status: 'blocked',
      detail: why,
      ms: 0,
      at: new Date().toISOString(),
    });
  }

  /** An observation worth reporting that is not itself a pass or a failure. */
  note(step: string, detail: string): void {
    write({
      phase: this.phase,
      actor: this.actor,
      step,
      status: 'note',
      detail,
      ms: 0,
      at: new Date().toISOString(),
    });
  }
}
