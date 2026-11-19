process.on("uncaughtException", e => {
  console.error(e);
  process.exit(1000);
});
process.on("SIGINT", () => process.exit(1001));
process.on("SIGTERM", () => process.exit(1002));
export const afterExit = (fn: () => void) => process.on("exit", fn);
