# FLOW architecture decisions

The design follows the FLOW Product, Architecture & Implementation Specification v1.0 and the approved M0 assessment. M0 establishes the boundaries below. The named domain modules and behaviors describe future work and are subject to their milestone gates.

## 1. One application with explicit trust boundaries

Use a Next.js App Router application and PostgreSQL. Keep account authorization, policy and financial orchestration on the server. Use a separate worker process from the same codebase when provisioning and settlement jobs are introduced. PostgreSQL owns state transitions and the durable outbox so workers can recover after a restart. Queue messages are delivery mechanisms and may be repeated.

- Identity authenticates users. A personal or business account is the tenant and owns its wallet, requests and records. Businesses receive their own wallet identity and policy instead of borrowing an owner's personal wallet.
- Custody resolves wallet addresses and their specific receive, sign, broadcast and balance capabilities. Its adapter holds only server-side credential references in the domain interface.
- The registry defines networks and assets. Routing translates FLOW requests into provider quotes and observes provider progress. A chain evidence adapter independently observes on-chain transfers and finality.
- Settlement reconciles the route with chain evidence and posts the ledger. Reporting reads projections from verified events and accounting records.

The wallet, routing and chain evidence interfaces are in [src/domain/providers.ts](../src/domain/providers.ts). Their types do not initiate provider calls. A future adapter can implement routing through 1Click or a verified direct transfer. The same orchestration must handle independent sender and recipient legs for either.

## 2. Chains, assets and custody positions

Represent a network by its canonical chain and environment. Represent an asset by network, standard and native identifier, contract or mint. A provider asset ID belongs in a versioned mapping. Each payment request pins the recipient's asset and wallet address. Each attempt separately selects a source asset, network and refund address and preserves the quote terms and funding instructions. Every address has a network even when EVM address strings match across chains.

Keep quantities in integer atomic units, represented as canonical integer strings at interfaces. Convert through `bigint` for arithmetic and use exact PostgreSQL numeric storage when money tables are introduced. Native NEAR, wrapped NEAR and different instances of USDC remain distinct assets. Native holdings, Intents balances and funds in transit have separate custody locations. Ledger records describe those holdings and do not add a second balance.

NEAR to Base USDC is the initial demo configuration. Support for other pairs comes from the intersection of verified network and wallet capabilities, the FLOW allowlist, and a provider quote for the chosen amount and addresses. A catalog listing or address derivation alone cannot enable a route.

## 3. Settlement, accounting and milestone ordering

Separate reusable payment requests from attempts. A committed attempt holds an immutable copy of the quote and route, including expiry, destination, and refund instructions. The worker can observe deposits and provider status while delivery remains pending. Provider success identifies candidate evidence. The chain verifier must match the network, token, recipient, amount and finality before completion. Claim each transfer event once, using the network, transaction and event identity. One transaction may contain multiple transfers.

Store final evidence, the balanced settlement journal and the completed state in one database transaction. Post journals once under a unique operation key and make posted entries immutable. Correct errors through reversing or adjusting journals. Handle ambiguous outcomes and late funding through reconciliation.

| Milestone | Dependency                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1        | Authentication and tenant authorization require review and a separate approval.                                                                                                                |
| M2–M3     | Verify wallet identity, policy and recovery before enabling custody capabilities. Record asset and balance sources per network and custody location.                                           |
| M4        | Prove native adapters with dedicated test wallets. Actual user-funded outgoing transfers wait for atomic reservations and applicable approval controls, even if a signing path already exists. |
| M5–M6     | Establish payment requests and routing. Minimum settlement accounting must exist before any M6 payment can complete.                                                                           |
| M7        | Enforce atomic reservations before user-funded outgoing transfers, including retries and concurrency.                                                                                          |
| M8–M9     | Extend the ledger, reconciliation and operational controls. Public mainnet use depends on route, custody, security and release evidence.                                                       |

## 4. Configuration, data access and diagnostics

The explicit FLOW environment is independent of the Next.js build phase. The M0 configuration permits only disabled financial execution and blocks public environment variables. Startup checks the environment-specific database and role. Local and test connect to loopback. Staging and production require verified TLS. Every environment separates the runtime, migration and cluster administrator inputs. Only the app role URL belongs in the web environment, including Next.js dotenv files. Prisma gets only the migrator URL from its command environment. Bootstrap credentials are scoped to an operator invocation. Deployment still needs separate identities, secret access, grants and network policies.

The first Prisma migration creates the `flow` namespace. Prisma tracks it in its migration table, which the app role cannot read. The PostgreSQL pool uses a bounded query to verify the actual database, login role, namespace usage and absence of elevated role attributes, role memberships and schema or database creation privileges. Deployment verifies migration history with the migrator role over a direct connection. Add domain tables and a generated Prisma client when the first domain schema is approved.

Use typed internal error codes and redact secrets at log serialization, including credentials in structured fields and common patterns in free-form text. Keep raw secret-bearing payloads out of logs. Readiness endpoints return a simple status. When a check fails, a request ID correlates the response with a log that contains no raw driver message or connection string. A liveness check remains available when the database is down.
