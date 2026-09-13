# Third-Party Notices

## plugin/core/ — vendored from @alicekk/sol-opencode-core (MIT)

The modules under `plugin/core/` are vendored from
https://github.com/ImKK666/SoL-OpenCode (`packages/core/src`, published as
`@alicekk/sol-opencode-core`), which is an MIT-licensed port of NVIDIA's
SoL-Pi. They are ported to dependency-free ESM JavaScript with type erasure
only; algorithms, constants, and assertion-relevant semantics are unchanged.

Each vendored file retains its upstream SPDX header. Files marked
`Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES` carry the NVIDIA MIT
notice below; files marked `Copyright (c) 2026 ImKK666` carry the ImKK666 MIT
notice below.

### Vendor deviations (recorded per file header and the P1 report)

1. `reducer/config.mjs`: `REDUCER_RECEIPT_PREFIX` renamed to
   `sol_zcode_evidence_receipt_v1` and `REDUCER_RECEIPT_SCHEMA` renamed to
   `sol-zcode-evidence-receipt/1` (equality tokens only; validation semantics
   unchanged); `loadReducerConfig` accepts an optional `options.storeRoot`
   override so the adapter can place the store per the sol-zcode DESIGN §1
   layout. Defaults unchanged.
2. `observation-pack/observation.mjs`: the evidence-receipt skip literal is
   renamed in lockstep with (1) so the cross-mechanism invariant
   (skip literal === receipt prefix) is preserved.
3. `reducer/receipt.mjs`: `reducerInputHeader` added (same field set as
   `reducerInput`'s header) for the out-of-band `--attach` transport; the
   `readback` line names sol-zcode's recall tooling.
4. `trajectory/jsonl.mjs`: unchanged; the adapter layers its own hash-chained
   writer (DESIGN §2.5) for the durable cross-process stream.

### NVIDIA CORPORATION & AFFILIATES MIT License

```
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: MIT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### ImKK666 MIT License

```
SPDX-FileCopyrightText: Copyright (c) 2026 ImKK666. All rights reserved.
SPDX-License-Identifier: MIT

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Upstream lineage

- SoL-Pi (NVIDIA): https://github.com/NVlabs/SoL-Pi — original five-mechanism
  research implementation (Action Fusion, Observation Pack, Evidence-Preserving
  Reducer, Online Context Compact; trajectory metadata facilities).
- SoL-OpenCode: https://github.com/ImKK666/SoL-OpenCode — OpenCode plugin port
  whose `packages/core` is vendored here.
