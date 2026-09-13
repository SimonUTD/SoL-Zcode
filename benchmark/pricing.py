"""GLM-5.3-Flash pricing (virtual cost accounting for the benchmark).

Source (checked 2026-09-13):
  - bigmodel.cn official price page / docs.bigmodel.cn pricing:
      GLM-5.3-Flash  input ¥0.8/M tok, output ¥2.8/M tok, cache-hit ¥0.23/M tok
      (limited-time 50% promo ended 2026-09-10; cache *storage* is currently
      free, so cacheWrite is billed at 0).
  - Z.ai international list (x.com @Zai_org 2026-08-26, openrouter echoes):
      input $0.15/M, output $0.50/M, cached input $0.03/M.

The benchmark reports USD using the Z.ai international list, which needs no
FX conversion. Actual consumption runs through the host's
`builtin:bigmodel-coding-plan` quota; these numbers are a comparable
per-token accounting, not an invoice.
"""

INPUT_USD_PER_M = 0.15
OUTPUT_USD_PER_M = 0.50
CACHE_READ_USD_PER_M = 0.03
CACHE_WRITE_USD_PER_M = 0.0  # cache storage is time-limited free (bigmodel.cn)

CNY_PER_M = {"input": 0.8, "output": 2.8, "cache_read": 0.23}

SOURCE_DATE = "2026-09-13"


def cost_usd(usage: dict) -> float:
    """USD cost of one zcode --json usage block.

    zcode's usage.inputTokens INCLUDES cached tokens (spike 2026-09-13:
    input=9332 + output=4 == total=9336 with cacheRead=64 inside input), so
    fresh input = inputTokens - cacheRead.
    """
    inp = float(usage.get("inputTokens", 0) or 0)
    out = float(usage.get("outputTokens", 0) or 0)
    cache_read = float(usage.get("cacheRead", usage.get("cacheReadTokens", 0)) or 0)
    cache_write = float(usage.get("cacheWrite", usage.get("cacheWriteTokens", 0)) or 0)
    fresh = max(inp - cache_read, 0.0)
    usd = (
        fresh * INPUT_USD_PER_M
        + cache_read * CACHE_READ_USD_PER_M
        + cache_write * CACHE_WRITE_USD_PER_M
        + out * OUTPUT_USD_PER_M
    ) / 1_000_000
    return round(usd, 6)
