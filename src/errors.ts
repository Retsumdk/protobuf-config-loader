import type { Issue } from "./types.js";

export type PclErrorCode =
  | "PCL_USAGE"
  | "PCL_SCHEMA_PARSE"
  | "PCL_SCHEMA_REF"
  | "PCL_IO"
  | "PCL_VALIDATION"
  | "PCL_INTERNAL";

export const EXIT_CODES: Record<PclErrorCode, number> = {
  PCL_USAGE: 2,
  PCL_SCHEMA_PARSE: 3,
  PCL_SCHEMA_REF: 3,
  PCL_IO: 5,
  PCL_VALIDATION: 4,
  PCL_INTERNAL: 1,
};

export class PclError extends Error {
  readonly code: PclErrorCode;
  readonly issues?: Issue[];

  constructor(code: PclErrorCode, message: string, issues?: Issue[]) {
    super(message);
    this.name = "PclError";
    this.code = code;
    if (issues !== undefined) this.issues = issues;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}
