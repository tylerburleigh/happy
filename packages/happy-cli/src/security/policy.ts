import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

export type SecurityPolicyDecisionType = 'allow' | 'ask' | 'deny';
export type SecurityPolicyRisk = 'low' | 'medium' | 'high';
export type SecurityPolicyCategory =
    | 'shell'
    | 'git'
    | 'github'
    | 'package-publish'
    | 'protected-file';

export interface SecurityPolicyDecision {
    decision: SecurityPolicyDecisionType;
    risk: SecurityPolicyRisk;
    category: SecurityPolicyCategory;
    reason: string;
}

export interface ShellPolicyInput {
    command: unknown;
    cwd?: string;
}

export interface FileChangePolicyInput {
    fileChanges: unknown;
    cwd?: string;
}

const ALLOW: SecurityPolicyDecision = {
    decision: 'allow',
    risk: 'low',
    category: 'shell',
    reason: 'No semantic sandbox policy matched.',
};

const SAFE_GIT_SUBCOMMANDS = new Set([
    'blame',
    'diff',
    'grep',
    'log',
    'ls-files',
    'remote',
    'rev-parse',
    'show',
    'status',
    'tag',
]);

const LOCAL_MUTATING_GIT_SUBCOMMANDS = new Set([
    'add',
    'commit',
    'mv',
    'stash',
]);

const RISKY_GIT_SUBCOMMANDS = new Set([
    'checkout',
    'clean',
    'config',
    'merge',
    'pull',
    'push',
    'rebase',
    'reset',
    'restore',
    'rm',
    'switch',
    'worktree',
]);

const SAFE_GH_SUBCOMMANDS = new Set([
    'browse',
    'help',
    'issue',
    'label',
    'pr',
    'repo',
    'run',
    'workflow',
]);

const SAFE_GH_READ_ACTIONS = new Set([
    'checks',
    'diff',
    'list',
    'status',
    'view',
]);

const MUTATING_GH_ACTIONS = new Set([
    'archive',
    'cancel',
    'close',
    'comment',
    'create',
    'delete',
    'disable',
    'edit',
    'enable',
    'lock',
    'merge',
    'ready',
    'reopen',
    'rerun',
    'review',
    'run',
    'set',
    'unlock',
]);

function decision(
    type: SecurityPolicyDecisionType,
    risk: SecurityPolicyRisk,
    category: SecurityPolicyCategory,
    reason: string,
): SecurityPolicyDecision {
    return { decision: type, risk, category, reason };
}

function flattenCommand(command: unknown): string[] {
    if (Array.isArray(command)) {
        return command.flatMap((part) => flattenCommand(part));
    }

    if (command === null || command === undefined) {
        return [];
    }

    return [String(command)];
}

function commandDisplay(command: unknown): string {
    const parts = flattenCommand(command);
    return parts.join(' ').trim();
}

