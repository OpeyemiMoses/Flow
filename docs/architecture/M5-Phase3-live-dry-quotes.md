# FLOW — M5 Phase 3 Genuine Live Dry Quote Audit Record

**Representative Live Provider Quoting Responses (Read-Only dry:true Queries)**

Date of Observation: 2026-11-09T14:55:43Z  
Provider Endpoint: `https://1click.chaindefuser.com/v0/quote`  
Mode: `dry: true`, `swapType: "EXACT_OUTPUT"`  
Requested Destination Output: `10000000` (10.00 USDC on Base Mainnet)  
Financial Execution: Disabled (`FLOW_EXECUTION=disabled`)

---

### Genuine Live Quoting Matrix

| Route                         | Origin Asset Identifier                                           | Destination Asset Identifier                                       | HTTP Status   | Quoted Source Atomic                       | Quoted Destination Atomic | Exact Output Satisfied       | Provider Time Estimate | Provider Fees Reported                           | Correlation ID                         |
| :---------------------------- | :---------------------------------------------------------------- | :----------------------------------------------------------------- | :------------ | :----------------------------------------- | :------------------------ | :--------------------------- | :--------------------- | :----------------------------------------------- | :------------------------------------- |
| **Solana SOL → Base USDC**    | `nep141:sol.omft.near`                                            | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | `201 Created` | `116098457` (~0.1161 SOL)                  | `10000000` (10.00 USDC)   | Yes (`10000000 >= 10000000`) | 22s                    | `refundFee: 114049`, `withdrawFee: 2400`         | `97a1cdf9-e349-4b6e-8daa-535e631be29a` |
| **Solana USDT → Base USDC**   | `nep141:sol-c800a4bd850783ccb82c2b2c7e84175443606352.omft.near`   | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | `201 Created` | `10114986` (~10.11 USDT)                   | `10000000` (10.00 USDC)   | Yes (`10000000 >= 10000000`) | 22s                    | `refundFee: 10010`, `withdrawFee: 2400`          | `f4adad47-1232-4d43-a6ed-863b6e01d1a5` |
| **Ethereum ETH → Base USDC**  | `nep141:eth.omft.near`                                            | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | `201 Created` | `4761826033562274` (~0.00476 ETH)          | `10000000` (10.00 USDC)   | Yes (`10000000 >= 10000000`) | 47s                    | `refundFee: 35000000000000`, `withdrawFee: 2400` | `d2b520e2-3edf-469e-aeb1-6e1185626e46` |
| **Ethereum USDT → Base USDC** | `nep141:eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near` | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | `201 Created` | `10114984` (~10.11 USDT)                   | `10000000` (10.00 USDC)   | Yes (`10000000 >= 10000000`) | 47s                    | `refundFee: 300000`, `withdrawFee: 2400`         | `dea8119a-0596-44d0-9b09-103d8e5f2510` |
| **NEAR wNEAR → Base USDC**    | `nep141:wrap.near`                                                | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | `201 Created` | `2812067450621102369042695` (~2.812 wNEAR) | `10000000` (10.00 USDC)   | Yes (`10000000 >= 10000000`) | 22s                    | `refundFee: 0`, `withdrawFee: 2400`              | `fc965cb5-29b5-4e4e-8b13-c199202fecad` |
| **NEAR USDT → Base USDC**     | `nep141:usdt.tether-token.near`                                   | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | `201 Created` | `10114985` (~10.11 USDT)                   | `10000000` (10.00 USDC)   | Yes (`10000000 >= 10000000`) | 22s                    | `refundFee: 4517`, `withdrawFee: 2400`           | `0c130319-4ee1-4456-a830-a4462e665a4b` |
| **Base ETH → Base USDC**      | `nep141:base.omft.near`                                           | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` | `201 Created` | `4763769752729861` (~0.00476 ETH)          | `10000000` (10.00 USDC)   | Yes (`10000000 >= 10000000`) | 37s                    | `refundFee: 560000000000`, `withdrawFee: 2400`   | `782d1cba-0ac1-4c13-b991-8a4aeaaddacb` |

---

### Distinction: Fixture Test Rates vs Genuine Live Rates

1. **Local Test Fixtures:**
   - In automated test runs (`test/security.integration.mjs` and `test/support/provider-fixture.mjs`), network calls are intercepted locally to ensure offline determinism, test resilience, and zero flakiness.
   - Fixture rate: `50000000` (~0.05 SOL) for 10 USDC. This is a synthetic mock fixture value for deterministic testing.
2. **Genuine Live 1Click Solver Rates:**
   - As demonstrated above, real 1Click solver dry quotes return active market rates (`116098457` ≈ 0.1161 SOL for 10 USDC, matching ~$86.13 SOL/USD market pricing).
   - In all documentation and reporting, synthetic test fixture numbers are explicitly labeled as test fixtures, and live queries are recorded separately.
