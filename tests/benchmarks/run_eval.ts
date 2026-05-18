import { loadTasks, runEvalSuite, summarize, writeReport } from './harness.js';

async function main(): Promise<void> {
  const tasks = await loadTasks(process.argv[2] ?? 'tests/benchmarks/tasks.sample.json');
  const results = await runEvalSuite(tasks);
  await writeReport(results, process.argv[3] ?? 'tests/benchmarks/reports/latest.json');
  const summary = summarize(results);
  console.log(JSON.stringify(summary, null, 2));
  if (summary.passed !== summary.total) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
