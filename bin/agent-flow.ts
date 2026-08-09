import { main } from '../src/cli/index.js';

// The exit code has to reach the shell: scripts and CI distinguish a config
// error from an execution failure by it, and returning it from main() without
// setting it here would report every failure as success.
process.exitCode = await main(process.argv);
