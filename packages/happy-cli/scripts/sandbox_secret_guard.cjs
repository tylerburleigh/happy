#!/usr/bin/env node

const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    process.exit(0);
  }

  const tool = input.tool_name || input.toolName || '';
  if (tool !== 'Bash') {
    process.exit(0);
  }

  const command = String(input.tool_input?.command || input.toolInput?.command || '');
  if (!command) {
    process.exit(0);
  }

  const normalized = command
    .replace(/\\([a-zA-Z0-9_-])/g, '$1')
    .replace(/""|''/g, '')
    .toLowerCase();

  const commandPattern = (commandName) => `(?:[./a-z0-9_-]+/)*${commandName}`;
  const protectedCommands = [
    { pattern: new RegExp(`(^|[^a-z0-9_/-])${commandPattern('security')}\\s+find-generic-password\\b`), name: 'macOS Keychain credential reads' },
    { pattern: new RegExp(`(^|[^a-z0-9_/-])${commandPattern('gh')}\\s+auth\\s+token\\b`), name: 'GitHub token export' },
    { pattern: new RegExp(`(^|[^a-z0-9_/-])${commandPattern('gcloud')}\\s+auth\\s+print-(?:access|identity)-token\\b`), name: 'Google Cloud token export' },
    { pattern: new RegExp(`(^|[^a-z0-9_/-])${commandPattern('aws')}\\s+(?:configure|sts|get-login-password|sso)\\b`), name: 'AWS credential access' },
    { pattern: new RegExp(`(^|[^a-z0-9_/-])${commandPattern('kubectl')}\\s+config\\s+view\\b`), name: 'Kubernetes credential access' },
    { pattern: new RegExp(`(^|[^a-z0-9_/-])${commandPattern('docker')}\\s+(?:login|context|system\\s+info)\\b`), name: 'Docker credential/context access' },
    { pattern: new RegExp(`(^|[^a-z0-9_/-])${commandPattern('op')}\\s+(?:read|item|get|signin|account)\\b`), name: '1Password secret access' },
    { pattern: new RegExp(`(^|[^a-z0-9_/-])${commandPattern('ksm')}\\b`), name: 'Keeper secret access' },
    { pattern: new RegExp(`(^|[^a-z0-9_/-])${commandPattern('ssh-add')}\\b`), name: 'SSH agent access' },
    { pattern: new RegExp(`(^|[^a-z0-9_/-])${commandPattern('pbpaste')}\\b`), name: 'clipboard reads' },
    { pattern: /(^|[^a-z0-9_/-])(?:[./a-z0-9_-]+\/)*secret-tool\b/, name: 'Linux Secret Service access' },
    { pattern: /(^|[^a-z0-9_/-])(?:[./a-z0-9_-]+\/)*(?:pass|gopass|kwallet-query|keyctl)\b/, name: 'Linux credential store access' },
    { pattern: /(^|[^a-z0-9_/-])(?:[./a-z0-9_-]+\/)*(?:xclip|xsel|wl-paste)\b/, name: 'clipboard access' },
    { pattern: /(^|[^a-z0-9_/-])(?:[./a-z0-9_-]+\/)*dbus-send\b.*org\.freedesktop\.secrets\b/, name: 'Linux Secret Service D-Bus access' },
  ];

  const match = protectedCommands.find(({ pattern }) => pattern.test(normalized));
  if (!match) {
    process.exit(0);
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `Blocked by Happy sandbox guard: ${match.name} is not allowed from a sandboxed agent session. Run it manually outside the agent if you intentionally need it.`,
    },
  }));
  process.exit(0);
});

process.stdin.resume();
