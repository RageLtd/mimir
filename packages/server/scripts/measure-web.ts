import { web } from "../src/web";
import {
  assertTransferBudget,
  COLD_LOAD_BUDGET_BYTES,
  measureFirstLoad,
  SINGLE_DATAGRAM_TARGET_BYTES,
} from "../src/web/transfer-budget";

const fetcher = (path: string, init?: RequestInit) => web.request(path, init);
const reports = [
  await measureFirstLoad(fetcher, "/sign-in", "identity"),
  await measureFirstLoad(fetcher, "/sign-in", "gzip"),
  await measureFirstLoad(fetcher, "/sign-up", "identity"),
  await measureFirstLoad(fetcher, "/sign-up", "gzip"),
  await measureFirstLoad(fetcher, "/app", "identity"),
  await measureFirstLoad(fetcher, "/app", "gzip"),
];

for (const report of reports) assertTransferBudget(report);

process.stdout.write(
  `${JSON.stringify(
    {
      budgets: {
        singleDatagramTargetBytes: SINGLE_DATAGRAM_TARGET_BYTES,
        coldLoadHardLimitBytes: COLD_LOAD_BUDGET_BYTES,
      },
      reports,
    },
    null,
    2,
  )}\n`,
);
