// Typed errors mapped from the C++ facade's status values.
//
// The facade never throws across the WASM boundary; it returns a status and a
// message. This module turns those into JavaScript errors so callers can
// discriminate a caller mistake from a kernel failure without string matching.
//
// Since the kernel runs in a Worker, these errors are also raised on the far
// side of a thread boundary. Structured cloning reduces an Error subclass to a
// plain Error and loses the type, so failures cross as the flat `KernelFailure`
// payload and are rebuilt here by `reviveFailure`. `throwForStatus` (status ->
// error) and `reviveFailure` (code -> error) are two views of one mapping and
// must be kept in step; `tests/worker-protocol.test.ts` asserts they are.

import type { KernelFailure } from './worker/protocol.ts';

/** Status codes; must stay in sync with native/src/status.hpp. */
export const Status = {
  Ok: 0,
  InvalidHandle: 1,
  InvalidParameter: 2,
  KernelOperationFailed: 3,
  EmptyResult: 4,
  TranslationFailed: 5,
} as const;

export type StatusCode = (typeof Status)[keyof typeof Status];

export abstract class KernelError extends Error {
  abstract readonly code: string;

  /** The operation that failed, for attribution and for revival. */
  readonly operation: string;

  /**
   * The message before this class applied its own framing.
   *
   * Carried separately because revival re-runs the constructor: rebuilding from
   * the already-framed message would prefix it a second time.
   */
  readonly detail: string;

  constructor(
    detail: string,
    operation: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.detail = detail;
    this.operation = operation;
  }
}

/** An operation was attempted before initialization completed. */
export class KernelNotReadyError extends KernelError {
  readonly code = 'KernelNotReady';

  constructor(operation: string) {
    super(
      operation,
      operation,
      `Kernel is not ready; cannot run "${operation}". ` +
        'Await initialize() before invoking geometry operations.',
    );
  }
}

/** The environment cannot host the kernel at all. */
export class WebAssemblyUnsupportedError extends KernelError {
  readonly code = 'WebAssemblyUnsupported';

  constructor(detail: string, options?: { cause?: unknown }) {
    super(
      detail,
      'initialize',
      `This environment cannot run the geometry kernel: ${detail}`,
      options,
    );
  }
}

/** A handle was never issued by this kernel instance, or has been released. */
export class InvalidHandleError extends KernelError {
  readonly code = 'InvalidHandle';

  constructor(message: string, operation: string) {
    super(message, operation, `${operation}: ${message}`);
  }
}

/** A parameter was rejected before any geometry work began. */
export class InvalidParameterError extends KernelError {
  readonly code = 'InvalidParameter';

  constructor(message: string, operation: string) {
    super(message, operation, `${operation}: ${message}`);
  }
}

/**
 * The underlying OCCT algorithm failed. The kernel remains usable and any
 * operand handles remain valid.
 */
export class KernelOperationFailedError extends KernelError {
  readonly code = 'KernelOperationFailed';

  constructor(message: string, operation: string) {
    super(message, operation, `${operation}: ${message}`);
  }
}

/**
 * A foreign interchange payload could not be translated.
 *
 * Distinct from `KernelOperationFailed` on purpose. That one means a geometry
 * algorithm failed on data this kernel produced, which is the kernel's problem.
 * This one usually means the file was not what it claimed to be, which is the
 * user's - and the two want different words in the interface.
 */
export class StepTranslationError extends KernelError {
  readonly code = 'StepTranslationFailed';

  constructor(message: string, operation: string) {
    super(message, operation, `${operation}: ${message}`);
  }
}

/**
 * The kernel is gone: the Worker was disposed, or it died with work in flight.
 *
 * Distinct from `KernelNotReady`, which means "not yet". This one means the
 * geometry that was there is unrecoverable, so a caller holding handles knows
 * they are worthless rather than merely unusable for the moment.
 */
export class KernelTerminatedError extends KernelError {
  readonly code = 'KernelTerminated';

  constructor(message: string, operation: string) {
    super(message, operation, `${operation}: ${message}`);
  }
}

/**
 * Converts a non-Ok status into the matching error.
 *
 * `EmptyResult` is deliberately absent: it is not an error. Operations that can
 * legitimately produce no geometry return it as a value, because the specs
 * require callers to distinguish "no geometry" from "operation failed".
 */
export function throwForStatus(
  status: number,
  message: string,
  operation: string,
): never {
  switch (status) {
    case Status.InvalidHandle:
      throw new InvalidHandleError(message, operation);
    case Status.InvalidParameter:
      throw new InvalidParameterError(message, operation);
    case Status.KernelOperationFailed:
      throw new KernelOperationFailedError(message, operation);
    case Status.TranslationFailed:
      throw new StepTranslationError(message, operation);
    default:
      throw new KernelOperationFailedError(
        `unexpected status ${status}: ${message}`,
        operation,
      );
  }
}

/**
 * Flattens an error for the wire.
 *
 * Anything that is not a `KernelError` - a bug in the Worker rather than a
 * kernel failure - is reported as `KernelOperationFailed` so the caller still
 * receives a typed rejection carrying the operation, instead of an opaque one.
 */
export function toFailure(error: unknown, operation: string): KernelFailure {
  if (error instanceof KernelError) {
    return {
      code: error.code,
      message: error.detail,
      operation: error.operation,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'KernelOperationFailed',
    message: `unexpected kernel error: ${message}`,
    operation,
    ...(error instanceof Error && error.stack !== undefined
      ? { stack: error.stack }
      : {}),
  };
}

/**
 * Rebuilds the error a caller would have seen had the kernel run in-process.
 *
 * The far-side stack is attached as `cause`: the revived error's own stack
 * starts at this line, which says nothing about where the failure came from.
 */
export function reviveFailure(failure: KernelFailure): KernelError {
  const error = construct(failure);
  if (failure.stack !== undefined) {
    (error as { cause?: unknown }).cause = new Error(
      `kernel-side stack:\n${failure.stack}`,
    );
  }
  return error;
}

function construct(failure: KernelFailure): KernelError {
  const { code, message, operation } = failure;
  switch (code) {
    case 'KernelNotReady':
      return new KernelNotReadyError(operation);
    case 'WebAssemblyUnsupported':
      return new WebAssemblyUnsupportedError(message);
    case 'InvalidHandle':
      return new InvalidHandleError(message, operation);
    case 'InvalidParameter':
      return new InvalidParameterError(message, operation);
    case 'KernelTerminated':
      return new KernelTerminatedError(message, operation);
    case 'KernelOperationFailed':
      return new KernelOperationFailedError(message, operation);
    case 'StepTranslationFailed':
      return new StepTranslationError(message, operation);
    default:
      return new KernelOperationFailedError(
        `unrecognized kernel error code "${code}": ${message}`,
        operation,
      );
  }
}
