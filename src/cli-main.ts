import { PclError } from "./errors.js";
import { main } from "./cli.js";

export function run(argv: string[]): number {
  try {
    return main(argv);
  } catch (error) {
    if (error instanceof PclError) {
      if (error.issues) {
        for (const issue of error.issues) {
          const src = issue.source ? ` [${issue.source}]` : "";
          console.error(`error${src}: ${issue.path}: ${issue.message}`);
        }
      } else {
        console.error(`error [${error.code}]: ${error.message}`);
      }
      return error.exitCode;
    }
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}
