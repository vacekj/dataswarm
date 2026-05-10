export class SwarmKvError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'SwarmKvError'
  }
}

export class KeyNotFoundError extends SwarmKvError {
  constructor(key: string) {
    super(`No value for key: ${JSON.stringify(key)}`, 'KEY_NOT_FOUND')
    this.name = 'KeyNotFoundError'
  }
}

export class RevisionConflictError extends SwarmKvError {
  constructor(
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      `Index revision mismatch: expected ${expected}, index is at ${actual}. Another writer updated the store.`,
      'REVISION_CONFLICT',
    )
    this.name = 'RevisionConflictError'
  }
}

export class InvalidKeyError extends SwarmKvError {
  constructor(detail: string) {
    super(detail, 'INVALID_KEY')
    this.name = 'InvalidKeyError'
  }
}
