#!/usr/bin/env node
// process-killer — zero-dependency CLI to kill processes by port, name, or PID
// Usage: pk <port> | pk --name <pattern> | pk --pid <pid> | pk list | pk tui | pk ports | pk clean

import { execFileSync, spawnSync } from 'node:child_process';
import * as readline from 'node:readline';
import * as os from 'node:os';

// ─── Platform ────────────────────────────────────────────────────────────────
const IS_MACOS = os.platform() === 'darwin';
const IS_LINUX = os.platform() === 'linux';

// ─── ANSI helpers ────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgBlue: '\x1b[44m',
  clearLine: '\x1b[2K',
  cursorUp: (n) => `\x1b[${n}A`,
  cursorDown: (n) => `\x1b[${n}B`,
  cursorCol: (n) => `\x1b[${n}G`,
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
  altScreen: '\x1b[?1049h',
  mainScreen: '\x1b[?1049l',
  clearScreen: '\x1b[2J\x1b[H',
};

const fmt = {
  error: (msg) => `${c.red}${c.bold}✖ ${msg}${c.reset}`,
  success: (msg) => `${c.green}${c.bold}✔ ${msg}${c.reset}`,
  warn: (msg) => `${c.yellow}⚠ ${msg}${c.reset}`,
  info: (msg) => `${c.cyan}ℹ ${msg}${c.reset}`,
  dim: (msg) => `${c.dim}${msg}${c.reset}`,
  bold: (msg) => `${c.bold}${msg}${c.reset}`,
  port: (p) => `${c.magenta}:${p}${c.reset}`,
  pid: (p) => `${c.yellow}${p}${c.reset}`,
  name: (n) => `${c.green}${n}${c.reset}`,
};

// ─── Safe exec helpers ────────────────────────────────────────────────────────
function safeExecFile(cmd, args, opts = {}) {
  try {
    const result = execFileSync(cmd, args, { encoding: 'utf8', ...opts });
    return result.trim();
  } catch {
    return null;
  }
}

function safeSpawn(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim();
}

// ─── Port → PID resolution ────────────────────────────────────────────────────
function findPidByPort(port) {
  if (IS_MACOS) {
    const out = safeExecFile('lsof', ['-ti', `:${port}`]);
    if (!out) return [];
    return out.split('\n').map((l) => parseInt(l.trim(), 10)).filter(Boolean);
  }
  // Linux: try ss first, then fuser
  const ssOut = safeExecFile('ss', ['-tlnp', `sport = :${port}`]);
  if (ssOut) {
    const pids = [];
    for (const line of ssOut.split('\n')) {
      const m = line.match(/pid=(\d+)/);
      if (m) pids.push(parseInt(m[1], 10));
    }
    if (pids.length) return pids;
  }
  const fuserOut = safeExecFile('fuser', [`${port}/tcp`]);
  if (fuserOut) {
    return fuserOut.split(/\s+/).map(Number).filter(Boolean);
  }
  return [];
}

// ─── Process name for a PID ───────────────────────────────────────────────────
function getProcessName(pid) {
  if (IS_MACOS) {
    return safeExecFile('ps', ['-p', String(pid), '-o', 'comm=']) || 'unknown';
  }
  return safeExecFile('ps', ['-p', String(pid), '-o', 'comm=']) || 'unknown';
}

// ─── List all user processes ──────────────────────────────────────────────────
function listProcesses() {
  const raw = safeExecFile('ps', ['aux']);
  if (!raw) return [];
  const lines = raw.split('\n');
  const header = lines[0];
  const procs = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const user = parts[0];
    const pid = parseInt(parts[1], 10);
    const cpu = parts[2];
    const mem = parts[3];
    const command = parts.slice(10).join(' ');
    const name = parts[10] ? parts[10].split('/').pop() : 'unknown';
    if (!pid || pid === process.pid) continue;
    procs.push({ user, pid, cpu, mem, name, command });
  }
  return procs;
}

