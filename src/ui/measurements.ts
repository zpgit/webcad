import type { KernelStats, OperationRecord } from '../kernel/types.ts';

/**
 * One frame at 60Hz.
 *
 * MVP-0 ran the kernel on the main thread, so an operation longer than this
 * froze the UI, and the readout flagged it as over budget. With the kernel in a
 * Worker that inference no longer holds: the same 66 ms subtract now costs
 * latency, not frames. The duration is still worth showing - it is what the user
 * waits for - but it is reported as latency rather than as a freeze, because
 * relabelling it would be the one dishonest way to make the warning go away.
 */
export const FRAME_BUDGET_MS = 1000 / 60;

export interface ReadoutInput {
  stats: KernelStats;
  log: readonly OperationRecord[];
  backend: string;
  occtVersion: string;
  totalTriangles: number;
  selectionCount: number;
}

const MB = 1024 * 1024;

function mb(bytes: number): string {
  return `${(bytes / MB).toFixed(1)} MB`;
}

function ms(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

/** What the transport cost: everything in the round trip that was not kernel work. */
function transportMs(entry: OperationRecord): number | undefined {
  if (entry.roundTripMs === undefined) return undefined;
  return Math.max(0, entry.roundTripMs - entry.durationMs);
}

/**
 * The MVP-0 measurement readout.
 *
 * MVP-0's purpose is to measure the OCCT/WASM-to-rendering boundary, so these
 * numbers are the stage's deliverable rather than debug output. In particular,
 * surfacing per-operation duration is what makes main-thread blocking
 * observable instead of merely assumed absent.
 */
export class MeasurementReadout {
  readonly #list: HTMLElement;
  readonly #opLog: HTMLElement;

  constructor(list: HTMLElement, opLog: HTMLElement) {
    this.#list = list;
    this.#opLog = opLog;
  }

  render(input: ReadoutInput): void {
    const { stats, log } = input;
    const last = log[log.length - 1];
    const slowest = log.reduce<OperationRecord | undefined>(
      (acc, entry) => (acc === undefined || entry.durationMs > acc.durationMs ? entry : acc),
      undefined,
    );
    const lastTransfer = log.reduce<OperationRecord | undefined>(
      (acc, entry) => (entry.transferBytes === undefined ? acc : entry),
      undefined,
    );

    const rows: Array<[string, string]> = [
      ['Backend', input.backend],
      ['OCCT', input.occtVersion],
      ['Live bodies', String(stats.liveBodyCount)],
      ['Bodies created', String(stats.totalBodiesCreated)],
      ['Selected', String(input.selectionCount)],
      ['Triangles', input.totalTriangles.toLocaleString('en-US')],
      ['Cached meshes', String(stats.cachedMeshCount)],
      ['Mesh cache', mb(stats.meshCacheBytes)],
      ['WASM memory', mb(stats.wasmMemoryBytes)],
      ['WASM peak', mb(stats.wasmPeakMemoryBytes)],
      ['Last op', last === undefined ? '—' : `${last.operation} ${ms(last.durationMs)}`],
      [
        'Slowest op',
        slowest === undefined ? '—' : `${slowest.operation} ${ms(slowest.durationMs)}`,
      ],
      // What hosting the kernel off the main thread costs. Reported next to the
      // kernel time it bought, so the trade is visible rather than asserted.
      [
        'Transport',
        last === undefined || transportMs(last) === undefined
          ? '—'
          : ms(transportMs(last) as number),
      ],
      [
        'Mesh transferred',
        lastTransfer === undefined
          ? '—'
          : `${kb(lastTransfer.transferBytes ?? 0)} in ${ms(lastTransfer.copyMs ?? 0)}`,
      ],
    ];

    this.#list.replaceChildren(
      ...rows.flatMap(([label, value]) => {
        const dt = document.createElement('dt');
        dt.textContent = label;
        const dd = document.createElement('dd');
        dd.textContent = value;
        return [dt, dd];
      }),
    );

    // Most recent first, and only the tail: the full log lives on the kernel.
    const recent = log.slice(-12).reverse();
    this.#opLog.replaceChildren(
      ...recent.map((entry) => {
        const li = document.createElement('li');
        const slow = entry.durationMs > FRAME_BUDGET_MS;
        const parts = [entry.operation, ms(entry.durationMs)];

        const transport = transportMs(entry);
        if (transport !== undefined) parts.push(`+${ms(transport)} transport`);
        if (entry.triangleCount !== undefined) {
          parts.push(`${entry.triangleCount.toLocaleString('en-US')} tris`);
        }
        if (slow) {
          // Latency, not a dropped frame. The kernel is in a Worker, so this is
          // how long the user waited - the viewport kept drawing throughout.
          parts.push(`⏱ ${Math.round(entry.durationMs / FRAME_BUDGET_MS)}× frame latency`);
        }

        li.textContent = parts.join(' · ');
        if (entry.status !== 0) li.classList.add('failed');
        if (slow) li.classList.add('empty-result');
        return li;
      }),
    );
  }
}
