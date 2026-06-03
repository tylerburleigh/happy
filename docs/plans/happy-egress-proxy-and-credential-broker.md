# Happy Egress Proxy and Credential Broker Plan

## Status

Proposed. No implementation work has started.

This plan is intended to be detailed enough for a future engineer or agent to pick up without needing the original design conversation.

## Objective

Add a Happy-managed egress layer for sandboxed sessions.

The work has two stages:

1. **Egress proxy:** route sandboxed agent network traffic through a local Happy proxy so Happy can enforce and audit network policy.
2. **Credential broker:** for supported providers, keep raw provider credentials out of the agent environment and provider state files. The proxy injects credentials upstream after validating session policy.

The egress proxy is the integration layer. Credential brokering is a feature built on top of it.

## Summary

Happy already owns the daemon lifecycle, session metadata, sandbox config, provider auth flows, and mobile/server control plane. The egress proxy should therefore be a Happy daemon-owned per-session component.

```txt
Session start
|
+- daemon reads settings.sandboxConfig
+- daemon resolves SessionNetworkPolicy
+- daemon starts HappyEgressProxy on 127.0.0.1:<randomPort>
+- launcher injects proxy env into the sandboxed agent
+- sandbox allows agent -> proxy
+- sandbox blocks agent -> external network directly, where runtime support allows
```

Network-only proxy:

```txt
agent process
|
+- HTTPS_PROXY=http://127.0.0.1:<port>
+- CONNECT api.example.com:443
   |
   +- HappyEgressProxy
      +- authenticates per-session proxy token
      +- checks SessionNetworkPolicy
      +- blocks private/link-local/metadata targets
      +- emits EgressAuditEvent
      +- forwards TCP stream if allowed
```

Credential broker:

```txt
agent process
|
+- PROVIDER_BASE_URL=http://127.0.0.1:<port>/providers/anthropic
+- no raw ANTHROPIC_API_KEY in env
+- POST /providers/anthropic/v1/messages
   |
   +- HappyEgressProxy
      +- authenticates per-session proxy token
      +- validates provider route, endpoint, model, and limits
      +- loads provider credential from Happy-controlled storage/memory
      +- injects upstream Authorization
      +- streams response from provider
```

## Current Happy Context

Relevant existing pieces:

- Sandbox config and defaults: `packages/happy-cli/src/persistence.ts`
- Sandbox runtime config builder: `packages/happy-cli/src/sandbox/config.ts`
- Sandbox process env filtering: `packages/happy-cli/src/sandbox/env.ts`
- Sandbox runtime dirs: `packages/happy-cli/src/sandbox/temp.ts`
- Daemon session spawning and lifecycle: `packages/happy-cli/src/daemon/run.ts`
- Local daemon control server/client: `packages/happy-cli/src/daemon/controlServer.ts`, `packages/happy-cli/src/daemon/controlClient.ts`
- Session metadata creation: `packages/happy-cli/src/utils/createSessionMetadata.ts`
- Claude launch path: `packages/happy-cli/src/claude/runClaude.ts`, `packages/happy-cli/src/claude/claudeLocal.ts`, `packages/happy-cli/src/claude/sdk/query.ts`
- Codex launch path: `packages/happy-cli/src/codex/runCodex.ts`, `packages/happy-cli/src/codex/codexAppServerClient.ts`
- ACP launch path: `packages/happy-cli/src/agent/acp/runAcp.ts`, `packages/happy-cli/src/agent/acp/AcpBackend.ts`

The sandbox hardening work already moved Happy toward:

- managed sandbox home/temp dirs
- filtered sandbox env
- isolated provider state
- daemon control token auth
- stricter spawn/env validation
- denial of shared sensitive Happy state inside sandboxed sessions

The egress proxy should build on that, not replace it.

## Security Goals

### Network proxy goals

- Centralize outbound network policy enforcement for sandboxed sessions.
- Make egress auditable per session.
- Block access to private networks, link-local ranges, cloud metadata IPs, and loopback services unless explicitly allowed.
- Support runtime kill switch by stopping or tightening the per-session proxy.
- Reduce reliance on provider-specific agent behavior for network restrictions.

### Credential broker goals

- Prevent supported sandboxed agents from reading raw long-lived provider credentials.
- Keep provider credentials in Happy-controlled storage and daemon/proxy memory.
- Allow agents to perform credentialed provider requests only through constrained provider gateways.
- Enforce provider-specific endpoint/model/rate policy before injecting credentials.
- Preserve streaming behavior for chat/completions APIs.