// ─── List all listening ports ─────────────────────────────────────────────────
function listPorts() {
  if (IS_MACOS) {
    const raw = safeExecFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
    if (!raw) return [];
    const lines = raw.split('\n').slice(1);
    const entries = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split(/\s+/);
      const name = parts[0];
      const pid = parseInt(parts[1], 10);
      const addr = parts[8] || '';
      const portMatch = addr.match(/:(\d+)$/);
      if (portMatch) {
        entries.push({ name, pid, port: parseInt(portMatch[1], 10), addr });
      }
    }
    return entries;
  }
  // Linux: ss
  const raw = safeExecFile('ss', ['-tlnp']);
  if (!raw) return [];
  const lines = raw.split('\n').slice(1);
  const entries = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(/\s+/);
    const localAddr = parts[3] || '';
    const portMatch = localAddr.match(/:(\d+)$/);
    const pidMatch = line.match(/pid=(\d+)/);
    const nameMatch = line.match(/\("([^"]+)"/);
    if (portMatch && pidMatch) {
      entries.push({
        name: nameMatch ? nameMatch[1] : 'unknown',
        pid: parseInt(pidMatch[1], 10),
        port: parseInt(portMatch[1], 10),
        addr: localAddr,
      });
    }
  }
  return entries;
}

// ─── Find processes by name pattern ──────────────────────────────────────────
function findByName(pattern) {
  const procs = listProcesses();
  const re = new RegExp(pattern, 'i');
  return procs.filter((p) => re.test(p.name) || re.test(p.command));
}

