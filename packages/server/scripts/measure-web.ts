import { web } from "../src/web";
import {
  assertTransferBudget,
  COLD_LOAD_BUDGET_BYTES,
  measureFirstLoad,
  SINGLE_DATAGRAM_TARGET_BYTES,
} from "../src/web/transfer-budget";

const fetcher = (path: string, init?: RequestInit) => web.request(path, init);
const identity = await measureFirstLoad(fetcher, "/", "identity");
const gzip = await measureFirstLoad(fetcher, "/", "gzip");

assertTransferBudget(identity);
assertTransferBudget(gzip);

process.stdout.write(
  `${JSON.stringify(
    {
      budgets: {
        singleDatagramTargetBytes: SINGLE_DATAGRAM_TARGET_BYTES,
        coldLoadHardLimitBytes: COLD_LOAD_BUDGET_BYTES,
      },
      reports: [identity, gzip],
    },
    null,
    2,
  )}\n`,
);
