const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_PATTERN = [
  String.raw`[A-Za-z0-9_.-]*(?:api[-_]?key|access[-_]?key|private[-_]?key|machine[-_]?key|encryption[-_]?key)[A-Za-z0-9_.-]*`,
  String.raw`[A-Za-z0-9_.-]*(?:access[-_]?token|refresh[-_]?token|id[-_]?token|oauth[-_]?token|session[-_]?token|control[-_]?token|auth[-_]?token)[A-Za-z0-9_.-]*`,
  String.raw`[A-Za-z0-9_.-]*(?:password|passwd|secret|credential)s?[A-Za-z0-9_.-]*`,
  String.raw`(?:authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|token)`,
].join('|');

const SENSITIVE_KEY_VALUE = new RegExp(
  String.raw`((?:["']?(?:${SENSITIVE_KEY_PATTERN})["']?\s*[:=]\s*))("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,}]+)`,
  'gi',
);

const SECRET_LIKE_KEY_PATTERNS = [
  /(^|[_\-.])api[_\-.]?key($|[_\-.])/i,
  /(^|[_\-.])access[_\-.]?key($|[_\-.])/i,
  /(^|[_\-.])private[_\-.]?key($|[_\-.])/i,
  /(^|[_\-.])machine[_\-.]?key($|[_\-.])/i,
  /(^|[_\-.])encryption[_\-.]?key($|[_\-.])/i,
  /(^|[_\-.])(access|refresh|id|oauth|session|control|auth)[_\-.]?token($|[_\-.])/i,
  /(^|[_\-.])token$/i,
  /(^|[_\-.])(password|passwd|secret|credential|authorization|cookie)($|[_\-.])/i,
];

const PUBLIC_KEY_PATTERN = /(^|[_\-.])public[_\-.]?key($|[_\-.])/i;

function normalizeKey(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, '$1_$2');
}

export function isSecretLikeKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (PUBLIC_KEY_PATTERN.test(normalized)) {
    return false;
  }
  return SECRET_LIKE_KEY_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function redactSecrets(input: string): string {
  let output = input;

  output = output.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    '-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----',
  );

  output = output.replace(
    /\b(Authorization|Proxy-Authorization)\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
    '$1: Bearer [REDACTED]',
  );
  output = output.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED]');

  output = output.replace(SENSITIVE_KEY_VALUE, (_match, prefix: string, value: string) => {
    if (value.toLowerCase() === 'bearer') {
      return `${prefix}${value}`;
    }
    const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : '';
    return `${prefix}${quote}${REDACTED}${quote}`;
  });

  output = output.replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-[REDACTED]');
  output = output.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_[REDACTED]');
  output = output.replace(/\bgh[opsur]_[A-Za-z0-9_]{20,}\b/g, 'gh_[REDACTED]');
  output = output.replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, 'xox-[REDACTED]');
  output = output.replace(/\bya29\.[A-Za-z0-9._-]{20,}\b/g, 'ya29.[REDACTED]');
  output = output.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'AWS_ACCESS_KEY_[REDACTED]');
  output = output.replace(/\b[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, 'JWT_[REDACTED]');
  output = output.replace(/:\/\/([^:\s/@]+):([^@\s/]+)@/g, '://$1:[REDACTED]@');

  return output;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function redactSensitiveData<T>(value: T): T {
  return redactSensitiveDataInternal(value, new WeakSet()) as T;
}

function redactSensitiveDataInternal(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactSecrets(value);
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  if (value instanceof Date || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return value;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveDataInternal(item, seen));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSecretLikeKey(key)
      ? REDACTED
      : redactSensitiveDataInternal(entry, seen);
  }
  return result;
}
