import { buildDemoScene } from './app/demo-scene.ts';
import { ModelingSession } from './app/modeling-session.ts';
import { Kernel } from './kernel/kernel.ts';
import { KernelError } from './kernel/errors.ts';
import { MeasurementReadout } from './ui/measurements.ts';
import { NoRendererError, Viewport } from './viewport/viewport.ts';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) throw new Error(`missing #${id} in index.html`);
  return found as T;
}

function showFatal(message: string, detail?: string): void {
  const panel = element('fatal');
  panel.hidden = false;
  panel.replaceChildren();

  const text = document.createElement('div');
  text.textContent = message;
  panel.appendChild(text);

  if (detail !== undefined) {
    const code = document.createElement('code');
    code.textContent = detail;
    panel.appendChild(code);
  }
}

async function main(): Promise<void> {
  const canvas = element<HTMLCanvasElement>('viewport');

  let viewport: Viewport;
  try {
    viewport = await Viewport.create(canvas);
  } catch (error) {
    // An explicit unsupported-environment message, rather than a blank canvas.
    if (error instanceof NoRendererError) {
      showFatal(error.message);
    } else {
      showFatal('The viewport failed to initialize.', String(error));
    }
    return;
  }

  const kernel = new Kernel();
  try {
    await kernel.initialize();
  } catch (error) {
    showFatal(
      error instanceof KernelError
        ? error.message
        : 'The geometry kernel failed to load.',
      'Build it with `npm run kernel:build`.',
    );
    return;
  }

  const session = new ModelingSession(kernel, viewport);
  const readout = new MeasurementReadout(
    element('measurements'),
    element('oplog'),
  );

  const hint = element('selection-hint');
  const booleanButtons = [
    element<HTMLButtonElement>('btn-union'),
    element<HTMLButtonElement>('btn-subtract'),
    element<HTMLButtonElement>('btn-intersect'),
  ];

  const refresh = (): void => {
    readout.render({
      stats: kernel.stats(),
      log: kernel.operationLog,
      backend: viewport.backend,
      occtVersion: kernel.occtVersion,
      totalTriangles: viewport.totalTriangles,
      selectionCount: viewport.selection.length,
    });
  };

  const updateSelectionUi = (): void => {
    const count = viewport.selection.length;
    const ready = count === 2;
    booleanButtons.forEach((button) => {
      button.disabled = !ready;
    });
    // Spell out which body is which. Operand order decides what a Boolean
    // means, and colour-coding alone left it undiscoverable: subtracting in the
    // wrong order gives a perfectly correct result that looks wrong.
    const [target, tool] = viewport.selection;
    hint.textContent = ready
      ? `Target #${target} (blue) − Tool #${tool} (orange)`
      : count === 1
        ? `Target #${target} selected — shift-click the tool.`
        : 'Select two bodies: first the target, then the tool.';
    refresh();
  };

  viewport.onSelectionChange(updateSelectionUi);

  session.onEvent((event) => {
    if (event.kind === 'empty') {
      hint.textContent = `${event.op}: produced no geometry (${event.message}).`;
    } else if (event.kind === 'error') {
      hint.textContent = event.message;
    }
    refresh();
  });

  // Reports a failed action without tearing down the session: a kernel failure
  // leaves the kernel usable, so the UI should stay usable too.
  const run = (action: () => Promise<unknown>) => async (): Promise<void> => {
    try {
      await action();
    } catch (error) {
      hint.textContent =
        error instanceof KernelError ? error.message : String(error);
    } finally {
      updateSelectionUi();
    }
  };

  // Offsets so successive primitives do not land exactly on top of each other.
  let created = 0;
  const nextOffset = (): [number, number, number] => {
    const step = created++ * 45;
    return [step, 0, 0];
  };

  element('btn-box').addEventListener(
    'click',
    run(() =>
      session.createBox({
        width: 40,
        depth: 30,
        height: 20,
        origin: nextOffset(),
      }),
    ),
  );

  element('btn-cylinder').addEventListener(
    'click',
    run(() =>
      session.createCylinder({
        radius: 15,
        height: 40,
        origin: nextOffset(),
      }),
    ),
  );

  element('btn-union').addEventListener(
    'click',
    run(() => session.applyBooleanToSelection('union')),
  );
  element('btn-subtract').addEventListener(
    'click',
    run(() => session.applyBooleanToSelection('subtract')),
  );
  element('btn-intersect').addEventListener(
    'click',
    run(() => session.applyBooleanToSelection('intersect')),
  );

  element('btn-fit').addEventListener('click', () => {
    viewport.fitToView();
  });

  element('btn-demo').addEventListener(
    'click',
    run(async () => {
      await buildDemoScene(session);
      viewport.fitToView();
    }),
  );

  element('btn-release').addEventListener(
    'click',
    run(() => session.releaseSelection()),
  );

  updateSelectionUi();

  // Development-only handle for automated browser verification, which needs to
  // resolve which body sits under a pixel rather than guessing coordinates.
  // Stripped from production builds.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__webcad = {
      kernel,
      viewport,
      session,
    };
  }

  console.info(
    `[webcad] kernel ready — OCCT ${kernel.occtVersion}, backend ${viewport.backend}`,
  );
}

void main();
