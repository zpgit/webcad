// Typed errors mapped from the C++ facade's status values.
//
// The facade never throws across the WASM boundary; it returns a status and a
// message. This module turns those into JavaScript errors so callers can
// discriminate a caller mistake from a kernel failure without string matching.

/** Status codes; must stay in sync with native/src/status.hpp. */
export const Status = {
  Ok: 0,
  InvalidHandle: 1,
  InvalidParameter: 2,
  KernelOperationFailed: 3,
  EmptyResult: 4,
} as const;

export type StatusCode = (typeof Status)[keyof typeof Status];

export abstract class KernelError extends Error {
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** An operation was attempted before initialization completed. */
export class KernelNotReadyError extends KernelError {
  readonly code = 'KernelNotReady';

  constructor(operation: string) {
    super(
      `Kernel is not ready; cannot run "${operation}". ` +
        'Await initialize() before invoking geometry operations.',
    );
  }
}

/** The environment cannot host the kernel at all. */
export class WebAssemblyUnsupportedError extends KernelError {
  readonly code = 'WebAssemblyUnsupported';

  constructor(detail: string, options?: { cause?: unknown }) {
    super(`This environment cannot run the geometry kernel: ${detail}`, options);
  }
}

/** A handle was never issued by this kernel instance, or has been released. */
export class InvalidHandleError extends KernelError {
  readonly code = 'InvalidHandle';

  readonly operation: string;

  constructor(message: string, operation: string) {
    super(`${operation}: ${message}`);
    this.operation = operation;
  }
}

/** A parameter was rejected before any geometry work began. */
export class InvalidParameterError extends KernelError {
  readonly code = 'InvalidParameter';

  readonly operation: string;

  constructor(message: string, operation: string) {
    super(`${operation}: ${message}`);
    this.operation = operation;
  }
}

/**
 * The underlying OCCT algorithm failed. The kernel remains usable and any
 * operand handles remain valid.
 */
export class KernelOperationFailedError extends KernelError {
  readonly code = 'KernelOperationFailed';

  readonly operation: string;

  constructor(message: string, operation: string) {
    super(`${operation}: ${message}`);
    this.operation = operation;
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
    default:
      throw new KernelOperationFailedError(
        `unexpected status ${status}: ${message}`,
        operation,
      );
  }
}
