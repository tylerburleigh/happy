# Happy Egress Proxy and Credential Broker Plan

## Status

Proposed. No implementation work has started.

This plan is intended to be detailed enough for a future engineer or agent to pick up without needing the original design conversation.

## Objective

Add a Happy-managed egress and credential-boundary layer for sandboxed sessions.

V1 should use the strongest available enforcement layer per backend and platform:

1. **Native/runtime egress controls first:** use Claude Code, Codex, a future backend's own sandbox/network controls, or Happy's existing sandbox runtime controls when they can express Happy policy and pass Happy's conformance suite.
2. **Pipelock or Happy proxy fallback:** use Pipelock or a Happy-managed HTTP/CONNECT proxy only where native/runtime controls are missing, insufficient, or fail conformance.
3. **Brokered actions before provider HTTP injection:** for credentialed tools such as GitHub, git, BigQuery, search, Slack, and Linear, prefer Happy CLI brokers or out-of-agent MCP/action brokers before provider HTTP credential injection.
4. **Provider HTTP gateways only where compatible:** use a provider gateway only for clients that support base URL/fake-token mode or an equivalent local gateway configuration.

Keep three claims separate:

- **Egress audit:** Happy can record attempted destinations.
- **Egress enforcement:** direct bypasses fail.
- **Credential non-exposure:** raw credentials are absent from sandbox env, sandbox-readable files, logs, metadata, and model-visible context.

## Summary

Happy already owns the session metadata, sandbox config, provider auth flows, daemon control plane, local launchers, and sandbox launch env. Happy should therefore own the egress policy model, conformance tests, metadata claims, and fallback orchestration even when the concrete enforcement layer is backend-native or an adopted tool.

V1 ownership decision: egress orchestration is owned by the Happy CLI child process that initializes the sandbox for the agent backend. The parent daemon still spawns and tracks sessions, but it should not host proxy/Pipelock lifecycle in v1. This matches the current architecture, where daemon-spawned, tmux-spawned, resumed, forked, and terminal-started sessions all eventually run the same Happy CLI agent process that resolves sandbox settings and initializes sandboxing.

If a Happy proxy or Pipelock fallback is active, the local listener runs in the Happy CLI process outside the sandboxed command context. The agent/backend child is the process constrained by the sandbox runtime.

V1 backend scope:

- In scope: Claude Code and Codex.
- Out of scope: ACP, Gemini, and OpenClaw. They should remain explicit unsupported/compatibility paths until a later backend-specific conformance pass.

Layer taxonomy:

- **backend-native:** controls provided and owned by the backend/client itself, such as Claude Code native sandbox settings.
- **happy-sandbox-runtime:** controls compiled by Happy into `@anthropic-ai/sandbox-runtime`, including the runtime's own host-side network mediation.
- **pipelock:** Pipelock owned by the Happy CLI child process for the session.
- **happy-proxy:** a Happy-native HTTP/CONNECT proxy fallback owned by the Happy CLI child process for the session.

Do not collapse these layers in metadata or user-facing claims. They have different audit visibility, platform behavior, failure modes, and support contracts.

```txt
Session start
|
+- Happy CLI agent process reads settings.sandboxConfig
+- Happy CLI agent process resolves SessionNetworkPolicy
+- if proxy/Pipelock fallback is active, Happy CLI agent process starts listener on 127.0.0.1:<randomPort>
+- if proxy/Pipelock fallback is active, launcher injects proxy env into the sandboxed agent/backend child
+- sandbox allows agent -> fallback listener port, where runtime support allows
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
+- provider API key env/config contains only a Happy broker capability token
+- no raw ANTHROPIC_API_KEY in env
+- POST /providers/anthropic/v1/messages
   |
   +- Happy provider gateway
      +- authenticates per-session provider broker capability token
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
- Out-of-scope v1 backend launch paths: ACP (`packages/happy-cli/src/agent/acp/runAcp.ts`, `packages/happy-cli/src/agent/acp/AcpBackend.ts`), Gemini (`packages/happy-cli/src/gemini/runGemini.ts`), and OpenClaw (`packages/happy-cli/src/openclaw/runOpenClaw.ts`)

The sandbox hardening work already moved Happy toward:

- managed sandbox home/temp dirs
- filtered sandbox env
- isolated provider state
- daemon control token auth
- stricter spawn/env validation
- denial of shared sensitive Happy state inside sandboxed sessions

The egress and credential-boundary layer should build on that, not replace it.

## Security Goals

### Network egress goals

- Centralize outbound network policy enforcement for sandboxed sessions.
- Make egress auditable per session.
- Block access to private networks, link-local ranges, cloud metadata IPs, and loopback services unless explicitly allowed.
- Support runtime kill switch by tightening the enforcement layer or terminating the session when the layer is child-owned.
- Reduce reliance on provider-specific agent behavior for network restrictions.

### Credential boundary goals

- Prevent supported sandboxed agents from reading raw long-lived provider credentials.
- Keep provider and tool credentials in Happy-controlled storage and broker/proxy memory.
- Allow agents to perform credentialed actions only through constrained brokers, MCP/tool gateways, or provider gateways.
- Enforce action, endpoint, model, argument, and rate policy before using credentials.
- Preserve streaming behavior for chat/completions APIs.

## Non-Goals

- Do not implement TLS MITM as the default design.
- Do not install a local root CA.
- Do not try to broker every provider or CLI in the first version.
- Do not include ACP, Gemini, or OpenClaw in v1 egress enforcement or credential-boundary claims.
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
+- arbitrary localhost services if the sandbox cannot restrict loopback by port
```

Credential broker:

```txt
Protects raw credential material if all are true:
+- raw credential not in env
+- raw credential not in sandbox-readable provider files
+- raw credential not copied into isolated provider state
+- provider traffic must use Happy provider gateway/base URL
+- direct external egress is blocked
+- provider gateway has no endpoint that returns credentials

Still allows:
+- agent can indirectly use credentials for permitted provider actions
+- proxy can deny/limit/audit those actions
+- agent can read and replay its short-lived Happy broker capability token within the same session/provider scope
```

Broker capability tokens are not upstream provider credentials. They are session-scoped bearer capabilities that let the agent call Happy's local provider gateway. Treat them as sensitive for logs and metadata, but do not claim they are secret from the agent.

## V1 Acceptance Gates

Happy may claim **egress enforcement** for a backend/platform only when all are true:

- Direct external egress fails when the approved egress path is bypassed.
- Raw TCP direct egress fails for representative public hosts and ports.
- Unregistered loopback access fails, or the backend/platform is explicitly labeled with weaker local-service isolation.
- Private, link-local, multicast, and metadata targets fail through the approved egress path.
- The active backend/platform has a passing conformance result for the selected enforcement layer: backend-native, happy-sandbox-runtime, Pipelock, or Happy proxy.
- Session metadata records the actual enforcement layer and known risk flags, including weaker network isolation.
- Sandbox fallback is disabled for enforced sessions. If `allowSandboxFallback` causes a session to continue without the selected enforcement layer, Happy must fail closed or downgrade the session to audit-only/no-enforcement with explicit metadata.

Happy may claim **egress audit** only for traffic that passes through an audited enforcement layer. If direct egress remains possible, audit coverage must be labeled partial.

Happy may claim **credential non-exposure** only when all are true for the credential class being discussed:

- The raw credential is not in sandbox env after final launch-env scrubbing.
- The raw credential is not in sandbox-readable provider/tool state.
- The raw credential is not written to logs, metadata, audit files, command output, prompts, or model-visible context.
- Credentialed actions occur in a broker/tool process outside the sandbox, or through a provider gateway that injects upstream credentials after local policy validation.
- The agent can still use permitted credentialed actions, so the claim is "raw credential non-exposure," not "misuse impossible."

## V1 Capability Matrix

Keep this table updated as spikes and conformance tests land.

| Backend | V1 scope | Egress layer | Direct egress blocked | Loopback restricted | Credential boundary | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Claude Code | in scope | backend-native or happy-sandbox-runtime first; Pipelock/Happy proxy fallback if needed | TBD | TBD | stored-only or brokered-tool TBD | spike |
| Codex | in scope | backend-native or happy-sandbox-runtime if available; Pipelock/Happy proxy fallback if needed | TBD | TBD | stored-only or brokered-tool TBD | spike |
| Gemini | out of scope | none | no claim | no claim | no claim | defer |
| ACP | out of scope | none | no claim | no claim | no claim | defer |
| OpenClaw | out of scope | none | no claim | no claim | no claim | defer |

## Proposed Modules

Add a new egress package area under `packages/happy-cli/src/egress/`.

Unconditional v1 primitives:

```txt
packages/happy-cli/src/egress/
|
+- policy.ts
|  +- SessionNetworkPolicy
|  +- resolveSessionNetworkPolicy()
|  +- isDestinationAllowed()
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
+- backendAdapters/
|  |
|  +- types.ts
|  |  +- BackendEgressAdapter
|  |  +- BackendEgressConformanceResult
|  |
|  +- claude.ts
|  +- codex.ts
|
+- routing.ts
|  +- local service registration
|  +- NO_PROXY composition helpers
```

Conditional proxy/Pipelock fallback modules. Do not add these until backend-native and Happy sandbox runtime controls are unavailable, insufficient, or fail conformance and the Pipelock spike does not satisfy v1 requirements.

```txt
packages/happy-cli/src/egress/
|
+- proxy.ts
|  +- HappyEgressProxy
|  +- startHappyEgressProxy()
|  +- stop()
|
+- httpProxy.ts
|  +- HTTP request proxy handling
|  +- CONNECT handling
```

Provider gateway modules. Do not add these until a provider compatibility spike proves base URL/fake-token support and brokered provider state can avoid raw credential copies.

```txt
packages/happy-cli/src/egress/
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

Keep initial policy, audit, and conformance primitives generic. Add provider gateways only after network enforcement and the selected credential boundary are proven for the target backend/provider.

## Core Types

Initial proposed type shapes:

```ts
export type SessionNetworkMode = "blocked" | "allowed" | "custom";
export type SessionEgressLayer = "backend-native" | "happy-sandbox-runtime" | "pipelock" | "happy-proxy" | "disabled";

export type SessionNetworkPolicy = {
  sessionId: string;
  machineId?: string;
  owner: "agent-process";
  backend: "claude" | "codex";
  egressLayer: SessionEgressLayer;
  networkMode: SessionNetworkMode;
  allowedDomains: string[];
  deniedDomains: string[];
  allowLocalBinding: boolean;
  blockPrivateNetworks: boolean;
  blockIpLiterals: boolean;
  allowProxyLoopbackOnly: boolean;
  allowedLocalDestinations: Array<{
    host: "127.0.0.1" | "::1" | "localhost";
    port: number;
    purpose: "egress-proxy" | "provider-gateway" | "mcp" | "happy-hook";
  }>;
  limits?: {
    maxConcurrentConnections?: number;
    maxRequestsPerMinute?: number;
    maxBytesPerMinute?: number;
    maxRequestBytes?: number;
  };
  createdAt: number;
};

export type EgressDecision =
  | { type: "allow" }
  | { type: "deny"; reason: string };

export type EgressAuditEvent = {
  schemaVersion: 1;
  sessionId: string;
  timestamp: number;
  protocol: "http" | "https-connect" | "provider";
  destinationHost: string;
  destinationPort: number;
  decision: EgressDecision["type"];
  reason?: string;
  resolvedAddresses?: string[];
  bytesIn?: number;
  bytesOut?: number;
  provider?: string;
  route?: string;
};

