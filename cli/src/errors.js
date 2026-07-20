// errors.js — CLI error taxonomy. UsageError maps to exit code 2 (bad
// invocation / bad input); AbortError maps to 130 (user cancelled — the
// conventional 128+SIGINT code, so scripts can tell "user said no" from
// "invocation was wrong"); everything else thrown by commands (ApiError,
// DecryptError, PasswordRequired, FormatError) maps to exit code 1.
export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export class AbortError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortError';
  }
}
