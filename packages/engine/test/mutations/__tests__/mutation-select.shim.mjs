#!/usr/bin/env node
// The `tools/mutation-select.mjs` of the consumer fixture, run in place by select.test.mjs:
// bind the fixture's Setup, then call the engine's select entry point.
import { bindConsumer } from './consumer.fixture.mjs';
import { main } from '../../../mutations/select.mjs';

bindConsumer();
try {
  main();
} catch (err) {
  console.error(
    `mutation-select: ${err.message}\nRun pnpm check:mutations for the registry report.`,
  );
  process.exit(1);
}
