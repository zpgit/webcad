import { buildDemoScene } from './app/demo-scene.ts';
import { ModelingSession } from './app/modeling-session.ts';
import type { ConstructionEntry } from './document/types.ts';
import { Kernel } from './kernel/kernel.ts';
import { KernelError } from './kernel/errors.ts';
import { openStore } from './storage/index.ts';
import type { DocumentStore } from './storage/types.ts';
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

  // In a Worker: OCCT operations run tens to hundreds of milliseconds against a
  // 16.7 ms frame, so anything else freezes the viewport mid-operation.
  let kernel: Kernel;
  try {
    kernel = await Kernel.createInWorker();
  } catch (error) {
    showFatal(
      error instanceof KernelError
        ? error.message
        : 'The geometry kernel failed to load.',
      'Build it with `npm run kernel:build`.',
    );
    return;
  }

  const status = element('doc-status');
  const say = (message: string, tone: 'success' | 'warning' | 'failure' | ''): void => {
    status.textContent = message;
    status.className = tone === '' ? 'hint' : `hint ${tone}`;
  };

  // Storage failing to open is reported, not fatal: a browser that refuses
  // storage can still run the modeller, and losing persistence is worth saying
  // out loud rather than refusing to start over.
  let store: DocumentStore | null = null;
  try {
    store = await openStore();
  } catch (error) {
    say(
      `Documents cannot be saved in this browser: ${
        error instanceof Error ? error.message : String(error)
      }`,
      'failure',
    );
  }

  const session = new ModelingSession(kernel, viewport, { store });
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

  // --- Document UI -----------------------------------------------------------

  const docName = element<HTMLInputElement>('doc-name');
  const docList = element<HTMLUListElement>('doc-list');
  const historyList = element<HTMLOListElement>('history');
  const saveButton = element<HTMLButtonElement>('btn-save');

  const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} kB`;

  const describe = (entry: ConstructionEntry): string => {
    switch (entry.op) {
      case 'createBox':
        return `${entry.produces} = box ${entry.params.width}×${entry.params.depth}×${entry.params.height}`;
      case 'createCylinder':
        return `${entry.produces} = cylinder r${entry.params.radius} h${entry.params.height}`;
      case 'boolean':
        return `${entry.produces} = ${entry.target} ${entry.kind} ${entry.tool}`;
      case 'release':
        return `${entry.body} removed`;
    }
  };

  const renderHistory = (): void => {
    const entries = session.document.entries;
    historyList.replaceChildren(
      ...entries.map((entry) => {
        const item = document.createElement('li');
        item.textContent = describe(entry);
        if (entry.op === 'release') item.className = 'retired';
        return item;
      }),
    );
  };

  const renderDocumentList = async (): Promise<void> => {
    const summaries = [...(await session.listDocuments())].sort((a, b) =>
      b.modifiedAt.localeCompare(a.modifiedAt),
    );

    docList.replaceChildren(
      ...summaries.map((summary) => {
        const item = document.createElement('li');
        if (summary.documentId === session.document.documentId) {
          item.className = 'current';
        }

        const title = document.createElement('span');
        title.className = 'doc-title';
        title.textContent = summary.name;
        item.appendChild(title);

        const meta = document.createElement('span');
        meta.className = 'doc-meta';
        meta.textContent = kb(summary.byteLength);
        item.appendChild(meta);

        const open = document.createElement('button');
        open.type = 'button';
        open.textContent = 'Open';
        open.addEventListener('click', () => {
          void openDocument(summary.documentId);
        });
        item.appendChild(open);

        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = 'Delete';
        remove.addEventListener('click', () => {
          void deleteDocument(summary.documentId);
        });
        item.appendChild(remove);

        return item;
      }),
    );
  };

  const syncDocumentUi = async (): Promise<void> => {
    docName.value = session.document.name;
    renderHistory();
    await renderDocumentList();
  };

  const openDocument = async (documentId: string): Promise<void> => {
    try {
      await session.open(documentId);
      viewport.fitToView();
    } catch (error) {
      // A refusal leaves the session exactly as it was, so the only thing to do
      // is say why. The message is written for a user, not a log.
      say(error instanceof Error ? error.message : String(error), 'failure');
    }
    await syncDocumentUi();
    updateSelectionUi();
  };

  const deleteDocument = async (documentId: string): Promise<void> => {
    try {
      await session.removeDocument(documentId);
      say('Document deleted.', '');
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), 'failure');
    }
    await syncDocumentUi();
  };

  session.onEvent((event) => {
    if (event.kind === 'empty') {
      hint.textContent = `${event.op}: produced no geometry (${event.message}).`;
    } else if (event.kind === 'error') {
      hint.textContent = event.message;
    } else if (event.kind === 'saved') {
      say(`Saved “${event.name}” (${kb(event.byteLength)}).`, 'success');
    } else if (event.kind === 'opened') {
      const warnings = event.warnings.join(' ');
      say(
        `Opened “${event.name}” — ${event.bodyCount} ${
          event.bodyCount === 1 ? 'body' : 'bodies'
        }.${warnings === '' ? '' : ` ${warnings}`}`,
        warnings === '' ? 'success' : 'warning',
      );
    }
    renderHistory();
    refresh();
  });

  docName.addEventListener('change', () => {
    session.rename(docName.value.trim() === '' ? 'Untitled' : docName.value.trim());
  });

  saveButton.addEventListener('click', () => {
    void (async () => {
      try {
        await session.save();
      } catch (error) {
        // Never reported as a success. A save that did not happen must not look
        // like one that did.
        say(error instanceof Error ? error.message : String(error), 'failure');
      }
      await syncDocumentUi();
    })();
  });

  element('btn-new').addEventListener('click', () => {
    void (async () => {
      await session.newDocument();
      say('Started a new document.', '');
      await syncDocumentUi();
      updateSelectionUi();
    })();
  });

  saveButton.disabled = !session.canPersist;

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

  // Reopen whatever was open last, so a browser restart returns the user to
  // their work rather than to an empty viewport.
  //
  // A failure here starts an empty session and says why, rather than stopping
  // the application: a document that has become unreadable must not be able to
  // make the modeller unusable.
  try {
    const restored = await session.restoreLastOpened();
    if (restored !== null) viewport.fitToView();
  } catch (error) {
    say(
      `The document you had open could not be reopened. ${
        error instanceof Error ? error.message : String(error)
      }`,
      'failure',
    );
  }
  await syncDocumentUi();
  updateSelectionUi();

  // Development-only handle for automated browser verification, which needs to
  // resolve which body sits under a pixel rather than guessing coordinates.
  // Stripped from production builds.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__webcad = {
      kernel,
      viewport,
      session,
      store,
    };
  }

  console.info(
    `[webcad] kernel ready — OCCT ${kernel.occtVersion}, backend ${viewport.backend}`,
  );
}

void main();
