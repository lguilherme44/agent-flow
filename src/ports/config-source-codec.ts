export type ConfigPath = readonly (string | number)[];

export type ConfigSourceCodecErrorCode = 'syntax' | 'root_not_mapping' | 'alias' | 'custom_tag';

export class ConfigSourceCodecError extends Error {
  constructor(readonly code: ConfigSourceCodecErrorCode, message: string) {
    super(message);
    this.name = 'ConfigSourceCodecError';
  }
}

export interface ConfigSourceDocument {
  readonly data: Record<string, unknown>;
  /** Paths only. Unknown values are deliberately never exposed. */
  readonly unknownPaths: readonly string[];
  set(path: ConfigPath, value: unknown): void;
  unset(path: ConfigPath): void;
  toString(): string;
}

/** AST-preserving source seam. Parsing does no filesystem I/O. */
export interface ConfigSourceCodec {
  parse(source: string): ConfigSourceDocument;
}
