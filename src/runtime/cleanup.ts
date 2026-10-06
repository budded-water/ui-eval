/** A bounded wait ended without proof that all owned resources were closed. */
export class IncompleteCleanupError extends Error {
  readonly code = "OWNED_RESOURCE_CLEANUP_INCOMPLETE"

  constructor(message: string) {
    super(message)
    this.name = "IncompleteCleanupError"
  }
}

export function hasIncompleteCleanup(error: unknown): boolean {
  if (error instanceof IncompleteCleanupError) return true
  return error instanceof AggregateError && error.errors.some(hasIncompleteCleanup)
}
