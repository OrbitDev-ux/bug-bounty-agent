import { resetDbForTests, getDb } from "../src/db/client.js";

/** Call at the top of each test file's first test / before each test to isolate state. */
export function freshDb() {
  resetDbForTests();
  return getDb(":memory:");
}