// ─── Kill with confirmation ───────────────────────────────────────────────────
async function confirmKill(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${c.yellow}${prompt}${c.reset} [y/N] `, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'y');
    });
  });
}

function killPid(pid, signal = 'SIGTERM') {
  try {
    process.kill(pid, signal);
    return true;
  } catch (e) {
    if (e.code === 'ESRCH') {
      console.error(fmt.warn(`PID ${pid} not found (already dead?)`));
    } else if (e.code === 'EPERM') {
      console.error(fmt.error(`Permission denied killing PID ${pid}`));
    } else {
      console.error(fmt.error(`Failed to kill PID ${pid}: ${e.message}`));
    }
    return false;
  }
}

// ─── Command: kill by port ────────────────────────────────────────────────────
async function cmdPort(port, opts) {
  const pids = findPidByPort(port);
  if (!pids.length) {
    console.log(fmt.warn(`No process found on port ${port}`));
    return;
  }
  for (const pid of pids) {
    const name = getProcessName(pid);
    if (!opts.force) {
      const ok = await confirmKill(
        `Kill ${fmt.name(name.trim())} (PID ${fmt.pid(pid)}) on ${fmt.port(port)}?`
      );
      if (!ok) {
        console.log(fmt.dim('Skipped.'));
        continue;
      }
    }
    if (killPid(pid, opts.signal || 'SIGTERM')) {
      console.log(fmt.success(`Killed ${name.trim()} (PID ${pid}) on port ${port}`));
    }
  }
}

// ─── Command: kill by name ────────────────────────────────────────────────────
async function cmdName(pattern, opts) {
  const procs = findByName(pattern);
  if (!procs.length) {
    console.log(fmt.warn(`No processes matching "${pattern}"`));
    return;
  }
  console.log(fmt.bold(`\nFound ${procs.length} process(es) matching "${pattern}":\n`));
  for (const p of procs) {
    console.log(
      `  ${fmt.pid(String(p.pid).padEnd(8))} ${fmt.name(p.name.padEnd(20))} ${fmt.dim(p.command.slice(0, 60))}`
    );
  }
  console.log('');
  if (!opts.force) {
    const ok = await confirmKill(`Kill all ${procs.length} process(es)?`);
    if (!ok) {
      console.log(fmt.dim('Aborted.'));
      return;
    }
  }
  for (const p of procs) {
    if (killPid(p.pid, opts.signal || 'SIGTERM')) {
      console.log(fmt.success(`Killed ${p.name} (PID ${p.pid})`));
    }
  }
}

// ─── Command: kill by PID ─────────────────────────────────────────────────────
async function cmdPid(pid, opts) {
  const name = getProcessName(pid);
  if (!opts.force) {
    const ok = await confirmKill(
      `Kill ${fmt.name(name.trim())} (PID ${fmt.pid(pid)})?`
    );
    if (!ok) {
      console.log(fmt.dim('Aborted.'));
      return;
    }
  }
  if (killPid(pid, opts.signal || 'SIGTERM')) {
    console.log(fmt.success(`Killed PID ${pid}`));
  }
}

// ─── Command: list ────────────────────────────────────────────────────────────
function cmdList(opts) {
  if (opts.port) {
    const pids = findPidByPort(opts.port);
    if (!pids.length) {
      console.log(fmt.warn(`Nothing found on port ${opts.port}`));
      return;
    }
    console.log(fmt.bold(`\nProcesses on port ${opts.port}:\n`));
    for (const pid of pids) {
      const name = getProcessName(pid);
      console.log(`  ${fmt.pid(String(pid).padEnd(8))} ${fmt.name(name.trim())}`);
    }
    return;
  }
  const procs = listProcesses();
  const cols = process.stdout.columns || 100;
  const header =
    `  ${'PID'.padEnd(8)}${'NAME'.padEnd(22)}${'CPU%'.padEnd(7)}${'MEM%'.padEnd(7)}COMMAND`;
  console.log('\n' + fmt.bold(header));
  console.log(fmt.dim('  ' + '─'.repeat(Math.min(cols - 4, 80))));
  for (const p of procs.slice(0, 50)) {
    const cmd = p.command.slice(0, cols - 48);
    console.log(
      `  ${fmt.pid(String(p.pid).padEnd(8))}${fmt.name(p.name.padEnd(22))}${p.cpu.padEnd(7)}${p.mem.padEnd(7)}${fmt.dim(cmd)}`
    );
  }
  if (procs.length > 50) console.log(fmt.dim(`\n  ... and ${procs.length - 50} more`));
  console.log('');
}

// ─── Command: ports ───────────────────────────────────────────────────────────
function cmdPorts() {
  const entries = listPorts();
  if (!entries.length) {
    console.log(fmt.warn('No listening ports found'));
    return;
  }
  const sorted = entries.sort((a, b) => a.port - b.port);
  console.log('\n' + fmt.bold(`  ${'PORT'.padEnd(8)}${'PID'.padEnd(8)}NAME`));
  console.log(fmt.dim('  ' + '─'.repeat(40)));
  for (const e of sorted) {
    console.log(
      `  ${fmt.port(String(e.port).padEnd(7))} ${fmt.pid(String(e.pid).padEnd(8))}${fmt.name(e.name)}`
    );
  }
  console.log('');
}

// ─── Command: clean ───────────────────────────────────────────────────────────
const DEV_PATTERNS = [
  'node', 'bun', 'deno', 'python', 'ruby', 'rails', 'puma', 'uvicorn',
  'gunicorn', 'flask', 'django', 'next-server', 'vite', 'webpack',
  'parcel', 'esbuild', 'ts-node', 'tsx', 'nodemon',
];

async function cmdClean(opts) {
  const allProcs = listProcesses();
  const matches = allProcs.filter((p) =>
    DEV_PATTERNS.some((pat) => p.name.toLowerCase().includes(pat) || p.command.toLowerCase().includes(pat))
  );
  if (!matches.length) {
    console.log(fmt.info('No dev server processes found. Already clean!'));
    return;
  }
  console.log(fmt.bold(`\nFound ${matches.length} dev process(es):\n`));
  for (const p of matches) {
    console.log(
      `  ${fmt.pid(String(p.pid).padEnd(8))} ${fmt.name(p.name.padEnd(20))} ${fmt.dim(p.command.slice(0, 55))}`
    );
  }
  console.log('');
  if (!opts.force) {
    const ok = await confirmKill(`Kill all ${matches.length} dev process(es)?`);
    if (!ok) {
      console.log(fmt.dim('Aborted.'));
      return;
    }
  }
  let killed = 0;
  for (const p of matches) {
    if (killPid(p.pid, opts.signal || 'SIGTERM')) {
      console.log(fmt.success(`Killed ${p.name} (PID ${p.pid})`));
      killed++;
    }
  }
  console.log(fmt.bold(`\nDone. Killed ${killed}/${matches.length} processes.`));
}

// ─── Command: TUI ─────────────────────────────────────────────────────────────
function cmdTui() {
  if (!process.stdout.isTTY) {
    console.error(fmt.error('TUI requires a TTY terminal'));
    process.exit(1);
  }

  const REFRESH_MS = 2000;
  let procs = [];
  let ports = [];
  let selected = 0;
  let filter = '';
  let filterMode = false;
  let signalMode = false;
  let signalInput = '';
  let scrollOffset = 0;
  let intervalId;

  const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGUSR1', 'SIGUSR2'];
  let signalIdx = 0;

  function getPortForPid(pid) {
    return ports.find((p) => p.pid === pid)?.port;
  }

  function getFiltered() {
    if (!filter) return procs;
    const re = new RegExp(filter, 'i');
    return procs.filter((p) => re.test(p.name) || re.test(p.command));
  }

  function refresh() {
    procs = listProcesses();
    ports = listPorts();
    draw();
  }

  function draw() {
    const rows = process.stdout.rows || 24;
    const cols = process.stdout.columns || 100;
    const filtered = getFiltered();
    const maxVisible = rows - 7;

    // Clamp selected
    if (selected >= filtered.length) selected = Math.max(0, filtered.length - 1);
    if (selected < scrollOffset) scrollOffset = selected;
    if (selected >= scrollOffset + maxVisible) scrollOffset = selected - maxVisible + 1;

    const lines = [];

    // Header
    const title = `${c.bold}${c.cyan} process-killer TUI ${c.reset}`;
    const refreshInfo = fmt.dim(` auto-refresh 2s`);
    lines.push(`${title}${refreshInfo}`);
    lines.push(fmt.dim('─'.repeat(cols)));

    // Column header
    lines.push(
      `${c.bold}  ${'PID'.padEnd(8)}${'NAME'.padEnd(22)}${'CPU%'.padEnd(7)}${'MEM%'.padEnd(7)}${'PORT'.padEnd(8)}COMMAND${c.reset}`
    );
    lines.push(fmt.dim('─'.repeat(cols)));

    // Process rows
    const visible = filtered.slice(scrollOffset, scrollOffset + maxVisible);
    for (let i = 0; i < visible.length; i++) {
      const p = visible[i];
      const absIdx = scrollOffset + i;
      const port = getPortForPid(p.pid);
      const portStr = port ? fmt.port(String(port)) : fmt.dim('—');
      const portPad = port ? String(port).length + 1 : 1;
      const cmd = p.command.slice(0, cols - 58);
      const isSelected = absIdx === selected;
      const row =
        `  ${String(p.pid).padEnd(8)}${p.name.padEnd(22)}${p.cpu.padEnd(7)}${p.mem.padEnd(7)}${portStr.padEnd(8 - portPad + portStr.length)}${fmt.dim(cmd)}`;
      if (isSelected) {
        lines.push(`${c.bgBlue}${c.white}${row}${c.reset}`);
      } else {
        lines.push(`  ${String(p.pid).padEnd(8)}${fmt.name(p.name.padEnd(22))}${p.cpu.padEnd(7)}${p.mem.padEnd(7)}${portStr}${''.padEnd(Math.max(0, 7 - portPad))}${fmt.dim(cmd)}`);
      }
    }

    // Pad remaining rows
    for (let i = visible.length; i < maxVisible; i++) lines.push('');

    // Footer
    lines.push(fmt.dim('─'.repeat(cols)));
    if (filterMode) {
      lines.push(`${c.cyan}Filter: ${filter}█${c.reset}  ${fmt.dim('[Enter] apply  [Esc] cancel')}`);
    } else if (signalMode) {
      const sig = SIGNALS[signalIdx];
      lines.push(`${c.yellow}Send signal: ${c.bold}${sig}${c.reset}  ${fmt.dim('[←/→] change  [Enter] confirm  [Esc] cancel')}`);
    } else {
      const sel = filtered[selected];
      const selInfo = sel ? `${fmt.name(sel.name)} PID ${fmt.pid(sel.pid)}` : '';
      lines.push(
        `${c.bold}[↑/↓]${c.reset} nav  ${c.bold}[k]${c.reset} kill  ${c.bold}[s]${c.reset} signal  ${c.bold}[f]${c.reset} filter  ${c.bold}[q]${c.reset} quit    ${selInfo}`
      );
    }

    process.stdout.write(c.clearScreen + lines.join('\n'));
  }

  function killSelected(signal = 'SIGTERM') {
    const filtered = getFiltered();
    const p = filtered[selected];
    if (!p) return;
    clearInterval(intervalId);
    process.stdout.write(c.mainScreen + c.showCursor);
    process.stdin.setRawMode(false);
    process.stdin.pause();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    process.stdin.resume();
    rl.question(
      `\n${c.yellow}Kill ${fmt.name(p.name)} (PID ${fmt.pid(p.pid)}) with ${signal}? [y/N] ${c.reset}`,
      (ans) => {
        rl.close();
        if (ans.trim().toLowerCase() === 'y') {
          if (killPid(p.pid, signal)) {
            console.log(fmt.success(`Killed ${p.name} (PID ${p.pid})`));
          }
        } else {
          console.log(fmt.dim('Skipped.'));
        }
        // Re-enter TUI
        startTui();
      }
    );
  }

  function startTui() {
    process.stdout.write(c.altScreen + c.hideCursor);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    refresh();
    intervalId = setInterval(refresh, REFRESH_MS);

    process.stdin.on('data', (key) => {
      const filtered = getFiltered();

      if (filterMode) {
        if (key === '\r' || key === '\n') {
          filterMode = false;
          selected = 0;
          scrollOffset = 0;
          draw();
        } else if (key === '\x1b') {
          filterMode = false;
          filter = '';
          draw();
        } else if (key === '\x7f') {
          filter = filter.slice(0, -1);
          draw();
        } else if (key >= ' ') {
          filter += key;
          draw();
        }
        return;
      }

      if (signalMode) {
        if (key === '\x1b[D' || key === 'h') {
          signalIdx = (signalIdx - 1 + SIGNALS.length) % SIGNALS.length;
          draw();
        } else if (key === '\x1b[C' || key === 'l') {
          signalIdx = (signalIdx + 1) % SIGNALS.length;
          draw();
        } else if (key === '\r' || key === '\n') {
          signalMode = false;
          killSelected(SIGNALS[signalIdx]);
        } else if (key === '\x1b') {
          signalMode = false;
          draw();
        }
        return;
      }

      // Normal mode
      if (key === '\x1b[A' || key === 'k') {
        // Up (but k is also kill — handle below)
        if (key === '\x1b[A') {
          selected = Math.max(0, selected - 1);
          draw();
          return;
        }
      }
      if (key === '\x1b[B') { // Down arrow
        selected = Math.min(filtered.length - 1, selected + 1);
        draw();
        return;
      }

      switch (key) {
        case 'q':
        case '\x03': // Ctrl-C
          clearInterval(intervalId);
          process.stdout.write(c.mainScreen + c.showCursor);
          process.stdin.setRawMode(false);
          process.exit(0);
          break;
        case 'k':
          killSelected('SIGTERM');
          break;
        case 's':
          signalMode = true;
          draw();
          break;
        case 'f':
          filterMode = true;
          filter = '';
          draw();
          break;
        case 'r':
          refresh();
          break;
      }
    });
  }

  startTui();

  // Cleanup on exit
  process.on('exit', () => {
    process.stdout.write(c.mainScreen + c.showCursor);
  });
  process.on('SIGINT', () => {
    clearInterval(intervalId);
    process.stdout.write(c.mainScreen + c.showCursor);
    process.exit(0);
  });
}

// ─── Help ─────────────────────────────────────────────────────────────────────
function printHelp() {
  console.log(`
${c.bold}${c.cyan}process-killer${c.reset} ${c.dim}v1.0.0${c.reset} — kill processes by port, name, or PID

${c.bold}USAGE${c.reset}
  ${c.green}pk${c.reset} <port>               Kill process on port (most common)
  ${c.green}pk${c.reset} --name <pattern>      Kill by process name pattern
  ${c.green}pk${c.reset} --pid <pid>           Kill specific PID
  ${c.green}pk${c.reset} list [--port <port>]  List processes (or what's on a port)
  ${c.green}pk${c.reset} tui                   Interactive process browser (TUI)
  ${c.green}pk${c.reset} ports                 Show all listening ports
  ${c.green}pk${c.reset} clean                 Kill all dev server processes

${c.bold}OPTIONS${c.reset}
  --force              Skip confirmation prompt
  --signal <SIG>       Signal to send (default: SIGTERM)
                       Options: SIGTERM, SIGKILL, SIGHUP, SIGINT

${c.bold}EXAMPLES${c.reset}
  ${c.dim}pk 3000${c.reset}                   Kill whatever is on port 3000
  ${c.dim}pk 3000 --force${c.reset}           Kill without confirmation
  ${c.dim}pk 3000 --signal SIGKILL${c.reset}  Force-kill on port 3000
  ${c.dim}pk --name node${c.reset}            Kill all node processes
  ${c.dim}pk --name "python.*server"${c.reset} Kill python servers (regex)
  ${c.dim}pk --pid 12345${c.reset}            Kill specific PID
  ${c.dim}pk list${c.reset}                   List all user processes
  ${c.dim}pk list --port 8080${c.reset}       Show what's on port 8080
  ${c.dim}pk ports${c.reset}                  Show all listening ports
  ${c.dim}pk tui${c.reset}                    Launch interactive TUI
  ${c.dim}pk clean${c.reset}                  Kill all dev servers (node, python, etc.)

${c.bold}TUI KEYS${c.reset}
  ↑/↓   Navigate    k  Kill selected    s  Send signal
  f     Filter       r  Refresh          q  Quit
`);
}

// ─── CLI Argument Parser ──────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    force: false,
    signal: 'SIGTERM',
    port: null,
    name: null,
    pid: null,
    command: null,
    positional: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--force' || arg === '-f') {
      opts.force = true;
    } else if (arg === '--signal' || arg === '-s') {
      opts.signal = args[++i]?.toUpperCase() || 'SIGTERM';
    } else if (arg === '--name' || arg === '-n') {
      opts.name = args[++i];
    } else if (arg === '--pid' || arg === '-p') {
      opts.pid = parseInt(args[++i], 10);
    } else if (arg === '--port') {
      opts.port = parseInt(args[++i], 10);
    } else if (arg === '--help' || arg === '-h') {
      opts.command = 'help';
    } else if (arg === '--version' || arg === '-v') {
      opts.command = 'version';
    } else if (!arg.startsWith('-')) {
      opts.positional.push(arg);
    }
  }

  // Resolve command from positional args
  if (!opts.command) {
    const first = opts.positional[0];
    if (first === 'list') opts.command = 'list';
    else if (first === 'tui') opts.command = 'tui';
    else if (first === 'ports') opts.command = 'ports';
    else if (first === 'clean') opts.command = 'clean';
    else if (first && /^\d+$/.test(first)) {
      opts.command = 'port';
      opts.port = parseInt(first, 10);
    } else if (opts.name) {
      opts.command = 'name';
    } else if (opts.pid) {
      opts.command = 'pid';
    } else {
      opts.command = 'help';
    }
  }

  return opts;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!IS_MACOS && !IS_LINUX) {
    console.error(fmt.error('process-killer only supports macOS and Linux'));
    process.exit(1);
  }

  const opts = parseArgs(process.argv);

  switch (opts.command) {
    case 'help':
      printHelp();
      break;
    case 'version':
      console.log('1.0.0');
      break;
    case 'port':
      if (!opts.port) {
        console.error(fmt.error('Port number required'));
        process.exit(1);
      }
      await cmdPort(opts.port, opts);
      break;
    case 'name':
      if (!opts.name) {
        console.error(fmt.error('--name <pattern> required'));
        process.exit(1);
      }
      await cmdName(opts.name, opts);
      break;
    case 'pid':
      if (!opts.pid) {
        console.error(fmt.error('--pid <pid> required'));
        process.exit(1);
      }
      await cmdPid(opts.pid, opts);
      break;
    case 'list':
      cmdList(opts);
      break;
    case 'tui':
      cmdTui();
      break;
    case 'ports':
      cmdPorts();
      break;
    case 'clean':
      await cmdClean(opts);
      break;
    default:
      printHelp();
  }
}

main().catch((err) => {
  console.error(fmt.error(err.message));
  process.exit(1);
});