export type EgressProxyRuntime = {
  port: number;
  token: string;
  owner: "agent-process";
  auditId: string;
  allowedLocalDestinations: SessionNetworkPolicy["allowedLocalDestinations"];
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

export type ProviderBrokerCapability = {
  provider: string;
  token: string;
  sessionId: string;
  expiresAt: number;
};

export type ProviderGatewayRequestContext = {
  sessionId: string;
  provider: string;
  credentialRef: ProviderCredentialRef;
  brokerCapability: ProviderBrokerCapability;
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
runClaude/runCodex
|
+- read settings.sandboxConfig
+- createSandboxAgentState(), when sandbox enabled
+- start session
   |
   +- Happy CLI agent process
      |
      +- resolve SessionNetworkPolicy from SandboxConfig
      +- select enforcement layer from backend conformance and flags
      |  +- backend-native, when supported and passing
      |  +- happy-sandbox-runtime, when Happy's initialized sandbox runtime is the selected passing layer
      |  +- Pipelock fallback, when selected and passing
      |  +- Happy proxy fallback, only if native/Pipelock fail or are unavailable
      |
      +- if proxy/Pipelock fallback is active:
      |  +- start listener on 127.0.0.1:<port>
      |  +- build egress env
      |     +- HTTP_PROXY=http://127.0.0.1:<port>
      |     +- HTTPS_PROXY=http://127.0.0.1:<port>
      |     +- lowercase variants if required
      |     +- NO_PROXY from local service composition rules
      |     +- HAPPY_EGRESS_TOKEN=<token>, only for Happy proxy
      |
      +- buildSandboxedProcessEnv(parentEnv, explicitEnv + sandboxAgentStateEnv + egressEnv)
      +- apply final sandbox launch env scrubber
      +- initializeSandbox(..., egress options)
      +- spawn agent
```

Questions to resolve during implementation:

- Can the egress helper be shared by Claude and Codex launchers without duplicating lifecycle code?
- Should non-sandboxed sessions get proxy audit only? Initial answer should be no, unless explicitly configured.

Recommended first integration:

- Start egress enforcement only for sandbox-enabled Claude/Codex sessions.
- Use backend-native or Happy sandbox runtime controls first when conformance passes.
- Start Pipelock/Happy proxy only when fallback enforcement is selected.
- Start fallback listeners inside the Happy CLI agent process, close to the code that already creates isolated provider state and initializes the sandbox.
- Terminal-started sandbox sessions should get the same behavior when the feature flag is enabled, because they use the same agent process paths.
- Store fallback runtime handles on the backend/launcher instance, not only on daemon `TrackedSession`. The daemon may record metadata and audit ids, but v1 cleanup should not depend on the parent daemon being alive.
- If the Happy CLI child exits normally, stop fallback listeners in `finally` cleanup. If it crashes, the OS closes in-process listeners.
- If enforcement is enabled, `allowSandboxFallback=true` must not silently continue without enforcement. Either fail closed or continue only in an explicit audit-only/no-enforcement mode with downgraded metadata.

### Runtime owner contract

V1 should use a single owner model:

```txt
parent daemon
|
+- spawns happy claude/codex child
   |
   +- child reads settings and creates session metadata
   +- child selects egress enforcement layer
   +- child starts fallback listener outside sandboxed command context, if needed
   +- child initializes sandbox
   +- child spawns or invokes agent backend inside sandbox
   +- child stops fallback listener during backend cleanup
```

Implications:

- Regular daemon spawn, tmux spawn, resume, and fork flows inherit Claude/Codex egress behavior by running the same Happy CLI child.
- Externally started terminal sessions can participate without needing a parent daemon proxy.
- The daemon should not assume it can stop an in-child fallback listener directly. It can stop the child process; child cleanup handles graceful shutdown, and process exit handles crash cleanup.
- If a future version moves proxy/Pipelock hosting into the parent daemon, that should be a separate migration with a daemon-child proxy contract, child reconnect behavior, and stale runtime cleanup.

### Session cleanup flow

```txt
session exits / daemon stop / interrupt cleanup
|
+- stop agent child process
+- stop Pipelock/HappyEgressProxy fallback runtime, if active
+- SandboxManager.reset()
+- flush audit sink
+- persist final audit summary in metadata or daemon state
```

For child-owned v1, the cleanup flow lives in each in-scope backend launcher. The parent daemon's `stopSession` and shutdown paths only need to terminate the Happy CLI child; they do not need direct access to fallback runtime objects.

## Sandbox Integration

Any egress enforcement layer is only a strong enforcement point if direct bypasses fail. For proxy/Pipelock fallback, that means direct external egress must be blocked and the agent must be able to reach only the approved local listener and registered local services.

Target end-state:

```txt
sandbox network config
|
+- allow outbound to 127.0.0.1:<egressProxyPort>
+- allow outbound to explicitly registered local Happy/MCP ports, if needed
+- deny external outbound from agent process
+- proxy process runs outside that sandbox or in a separate broker context
```

Implementation depends on what `@anthropic-ai/sandbox-runtime` can express:

- If it can allow loopback binding/connection to specific ports, use that.
- If it can only allow/deny domains broadly, proxy still provides audit but not complete enforcement.
- If needed, run the proxy outside the sandbox and set network mode to blocked for the agent, with explicit local proxy exception.
- If Happy uses `@anthropic-ai/sandbox-runtime` itself as the selected layer, record `happy-sandbox-runtime` rather than `backend-native`. Its host-side proxy behavior, supported platforms, risk flags, and audit visibility must be validated separately from backend-owned sandbox settings.

Add an implementation note after exploring sandbox runtime capabilities.

### Local service access model

The egress proxy is itself a loopback service, but Happy also uses local services for hooks, MCP servers, app-server transports, and development workflows. V1 needs an explicit local service model instead of treating all loopback access as equivalent.

Rules:

- `NO_PROXY` is client routing only. It must not be treated as a security boundary.
- `NO_PROXY` composition must happen after Happy knows which local services are intentionally exposed to the sandboxed process.
- `NO_PROXY` entries should be generated from the registered local service model, not copied blindly from parent env.
- Do not use a blanket loopback bypass such as `127.0.0.1,localhost,::1` in enforcement mode unless the sandbox/runtime independently restricts loopback to registered ports. Existing compatibility helpers that append all loopback hosts are acceptable only for non-enforced or explicitly downgraded paths.
- The sandbox policy should allow loopback access only to registered Happy ports: egress proxy, provider gateway, hook server, and MCP servers that Happy intentionally exposes to the agent.
- If the sandbox runtime cannot restrict loopback by port, document that arbitrary localhost services may be reachable and downgrade the enforcement claim.
- MCP servers should be classified as either in-sandbox subprocesses or out-of-sandbox local services. Out-of-sandbox MCP servers should have separate local access entries and, later, separate proxy tokens/policies.
- The egress proxy must continue to deny proxy requests to `localhost`, `127.0.0.0/8`, `::1`, private networks, and metadata IPs unless a destination is explicitly represented as a local Happy service entry.

Tests should include:

- egress proxy/Pipelock fallback plus local MCP in the same session
- egress proxy/Pipelock fallback plus provider gateway in the same session
- both uppercase and lowercase proxy env variants
- a local HTTP server on an unregistered loopback port, verifying the sandboxed agent cannot reach it when runtime support exists

## Proxy Protocol Details

### HTTP proxy support

Support standard proxy env vars:

- `HTTP_PROXY`
- `HTTPS_PROXY`
- lowercase variants if required by existing clients
- `NO_PROXY` generated from registered local services. In enforcement mode, do not use blanket loopback bypass unless loopback is independently restricted by the sandbox/runtime.

Do not set `ALL_PROXY` in v1 unless the implementation supports and tests the protocol expectations of clients that read it. Many clients treat `ALL_PROXY` as SOCKS-capable or apply it to non-HTTP protocols, while the first proxy is an HTTP/HTTPS CONNECT proxy.

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
- Treat the HTTP proxy token as a cross-session/local-client guard, not as a secret from the agent. The agent receives it in env and can reuse it for destinations allowed by its session policy.
- Provider gateway requests should use separate provider broker capability tokens, because base URL SDK calls usually are not standard proxy requests and may never send `Proxy-Authorization`.

### Provider gateway authentication

Base URL provider traffic is ordinary HTTP to `http://127.0.0.1:<port>/providers/<provider>`, not a standard proxy request. The provider gateway therefore needs its own auth model.

Recommended v1:

- Generate a short-lived random broker capability token per session/provider.
- If the provider client requires an API key env/config value, inject the broker capability token in that field, for example `ANTHROPIC_AUTH_TOKEN=happy-broker-...` or `OPENAI_API_KEY=happy-broker-...`.
- If the provider client supports a custom auth header separate from provider auth, prefer that. Do not require this for v1.
- The provider gateway accepts only the expected broker capability token for the session/provider, strips it from the upstream request, and injects the real upstream provider credential.
- The broker capability token expires when the proxy stops and is never written to session metadata, audit logs, or provider state files.
- A wrong or missing broker token must fail closed with a provider audit event.

Compatibility consequence:

- Provider brokering is feasible only when the SDK/CLI can be pointed at the local base URL and can be satisfied with a fake/local API key or custom local auth.
- If a client insists on official provider hostnames, validates provider key format against the real provider, or bypasses base URL settings, it must stay on isolated provider state fallback.

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

DNS handling:

- Resolve hostnames before connecting.
- Validate every returned address against private/link-local/metadata rules.
- Connect to one of the already validated addresses, not by passing the original hostname to a socket API that may resolve again.
- Preserve the original hostname for CONNECT target semantics and audit, but tie the actual outbound socket to the validated address.
- Re-check DNS on each new connection. Do not cache allow decisions across sessions.

Add adversarial tests for DNS rebinding, CNAME chains to private addresses, IPv6-mapped IPv4 addresses, bracketed IPv6 literals, and hostnames with mixed case/trailing dot normalization.

### Upstream proxy and CA behavior

Happy users may already run behind a corporate or local proxy. When Happy injects `HTTP_PROXY` and `HTTPS_PROXY` into the agent, the Happy egress proxy becomes the agent's immediate proxy and must decide how to reach upstream destinations.

V1 requirements:

- Capture parent `HTTP_PROXY`, `HTTPS_PROXY`, lowercase variants, and `NO_PROXY` before injecting Happy proxy env into the agent.
- The Happy proxy may use those captured upstream proxy settings for its own outbound connections, but must avoid loops to itself.
- Preserve existing CA-related env such as `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, and `CURL_CA_BUNDLE` where the current sandbox env policy already permits them.
- Add tests for "agent uses Happy proxy, Happy proxy uses upstream corporate proxy" and "Happy proxy does not recursively call itself."

Private-network enforcement caveat:

- If Happy connects directly to a validated resolved address, Happy can enforce "resolve, classify, then connect" itself.
- If Happy sends a `CONNECT` request through an upstream corporate proxy, the upstream proxy may perform its own DNS resolution. In that mode, Happy cannot fully guarantee that upstream DNS will not resolve to a private/link-local/metadata address unless the upstream proxy provides an enforceable policy contract.
- Strict private-address enforcement should therefore either reject upstream proxy use, require an upstream proxy policy that blocks private/link-local/metadata targets, or mark private-address enforcement as weaker/partial in metadata.

## Credential Broker Design

### Provider base URL mode

For providers whose clients support custom base URLs:

```txt
agent env
|
+- ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/providers/anthropic
+- ANTHROPIC_AUTH_TOKEN=happy-broker-<opaque-session-provider-token>
+- no raw upstream ANTHROPIC_API_KEY or OAuth refresh token
```

Proxy route:

```txt
/providers/anthropic/v1/messages
|
+- authenticate provider broker capability token
+- validate endpoint is allowed
+- validate model is allowed
+- load credentialRef for session/provider
+- strip any client-supplied upstream Authorization or API key header
+- inject Authorization or provider-specific auth
+- forward to https://api.anthropic.com/v1/messages
+- stream response back
```

### Broker-aware provider state

Current sandbox setup copies provider state into a managed per-session directory. Brokered provider mode must change that behavior before it can claim raw credential secrecy.

This must be decided before provider state is copied at session startup. A brokered or credential-non-exposure mode cannot first copy raw provider auth state and then clean it up later. The provider-state builder should be policy-aware from the start of the launch flow, and `agentHomeMode=shared` must be rejected for any session that wants a raw credential non-exposure claim.

For each brokered provider:

- Identify every local file that can contain upstream credentials, refresh tokens, session cookies, or provider account tokens.
- Add a brokered-state builder that copies only non-sensitive provider state required for the client to boot, or creates a minimal synthetic state directory.
- Deny-read the original shared provider state as today.
- Do not copy raw auth files into the isolated provider state for brokered sessions.
- If the provider client requires an auth file rather than env, write only the Happy broker capability token or non-secret base URL config, never the upstream provider credential.
- Keep the existing isolated-state fallback for unsupported clients and users.

Provider gateway work is not accepted until tests prove the sandboxed provider state does not contain the upstream provider credential material for the selected provider.

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

| Provider/backend | Supports base URL | Accepts fake/local key | Brokered state feasible | Streaming behavior | Broker feasible | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Claude SDK | TBD | TBD | TBD | streaming | TBD | inspect `claude/sdk/query.ts` |
| Claude Code CLI | TBD | TBD | TBD | CLI-managed | harder | may require isolated state fallback |
| Codex app-server | TBD | TBD | TBD | JSON-RPC child | TBD | inspect app-server config options |
| ACP agents | out of scope v1 | out of scope v1 | out of scope v1 | protocol-specific | no | revisit after Claude/Codex |
| Gemini | out of scope v1 | out of scope v1 | out of scope v1 | CLI-managed | no | revisit after Claude/Codex |
| OpenClaw | out of scope v1 | out of scope v1 | out of scope v1 | protocol-specific | no | revisit after Claude/Codex |

Do not remove the existing isolated provider state fallback until a provider has a passing broker compatibility suite.

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
    maxConcurrentConnections?: number;
    maxRequestsPerMinute?: number;
    maxBytesPerMinute?: number;
    maxRequestBytes?: number;
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

### Rate and volume limits

The security claims include rate/volume caps, so v1 must either implement minimal caps or avoid claiming them.

Recommended v1:

- Implement `maxConcurrentConnections` and `maxRequestBytes` first.
- Add counters for requests and bytes even if minute-window limits stay disabled behind an internal flag.
- Emit denied audit events with reasons such as `connection_limit_exceeded`, `request_too_large`, or `byte_limit_exceeded`.
- Do not expose user-facing settings for limits until behavior is stable.

## Metadata and Audit Integration

Session metadata should include a summary, not secrets:

```ts
type Metadata = {
  // existing fields...
  egress?: {
    enabled: boolean;
    layer: "backend-native" | "happy-sandbox-runtime" | "pipelock" | "happy-proxy" | "disabled";
    auditCoverage: "none" | "partial" | "proxy-only" | "full";
    auditSource?: "backend" | "happy-sandbox-runtime" | "pipelock" | "happy-proxy" | "provider-gateway";
    auditId?: string;
    policySummary: {
      networkMode: "blocked" | "allowed" | "custom";
      allowedDomainsCount: number;
      deniedDomainsCount: number;
      blockPrivateNetworks: boolean;
    };
    directEgressBlocked?: boolean;
    loopbackRestricted?: boolean;
    riskFlags?: string[];
    credentialBoundary?: "none" | "stored-only" | "brokered-tool" | "split-harness";
    providerStateBoundary?: "shared" | "isolated-copy" | "brokered-redacted" | "synthetic";
    brokeredProviders?: string[];
  } | null;
};
```

Enforcement coverage and audit coverage are separate. A backend-native or Happy sandbox runtime layer may enforce a network policy without producing Happy-local per-destination audit events. In that case, metadata should show enforcement as active but audit coverage as `none` or `partial` rather than implying full Happy-visible egress logs.

Audit sink v1 can be local file-backed under Happy home:

```txt
~/.happy/server-data/egress-audit/<session-id>.jsonl
```

Each line:

```ts
type EgressAuditEvent = {
  schemaVersion: 1;
  sessionId: string;
  timestamp: number;
  protocol: "http" | "https-connect" | "provider";
  destinationHost: string;
  destinationPort: number;
  decision: "allow" | "deny";
  reason?: string;
  bytesIn?: number;
  bytesOut?: number;
  provider?: string;
  route?: string;
};
```

Audit storage requirements:

- Create audit directories with mode `0700`.
- Create audit files with mode `0600`.
- Include `schemaVersion` on each event so future readers can migrate safely.
- Rotate or stop writing when a per-session audit file reaches a configured size cap.
- Add a retention policy before this becomes user-facing. A local-only development default can keep recent files, but should not grow unbounded.
- Never upload audit logs to Happy server until product/privacy review explicitly approves it.

Do not log:

- request bodies
- Authorization headers
- cookies
- raw provider credentials
- proxy tokens
- provider broker capability tokens
- full URLs with query strings until reviewed for secrets

## Feature Flags

Use feature flags so rollout can be staged.

Suggested env/settings flags:

- `HAPPY_EGRESS_PROXY=1`
- `HAPPY_EGRESS_MODE=native|pipelock|proxy|off`
- `HAPPY_EGRESS_PROXY_AUDIT=1`
- `HAPPY_CREDENTIAL_BROKER=1`
- provider-specific flags later, for example `HAPPY_BROKER_ANTHROPIC=1`

Prefer settings flags once the feature is user-facing.

## Build vs Adopt Review

Before implementing a Happy-native proxy from scratch, evaluate whether existing maintained tools can satisfy one or more layers of the design.

This is not a single-tool decision. Happy likely has three separable needs:

1. **Backend-native egress enforcement:** use Claude Code, Codex, or a future backend's own sandbox/network policy when it is strong, testable, and can express the Happy policy.
2. **Generic network egress enforcement:** destination allow/deny, CONNECT handling, DNS/private network checks, rate limits, audit, and direct-egress blocking integration when native/runtime controls are unavailable or insufficient.
3. **Credential brokering for HTTP APIs:** local/session-scoped placeholder credentials, upstream credential injection, provider route policy, and redaction.
4. **MCP/server governance and CLI/action brokering:** lifecycle, isolation, credential injection into tools, access control, and audit for credentialed actions.

The review should decide which tool, if any, owns each layer.

### Backend-native egress controls

Use each backend's native sandbox/network controls before adding another proxy layer, if they can be verified.

Claude Code example observed on 2026-06-03:

- `/Users/tylerburleigh/khan/assessments-research/.claude/settings.json` enables Claude sandboxing.
- It denies unsandboxed commands.
- It sets `sandbox.network.allowedDomains` for `localhost`, GitHub, PyPI, Python hosted files, and CRAN.
- It enables `allowLocalBinding`.
- It enables `enableWeakerNetworkIsolation`.
- It uses hooks to guard secret, cloud, dataset, and data-file access.

Claude Code's documented settings support:

- `sandbox.network.allowedDomains` and `sandbox.network.deniedDomains`.
- `sandbox.network.allowLocalBinding`.
- `sandbox.network.httpProxyPort` and `sandbox.network.socksProxyPort` for bring-your-own proxy mode.
- OS-level sandbox filesystem/network restrictions that apply to subprocess commands, not only Claude file tools.

Decision on 2026-06-03:

- Treat backend-native sandbox network controls and Happy sandbox runtime controls as the first enforcement candidates when they can pass conformance.
- Happy still owns the policy model, policy compilation, user-facing claims, and conformance tests.
- Do not require Pipelock or a Happy proxy for Claude Code sessions if Claude's native sandbox passes Happy's egress conformance suite for the configured policy.
- Surface risk flags such as Claude Code's `enableWeakerNetworkIsolation`, because Claude documents it as reducing security and opening a possible exfiltration path.
- Use Pipelock or a Happy proxy when native/runtime controls are missing, cannot express the policy, fail conformance, or when Happy needs cross-backend central audit/approval semantics that the selected layer cannot provide.

Domain policy guidance:

- If BigQuery MCP runs outside the sandbox as a brokered tool, the sandboxed agent should not need direct access to Google API hosts for that action. The broker/MCP server needs that access.
- If BigQuery MCP runs inside the sandbox, then the sandbox policy must explicitly allow the required Google endpoints, and the credential isolation claim is weaker.
- If web search is backend-native, use the backend's WebSearch/WebFetch permission/domain controls.
- If web search is Happy-brokered, the sandboxed agent should call Happy's broker and should not need the search provider API host or token.
- If web search is an arbitrary CLI/API tool inside the sandbox, then allowed domains must include the search provider hosts and the credential boundary is weaker unless the tool uses a separate broker.

Source links:

- https://code.claude.com/docs/en/configuration

### Envoy candidate

Use Envoy as the candidate for generic network proxy infrastructure.

Promising fit:

- Mature maintained proxy implementation.
- Dynamic forward proxy support for unknown outbound hosts.
- External authorization hooks for Happy policy decisions.
- RBAC, access logs, connection limits, and local/global rate limiting.
- Avoids hand-rolling HTTP proxy parsing, CONNECT handling, connection lifecycle, and many protocol edge cases.

Likely Happy-owned glue:

- Starting/stopping a per-session Envoy process.
- Generating per-session Envoy config.
- Happy policy service for ext_authz.
- Mapping Happy `SandboxConfig` to Envoy route/RBAC/policy.
- Session metadata and local audit format.
- Sandbox integration so direct egress is blocked and only the Envoy listener is reachable.

Questions for spike:

- Can Envoy dynamic forward proxy cleanly support the exact HTTP proxy behavior used by common agent clients?
- Can Happy enforce private/link-local/metadata destination denial with Envoy config/ext_authz without DNS time-of-check/time-of-use gaps?
- Can Envoy run acceptably as one per-session local child process on macOS/Linux?
- How much config complexity is needed for per-session policies and hot updates?
- Can logs be shaped to Happy's redaction and local-retention requirements?

Decision output:

- Use Envoy for v1 network proxy, use Envoy later, or reject with documented reasons.

Decision on 2026-06-03:

- Do not adopt Envoy as the default v1 local egress proxy.
- Keep Envoy as a future replacement/escalation path if Happy's native proxy grows beyond a small HTTP/CONNECT enforcement point.

Rationale:

- Envoy is the strongest mature proxy substrate reviewed. It has dynamic forward proxy, CONNECT support, ext_authz, RBAC, access logs, circuit breakers, and rate-limit primitives.
- It also adds a large binary/runtime dependency, per-session config generation, and likely an ext_authz/policy service.
- Envoy's own dynamic forward proxy documentation warns about confused deputy risks for localhost, link-local, metadata, and private network access. Happy would still need sandbox direct-egress blocking and careful destination policy.
- Happy needs exact control over DNS resolution, private-address classification, local audit redaction, and per-session lifecycle. A small Happy-native proxy can be simpler for v1 and easier to test end-to-end.

Source links:

- https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/http/http_proxy.html
- https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/dynamic_forward_proxy_filter
- https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/http/upgrades.html
- https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/ext_authz_filter

### OneCLI candidate

Use OneCLI as the candidate for HTTP API credential brokering.

Promising fit:

- Purpose-built for AI-agent credential gateway use cases.
- Stores real credentials outside the agent and lets the agent use placeholder credentials.
- Injects credentials at gateway time based on host/path matching.
- Supports scoped agent access tokens and an encrypted secret store.

Potential friction:

- It may rely on HTTPS MITM for transparent credential injection in cases where Happy's plan avoids installing a root CA or MITM by default.
- Happy needs tight session ownership, metadata, mobile approval, and sandbox lifecycle integration.
- Provider-specific behavior may still be required for Claude Code, Codex, Google APIs, and streaming model APIs.
- Operational footprint may be larger than a small in-process provider gateway.

Questions for spike:

- Can OneCLI be embedded or controlled as a local per-session/service process without cloud dependency?
- Can it support Happy's no-default-MITM policy by using base URL/provider gateway mode rather than transparent HTTPS interception?
- Can credentials be sourced from Happy-controlled auth state instead of OneCLI's own vault when needed?
- Can policy, audit, and redaction outputs be made compatible with Happy metadata and logs?
- Can it support the first target provider/backend without exposing raw credentials in env or provider state?

Decision output:

- Use OneCLI for credential brokering, reuse concepts/code selectively, or reject with documented reasons.

Decision on 2026-06-03:

- Do not adopt OneCLI as a built-in Happy credential broker for v1.
- Reuse the design pattern: placeholder credentials, gateway-side injection, host/path policy, scoped agent tokens, credential stubs.
- Consider an optional OneCLI integration later for users who explicitly want a full credential vault and are willing to run/trust its gateway.

Rationale:

- OneCLI is the closest match to the credential-broker concept. Its docs describe a Rust gateway, scoped agent tokens, encrypted secret store, host/path matching, rule enforcement, audit logs, and credential injection.
- Its transparent HTTPS mode relies on MITM interception and installing/trusting a gateway CA. Happy's plan explicitly avoids TLS MITM and root CA installation by default.
- OneCLI also brings a broader product surface: gateway, dashboard, database, encrypted vault, and possibly Docker-based deployment. That is too much to make a core dependency for Happy's first broker.
- Happy still needs provider-specific compatibility work for Claude Code, Codex, Google APIs, model streaming, and provider state redaction.

Source links:

- https://onecli.sh/docs/how-it-works
- https://onecli.sh/docs/guides/coding-agents
- https://onecli.sh/docs/integrations/anthropic
- https://onecli.sh/docs/guides/credential-stubs/general-app

### Docker MCP Gateway candidate

Use Docker MCP Gateway as the candidate for MCP server governance and credential isolation.

Promising fit:

- Central proxy between MCP clients and MCP servers.
- Manages MCP server lifecycle.
- Runs MCP servers in isolated Docker containers with restricted privileges, network access, and resource usage.
- Injects required credentials into MCP servers and provides logging/call tracing.
- Fits BigQuery MCP and similar tools better than raw HTTP credential brokering, because the MCP server can hold the provider credential while the agent only sees the MCP tool interface.

Potential friction:

- Requires Docker or Docker Desktop/Engine availability.
- Happy currently supports local sandboxing paths that may not assume Docker.
- Gateway-level policy may not match Happy's session/project/mobile approval model without adaptation.
- Need to understand how per-session credentials, profiles, and server lifecycle map to Happy sessions.
- Need to ensure MCP server containers cannot become a broad network escape hatch.

Questions for spike:

- Can Happy launch and manage Docker MCP Gateway per session or per machine without conflicting with user Docker state?
- Can Happy create per-session MCP profiles with least-privilege credentials and tool allowlists?
- Can BigQuery MCP run through this model without raw Google credentials entering the agent sandbox?
- Can Docker MCP Gateway expose audit data that Happy can store locally and summarize in metadata?
- What is the fallback when Docker is unavailable?

Decision output:

- Use Docker MCP Gateway for MCP servers, support it as an optional backend, or reject with documented reasons.

Decision on 2026-06-03:

- Adopt Docker MCP Gateway as the first optional candidate for MCP server governance and credential isolation.
- Do not make it mandatory for Happy sessions because it requires Docker/Docker Desktop or the `docker mcp` CLI plugin.
- Run a targeted spike with BigQuery MCP or a similarly credential-sensitive MCP server.

Rationale:

- Docker MCP Gateway directly matches the MCP layer: centralized proxy, server lifecycle management, container isolation, credential injection into MCP servers, tool filtering, logging/call tracing, and profiles.
- This fits BigQuery MCP better than raw HTTP credential brokering. The MCP server can hold Google credentials in a managed container/tool boundary while the sandboxed agent only sees the MCP tool interface.
- Docker's CLI docs expose relevant controls: `--block-network`, `--block-secrets`, `--log-calls`, `--tools`, `--profile`, resource limits, secrets sources, and signature verification.
- The main friction is availability and product dependency. Docker is installed in the current dev environment, but `docker mcp` is not currently available on PATH, so Happy needs a fallback path.

Source links:

- https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/
- https://docs.docker.com/reference/cli/docker/mcp/gateway/gateway_run/
- https://docs.docker.com/ai/mcp-catalog-and-toolkit/faqs/
- https://docs.docker.com/ai/mcp-catalog-and-toolkit/catalog/

### Envoy MCP filters note

Envoy also has MCP HTTP filter work that can parse MCP JSON-RPC metadata and feed RBAC/ext_authz policy. Do not use it for v1. The docs mark the MCP filter as actively under development, and Docker MCP Gateway is a better fit for immediate MCP server lifecycle and credential isolation.

Source link:

- https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/mcp_filter

### Additional tool search on 2026-06-03

A broader search found several credible projects beyond Envoy, OneCLI, and Docker MCP Gateway. This changes the plan from "build native egress immediately" to "run two short hands-on spikes before committing to native implementation details."

#### Pipelock candidate

Use Pipelock as the strongest additional candidate for agent egress firewall behavior.

Promising fit:

- Purpose-built AI agent firewall.
- Supports standard `HTTPS_PROXY` forward proxy mode.
- Supports MCP proxy wrapping.
- Includes SSRF/private-address/DNS rebinding protections, rate/data budgets, DLP scanning, prompt-injection response scanning, kill switch, and signed audit/evidence.
- Documents the same trust boundary Happy needs: the agent must not have direct network access outside the proxy.
- Provides local binary, Docker, and sandbox modes.

Potential friction:

- It is broader than Happy's immediate v1 egress goal. Much of its value is DLP/body scanning and response scanning, while Happy's no-MITM v1 proxy mostly needs host/port policy, audit, and direct-egress enforcement.
- Credential brokering is not the core model. Pipelock assumes the agent may still hold secrets and tries to detect/block exfiltration.
- Happy would need to map Pipelock policy/audit semantics to `SandboxConfig`, session metadata, mobile approvals, and existing Happy sandbox lifecycle.
- Optional TLS interception/full request body inspection would need to stay off by default to preserve Happy's no-default-MITM stance.

Decision on 2026-06-03:

- Add a Pipelock hands-on spike before implementing `egress/proxy.ts` for any backend where native network controls are unavailable, insufficient, or fail conformance.
- Do not adopt Pipelock as a core dependency yet.
- If the spike shows Pipelock can satisfy Happy's network-only proxy requirements with clean child-process lifecycle, no MITM, stable local audit, and direct-egress tests, prefer adopting it over a native HTTP proxy.
- If not, proceed with the Happy-native proxy and reuse Pipelock's threat model/test ideas.

Source links:

- https://pipelab.org/pipelock/
- https://github.com/luckyPipewrench/pipelock

#### ToolHive candidate

Use ToolHive as a second MCP-layer candidate alongside Docker MCP Gateway.

Promising fit:

- Open-source MCP platform with local Docker/Podman and Kubernetes runtime paths.
- Runs MCP servers in isolated containers.
- Includes encrypted secrets, network isolation, identity/access policy, audit/observability, registry, and desktop/CLI workflows.
- Active project with substantial repository activity.

Potential friction:

- Broader platform than Happy needs for v1.
- Requires container runtime assumptions and its own registry/runtime model.
- Needs a concrete test with BigQuery MCP or a similarly credential-sensitive MCP server to compare with Docker MCP Gateway.

Decision on 2026-06-03:

- Add ToolHive to the MCP gateway spike.
- Compare ToolHive and Docker MCP Gateway before choosing the optional MCP server governance path.
- Do not make either mandatory for Happy sessions.

Source links:

- https://toolhive.dev/
- https://github.com/stacklok/toolhive

#### Obot candidate

Obot is a credible open-source MCP platform with hosting, registry, gateway, OAuth, access control, audit, and enterprise management.

Decision on 2026-06-03:

- Do not adopt for core Happy v1.
- Treat as enterprise MCP control-plane prior art.
- Revisit only if Happy needs a broader self-hosted MCP platform rather than local per-session MCP isolation.

Source links:

- https://obot.ai/
- https://github.com/obot-platform/obot

#### agentgateway candidate

agentgateway is a Linux Foundation/Solo.io AI-native gateway for service, LLM, MCP, and A2A traffic. It supports MCP target policies, backend auth, LLM provider routing, policies, and observability.

Decision on 2026-06-03:

- Do not adopt for core local v1.
- Treat as a future candidate if Happy needs a general LLM/MCP gateway rather than a local sandbox egress component.
- It may be more relevant to hosted/team deployments than to per-session local sandbox enforcement.

Source links:

- https://agentgateway.dev/
- https://github.com/agentgateway/agentgateway
- https://agentgateway.dev/docs/standalone/latest/mcp/mcp-target-policies/

#### Authsome and KeyLore candidates

Authsome and KeyLore both target the credential-broker problem more directly than generic LLM gateways.

Promising fit:

- Authsome provides a local credential vault/proxy, OAuth/API-key flows, token refresh, provider definitions, and agent integrations.
- KeyLore provides a local-first credential broker and metadata catalog for AI coding tools and MCP clients, with policy, approvals, audit, secret adapters, and constrained proxy execution.

Potential friction:

- Both introduce a separate credential store/control plane that may conflict with Happy-owned auth flows and session metadata.
- Happy still needs provider-specific compatibility, sandbox provider-state redaction, and base URL/fake-token behavior for Claude Code/Codex/model APIs.
- Maturity and maintenance posture need hands-on validation before depending on either.

Decision on 2026-06-03:

- Do not adopt either as a core v1 dependency.
- Reuse their patterns: metadata-only credential discovery, brokered action execution, local credential vault, policy before secret access, audit, and OAuth/token lifecycle handling.
- Consider an optional credential-vault integration after the first Happy-native provider gateway proves the interface.

Source links:

- https://authsome.ai/
- https://github.com/agentrhq/authsome
- https://keylore.bestdev.co.il/
- https://github.com/Simonsbs/keylore

#### Non-proxy brokered action candidates and patterns

There is a stronger non-proxy pattern for credentialed work: keep credentials in a separate broker/tool process and expose only constrained actions to the agent. The agent never gets the raw upstream credential. It gets tool schemas, metadata, a local/session capability, and results.

This differs from a secret manager or short-lived token. A secret manager can reduce credential lifetime and improve audit, but if the token is injected into the agent process, the agent can still read and exfiltrate it. Brokered action execution moves the credentialed operation itself outside the agent process.

Promising fit:

- MCP/tool gateways such as Docker MCP Gateway and ToolHive can run credential-sensitive MCP servers outside the sandboxed agent and expose only selected tools.
- Hosted or self-hosted action platforms such as Jentic, Pipedream Connect, and Composio expose authenticated API actions through MCP/REST while handling OAuth, token refresh, storage, and execution outside the agent process.
- Local credential brokers such as KeyLore and Authsome point toward the same interface: AI-visible credential metadata plus brokered action execution, rather than process-wide `.env` secrets.
- Cloud-native delegation can narrow impact. Google Cloud service account impersonation issues short-lived access tokens, and BigQuery authorization can be constrained with IAM roles, row-level policies, column policies, views, and authorized routines.
- Workload identity systems such as SPIFFE/SPIRE can remove static bootstrap secrets for Happy-managed broker processes.

Potential friction:

- Brokered action execution prevents raw credential theft, but it does not prevent malicious or prompt-injected use of the credentialed action. Happy still needs per-action authorization, allowlists, approval points, rate limits, and audit.
- Coverage is uneven. Generic web/search/provider APIs may not have a good prebuilt tool server or OpenAPI/action definition.
- SaaS action platforms move the trust boundary to a third party. That may be unacceptable for local-first Happy sessions unless explicitly configured.
- Local MCP/action gateways need lifecycle management, tool version pinning, secret storage, logging, and fallback when Docker/Podman/desktop components are unavailable.
- Cloud downscoping is provider-specific. Google Credential Access Boundaries only apply to Cloud Storage, not BigQuery. For BigQuery, least privilege must come from BigQuery IAM, dataset/table permissions, row/column controls, views, authorized routines, and query/job policy.
- Workload identity and dynamic secrets are not sufficient if issued directly to the agent process. They are most useful as the broker's identity or as short-lived credentials consumed only by the broker.

Decision on 2026-06-03:

- Treat non-proxy brokered action execution as the preferred credential boundary whenever a task can be represented as tools/actions.
- For BigQuery MCP, prefer an out-of-agent MCP/tool boundary first: Docker MCP Gateway or ToolHive locally; hosted action platforms only if the user explicitly opts into that trust boundary.
- Keep the Happy provider gateway for model-provider APIs and clients where base URL/fake-token mode is the only practical integration.
- Keep the network egress proxy, or Pipelock if adopted, for destination enforcement and audit. Do not make it carry the whole credential isolation story.
- Add acceptance criteria that distinguish "agent cannot read raw credential" from "agent can still request credentialed action."

Source links:

- https://docs.docker.com/ai/mcp-catalog-and-toolkit/mcp-gateway/
- https://toolhive.dev/
- https://jentic.com/blog/managed-execution-for-ai-agents
- https://pipedream.com/docs/connect/mcp/developers
- https://docs.composio.dev/docs/how-composio-works
- https://docs.cloud.google.com/iam/docs/service-account-creds
- https://docs.cloud.google.com/bigquery/docs/access-control
- https://docs.cloud.google.com/bigquery/docs/authorized-routines
- https://spiffe.io/docs/latest/spire-about/spire-concepts/

#### Harness credential boundary

Harness credentials are different from ordinary tool credentials. They are the credentials used by the agent runtime itself to call a model provider or hosted agent service, for example Codex/OpenAI credentials, Claude Code/Anthropic credentials, and sometimes GitHub credentials used by the harness for clone/push/PR operations.

Current local pattern observed on 2026-06-03:

- `~/.zshrc` has a Keychain-backed `load_agent_secrets` helper and `with_agent_secrets` subshell wrapper.
- This is better than plaintext `.env` because secrets are not loaded by default.
- It is not a strong agent boundary. Once a wrapper exports a secret into the agent or tool process, anything running in that process boundary can potentially read it from env, process state, child process inheritance, debug logs, or generated commands.

Threat model distinction:

- **Secret storage** protects secrets at rest.
- **Short-lived/dynamic credentials** reduce lifetime and blast radius.
- **Process/env injection** still gives the process the credential.
- **Brokered action execution** keeps the credential out of the agent process.
- **Split harness architecture** keeps model-provider credentials out of the tool-running agent process.

Model harness credentials:

- A monolithic coding CLI that both holds its own provider credential and executes agent-requested shell/file/tool operations cannot provide a hard guarantee that the agent cannot access the harness credential. The credential may be in an environment variable, local auth file, OS keyring-accessible client, process memory, or CLI-managed token cache.
- Codex supports ChatGPT login, API key login, and access-token automation. Its docs say CLI credentials can be stored in `~/.codex/auth.json` or an OS credential store, and `cli_auth_credentials_store = "keyring"` can force OS credential-store use. This improves local storage, but it does not by itself separate the model credential from the Codex process.
- Codex also supports `CODEX_API_KEY` for a single `codex exec` run and `CODEX_ACCESS_TOKEN` for trusted automation. These should be treated as automation secrets and should not be inherited by sandboxed tool subprocesses unless explicitly required.
- Claude Code prioritizes `ANTHROPIC_API_KEY` environment variables over subscription login. For Happy-managed Claude Code launches, keep `ANTHROPIC_API_KEY` and similar broad provider secrets out of the final sandbox launch env unless a specific backend mode requires them.
- Claude Code's cloud execution docs describe a stronger pattern for GitHub: a secure proxy uses a scoped credential inside the sandbox and translates it to the real GitHub token outside the sandbox. That is the right conceptual model for Happy to copy locally where feasible.

Recommended Happy direction:

- Add a final launch-env scrubber for sandboxed launches. Default-deny known credential variables such as `OPENAI_API_KEY`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, cloud-provider keys, and project-specific tokens unless the selected backend explicitly declares it needs one.
- Add a `SecretProvider` interface for retrieving secrets from macOS Keychain, 1Password, Vault, or other stores. This is storage plumbing only; do not claim it prevents agent access if the secret is then injected into the agent process.
- Prefer credentialed action brokers for tools like GitHub, BigQuery, Slack, Linear, and web search. The agent should call a tool/action interface, not receive those service tokens.
- For GitHub, prefer GitHub App or fine-grained, expiring PAT credentials held by a broker/MCP server. Do not put broad `GITHUB_TOKEN`/`GH_TOKEN` into the agent environment by default.
- For local git operations, distinguish unauthenticated local repository actions from authenticated remote actions. Clone/fetch/push/PR creation should eventually route through a GitHub action broker or a narrowly scoped credential helper controlled by Happy policy.
- For the strongest model-provider boundary, build or adopt a split harness mode: Happy, or a trusted broker process, holds the OpenAI/Anthropic credential and talks to the model API; the sandboxed worker only receives tool-call instructions and returns observations. Stock monolithic CLI integrations remain compatibility modes with weaker credential-isolation claims.
- Add a user-visible capability claim per backend:
  - `none`: raw credential may be visible to the agent process
  - `stored-only`: credential is protected at rest but injected at runtime
  - `brokered-tool`: raw tool credential is outside the agent, but allowed actions can still be misused
  - `split-harness`: model credential and tool credentials are outside the sandboxed worker

Existing tools to spike:

- 1Password MCP Server for Codex. Its docs explicitly say it lets Codex manage 1Password Environments without returning secrets to the agent, and injects secrets into the application process through an in-memory FIFO for authorized runs. This is promising for application/runtime secrets, not a complete answer for Codex's own model credential.
- 1Password `op run`, `op read`, `op inject`, and shell plugins. These are useful for human/trusted command workflows, but `op run` still provisions environment variables to the subprocess, so it is not enough for an untrusted agent boundary.
- GitHub official MCP server. Useful for brokered GitHub actions with toolsets, individual tool allowlists, and read-only mode. It still needs its own credential, so Happy should run it outside the sandboxed agent or through Docker MCP Gateway/ToolHive.
- Codex keyring credential storage. Use it where Codex is the harness, but treat it as at-rest hardening rather than a full anti-exfiltration boundary.

Decision on 2026-06-03:

- Add harness credential isolation as a separate workstream from egress proxying.
- Do not claim robust credential non-exfiltration for stock Codex/Claude Code CLI modes if those CLIs need provider credentials in the same process boundary that executes agent-controlled tools.
- Prefer "no inherited credentials plus brokered tools" for v1, then evaluate split-harness architecture for a stronger v2 claim.
- Add a local spike for 1Password MCP Server for Codex and a GitHub MCP broker, because these are closer to the desired non-proxy credential-action model than plain environment injection.

Source links:

- https://www.1password.dev/environments/mcp-codex-server
- https://www.1password.dev/cli/secrets-scripts
- https://github.com/github/github-mcp-server
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens
- https://support.claude.com/en/articles/12304248-manage-api-key-environment-variables-in-claude-code
- https://code.claude.com/docs/en/security
- OpenAI Codex manual fetched 2026-06-03: `/codex/auth.md`, `/codex/environment-variables.md`, `/codex/enterprise/access-tokens.md`, `/codex/agent-approvals-security.md`, `/codex/concepts/sandboxing.md`

#### CLI action broker alternative to MCP

MCP is not required for brokered actions. Happy can keep a command-line workflow and still avoid exposing raw credentials by making Happy the command broker.

Pattern:

```txt
sandboxed agent
|
+- runs: happy gh pr create ...
+- runs: happy git push ...
+- runs: happy bq query ...
   |
   +- Happy command broker validates command, arguments, repo/session policy, and approval state
   +- broker retrieves credential outside sandbox
   +- broker invokes real CLI outside sandbox or in a credentialed broker context
   +- broker returns sanitized stdout/stderr/result metadata
```

This preserves the developer ergonomics of command-line tools while avoiding a direct `GH_TOKEN`, `GITHUB_TOKEN`, `ANTHROPIC_API_KEY`, Google ADC file, or other secret in the agent environment.

Required transport contract:

- A sandbox-visible `happy gh`, `happy git`, `happy bq`, or PATH shim must not simply execute the real credentialed CLI inside the sandbox.
- It must cross to an out-of-sandbox broker context through a defined local transport: daemon RPC, a child-owned local broker service, an MCP/action gateway, or another explicitly registered broker channel.
- The broker transport needs per-session capability auth, local service registration, argument validation, approval policy, audit events, timeout/cancellation behavior, and sanitized stdout/stderr.
- If the broker transport is unavailable, unregistered, unauthenticated, or cannot validate the requested action, it must fail closed for brokered-tool sessions.
- The sandbox policy must prevent bypasses to the real credential store, real credentialed CLI, or direct provider network path where the platform can enforce those restrictions.

Preferred forms:

- A first-class `happy tool ...` or `happy gh ...` broker command with explicit subcommands.
- PATH shims inside the sandbox for selected commands, for example `gh`, `git`, `bq`, or `gcloud`, that route to Happy's broker instead of the real binary.
- A Happy-owned git remote/credential helper only for narrow git fetch/push operations, if it can reject direct credential-fill/exfiltration attempts.
- For SSH git operations, a constrained SSH agent, deploy key, or hardware-backed key can prevent private-key extraction, but it still grants signing/use capability. Treat it as "credential bytes protected, action misuse still possible."

Do not expose full CLIs as the security boundary:

- Full `gh` is not safe as a raw-token boundary. GitHub CLI documents `gh auth token`, which prints the auth token, and `gh auth status --show-token`, which can display tokens. It also has `gh api`, which can call arbitrary GitHub API endpoints.
- Full `git` with a normal credential helper may still be able to retrieve stored credentials through credential-helper paths or use broad push/fetch rights. Use local git freely for non-authenticated repository operations, but broker authenticated remotes.
- Full `gcloud`, `bq`, `aws`, `op`, or similar CLIs can often print credentials, mint tokens, read account state, or access more resources than the current task requires.

Advantages over MCP:

- Keeps terminal-first workflows and user expectations.
- Reuses mature provider CLIs, auth flows, output formats, and local config.
- Avoids adding an MCP dependency or tool catalog for simple operations.
- Can be introduced incrementally with PATH shims and explicit Happy subcommands.

Friction:

- It must be allowlist-based. A generic "run any gh command" broker recreates the same problem.
- CLI output is less stable than typed APIs. Prefer `--json`/machine-readable output where each CLI supports it.
- Interactive CLIs, pagers, editors, prompts, and TTY behavior need explicit handling.
- The broker must sanitize stdout/stderr because CLIs may print URLs, headers, account ids, or secrets.
- Direct network and direct secret-store access still need sandbox restrictions; otherwise the agent can bypass the broker.
- Command policy becomes product surface: Happy needs command templates, argument validators, approval prompts, audit events, and fallback behavior.

Good first CLI broker candidates:

- `happy gh pr list/view/create/comment` using the real `gh` outside the sandbox with a narrowly scoped GitHub credential.
- `happy git fetch/push` for the current repository and branch only.
- `happy bq query` or `happy gcloud ...` for a constrained BigQuery job policy: allowed projects/datasets, dry-run first, max bytes billed, read-only by default, explicit approval for writes.
- `happy search` for web search through a Happy-held API key, returning snippets/results without exposing the search provider token.

Decision on 2026-06-03:

- Add CLI action brokering as a first-class alternative to MCP.
- Do not require MCP for GitHub or other command-line-native workflows.
- For v1, prefer a small `happy gh`/`happy git` broker spike over exposing full `gh`/`git` with inherited credentials.
- Keep MCP as one optional transport/tooling model, not the only credential-boundary strategy.

Source links:

- https://cli.github.com/manual/gh_auth_token
- https://cli.github.com/manual/gh_auth_status
- https://cli.github.com/manual/gh_api
- https://cli.github.com/manual/
- https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens

#### LLM gateway candidates

LiteLLM, Portkey, Helicone, and similar LLM gateways solve model-provider routing, virtual keys, observability, budget/rate limits, and OpenAI-compatible APIs.

Decision on 2026-06-03:

- Do not use these for Happy's sandbox egress layer.
- They may help with model-provider gatewaying later, but they do not solve generic sandbox direct-egress blocking, local provider state redaction, or MCP credential isolation.

### Expected split

The expected architecture after review may be:

```txt
sandboxed agent
|
+- model/harness access -> stock CLI compatibility mode, or future split-harness broker
+- HTTP/HTTPS egress -> backend-native or Happy sandbox runtime first; Pipelock or Happy proxy where native/runtime controls fail
+- credentialed tools/actions -> Happy CLI broker or out-of-agent MCP/action broker
+- provider API calls -> Happy provider gateway only where base URL/fake-token mode is compatible
+- MCP tool calls -> optional Docker MCP Gateway or ToolHive for credential-sensitive MCP servers, starting with BigQuery MCP
```

Do not choose a single tool just to simplify the diagram. The right outcome may be a small Happy orchestration layer over multiple specialized components.

Current build/adopt split:

- **Use first where viable:** backend-native and Happy sandbox runtime egress controls, starting with Claude Code sandbox network policy, Happy's `@anthropic-ai/sandbox-runtime` integration, and conformance tests.
- **Spike before building proxy internals only when needed:** Pipelock for network egress/firewall behavior where native/runtime controls fail or are missing.
- **Build unless native/Pipelock passes:** Happy-native v1 HTTP/CONNECT egress proxy fallback. Policy resolver, audit sink, backend adapters, and capability metadata are still Happy-owned primitives.
- **Prefer for credential actions:** out-of-agent MCP/action brokers, because they can keep raw credentials outside the agent process.
- **Prefer for CLI-native workflows:** Happy CLI action brokers or PATH shims over full raw CLI exposure.
- **Adopt optionally:** Docker MCP Gateway or ToolHive for selected MCP servers, starting with BigQuery MCP.
- **Harden immediately:** final sandbox launch-env scrubbing and backend capability labels for whether credentials are raw, stored-only, brokered-tool, or split-harness.
- **Do not adopt for core v1:** Envoy and OneCLI.
- **Revisit later:** Envoy/agentgateway if the native proxy becomes a general gateway; OneCLI/Authsome/KeyLore/Jentic/Pipedream/Composio if users want a full external credential/action platform and accept that trust boundary.

## Implementation Plan

Implementation order is part of the security design:

1. Prove enforcement capability and conformance for Claude Code, Codex, and Happy's sandbox runtime integration.
2. Add final launch-env hardening and backend credential-boundary labels.
3. Use backend-native or Happy sandbox runtime egress adapters where conformance passes.
4. Run a Pipelock hands-on spike only where native/runtime controls fail or are missing.
5. Add a Happy-native proxy only if native/runtime controls and Pipelock do not satisfy v1 requirements.
6. Prefer brokered action/MCP credential boundaries before provider HTTP credential injection.
7. Add provider HTTP gateways only after compatibility and brokered provider-state tests pass.

### Phase -1: Existing tool evaluation

- [x] Evaluate Envoy for the network proxy substrate.
- [x] Evaluate OneCLI for HTTP API credential brokering.
- [x] Evaluate Docker MCP Gateway for MCP server governance and credential isolation.
- [x] Evaluate broader egress, MCP, credential-broker, and non-proxy brokered-action candidates.
- [x] Evaluate harness credentials separately from tool credentials.
- [x] Evaluate CLI action brokering as an alternative to MCP for command-line-native workflows.
- [x] Evaluate backend-native and Happy sandbox runtime egress controls as the preferred first enforcement layer when they are strong and testable.
- [x] For each candidate, document:
  - required local dependencies
  - per-session startup/shutdown model
  - policy expressiveness
  - direct-egress blocking assumptions
  - credential storage and injection model
  - audit/log redaction behavior
  - compatibility with Claude Code, Codex, BigQuery MCP, and one web-search-style MCP/API tool
  - failure and fallback behavior
- [x] Update this plan with a build/adopt decision before starting Phase 1 proxy implementation.

Acceptance:

- Envoy and OneCLI have been evaluated and rejected as core v1 dependencies.
- Pipelock has been selected for a hands-on egress/firewall spike before implementing proxy internals.
- Docker MCP Gateway and ToolHive have been selected as optional MCP-layer candidates.
- The credential boundary decision is explicit: prefer brokered action execution over proxy-based credential injection whenever tool/action coverage exists.
- The harness credential decision is explicit: stock monolithic CLI modes cannot claim robust non-exfiltration of their own provider credential; split-harness mode is a future stronger architecture.
- The CLI workflow decision is explicit: MCP is optional; Happy CLI action brokers can be the default for GitHub/git-style workflows.
- The egress decision is explicit: use backend-native or Happy sandbox runtime network controls first where conformance passes; use Pipelock/Happy proxy only where native/runtime controls fail or are missing.
- The first implementation PR may create Happy-native policy/auth/audit primitives, but `egress/proxy.ts` should wait until native/runtime-control conformance and any needed Pipelock spike are complete.
- The MCP credential path should start with a Docker MCP Gateway vs ToolHive spike for BigQuery MCP or a similar high-value MCP server.

### Phase -0.5: Final launch env hardening and capability labels

- [ ] Add a central sandbox launch env scrubber before proxy work.
- [ ] Run the scrubber after all launch env sources are merged:
  - allowlisted parent env
  - daemon-provided env
  - backend explicit env
  - sandbox agent state env
  - backend-native/Happy sandbox runtime/Pipelock/Happy proxy env
  - provider gateway env, if brokered mode is active
- [ ] Default-deny broad credential variables unless the selected backend explicitly declares them required:
  - `OPENAI_API_KEY`
  - `CODEX_API_KEY`
  - `CODEX_ACCESS_TOKEN`
  - `ANTHROPIC_API_KEY`
  - `CLAUDE_CODE_OAUTH_TOKEN`
  - `GITHUB_TOKEN`
  - `GH_TOKEN`
  - common cloud-provider and project-specific token/key variables
- [ ] Add backend credential env policy declarations:

  ```ts
  type BackendCredentialEnvPolicy = {
    backend: "claude" | "codex";
    allowedSecretEnv: string[];
    credentialBoundary: "none" | "stored-only" | "brokered-tool" | "split-harness";
  };
  ```

- [ ] Add backend credential-boundary labels:
  - `none`
  - `stored-only`
  - `brokered-tool`
  - `split-harness`
- [ ] Add a provider-state policy hook before `createSandboxAgentState()` copies any backend state:
  - compatibility mode may keep the existing isolated provider state copy
  - brokered/non-exposure mode must copy only non-sensitive state or create synthetic state
  - brokered/non-exposure mode must reject `agentHomeMode=shared`
  - provider-state policy decisions must be represented in metadata as labels, not raw paths containing secrets
- [ ] Ensure logs, metadata, debug output, and approval prompts show labels and variable names, not values.
- [ ] Add tests that `with_agent_secrets`-style parent shells do not leak broad secrets into sandboxed agent children by default.
- [ ] Add tests that explicit launch env cannot pass broad credential variables unless the backend policy declares them.
- [ ] Add tests that a brokered/non-exposure launch cannot copy known provider auth files into sandbox-readable provider state and cannot use shared agent homes.

Acceptance:

- A sandboxed Happy launch from a shell with broad local secrets does not inherit those secrets unless explicitly declared by the backend policy.
- Backend explicit env cannot reintroduce broad credentials unless explicitly declared by the backend policy.
- Brokered/non-exposure modes select provider state behavior before copying state and fail closed if non-sensitive state cannot be built.
- The UI/metadata can tell users whether the selected backend is raw/stored-only/brokered/split-harness.
- Stock Codex/Claude Code compatibility modes are labeled honestly instead of being described as fully credential-isolated.

### Phase -0.25: Native/runtime egress adapter and conformance

- [ ] Add a Happy `SessionEgressPolicy` compiler for backend-native controls.
- [ ] Add a Happy sandbox runtime adapter that compiles `SandboxConfig`/`SessionEgressPolicy` into `@anthropic-ai/sandbox-runtime`, records platform-specific risk flags, and exposes whether audit visibility is none/partial/full.
- [ ] Add a Claude Code adapter that can emit or validate the corresponding `.claude/settings.json` sandbox network policy:
  - `allowedDomains`
  - `deniedDomains`
  - `allowLocalBinding`
  - `httpProxyPort` / `socksProxyPort`, only when using Happy/Pipelock as bring-your-own proxy
  - risk flags such as `enableWeakerNetworkIsolation`
- [ ] Add a Codex adapter for Codex network controls where available.
- [ ] Add a generic "unsupported backend/runtime" result so Happy can fall back to Pipelock/Happy proxy, network-off mode, or explicit audit-only/no-claim mode.
- [ ] Mark ACP, Gemini, and OpenClaw as out of scope for v1 in metadata/status if egress features are requested.
- [ ] Add egress conformance tests that can run against each backend adapter:
  - allowed public domain succeeds
  - denied domain fails
  - private IP and metadata IP fail
  - raw TCP direct egress fails when policy says network must go through approved controls
  - unregistered localhost fails when backend can express loopback restrictions
  - BigQuery MCP broker path does not require agent access to Google API hosts when the MCP server runs outside the sandbox
  - web search path documents whether traffic is backend-native WebFetch/Search, Happy brokered search, or direct allowed-domain egress

Acceptance:

- Happy can state, per backend/session, whether egress is enforced by backend-native controls, Happy sandbox runtime, Pipelock, Happy proxy, or disabled network.
- Claude Code native sandbox enforcement passes or fails the conformance suite before Happy decides to add a proxy layer.
- Happy sandbox runtime enforcement passes or fails the conformance suite before Happy decides to add a proxy/Pipelock fallback for local launcher paths.
- Risk flags such as weaker network isolation are surfaced in metadata and user-facing status.

### Phase 0: Design spike

- [ ] Confirm `@anthropic-ai/sandbox-runtime` network capabilities:
  - Can it allow only loopback to one proxy port?
  - Can it deny all other external network?
  - How do `allowLocalBinding`, `allowUnixSockets`, allowed domains, and denied domains interact?
- [ ] Document the v1 proxy owner contract:
  - Happy CLI child process owns proxy lifecycle.
  - Parent daemon only starts/stops the child and records metadata/audit ids.
  - Terminal-started sandbox sessions use the same child-owned path.
- [ ] Define the local service access model:
  - egress proxy port
  - provider gateway port/path
  - hook server ports
  - MCP server ports and whether each is in-sandbox or out-of-sandbox
- [ ] Identify which Happy launch paths should use egress in v1:
  - Claude local
  - Claude SDK/remote
  - Codex app-server
- [ ] Mark these launch paths out of scope for v1:
  - ACP
  - Gemini
  - OpenClaw
- [ ] Decide if terminal-started sandbox sessions should get proxy v1.
- [ ] Write final `SessionNetworkPolicy` and `EgressAuditEvent` types.

Acceptance:

- A short implementation note is added to this plan with sandbox runtime findings.
- A minimal provider compatibility matrix is filled in.
- The plan states whether arbitrary loopback services are protected on each supported platform.

### Phase 0.5: Pipelock fallback spike

Run this phase only for an in-scope backend/policy where backend-native and Happy sandbox runtime controls are unavailable, insufficient, or fail conformance.

- [ ] Start and stop Pipelock per Happy session.
- [ ] Configure standard `HTTP_PROXY`/`HTTPS_PROXY` behavior without default TLS interception.
- [ ] Deny private, link-local, metadata, multicast, and unregistered localhost destinations.
- [ ] Verify direct egress fails when sandbox runtime support exists.
- [ ] Verify Pipelock audit data can be transformed into Happy's local audit summary without leaking tokens, headers, bodies, or query strings.
- [ ] Verify fallback behavior when Pipelock binary/configuration is unavailable.

Acceptance:

- If Pipelock satisfies v1 network-only proxy requirements, replace Phase 1 with a thin Happy adapter around Pipelock lifecycle, policy generation, audit ingestion, metadata, and fallback behavior.
- If Pipelock does not satisfy v1 requirements, proceed to the Happy-native proxy fallback.

### Phase 1: Network proxy skeleton

Run this phase only if backend-native and Happy sandbox runtime controls are unavailable or fail conformance and the Pipelock spike does not satisfy the v1 network-only proxy requirements. If native/runtime controls pass, use that adapter. If Pipelock passes, replace this phase with a thin Happy adapter around Pipelock lifecycle, policy generation, audit ingestion, and fallback behavior.

- [ ] Add `packages/happy-cli/src/egress/policy.ts`.
- [ ] Add `packages/happy-cli/src/egress/audit.ts`.
- [ ] Add `packages/happy-cli/src/egress/auth.ts`.
- [ ] Add `packages/happy-cli/src/egress/proxy.ts`.
- [ ] Implement local HTTP proxy listener on `127.0.0.1:0`.
- [ ] Implement `CONNECT host:port` handling.
- [ ] Implement basic HTTP absolute-URL proxy handling.
- [ ] Require proxy auth token.
- [ ] Emit allow/deny audit events.
- [ ] Capture parent upstream proxy and CA-related env before injecting Happy proxy env.
- [ ] Do not set `ALL_PROXY` unless SOCKS/non-HTTP semantics are implemented and tested.
- [ ] Add lifecycle `stop()`.

Tests:

- [ ] Starts on loopback random port.
- [ ] Rejects missing or wrong token.
- [ ] Allows authenticated request to allowed host.
- [ ] Denies authenticated request to denied host.
- [ ] Emits audit event for allow and deny.
- [ ] `stop()` closes listener.
- [ ] Happy proxy does not recursively proxy to itself when parent proxy env exists.

### Phase 2: Policy enforcement

- [ ] Implement domain matching with wildcard support consistent with `sandbox/config.ts`.
- [ ] Normalize hostnames.
- [ ] Block private IP ranges and metadata endpoints.
- [ ] Block IP literals by default, unless policy explicitly allows them.
- [ ] Resolve DNS and check all returned addresses for private/link-local classification.
- [ ] Connect to a validated resolved address, not a separately re-resolved hostname.
- [ ] Add redirect behavior decision. Recommended: proxy does not follow redirects.
- [ ] Implement initial `maxConcurrentConnections` and `maxRequestBytes`, or remove rate/volume cap claims from this plan.

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
- [ ] CNAME to private address denied
- [ ] DNS rebinding-style changed answer is rechecked per connection
- [ ] IPv6-mapped IPv4 private address denied
- [ ] bracketed IPv6 literal normalized and denied
- [ ] connection/request limits deny with auditable reasons

### Phase 3: Session integration

- [ ] Add `startSessionEgressProxy()` helper used by backend launchers that takes:
  - `SandboxConfig`
  - session id
  - machine id
  - in-scope backend flavor: Claude or Codex
- [ ] Start fallback proxy in the Happy CLI agent process before initializing the sandbox.
- [ ] Inject fallback proxy env into sandboxed process env.
- [ ] Inject only `HTTP_PROXY`, `HTTPS_PROXY`, lowercase variants if needed, `NO_PROXY`, and `HAPPY_EGRESS_TOKEN` for the network proxy.
- [ ] Add provider broker capability env/config only in brokered provider mode.
- [ ] Ensure proxy token is treated as sensitive:
  - not logged
  - not persisted except where required for local child process
  - never included in session metadata
- [ ] Store egress runtime handle on the backend/launcher instance for cleanup.
- [ ] Stop fallback proxy on session exit, interrupt cleanup, spawn failure, and sandbox initialization failure.
- [ ] Add metadata summary via `createSessionMetadata`.

Tests:

- [ ] launcher passes proxy env only when egress is enabled
- [ ] cleanup stops proxy
- [ ] metadata includes selected egress layer, audit coverage/source, policy summary, capability labels, provider-state boundary, and risk flags, not tokens
- [ ] sandbox env filter permits proxy env keys required for operation
- [ ] daemon-spawned, tmux-spawned, resumed, forked, and terminal-started Claude/Codex sandbox sessions follow the same owner model
- [ ] `allowSandboxFallback=true` cannot silently produce an enforced-session claim after sandbox initialization fails

### Phase 4: Direct-egress blocking

- [ ] Modify sandbox runtime config to allow agent access to egress proxy while denying direct external network, if runtime supports this.
- [ ] Modify sandbox runtime config to allow only registered loopback ports when runtime supports this.
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
+- curl http://127.0.0.1:<unregisteredPort> direct -> denied, where runtime supports port-specific loopback policy
+- raw TCP connection to example.com:443 without proxy -> denied
+- git ssh or ssh to github.com without proxy -> denied, where available
```

Acceptance:

- The selected enforcement layer is a real enforcement point for supported platforms.
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
- [ ] audit directory is `0700` and files are `0600`
- [ ] audit file rotation or size cap is enforced

### Phase 6: Brokered action credential-boundary spike

Run this before provider HTTP credential brokering.

- [ ] Select one command-line-native credentialed workflow:
  - GitHub PR/list/view/comment/create through `happy gh`, or
  - constrained git fetch/push for the current repository/branch
- [ ] Define the out-of-sandbox transport for the selected command-line broker:
  - daemon RPC
  - child-owned local broker service
  - MCP/action gateway
  - or another explicitly registered broker channel
- [ ] Select one MCP/tool workflow:
  - BigQuery MCP or similarly sensitive credentialed MCP through Docker MCP Gateway and ToolHive
- [ ] Verify raw tool credentials are absent from sandbox env, sandbox-readable files, logs, metadata, audit files, and model-visible context.
- [ ] Verify the broker can restrict tools/actions, validate arguments, log calls, deny destructive actions, and fail closed when unavailable.
- [ ] Verify direct network and direct secret-store access cannot bypass the broker where the sandbox can enforce those restrictions.
- [ ] Document the residual risk: the agent cannot read the raw credential, but can still misuse allowed credentialed actions within policy.

Acceptance:

- At least one useful credentialed action succeeds without exposing raw credential material to the sandboxed agent.
- The action boundary is represented in metadata as `brokered-tool`.
- The broker transport is authenticated, registered as an allowed local service if needed, audited, and fails closed when unavailable.
- The fallback behavior is explicit when Docker/ToolHive/MCP dependencies or broker credentials are unavailable.

### Phase 7: Provider HTTP credential broker design spike

- [ ] Select first provider/backend.
- [ ] Confirm base URL support.
- [ ] Confirm whether SDK/CLI can run without raw API key if base URL points at Happy.
- [ ] Confirm whether SDK/CLI accepts a fake/local broker capability token in its normal API key field.
- [ ] Confirm whether SDK/CLI validates provider key format before sending requests.
- [ ] Confirm streaming behavior.
- [ ] Identify current credential source:
  - Happy cloud vendor token
  - local provider config
  - user env var
  - OAuth refresh token
- [ ] Define credential reference type for that provider.
- [ ] Identify provider state files that can contain raw credentials, refresh tokens, cookies, or account tokens.
- [ ] Define brokered provider state behavior:
  - no copy
  - redacted copy
  - synthetic minimal state
  - existing isolated state fallback
- [ ] Define the provider broker capability token format, expiry, and validation rules.

Acceptance:

- One provider is selected for v1 broker.
- A compatibility note is added to this plan or a provider-specific plan.
- There is a clear fallback for unsupported users.
- The selected provider has a documented plan for avoiding raw credential env and raw credential state copies.

### Phase 8: Provider gateway v1

- [ ] Add `packages/happy-cli/src/egress/providers/types.ts`.
- [ ] Add first provider gateway implementation.
- [ ] Generate and validate per-session/provider broker capability token.
- [ ] Add route validation:
  - allowed endpoints only
  - allowed methods only
  - allowed model list if available
  - request size limit
- [ ] Inject upstream auth from Happy-controlled credential source.
- [ ] Stream response without buffering full body.
- [ ] Strip hop-by-hop headers and client-supplied local broker auth before forwarding upstream.
- [ ] Reject requests that are missing or have the wrong broker capability token.
- [ ] Ensure the broker capability token cannot be forwarded as upstream provider auth.

Tests:

- [ ] agent request without raw provider key succeeds through broker
- [ ] upstream receives injected Authorization
- [ ] client-supplied local broker Authorization/API key is validated locally and stripped before upstream
- [ ] missing/wrong broker capability token is denied
- [ ] disallowed endpoint denied
- [ ] disallowed model denied, if model can be parsed safely
- [ ] streaming response passes through
- [ ] audit event records provider route and decision, not credential
- [ ] audit event does not record broker capability token

### Phase 9: Remove raw credentials for brokered provider

- [ ] Update sandbox env builder/launcher for provider:
  - remove raw provider credential env
  - remove provider auth file from isolated state copy, if brokered mode is active
  - write only broker capability token or non-secret base URL config when the provider client requires local auth state
  - inject provider base URL pointed at Happy proxy
- [ ] Preserve non-broker fallback.
- [ ] Ensure resume/fork flows keep broker policy consistent.

Tests:

- [ ] brokered session env does not include raw provider API key
- [ ] brokered sandbox provider state does not include raw credential file
- [ ] brokered sandbox provider state does not include OAuth refresh tokens, cookies, or provider account tokens
- [ ] provider request still succeeds through proxy
- [ ] direct external provider request fails when direct egress blocked
- [ ] resume session reuses broker without exposing credential

## Test Strategy

Unit tests:

- policy matching
- backend-native egress policy compilation
- Happy sandbox runtime egress policy compilation
- private network classification
- proxy auth
- provider broker capability auth
- audit redaction
- audit file permissions and rotation
- provider route validation
- env injection/redaction
- sandbox fallback enforcement downgrade/fail-closed behavior
- provider-state policy selection before state copy
- brokered provider state redaction/synthetic state creation
- upstream proxy env capture and self-loop prevention

Integration tests:

- backend-native egress conformance for Claude Code and Codex where available
- Happy sandbox runtime egress conformance for current local launcher paths
- local proxy with real HTTP server
- CONNECT tunnel to local TLS test server
- sandboxed subprocess egress behavior
- provider gateway with mocked upstream streaming server
- Happy proxy forwarding through a mocked upstream corporate proxy
- unregistered local loopback service access from sandboxed process

Regression/adversarial tests:

- backend-native allowed-domain bypass attempt
- backend-native denied-domain bypass attempt
- backend-native weaker-network-isolation risk flag appears in metadata/status
- unset proxy env and attempt direct egress
- raw TCP direct egress
- sandbox initialization failure with `allowSandboxFallback=true` cannot retain enforcement metadata
- non-HTTP protocol direct egress, such as ssh/git+ssh where available
- malformed proxy auth
- missing/wrong provider broker capability token
- oversized CONNECT host
- control characters in host
- IP literal bypass
- DNS result resolves to private IP
- DNS result changes between requests
- CNAME chain resolves to private IP
- IPv6-mapped IPv4 private address
- wildcard allow conflicting with deny
- redirect to private IP
- client-supplied Authorization header in brokered request
- copied provider state includes no upstream credential material in brokered mode
- shared agent home is rejected for brokered/non-exposure modes
- broker capability token never appears in audit, metadata, or debug logs

Suggested commands:

```sh
pnpm --filter happy exec vitest run --project unit src/egress
pnpm --filter happy exec vitest run --project unit src/sandbox src/daemon src/api
pnpm --filter happy exec tsc --noEmit
git diff --check
```

## Rollout Plan

1. Hidden feature flag, unit tests only.
2. Ship final launch-env scrubbing for sandboxed launches behind a cautious default.
3. Add backend-native and Happy sandbox runtime egress policy adapters and conformance tests, starting with Claude Code and current local launcher paths.
4. Add local integration/conformance test command or developer-only mode.
5. Prove direct-egress and registered-loopback behavior for each backend/platform before enabling enforcement claims.
6. Ensure `allowSandboxFallback` paths either fail closed or downgrade to audit-only/no-enforcement metadata before enabling enforcement claims.
7. Enable native/runtime egress enforcement for sandboxed daemon sessions where conformance and V1 gates pass.
8. Enable native/runtime egress enforcement for terminal-started sandbox sessions where conformance and V1 gates pass.
9. Spike Pipelock only for in-scope backends or policies where native/runtime controls are missing or fail conformance.
10. Enable Pipelock/Happy proxy fallback behind opt-in flag only after direct-egress and loopback tests pass for that fallback.
11. Collect local audit feedback from development usage.
12. Spike non-proxy brokered action execution with a Happy CLI broker for GitHub/git and, separately, BigQuery MCP through Docker MCP Gateway and ToolHive.
13. Spike 1Password MCP Server for Codex and a GitHub CLI broker for non-provider application/tool credentials.
14. Ship network hardening only on platforms/backends where enforcement claims are proven.
15. Add one provider HTTP broker behind provider-specific opt-in flag only when the target cannot be handled as a brokered action/tool and after broker capability auth and brokered provider state tests pass.
16. Expand provider support only after compatibility, credential-state, action-boundary, and streaming tests are stable.

## Rollback Plan

- Keep new enforcement layers behind feature flags until stable.
- If the selected enforcement layer fails to start, fail closed for sandboxed sessions when enforcement mode is enabled.
- If sandbox initialization fails and `allowSandboxFallback=true`, fail closed for enforced sessions or continue only with explicit audit-only/no-enforcement metadata.
- In early audit-only mode, fail open only if explicitly configured.
- Credential broker must have fallback to existing isolated provider state path only with an explicit credential-boundary downgrade, because that fallback may expose provider credentials to the sandboxed agent.
- Session metadata should record the selected egress layer, broker status, and capability labels so debugging is possible.
- If child-owned fallback cleanup fails, log the error without exposing tokens. A normal child process exit closes the listener.
- If upstream proxy handling fails, deny the outbound request in enforcement mode and emit an audit reason.
- If strict private-address enforcement depends on Happy-controlled DNS resolution, upstream corporate proxy use must be rejected or marked as weaker/partial.
- If brokered provider state cannot be built without raw credentials, disable brokered mode for that provider/session and use explicit fallback.

## Open Questions

- Can sandbox runtime allow only loopback to a specific proxy port?
- Which backend/provider is easiest for the first broker?
- Should child-owned fallback runtime remain the long-term model, or should a later version move proxy/Pipelock hosting into the parent daemon?
- Should terminal-started sandbox sessions use egress enforcement by default after the feature flag period?
- Should egress audit be local-only forever, or optionally synced to Happy server?
- How should users approve new network domains from mobile?
- Should MCP servers get separate proxy tokens and policies from the main agent?
- Should provider gateways parse bodies for model allowlists, or only enforce endpoint-level rules in v1?
- What are acceptable local audit retention defaults?
- How should Happy expose upstream corporate proxy misconfiguration to users without leaking proxy credentials?
- For each credentialed action, what is the policy boundary: raw token prevention only, or also semantic action approval and result filtering?
- Which native/runtime egress controls are strong enough for Happy to trust by default after conformance: Claude Code, Codex, Happy sandbox runtime, some combination, or none?
- Should Happy fail closed when a backend setting such as `enableWeakerNetworkIsolation` is required for a workflow, or surface a warning and continue under a weaker claim?

## Recommended First PR

Keep the first PR narrow:

- Add final launch-env credential scrubbing for sandboxed launches after all env sources are merged.
- Add backend credential env policy declarations.
- Add backend credential-boundary labels and metadata.
- Add provider-state policy selection before sandbox agent state is copied.
- Add enforced-session handling for `allowSandboxFallback` downgrade/fail-closed behavior.
- Unit test that common credential variables are removed by default, including from explicit launch env, and only restored by explicit backend declarations.
- Add no process launch proxy integration yet.

Recommended second PR:

- Add `egress/policy.ts`, `egress/auth.ts`, `egress/audit.ts`, and native/runtime egress adapter types.
- Add no process launch integration yet.
- Unit test policy matching, token validation, audit redaction, audit file permissions, private IP classification, and DNS normalization helpers.
- Add a short note to this plan with sandbox runtime findings, child-owned fallback runtime lifecycle decision, and local service access limitations.

Recommended third PR:

- Add Happy sandbox runtime and Claude Code native egress adapter/conformance tests:
  - compile Happy policy to `@anthropic-ai/sandbox-runtime` network settings for current local launcher paths
  - verify allowed/denied/private/local behavior with subprocess commands where the runtime supports it
  - compile Happy policy to Claude sandbox network settings or validate an existing `.claude/settings.json`
  - verify allowed/denied/private/local behavior with subprocess commands
  - record risk flags such as `enableWeakerNetworkIsolation`
  - document whether BigQuery MCP and web search require agent-domain allowlist entries or are brokered outside the sandbox

Recommended fourth PR, only where native/runtime controls fail or are missing:

- Run the Pipelock hands-on spike before writing `egress/proxy.ts`:
  - start/stop per Happy session
  - standard `HTTP_PROXY`/`HTTPS_PROXY` behavior without default TLS interception
  - deny private/link-local/metadata destinations
  - deny direct egress when sandbox runtime support exists
  - produce local audit data that Happy can summarize without leaking tokens

Recommended fifth PR, if native/runtime controls and Pipelock do not satisfy the v1 requirements:

- Add `egress/proxy.ts` network-only proxy.
- Unit test HTTP and CONNECT handling with local test servers, validated-address connect behavior, upstream proxy env capture, and initial limit enforcement.

Recommended sixth PR:

- Wire fallback proxy into one in-scope sandboxed launch path behind a feature flag.
- Add cleanup and metadata summary.
- Add direct-egress and unregistered-loopback integration tests for platforms where the sandbox runtime can enforce them.

Recommended seventh PR:

- Wire fallback proxy helper into the remaining in-scope sandboxed backend launch paths.
- Verify daemon-spawned, tmux-spawned, resumed, forked, and terminal-started Claude/Codex sessions follow the same child-owned fallback runtime lifecycle.

Recommended non-proxy credential-action spike:

- Run a Happy CLI broker for GitHub/git operations without exposing `gh`, `GITHUB_TOKEN`, `GH_TOKEN`, or git credentials to the sandboxed agent.
- Run BigQuery MCP or a similarly sensitive credentialed tool through Docker MCP Gateway and ToolHive.
- Verify the sandboxed agent can perform a useful credentialed action while raw Google/user credentials are absent from env, files, logs, metadata, and model-visible context.
- Verify the broker can restrict tools/actions, log calls, deny destructive actions, and fail closed when the gateway is unavailable.
- Document whether the agent can still misuse allowed BigQuery actions, even though it cannot read the underlying credential.

Recommended MCP gateway spike details:

- Install or locate `docker mcp` support.
- Run Docker MCP Gateway and ToolHive with one credential-sensitive MCP server, preferably BigQuery MCP.
- Verify credentials stay outside the sandboxed agent environment and provider state.
- Verify tool allowlists, call logging, network/secrets blocking controls, and fallback behavior when the MCP gateway is unavailable.

Recommended harness/tool credential spike:

- Run 1Password MCP Server for Codex with a toy app secret and confirm Codex can manage environment metadata without seeing the secret value.
- Run a GitHub CLI broker outside the sandboxed agent with a read-only or narrowly scoped credential.
- Optionally compare the GitHub official MCP server as another transport, but do not make it required for the GitHub path.
- Verify Happy labels stock Codex/Claude Code CLI runs as compatibility modes unless their model credential is outside the tool-running process.

Recommended credential-broker prerequisite PR:

- Add provider compatibility note for the first provider.
- Add provider broker capability token helpers.
- Add brokered provider state builder/redactor for the selected provider.
- Test that raw upstream credentials are absent from env, metadata, audit logs, and sandbox provider state in brokered mode.

Provider HTTP credential brokering should not start until the selected egress enforcement layer has working lifecycle, audit, and direct-egress tests for the target backend/platform.

Provider HTTP credential brokering should not be the first credential-boundary implementation if the first target can be handled through non-proxy MCP/action brokering.
