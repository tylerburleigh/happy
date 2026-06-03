> [!IMPORTANT]
> **This fork is a sandbox hardening preview.**
>
> This fork explores what Happy looks like when the local CLI is treated as a
> security boundary between a trusted user/control plane and an untrusted or
> mistake-prone coding agent. The goal is to reduce the blast radius of agent
> tool use while preserving Happy's mobile-first approval workflow.
>
> **Hardening added in this fork:**
>
> - OS-level sandbox launch paths for Claude, Codex, Gemini, and ACP-backed agents, with fail-closed startup unless fallback is explicitly enabled.
> - Isolated per-session agent state, managed sandbox home/temp directories, and filtered agent environments so globally exported secrets are not automatically inherited.
> - Per-project `.happy/sandbox.json` policy overlays, stricter path validation, default write scoping to the current Git worktree when available, and explicit denial of sensitive Happy state.
> - Semantic approval checks for high-risk commands and edits, including Git history/ref mutation, GitHub CLI token/destructive operations, package publishing, credential-adjacent files, and sandbox policy files.
> - Daemon/control-plane hardening, including authenticated local control endpoints, safer spawn validation, redacted logs/API payloads, private file permissions, and sandbox status metadata surfaced to the app.
>
> **Threat model:** this is not a claim of containment against a fully hostile
> local process or a compromised host. The intended threat model is an agent
> making mistakes inside a legitimate session.
>
> **Next planned layer:** a Happy-managed egress proxy and credential broker so
> supported providers can be used without exposing raw credentials inside agent
> environments.

---

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="/.github/logotype-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="/.github/logotype-light.png">
    <img src="/.github/logotype-dark.png" width="400" alt="Happy">
  </picture>
</div>

<h1 align="center">
  Mobile and Web Client for Claude Code & Codex
</h1>

<h4 align="center">
Use Claude Code or Codex from anywhere with end-to-end encryption.
</h4>

<div align="center">
  
[📱 **iOS App**](https://apps.apple.com/us/app/happy-claude-code-client/id6748571505) • [🤖 **Android App**](https://play.google.com/store/apps/details?id=com.ex3ndr.happy) • [🌐 **Web App**](https://app.happy.engineering) • [🎥 **See a Demo**](https://youtu.be/GCS0OG9QMSE) • [📚 **Documentation**](https://happy.engineering/docs/) • [💬 **Discord**](https://discord.gg/fX9WBAhyfD)

</div>

<img width="5178" height="2364" alt="github" src="/.github/header.png" />


<h3 align="center">
Step 1: Download App
</h3>

<div align="center">
<a href="https://apps.apple.com/us/app/happy-claude-code-client/id6748571505"><img width="135" height="39" alt="appstore" src="https://github.com/user-attachments/assets/45e31a11-cf6b-40a2-a083-6dc8d1f01291" /></a>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<a href="https://play.google.com/store/apps/details?id=com.ex3ndr.happy"><img width="135" height="39" alt="googleplay" src="https://github.com/user-attachments/assets/acbba639-858f-4c74-85c7-92a4096efbf5" /></a>
</div>

<h3 align="center">
Step 2: Install CLI on your computer
</h3>

```bash
npm install -g happy
```

> Migrated from the `happy-coder` package. Thanks to [@franciscop](https://github.com/franciscop) for donating the `happy` package name!

<h3 align="center">
Step 3: Start using `happy` instead of `claude` or `codex`
</h3>

```bash
# Instead of claude, use:
happy claude
# or
happy codex
```

## How does it work?

On your computer, run `happy` instead of `claude` or `happy codex` instead of `codex` to start your AI through our wrapper. When you want to control your coding agent from your phone, it restarts the session in remote mode. To switch back to your computer, just press any key on your keyboard.

## Security & Sandboxing

Happy supports an experimental OS-level sandbox for agent sessions. The sandbox hardening work includes isolated per-session provider state, managed sandbox home/temp directories, stricter filesystem and network policy validation, filtered agent environments, authenticated daemon control endpoints, and redacted control-plane logging. See the [Happy CLI README](packages/happy-cli/README.md#sandbox-experimental) for usage and the [egress proxy and credential broker plan](docs/plans/happy-egress-proxy-and-credential-broker.md) for the next planned security layer.

## 🔥 Why Happy Coder?

- 📱 **Mobile access to Claude Code and Codex** - Check what your AI is building while away from your desk
- 🔔 **Push notifications** - Get alerted when Claude Code and Codex needs permission or encounters errors  
- ⚡ **Switch devices instantly** - Take control from phone or desktop with one keypress
- 🔐 **End-to-end encrypted** - Your code never leaves your devices unencrypted
- 🛠️ **Open source** - Audit the code yourself. No telemetry, no tracking

## 📦 Project Components

- **[Happy App](https://github.com/slopus/happy/tree/main/packages/happy-app)** - Web UI + mobile client (Expo)
- **[Happy CLI](https://github.com/slopus/happy/tree/main/packages/happy-cli)** - Command-line interface for Claude Code and Codex
- **[Happy Agent](https://github.com/slopus/happy/tree/main/packages/happy-agent)** - Remote agent control CLI (create, send, monitor sessions)
- **[Happy Server](https://github.com/slopus/happy/tree/main/packages/happy-server)** - Backend server for encrypted sync

## 🏠 Who We Are

We're engineers scattered across Bay Area coffee shops and hacker houses, constantly checking how our AI coding agents are progressing on our pet projects during lunch breaks. Happy Coder was born from the frustration of not being able to peek at our AI coding tools building our side hustles while we're away from our keyboards. We believe the best tools come from scratching your own itch and sharing with the community.

## 📚 Documentation & Contributing

- **[Documentation Website](https://happy.engineering/docs/)** - Learn how to use Happy Coder effectively
- **[Contributing Guide](docs/CONTRIBUTING.md)** - How to contribute, PR guidelines, and development setup
- **[Edit docs at github.com/slopus/slopus.github.io](https://github.com/slopus/slopus.github.io)** - Help improve our documentation and guides

## License

MIT License - see [LICENSE](LICENSE) for details.