function hasShellControl(command: string): boolean {
    return /[;&|<>`\n\r]/.test(command) || command.includes('$(');
}

function tokenizeShell(command: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    let escaping = false;

    for (const char of command) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }

        if (char === '\\') {
            escaping = true;
            continue;
        }

        if (quote) {
            if (char === quote) {
                quote = null;
            } else {
                current += char;
            }
            continue;
        }

        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }

        if (/\s/.test(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
            continue;
        }

        if (';&|<>'.includes(char)) {
            if (current.length > 0) {
                tokens.push(current);
                current = '';
            }
            tokens.push(char);
            continue;
        }

        current += char;
    }

    if (escaping) {
        current += '\\';
    }
    if (current.length > 0) {
        tokens.push(current);
    }

    return tokens;
}

function commandTokens(command: unknown): { display: string; tokens: string[]; complex: boolean } {
    const flattened = flattenCommand(command).filter((part) => part.length > 0);

    if (flattened.length === 0) {
        return { display: '', tokens: [], complex: false };
    }

    if (flattened.length > 1) {
        const shell = commandName(flattened[0]);
        if (shell === 'bash' || shell === 'sh' || shell === 'zsh') {
            const commandFlagIndex = flattened.findIndex((token, index) => (
                index > 0
                && index < flattened.length - 1
                && token.startsWith('-')
                && !token.startsWith('--')
                && token.includes('c')
            ));
            if (commandFlagIndex !== -1) {
                const shellCommand = flattened[commandFlagIndex + 1];
                return {
                    display: shellCommand,
                    tokens: tokenizeShell(shellCommand),
                    complex: hasShellControl(shellCommand),
                };
            }
        }

        return {
            display: commandDisplay(command),
            tokens: flattened,
            complex: false,
        };
    }

    const display = flattened[0];
    return {
        display,
        tokens: tokenizeShell(display),
        complex: hasShellControl(display),
    };
}

function commandName(token: string | undefined): string {
    if (!token) return '';
    return basename(token).toLowerCase();
}

function hasAnyFlag(tokens: string[], flags: readonly string[]): boolean {
    return tokens.some((token) => flags.includes(token));
}

function hasShortFlag(tokens: string[], flag: string): boolean {
    return tokens.some((token) => token.startsWith('-') && !token.startsWith('--') && token.includes(flag));
}

function shellContainsCommand(display: string, names: readonly string[]): boolean {
    const alternates = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    return new RegExp(`(^|[^a-z0-9_./-])(?:[./a-z0-9_-]+/)*(?:${alternates})(\\s|$)`, 'i').test(display);
}

function evaluateGit(tokens: string[]): SecurityPolicyDecision {
    const subcommand = tokens.find((token, index) => index > 0 && !token.startsWith('-'))?.toLowerCase();
    if (!subcommand) {
        return decision('ask', 'medium', 'git', 'Git command could not be classified.');
    }

    if (subcommand === 'push') {
        if (
            hasAnyFlag(tokens, ['--force', '--force-with-lease', '--mirror', '--delete', '--prune', '--no-verify'])
            || hasShortFlag(tokens, 'f')
        ) {
            return decision('ask', 'high', 'git', 'Git push uses force, delete, mirror, prune, or no-verify flags.');
        }
        return decision('ask', 'medium', 'git', 'Git push publishes local state to a remote repository.');
    }

    if (subcommand === 'reset' && hasAnyFlag(tokens, ['--hard', '--merge', '--keep'])) {
        return decision('ask', 'high', 'git', 'Git reset can discard local worktree or index state.');
    }

    if (subcommand === 'clean' && (hasShortFlag(tokens, 'f') || hasAnyFlag(tokens, ['--force']))) {
        return decision('ask', 'high', 'git', 'Git clean can permanently remove untracked files.');
    }

    if (subcommand === 'branch' && (hasShortFlag(tokens, 'D') || hasAnyFlag(tokens, ['--delete', '--force']))) {
        return decision('ask', 'medium', 'git', 'Git branch deletion can remove local branch references.');
    }

    if (subcommand === 'config') {
        if (
            hasAnyFlag(tokens, ['--global', '--system', '--worktree'])
            || tokens.some((token) => /^credential(\.|$)/.test(token.toLowerCase()))
        ) {
            return decision('ask', 'high', 'git', 'Git config can modify global/system policy or credential helpers.');
        }
        return decision('ask', 'medium', 'git', 'Git config changes repository behavior.');
    }

    if (subcommand === 'commit' || subcommand === 'merge' || subcommand === 'am') {
        if (hasAnyFlag(tokens, ['--no-verify'])) {
            return decision('ask', 'medium', 'git', 'Git command bypasses configured hooks with --no-verify.');
        }
    }

    if (subcommand === 'rebase') {
        if (hasAnyFlag(tokens, ['--exec', '-x'])) {
            return decision('ask', 'high', 'git', 'Git rebase --exec runs commands while rewriting history.');
        }
        return decision('ask', 'medium', 'git', 'Git rebase rewrites local commit history.');
    }

    if (subcommand === 'pull') {
        return decision('ask', 'medium', 'git', 'Git pull fetches remote code and mutates the current worktree or refs.');
    }

    if (subcommand === 'checkout' || subcommand === 'restore' || subcommand === 'switch') {
        return decision('ask', 'medium', 'git', `Git ${subcommand} can change worktree contents or branch state.`);
    }

    if (subcommand === 'rm') {
        return decision('ask', 'medium', 'git', 'Git rm removes tracked files from the worktree and index.');
    }

    if (subcommand === 'worktree') {
        const action = tokens.find((token, index) => index > 1 && !token.startsWith('-'))?.toLowerCase();
        if (action === 'remove' || action === 'prune' || action === 'move') {
            return decision('ask', 'medium', 'git', 'Git worktree command can remove or move worktrees.');
        }
    }

    if (SAFE_GIT_SUBCOMMANDS.has(subcommand) || LOCAL_MUTATING_GIT_SUBCOMMANDS.has(subcommand)) {
        return {
            ...ALLOW,
            category: 'git',
            reason: 'Git command is read-only or limited to local staging/commit state.',
        };
    }

    if (RISKY_GIT_SUBCOMMANDS.has(subcommand)) {
        return decision('ask', 'medium', 'git', `Git ${subcommand} can affect repository or worktree state.`);
    }

    return decision('ask', 'medium', 'git', `Unrecognized git subcommand: ${subcommand}.`);
}

function ghAction(tokens: string[]): { subcommand: string | null; action: string | null } {
    const positional = tokens.slice(1).filter((token) => !token.startsWith('-'));
    return {
        subcommand: positional[0]?.toLowerCase() ?? null,
        action: positional[1]?.toLowerCase() ?? null,
    };
}

function ghApiMethod(tokens: string[]): string {
    for (let i = 1; i < tokens.length; i += 1) {
        const token = tokens[i];
        if ((token === '-X' || token === '--method') && tokens[i + 1]) {
            return tokens[i + 1].toUpperCase();
        }
        if (token.startsWith('--method=')) {
            return token.slice('--method='.length).toUpperCase();
        }
    }
    return 'GET';
}

function evaluateGh(tokens: string[]): SecurityPolicyDecision {
    const { subcommand, action } = ghAction(tokens);

    if (!subcommand) {
        return decision('ask', 'medium', 'github', 'GitHub CLI command could not be classified.');
    }

    if (subcommand === 'auth') {
        if (action === 'status') {
            return {
                ...ALLOW,
                category: 'github',
                reason: 'GitHub auth status does not expose a token or mutate remote state.',
            };
        }
        if (action === 'token') {
            return decision('deny', 'high', 'github', 'GitHub token export is not allowed from an agent session.');
        }
        return decision('ask', 'high', 'github', 'GitHub auth command can expose or modify credentials.');
    }

    if (subcommand === 'api') {
        const method = ghApiMethod(tokens);
        if (method === 'GET' || method === 'HEAD') {
            return {
                ...ALLOW,
                category: 'github',
                reason: 'GitHub API request is read-only.',
            };
        }
        return decision('ask', 'high', 'github', `GitHub API ${method} request can mutate remote state.`);
    }

    if (subcommand === 'secret' || subcommand === 'ssh-key' || subcommand === 'gpg-key') {
        return decision('ask', 'high', 'github', `GitHub ${subcommand} command touches account or repository credentials.`);
    }

    if (subcommand === 'pr' && action === 'merge') {
        return decision('ask', 'high', 'github', 'GitHub PR merge mutates the remote repository.');
    }

    if (subcommand === 'repo' && (action === 'delete' || action === 'archive')) {
        return decision('ask', 'high', 'github', `GitHub repo ${action} is destructive.`);
    }

    if (action && MUTATING_GH_ACTIONS.has(action)) {
        return decision('ask', 'medium', 'github', `GitHub ${subcommand} ${action} mutates remote state.`);
    }

    if (action && SAFE_GH_READ_ACTIONS.has(action)) {
        return {
            ...ALLOW,
            category: 'github',
            reason: `GitHub ${subcommand} ${action} is read-only.`,
        };
    }

    if (SAFE_GH_SUBCOMMANDS.has(subcommand)) {
        return decision('ask', 'medium', 'github', `GitHub ${subcommand} command needs review because the action was not classified.`);
    }

    return decision('ask', 'medium', 'github', `Unrecognized GitHub CLI command: ${subcommand}.`);
}

function evaluatePackagePublish(tokens: string[]): SecurityPolicyDecision | null {
    const executable = commandName(tokens[0]);
    if (!['npm', 'pnpm', 'yarn'].includes(executable)) {
        return null;
    }

    const subcommand = tokens.find((token, index) => index > 0 && !token.startsWith('-'))?.toLowerCase();
    if (subcommand !== 'publish') {
        return null;
    }

    return decision('ask', 'high', 'package-publish', `${executable} publish releases a package to a registry.`);
}

export function evaluateShellSecurityPolicy(input: ShellPolicyInput): SecurityPolicyDecision {
    const { display, tokens, complex } = commandTokens(input.command);
    if (tokens.length === 0) {
        return ALLOW;
    }

    const loweredDisplay = display.toLowerCase();

    if (shellContainsCommand(loweredDisplay, ['gh']) && /(^|[^a-z0-9_./-])(?:[./a-z0-9_-]+\/)*gh\s+auth\s+token\b/i.test(loweredDisplay)) {
        return decision('deny', 'high', 'github', 'GitHub token export is not allowed from an agent session.');
    }

    if (complex && shellContainsCommand(display, ['git', 'gh', 'npm', 'pnpm', 'yarn'])) {
        return decision('ask', 'medium', 'shell', 'Complex shell command contains git, GitHub CLI, or package publishing tooling.');
    }

    const publishDecision = evaluatePackagePublish(tokens);
    if (publishDecision) {
        return publishDecision;
    }

    switch (commandName(tokens[0])) {
        case 'git':
            return evaluateGit(tokens);
        case 'gh':
            return evaluateGh(tokens);
        default:
            return ALLOW;
    }
}

function pathRelativeToCwd(pathValue: string, cwd?: string): string {
    const trimmed = pathValue.trim();
    if (!trimmed) return '';

    const comparable = cwd && isAbsolute(trimmed)
        ? relative(resolve(cwd), resolve(trimmed))
        : trimmed;

    return comparable.split(sep).join('/').replace(/\\/g, '/').replace(/^\.\//, '');
}

export function isProtectedPolicyPath(pathValue: string, cwd?: string): boolean {
    const comparable = pathRelativeToCwd(pathValue, cwd);
    const normalized = comparable.toLowerCase();
    const name = basename(normalized);
    const segments = normalized.split('/').filter(Boolean);

    if (!normalized || normalized.startsWith('../')) {
        return true;
    }

    if (
        name === '.mcp.json'
        || name === 'agents.md'
        || name === 'claude.md'
        || normalized === '.happy/sandbox.json'
        || normalized === '.git/config'
        || normalized.startsWith('.git/hooks/')
        || segments.includes('.claude')
        || segments.includes('.codex')
        || segments.includes('.cursor')
    ) {
        return true;
    }

    for (let i = 0; i < segments.length - 1; i += 1) {
        if (segments[i] === '.github' && (segments[i + 1] === 'workflows' || segments[i + 1] === 'actions')) {
            return true;
        }
        if (segments[i] === '.git' && (segments[i + 1] === 'hooks' || segments[i + 1] === 'config')) {
            return true;
        }
        if (segments[i] === '.happy' && segments[i + 1] === 'sandbox.json') {
            return true;
        }
    }

    return name === '.env' || /^\.env\.(?!example$)/.test(name);
}

export function extractFileChangePaths(fileChanges: unknown): string[] {
    const paths = new Set<string>();

    const visit = (value: unknown): void => {
        if (!value || typeof value !== 'object') {
            return;
        }

        if (Array.isArray(value)) {
            for (const item of value) visit(item);
            return;
        }

        const record = value as Record<string, unknown>;
        for (const [key, child] of Object.entries(record)) {
            if (typeof child === 'object' && child !== null) {
                const childRecord = child as Record<string, unknown>;
                for (const candidateKey of ['path', 'file', 'filePath', 'absolutePath']) {
                    const candidate = childRecord[candidateKey];
                    if (typeof candidate === 'string' && candidate.length > 0) {
                        paths.add(candidate);
                    }
                }
            }

            if (
                key.includes('/')
                || key.includes('\\')
                || key.startsWith('.')
                || /\.[a-z0-9]+$/i.test(key)
            ) {
                paths.add(key);
            }
        }
    };

    visit(fileChanges);
    return Array.from(paths);
}

export function evaluateFileChangeSecurityPolicy(input: FileChangePolicyInput): SecurityPolicyDecision {
    const paths = extractFileChangePaths(input.fileChanges);
    const protectedPaths = paths.filter((pathValue) => isProtectedPolicyPath(pathValue, input.cwd));

    if (protectedPaths.length === 0) {
        return {
            ...ALLOW,
            category: 'protected-file',
            reason: 'No protected policy files are being changed.',
        };
    }

    return decision(
        'ask',
        'high',
        'protected-file',
        `Protected policy or credential-adjacent file change requires review: ${protectedPaths.join(', ')}`,
    );
}
