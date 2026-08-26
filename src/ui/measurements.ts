import type { KernelStats, OperationRecord } from '../kernel/types.ts';

/** One frame at 60Hz. Operations above this block the UI and are flagged. */
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
        const over = entry.durationMs > FRAME_BUDGET_MS;
        const parts = [entry.operation, ms(entry.durationMs)];
        if (entry.triangleCount !== undefined) {
          parts.push(`${entry.triangleCount.toLocaleString('en-US')} tris`);
        }
        if (over) {
          // Flagged because exceeding a frame budget is the evidence that the
          // Worker migration is needed - the note leaves that question open.
          parts.push('⚠ over frame budget');
        }
        li.textContent = parts.join(' · ');
        if (entry.status !== 0) li.classList.add('failed');
        if (over) li.classList.add('empty-result');
        return li;
      }),
    );
  }
}
