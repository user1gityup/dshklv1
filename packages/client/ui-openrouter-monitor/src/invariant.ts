export class InvariantError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvariantError'
  }
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvariantError(message)
}