## Non-Goals

- Do not implement TLS MITM as the default design.
- Do not install a local root CA.
- Do not try to broker every provider or CLI in the first version.
- Do not remove isolated provider state fallback until provider-specific broker support is proven.
- Do not claim credential secrecy if direct egress remains possible or provider credentials are still mounted into the sandbox.

## Security Claims and Limits

Network-only proxy:

```txt
Protects:
+- destination/domain allow/deny
+- private network access
+- egress audit
+- per-session kill switch
+- rate/volume caps

Does not protect:
+- credentials already visible to the agent
+- agent sending visible credentials to an allowed destination
+- HTTPS headers/bodies inside CONNECT tunnels
+- bypasses if direct external egress is still allowed
```

Credential broker:

```txt
Protects raw credential material if all are true:
+- raw credential not in env
+- raw credential not in sandbox-readable provider files
+- raw credential not copied into isolated provider state
+- provider traffic must use Happy proxy/base URL
+- direct external egress is blocked
+- proxy has no endpoint that returns credentials

Still allows:
+- agent can indirectly use credentials for permitted provider actions
+- proxy can deny/limit/audit those actions
```

## Proposed Modules

Add a new egress package area under `packages/happy-cli/src/egress/`.

```txt
packages/happy-cli/src/egress/
|
+- policy.ts
|  +- SessionNetworkPolicy
|  +- resolveSessionNetworkPolicy()
|  +- isDestinationAllowed()
|
+- proxy.ts
|  +- HappyEgressProxy
|  +- startHappyEgressProxy()
|  +- stop()
|
+- audit.ts
|  +- EgressAuditEvent
|  +- EgressAuditSink
|  +- in-memory or file-backed writer
|
+- auth.ts
|  +- generateEgressToken()
|  +- validateEgressToken()
|
+- privateNetworks.ts
|  +- classifyIpAddress()
|  +- assertPublicDestination()
|
+- httpProxy.ts
|  +- HTTP request proxy handling
|  +- CONNECT handling
|
+- providers/
   |
   +- types.ts
   |  +- ProviderGateway
   |  +- ProviderCredentialRef
   |
   +- anthropic.ts
   +- openai.ts
   +- codex.ts, if useful later
```

Keep the initial network proxy generic. Add provider gateways only after the proxy is stable.

## Core Types

Initial proposed type shapes:

```ts
export type SessionNetworkMode = "blocked" | "allowed" | "custom";

export type SessionNetworkPolicy = {
  sessionId: string;
  machineId?: string;
  networkMode: SessionNetworkMode;
  allowedDomains: string[];
  deniedDomains: string[];
  allowLocalBinding: boolean;
  blockPrivateNetworks: boolean;
  blockIpLiterals: boolean;
  allowProxyLoopbackOnly: boolean;
  createdAt: number;
};

export type EgressDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string };

export type EgressAuditEvent = {
  sessionId: string;
  timestamp: number;
  protocol: "http" | "https-connect" | "provider";
  destinationHost: string;
  destinationPort: number;
  decision: EgressDecision["type"];
  reason?: string;
  resolvedAddresses?: string[];
  provider?: string;
  route?: string;
};

export type EgressProxyRuntime = {
  port: number;
  token: string;
  auditId: string;
  stop: () => Promise<void>;
};
```

Credential broker types:

```ts
export type ProviderCredentialRef = {
  provider: "anthropic" | "openai" | "codex" | string;
  credentialId: string;
  accountId?: string;
};

export type ProviderGatewayRequestContext = {
  sessionId: string;
  provider: string;
  credentialRef: ProviderCredentialRef;
  policy: SessionNetworkPolicy;
};

export type ProviderGateway = {
  provider: string;
  basePath: string;
  matchRoute(request: Request): boolean;
  validateRequest(request: Request, context: ProviderGatewayRequestContext): Promise<EgressDecision>;
  buildUpstreamRequest(request: Request, context: ProviderGatewayRequestContext): Promise<Request>;
  streamResponse(response: Response): Response;
};
```

These exact types can change during implementation, but the concepts should remain stable.

## Session Lifecycle Integration

### Session start flow

