export class SharedSettingsStoreError extends Error {
  readonly cause?: unknown;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    this.cause = options?.cause;
  }
}

export class MalformedSharedSettingsError extends SharedSettingsStoreError {}

export class InvalidSharedSettingsError extends SharedSettingsStoreError {}

export class UnsupportedSharedSettingsVersionError extends SharedSettingsStoreError {
  readonly schemaVersion: number;

  constructor(schemaVersion: number) {
    super(`Shared settings schema version ${schemaVersion} is newer than the supported version 1.`);
    this.schemaVersion = schemaVersion;
  }
}

export class SharedSettingsNotInitializedError extends SharedSettingsStoreError {}

export class SharedSettingsAlreadyInitializedError extends SharedSettingsStoreError {}

export class SharedSettingsInitializationConflictError extends SharedSettingsAlreadyInitializedError {}
