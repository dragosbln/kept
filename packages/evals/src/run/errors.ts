import type { RunError, RunErrorKind } from './types.js';

/**
 * A run error with its kind attached, so runOnce can classify a throw by
 * position and the reporter can print the kind. Anything else that is
 * thrown is `unexpected`.
 */
export class RunFailure extends Error {
  constructor(
    readonly kind: RunErrorKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RunFailure';
  }

  toRunError(): RunError {
    return {
      kind: this.kind,
      message: this.message,
      ...(this.cause === undefined ? {} : { cause: this.cause }),
    };
  }
}

/** The placeholder body of a hand-written function whose skeleton landed before its body. */
export function notImplemented(what: string): never {
  throw new Error(`${what} is not implemented yet: hand-written`);
}