```txt
runClaude/runCodex/runAcp
|
+- read settings.sandboxConfig
+- createSandboxAgentState(), when sandbox enabled
+- start session
   |
   +- daemon spawn path
      |
      +- resolve SessionNetworkPolicy from SandboxConfig
      +- startHappyEgressProxy(policy)
      +- build egress env
      |  +- HTTP_PROXY=http://127.0.0.1:<port>
      |  +- HTTPS_PROXY=http://127.0.0.1:<port>
      |  +- ALL_PROXY=http://127.0.0.1:<port>
      |  +- NO_PROXY=127.0.0.1,localhost
      |  +- HAPPY_EGRESS_TOKEN=<token>
      |
      +- buildSandboxedProcessEnv(parentEnv, explicitEnv + egressEnv)
      +- initializeSandbox(..., egress options)
      +- spawn agent
```

Questions to resolve during implementation:

- Should the proxy be started in `daemon/run.ts`, or closer to each backend launcher?
- Should terminal-started sessions also get an egress proxy when sandbox is enabled?
- Should non-sandboxed sessions get proxy audit only? Initial answer should be no, unless explicitly configured.

Recommended first integration:

- Start proxy only for sandbox-enabled sessions.
- Start it in the common launcher path where sandbox runtime options are already assembled.
- Store proxy runtime on the session/tracked process so cleanup is tied to session exit.

### Session cleanup flow

```txt
session exits / daemon stop / interrupt cleanup
|
+- stop agent child process
+- SandboxManager.reset()
+- stop HappyEgressProxy
+- flush audit sink
+- persist final audit summary in metadata or daemon state
```

## Sandbox Integration

The network proxy is only a strong enforcement point if direct egress is blocked.

Target end-state:

```txt
sandbox network config
|
+- allow outbound to 127.0.0.1:<egressProxyPort>
+- deny external outbound from agent process
+- proxy process runs outside that sandbox or in a separate broker context
```

Implementation depends on what `@anthropic-ai/sandbox-runtime` can express:

- If it can allow loopback binding/connection to specific ports, use that.
- If it can only allow/deny domains broadly, proxy still provides audit but not complete enforcement.
- If needed, run the proxy outside the sandbox and set network mode to blocked for the agent, with explicit local proxy exception.

Add an implementation note after exploring sandbox runtime capabilities.

## Proxy Protocol Details

### HTTP proxy support

Support standard proxy env vars:

- `HTTP_PROXY`
- `HTTPS_PROXY`
- `ALL_PROXY`
- lowercase variants if required by existing clients
- `NO_PROXY=127.0.0.1,localhost`

For HTTP requests:

```txt
GET http://example.com/path HTTP/1.1
Host: example.com
Proxy-Authorization: Bearer <session proxy token>
```

For HTTPS:

```txt
CONNECT api.example.com:443 HTTP/1.1
Proxy-Authorization: Bearer <session proxy token>
```

The proxy should not log request headers or bodies by default.

### Proxy authentication

Options:

1. `Proxy-Authorization: Bearer <token>`
2. Append token in proxy URL credentials:
   `http://session:<token>@127.0.0.1:<port>`
3. Local-only listener plus token header.

Recommended:

- Use proxy URL credentials for generic clients that understand standard proxy auth.
- Also accept `Proxy-Authorization`.
- Never accept unauthenticated proxy requests, even on loopback.

### Destination normalization

Policy checks must canonicalize:

- lowercase hostnames
- trailing dot removal
- punycode/IDNA handling, if supported
- wildcard domain matching
- port normalization
- IPv4/IPv6 literals
- DNS resolution results

Block by default:

- `localhost`
- `127.0.0.0/8`
- `::1`
- RFC1918 ranges
- link-local ranges
- multicast
- cloud metadata endpoints such as `169.254.169.254`
- `.local` and other local discovery names unless explicitly allowed

Redirect handling:

- For HTTP proxy requests, re-check policy on redirected destinations if the proxy follows redirects.
- Prefer not following redirects in the proxy. Let the client handle redirect, causing another proxy request that is checked independently.

CONNECT handling:

- The proxy sees only target host and port.
- It cannot inspect TLS headers or request body.
- It may be able to check SNI only with deeper TCP/TLS parsing. Do not rely on that for v1.

## Credential Broker Design

### Provider base URL mode

For providers whose clients support custom base URLs:

```txt
agent env
|
+- ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/providers/anthropic
+- no ANTHROPIC_API_KEY
```

Proxy route:

```txt
/providers/anthropic/v1/messages
|
+- authenticate proxy token
+- validate endpoint is allowed
+- validate model is allowed
+- load credentialRef for session/provider
+- inject Authorization or provider-specific auth
+- forward to https://api.anthropic.com/v1/messages
+- stream response back
```

### Generic proxy auth injection mode

For SDKs that require the provider hostname but allow proxy usage:

```txt
agent -> CONNECT api.provider.com:443
```

The proxy cannot inject HTTP headers into a TLS tunnel without TLS MITM, so this mode cannot broker credentials. It is useful only for network policy/audit.

Credential brokering requires one of:

- provider base URL override
- custom local shim that speaks enough provider API
- provider-specific CLI config that points at Happy local gateway

### Provider compatibility matrix

Create and maintain a matrix during implementation:

| Provider/backend | Supports base URL | Supports no API key | Streaming behavior | Broker feasible | Notes |
| --- | --- | --- | --- | --- | --- |
| Claude SDK | TBD | TBD | streaming | TBD | inspect `claude/sdk/query.ts` |
| Claude Code CLI | TBD | TBD | CLI-managed | harder | may require isolated state fallback |
| Codex app-server | TBD | TBD | JSON-RPC child | TBD | inspect app-server config options |
| ACP agents | varies | varies | protocol-specific | per-agent | support proxy first |

Do not remove provider state credentials until a provider has a passing broker compatibility suite.

## Policy Model

`SandboxConfig` remains the user-facing source of truth.

Map to egress:

```txt
SandboxConfig
|
+- networkMode
|  +- blocked -> deny external
|  +- allowed -> allow external except deniedDomains
|  +- custom -> allow only allowedDomains, then apply deniedDomains
|
+- allowedDomains
+- deniedDomains
+- allowLocalBinding
   +- false -> block localhost/private by default
```

Proposed additions later:

```ts
export type SandboxConfig = {
  // existing fields...
  egressProxy?: {
    enabled?: boolean;
    audit?: "off" | "metadata";
    blockPrivateNetworks?: boolean;
    blockIpLiterals?: boolean;
  };
  credentialBroker?: {
    enabled?: boolean;
    providers?: Record<string, {
      enabled: boolean;
      credentialId?: string;
      allowedModels?: string[];
      allowedEndpoints?: string[];
    }>;
  };
};
```

Do not add all config fields up front. Start with internal defaults and feature flags.

## Metadata and Audit Integration

Session metadata should include a summary, not secrets:

```ts
type Metadata = {
  // existing fields...
  egress?: {
    enabled: boolean;
    proxyAuditId: string;
    policySummary: {
      networkMode: "blocked" | "allowed" | "custom";
      allowedDomainsCount: number;
      deniedDomainsCount: number;
      blockPrivateNetworks: boolean;
    };
    brokeredProviders?: string[];
  } | null;
};
```

Audit sink v1 can be local file-backed under Happy home:

```txt
~/.happy/server-data/egress-audit/<session-id>.jsonl
```

Each line:

```ts
type EgressAuditEvent = {
  sessionId: string;
  timestamp: number;
  protocol: "http" | "https-connect" | "provider";
  destinationHost: string;
  destinationPort: number;
  decision: "allow" | "deny";
  reason?: string;
  provider?: string;
  route?: string;
};
```

Do not log:

- request bodies
- Authorization headers
- cookies
- raw provider credentials
- proxy tokens
- full URLs with query strings until reviewed for secrets

## Feature Flags

Use feature flags so rollout can be staged.

Suggested env/settings flags:

- `HAPPY_EGRESS_PROXY=1`
- `HAPPY_EGRESS_PROXY_AUDIT=1`
- `HAPPY_CREDENTIAL_BROKER=1`
- provider-specific flags later, for example `HAPPY_BROKER_ANTHROPIC=1`

Prefer settings flags once the feature is user-facing.

## Implementation Plan

### Phase 0: Design spike

- [ ] Confirm `@anthropic-ai/sandbox-runtime` network capabilities:
  - Can it allow only loopback to one proxy port?
  - Can it deny all other external network?
  - How do `allowLocalBinding`, `allowUnixSockets`, allowed domains, and denied domains interact?
- [ ] Identify which Happy launch paths should use egress in v1:
  - Claude local
  - Claude SDK/remote
  - Codex app-server
  - ACP
- [ ] Decide if terminal-started sandbox sessions should get proxy v1.
- [ ] Write final `SessionNetworkPolicy` and `EgressAuditEvent` types.

