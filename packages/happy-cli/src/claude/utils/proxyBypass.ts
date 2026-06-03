/**
 * Prevents local MCP HTTP servers from being routed through a configured HTTP proxy
 * by appending 127.0.0.1, localhost, and ::1 (IPv6 loopback) to NO_PROXY if missing.
 *
 * Writes both NO_PROXY and no_proxy (undici reads no_proxy first).
 * When both exist, NO_PROXY takes precedence and the merged result is written to both.
 */
export function ensureLocalProxyBypass(env: Record<string, string | undefined>): void {
    const existing = env.NO_PROXY ?? env.no_proxy ?? ''
    const entries = [...new Set(existing
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .filter(s => !/[\u0000-\u001f\u007f]/.test(s))
    )]

    const toAdd = ['127.0.0.1', 'localhost', '::1'].filter(h => !entries.includes(h))
    if (toAdd.length === 0) {
        const normalized = entries.join(',')
        env.NO_PROXY = normalized
        env.no_proxy = normalized
        return
    }

    const updated = [...entries, ...toAdd].join(',')
    env.NO_PROXY = updated
    env.no_proxy = updated
}
