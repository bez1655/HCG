/**
 * Container entrypoint.
 *
 * Separate from index.ts so importing the module never starts the harvester.
 * The first version guarded the auto-run with an env flag, and the test suite
 * duly launched a live scraper in the background — hundreds of outbound
 * sockets during `npm test`. A file that only runs when it is the entrypoint
 * cannot be started by accident.
 */
import { main } from "./index.js";

main().catch((err) => {
  console.error("[harvester] фатальная ошибка:", err);
  process.exit(1);
});