Acceptance:

- A short implementation note is added to this plan with sandbox runtime findings.
- A minimal provider compatibility matrix is filled in.

### Phase 1: Network proxy skeleton

- [ ] Add `packages/happy-cli/src/egress/policy.ts`.
- [ ] Add `packages/happy-cli/src/egress/audit.ts`.
- [ ] Add `packages/happy-cli/src/egress/auth.ts`.
- [ ] Add `packages/happy-cli/src/egress/proxy.ts`.
- [ ] Implement local HTTP proxy listener on `127.0.0.1:0`.
- [ ] Implement `CONNECT host:port` handling.
- [ ] Implement basic HTTP absolute-URL proxy handling.
- [ ] Require proxy auth token.
- [ ] Emit allow/deny audit events.
- [ ] Add lifecycle `stop()`.

Tests:

- [ ] Starts on loopback random port.
- [ ] Rejects missing or wrong token.
- [ ] Allows authenticated request to allowed host.
- [ ] Denies authenticated request to denied host.
- [ ] Emits audit event for allow and deny.
- [ ] `stop()` closes listener.

### Phase 2: Policy enforcement

- [ ] Implement domain matching with wildcard support consistent with `sandbox/config.ts`.
- [ ] Normalize hostnames.
- [ ] Block private IP ranges and metadata endpoints.
- [ ] Block IP literals by default, unless policy explicitly allows them.
- [ ] Resolve DNS and check all returned addresses for private/link-local classification.
- [ ] Add redirect behavior decision. Recommended: proxy does not follow redirects.

Tests:

- [ ] exact domain allow/deny
- [ ] wildcard domain allow/deny
- [ ] case-insensitive domains
- [ ] trailing dot normalization
- [ ] IPv4 literal denied
- [ ] IPv6 literal denied
- [ ] `169.254.169.254` denied
- [ ] RFC1918 denied
- [ ] `localhost` denied when `allowLocalBinding=false`

### Phase 3: Session integration

- [ ] Add `startSessionEgressProxy()` helper that takes:
  - `SandboxConfig`
  - session id
  - machine id
  - optional backend flavor
- [ ] Inject proxy env into sandboxed process env.
- [ ] Ensure proxy token is treated as sensitive:
  - not logged
  - not persisted except where required for local child process
  - never included in session metadata
- [ ] Store egress runtime handle for cleanup.
- [ ] Stop proxy on session exit, daemon stop, and spawn failure.
- [ ] Add metadata summary via `createSessionMetadata`.

Tests:

- [ ] launcher passes proxy env only when egress is enabled
- [ ] cleanup stops proxy
- [ ] metadata includes policy summary, not token
- [ ] sandbox env filter permits proxy env keys required for operation

### Phase 4: Direct-egress blocking

- [ ] Modify sandbox runtime config to allow agent access to egress proxy while denying direct external network, if runtime supports this.
- [ ] If runtime cannot express this, document limitation and gate enforcement claims.
- [ ] Add integration tests with real subprocess commands where possible.

Adversarial tests:

```txt
inside sandbox:
+- curl https://allowed.example through proxy -> allowed
+- curl https://denied.example through proxy -> denied
+- curl https://example.com direct with proxy env unset -> denied
+- curl http://169.254.169.254 through proxy -> denied
+- curl http://192.168.1.1 through proxy -> denied
```

Acceptance:

- Network-only proxy is a real enforcement point for supported platforms.
- If platform support differs, tests document platform-specific behavior.

### Phase 5: Audit visibility

- [ ] Add local audit JSONL sink.
- [ ] Add local command or doctor output to inspect recent egress decisions.
- [ ] Optionally add daemon control endpoint for current proxy status.
- [ ] Do not upload audit logs to Happy server until product/privacy review.

Tests:

- [ ] audit file does not include headers or query strings
- [ ] denied private network event records reason
- [ ] proxy status does not include token

### Phase 6: Credential broker design spike

- [ ] Select first provider/backend.
- [ ] Confirm base URL support.
- [ ] Confirm whether SDK/CLI can run without raw API key if base URL points at Happy.
- [ ] Confirm streaming behavior.
- [ ] Identify current credential source:
  - Happy cloud vendor token
  - local provider config
  - user env var
  - OAuth refresh token
- [ ] Define credential reference type for that provider.

Acceptance:

- One provider is selected for v1 broker.
- A compatibility note is added to this plan or a provider-specific plan.
- There is a clear fallback for unsupported users.

### Phase 7: Provider gateway v1

- [ ] Add `packages/happy-cli/src/egress/providers/types.ts`.
- [ ] Add first provider gateway implementation.
- [ ] Add route validation:
  - allowed endpoints only
  - allowed methods only
  - allowed model list if available
  - request size limit
- [ ] Inject upstream auth from Happy-controlled credential source.
- [ ] Stream response without buffering full body.
- [ ] Strip hop-by-hop headers and any client-supplied Authorization to upstream.

Tests:

- [ ] agent request without raw provider key succeeds through broker
- [ ] upstream receives injected Authorization
- [ ] client-supplied Authorization is ignored/stripped
- [ ] disallowed endpoint denied
- [ ] disallowed model denied, if model can be parsed safely
- [ ] streaming response passes through
- [ ] audit event records provider route and decision, not credential

### Phase 8: Remove raw credentials for brokered provider

- [ ] Update sandbox env builder/launcher for provider:
  - remove raw provider credential env
  - remove provider auth file from isolated state copy, if brokered mode is active
  - inject provider base URL pointed at Happy proxy
- [ ] Preserve non-broker fallback.
- [ ] Ensure resume/fork flows keep broker policy consistent.

Tests:

- [ ] brokered session env does not include raw provider API key
- [ ] brokered sandbox provider state does not include raw credential file
- [ ] provider request still succeeds through proxy
- [ ] direct external provider request fails when direct egress blocked
- [ ] resume session reuses broker without exposing credential

## Test Strategy

Unit tests:

- policy matching
- private network classification
- proxy auth
- audit redaction
- provider route validation
- env injection/redaction

Integration tests:

- local proxy with real HTTP server
- CONNECT tunnel to local TLS test server
- sandboxed subprocess egress behavior
- provider gateway with mocked upstream streaming server

Regression/adversarial tests:

- unset proxy env and attempt direct egress
- malformed proxy auth
- oversized CONNECT host
- control characters in host
- IP literal bypass
- DNS result resolves to private IP
- wildcard allow conflicting with deny
- redirect to private IP
- client-supplied Authorization header in brokered request

Suggested commands:

```sh
pnpm --filter happy exec vitest run --project unit src/egress
pnpm --filter happy exec vitest run --project unit src/sandbox src/daemon src/api
pnpm --filter happy exec tsc --noEmit
git diff --check
```

## Rollout Plan

1. Hidden feature flag, unit tests only.
2. Local integration test command or developer-only mode.
3. Enable network-only proxy for sandboxed daemon sessions behind opt-in flag.
4. Collect local audit feedback from development usage.
5. Add direct-egress blocking where runtime supports it.
6. Ship network-only proxy as sandbox hardening.
7. Add one provider broker behind provider-specific opt-in flag.
8. Expand provider support only after compatibility and streaming tests are stable.

## Rollback Plan

- Keep proxy behind a feature flag until stable.
- If proxy startup fails, fail closed for sandboxed sessions when enforcement mode is enabled.
- In early audit-only mode, fail open only if explicitly configured.
- Credential broker must have fallback to existing isolated provider state path.
- Session metadata should record whether proxy/broker was active so debugging is possible.

## Open Questions

- Can sandbox runtime allow only loopback to a specific proxy port?
- Which backend/provider is easiest for the first broker?
- Should terminal-started sandbox sessions use egress proxy by default?
- Should proxy audit be local-only forever, or optionally synced to Happy server?
- How should users approve new network domains from mobile?
- Should MCP servers get separate proxy tokens and policies from the main agent?
- Should provider gateways parse bodies for model allowlists, or only enforce endpoint-level rules in v1?

## Recommended First PR

Keep the first PR narrow:

- Add `egress/policy.ts`, `egress/auth.ts`, and `egress/audit.ts`.
- Add no process launch integration yet.
- Unit test policy matching, token validation, audit redaction, private IP classification.
- Add a short note to this plan with sandbox runtime findings.

Recommended second PR:

- Add `egress/proxy.ts` network-only proxy.
- Unit test HTTP and CONNECT handling with local test servers.

Recommended third PR:

- Wire proxy into one sandboxed launch path behind a feature flag.
- Add cleanup and metadata summary.

Credential brokering should not start until the network-only proxy has working lifecycle, audit, and direct-egress tests.
