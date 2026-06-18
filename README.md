<div align="center">

# process-killer

**Kill processes by port, name, or PID — replaces `lsof | grep | kill` with one command**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?labelColor=0B0A09)](LICENSE)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen?labelColor=0B0A09)](package.json)
[![Node >=18](https://img.shields.io/badge/node-%3E%3D18-339933?labelColor=0B0A09)](package.json)

</div>

## Install

```bash
npx github:NickCirv/process-killer
```

Or alias for repeated use:

```bash
npm install -g github:NickCirv/process-killer
```

## Usage

```bash
pk <port>               # Kill process on port (most common)
pk --name <pattern>     # Kill by process name pattern (regex)
pk --pid <pid>          # Kill specific PID
pk list [--port <n>]    # List processes, or what's on a port
pk ports                # Show all listening ports with PIDs
pk clean                # Kill all dev server processes
pk tui                  # Interactive process browser
```

| Flag | Description |
|------|-------------|
| `--force` | Skip confirmation prompt |
| `--signal <SIG>` | Signal to send (default: SIGTERM). Options: SIGTERM, SIGKILL, SIGHUP, SIGINT, SIGQUIT, SIGUSR1, SIGUSR2 |

### Examples

```bash
pk 3000                        # Kill whatever is on port 3000
pk 3000 --force                # Kill without confirmation
pk 3000 --signal SIGKILL       # Force-kill on port 3000
pk --name node                 # Kill all node processes
pk --name "python.*server"     # Kill python servers (regex)
pk list --port 8080            # Show what's on port 8080
pk tui                         # Launch interactive TUI browser
pk clean                       # Kill all dev servers (node, vite, python, etc.)
```

## What it does

Uses `lsof` (macOS) or `ss`/`fuser` (Linux) to resolve port → PID, and `ps aux` for name/process listing. Signals are sent via Node's built-in `process.kill()` — no shell injection surface. The `clean` command targets common dev server patterns (node, bun, deno, vite, webpack, python, ruby, etc.) and always confirms before killing. The `tui` command launches a full-screen interactive browser with live 2-second refresh.

## TUI Keys

| Key | Action |
|-----|--------|
| `↑` / `↓` | Navigate processes |
| `k` | Kill selected process |
| `s` | Send custom signal |
| `f` | Filter processes |
| `r` | Refresh |
| `q` | Quit |

---
<sub>Zero dependencies · Node >=18 · MIT · by <a href="https://github.com/NickCirv">NickCirv</a></sub>
