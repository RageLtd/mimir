# Verify Assumptions Before Acting

Do not act on assumptions about what went wrong. Validate first.

- Unexpected result: inspect the actual return value before changing code
- API failure: read the response (status, body, headers) before hypothesizing a fix
- Test failure: read actual vs expected output before modifying the test or code under test
- Build/deploy failure: check logs and error messages before guessing at the cause
