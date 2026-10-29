import { PclError } from "./errors.js";
import { cmdDemo, cmdDemoSchema, cmdHelp, cmdPrint, cmdSchema, cmdValidate, cmdVersion, type GlobalOpts } from "./cli-run.js";

const COMMANDS = new Set(["validate", "print", "schema", "demo", "demo-schema", "version", "help"]);

export interface ParsedArgv {
  command: string | undefined;
  args: string[];
  global: GlobalOpts;
}

export function parseArgv(argv: string[]): ParsedArgv {
  const global: GlobalOpts = {};
  const args: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--schema") {
      const next = argv[++i];
      if (next === undefined) throw new PclError("PCL_USAGE", "--schema requires a file path");
      global.schema = next;
      continue;
    }
    if (arg === "--root") {
      const next = argv[++i];
      if (next === undefined) throw new PclError("PCL_USAGE", "--root requires a message name");
      global.root = next;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      if (command === undefined) command = "help";
      continue;
    }
    if (arg.startsWith("-") && arg !== "-") {
      throw new PclError("PCL_USAGE", `unknown option '${arg}' (see 'pcl help')`);
    }
    if (command === undefined) {
      command = arg;
      continue;
    }
    args.push(arg);
  }

  return { command, args, global };
}

export function main(argv: string[]): number {
  const { command, args, global } = parseArgv(argv);

  if (command === undefined || command === "help") return cmdHelp();
  if (!COMMANDS.has(command)) {
    console.error(`Unknown command '${command}'. See 'pcl help'.`);
    return 2;
  }
  switch (command) {
    case "validate": return cmdValidate(args, global);
    case "print": return cmdPrint(args, global);
    case "schema": return cmdSchema(args, global);
    case "demo": return cmdDemo(args);
    case "demo-schema": return cmdDemoSchema(args);
    case "version": return cmdVersion();
  }
  return 0;
}

export { PclError };
