// strays: what the scan found, grouped and put into words. No `$` here: every
// function is plain data in, plain data out, so the tests call them directly.

/** How a process was tied to Claude Code: bin/scan.sh says what each letter stands for. */
export type How = 'e' | 'w' | 't' | 'g'

/** One process, as bin/scan.sh prints it. */
export type Proc = {
  pid: number
  ppid: number
  seconds: number
  rssKb: number
  sid: string
  claudePid: string
  isAlive: boolean
  isAttached: boolean
  ports: number[]
  cwd: string
  how: How
  pgid: number
  cpu: number
  start: number
  command: string
}

/**
 * Why a process is here: its session is gone (`orphan`); its session runs but
 * it was cut loose from it, as with nohup or & (`detached`); it still hangs
 * under a running session (`running`); it is a session's MCP server or helper (`mcp`).
 */
export type Kind = 'orphan' | 'detached' | 'running' | 'mcp'

export type Member = { pid: number; start: number; label: string; rssKb: number }

/** A process and everything it started, shown and ended as one. */
export type Group = {
  pid: number
  kind: Kind
  label: string
  icon: string
  command: string
  members: Member[]
  ports: number[]
  rssKb: number
  cpu: number
  seconds: number
  start: number
  cwd: string
  sid: string
  claudePid: string
  how: How
}

export const SECTIONS: { kind: Kind; icon: string; title: string; why: string }[] = [
  { kind: 'orphan', icon: '👻', title: 'Left behind', why: 'session closed' },
  { kind: 'detached', icon: '🌙', title: 'In the background', why: 'session still open' },
  { kind: 'running', icon: '🏃', title: 'Still running', why: 'under an open session, for over a minute' },
  { kind: 'mcp', icon: '🔌', title: 'MCP servers and helpers', why: 'ending one breaks its session' },
]

const STATE: Record<Kind, string> = {
  orphan: 'left behind: the session that started it is closed',
  detached: 'in the background: its session is still open, and it runs outside it',
  running: 'running under an open session',
  mcp: 'an MCP server or helper of an open session',
}

const FOUND: Record<How, string> = {
  e: "Claude Code's mark in its environment (CLAUDECODE=1)",
  w: 'it is the shell the Bash tool ran a command in',
  t: 'its place in the process tree, under a Claude Code session',
  g: 'its process group, shared with a process Claude Code marked',
}

export function parse(stdout: string): Proc[] {
  const procs: Proc[] = []
  for (const line of stdout.split('\n')) {
    const f = line.split('\t')
    if (f.length < 15) continue
    procs.push({
      pid: Number(f[0]),
      ppid: Number(f[1]),
      seconds: Number(f[2]),
      rssKb: Number(f[3]),
      sid: f[4] ?? '',
      claudePid: f[5] ?? '',
      isAlive: f[6] === '1',
      isAttached: f[7] === '1',
      ports: (f[8] ?? '').split(',').filter(Boolean).map(Number),
      cwd: f[9] ?? '',
      how: (['e', 'w', 't', 'g'].includes(f[10] ?? '') ? f[10] : 'e') as How,
      pgid: Number(f[11]),
      cpu: Number((f[12] ?? '0').replace(',', '.')) || 0,
      start: Number(f[13]),
      command: f.slice(14).join(' '),
    })
  }

  return procs
}

export const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const isSession = (command: string) => basename(command.split(' ')[0] ?? '') === 'claude'
// A browser's crash reporter runs beside it and ends with it: not worth a row.
const isNoise = (command: string) => /crashpad[_-]handler/.test(command)

/** The command as a person would recognize it: what the Bash tool was asked to run, every path cut to its name. */
export function describe(command: string) {
  let text = command
  // The Bash tool runs a command as `zsh -c source <snapshot> … && eval '<command>' …`
  const at = text.indexOf("eval '")
  if (text.includes('/shell-snapshots/') && at >= 0) {
    text = text.slice(at + 6)
    const quote = text.lastIndexOf("'")
    if (quote > 0) text = text.slice(0, quote)
  }
  text = text.replace(/\s+/g, ' ').trim()
  // An app's program sits in a bundle whose path may hold spaces: name it for
  // the bundle, and go on with what follows the program.
  let name = ''
  const bundle = text.lastIndexOf('.app/Contents/MacOS/')
  if (text.startsWith('/') && bundle >= 0) {
    name = basename(text.slice(0, bundle))
    const rest = text.slice(bundle + '.app/Contents/MacOS/'.length)
    text = rest.startsWith(name) ? rest.slice(name.length) : rest.slice(Math.max(0, rest.indexOf(' ')))
  }
  // Every path is cut to its last name: node_modules/.bin/vite reads vite.
  const isPath = (word: string) =>
    word.includes('/') && !word.startsWith('-') && !word.includes('://') && !word.endsWith('/') && !word.startsWith('/dev/')
  const words = text
    .split(' ')
    .filter(Boolean)
    .map(word => (isPath(word) ? basename(word) : word))

  return [name, ...words].filter(Boolean).join(' ')
}

// What a process is, at a glance. Each icon is one emoji two cells wide, so rows line up.
const ICONS: [RegExp, string][] = [
  [/chrome|chromium|firefox|webkit|playwright|puppeteer/i, '🌐'],
  [/\b(jest|vitest|pytest|mocha|playwright test|cargo test|go test)\b|\b(npm|pnpm|yarn|bun) (run )?test\b/i, '🧪'],
  [/\b(postgres|psql|mysqld?|redis(-server)?|mongod?|sqlite3?)\b/i, '💾'],
  [/\bdocker\b|\bpodman\b/i, '🐳'],
  [/\b(tail|less|watch|fswatch|chokidar|nodemon)\b|--watch\b/i, '👀'],
  [/^(npm|pnpm|yarn|bun|npx|bunx)\b/i, '📦'],
  [/^(node|deno|tsx|ts-node)(\s|$)|\b(vite|next|webpack|esbuild|astro|nuxt)\b/i, '🟩'],
  [/^python[\d.]*(\s|$)|\b(uvicorn|gunicorn|flask|django|manage\.py)\b/i, '🐍'],
  [/^(ruby|rails|bundle|rake)\b/i, '💎'],
  [/^(cargo|rustc)\b|target\/(debug|release)\//i, '🦀'],
  [/^(go|air)\b/i, '🐹'],
  [/^(java|gradle|mvn)\b/i, '🍵'],
  [/^(sh|bash|zsh|fish|nc|ssh|socat)\b|&&|\bwhile\b/i, '🐚'],
]

export function iconOf(label: string, command: string) {
  for (const [pattern, icon] of ICONS) if (pattern.test(label) || pattern.test(command)) return icon

  return '🔧'
}

export function group(procs: Proc[]): Group[] {
  const shown = procs.filter(p => !isSession(p.command) && !isNoise(p.command))
  const pids = new Set(shown.map(p => p.pid))
  const children = new Map<number, Proc[]>()
  for (const p of shown) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
  const out: Group[] = []
  for (const root of shown) {
    if (pids.has(root.ppid)) continue
    const members: Proc[] = []
    for (const queue = [root]; queue.length > 0; ) {
      const next = queue.shift()
      if (!next) break
      members.push(next)
      queue.push(...(children.get(next.pid) ?? []))
    }
    const kind: Kind = !root.isAlive ? 'orphan' : root.claudePid === '' ? 'mcp' : root.isAttached ? 'running' : 'detached'
    const label = describe(root.command)
    out.push({
      pid: root.pid,
      kind,
      label,
      icon: iconOf(label, root.command),
      command: root.command.replace(/\s+/g, ' ').trim(),
      // children first, so a parent does not restart what was just ended
      members: members.map(m => ({ pid: m.pid, start: m.start, label: describe(m.command), rssKb: m.rssKb })).reverse(),
      ports: [...new Set(members.flatMap(m => m.ports))].sort((a, b) => a - b),
      rssKb: members.reduce((sum, m) => sum + m.rssKb, 0),
      cpu: Math.round(members.reduce((sum, m) => sum + m.cpu, 0) * 10) / 10,
      seconds: root.seconds,
      start: root.start,
      cwd: root.cwd,
      sid: root.sid,
      claudePid: root.claudePid,
      how: root.how,
    })
  }

  return out.sort((a, b) => b.seconds - a.seconds)
}

export function age(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`

  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`
}

export const megabytes = (kb: number) =>
  kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(kb / 1024))} MB`
export const portsText = (g: Group) => g.ports.map(p => `:${p}`).join(' ')
export const portsOf = (list: Group[]) => {
  const ports = [...new Set(list.flatMap(g => g.ports))].map(p => `:${p}`)

  return ports.length > 4 ? `${ports.slice(0, 4).join(' ')} +${ports.length - 4}` : ports.join(' ')
}
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : word.endsWith('s') ? 'es' : 's'}`
export const fit = (text: string, width: number) =>
  text.length > width ? text.slice(0, Math.max(1, width - 1)) + '…' : text.padEnd(width)

// A command the Bash tool is running right now is not worth a row: under an open
// session, only what has run for a minute is shown.
export const visible = (groups: Group[], kind: Kind) =>
  groups.filter(g => g.kind === kind && (kind !== 'running' || g.seconds >= 60))

/** The groups in the order they are shown, MCP servers last and only on request. */
export const shown = (groups: Group[], withMcp: boolean) =>
  SECTIONS.filter(s => withMcp || s.kind !== 'mcp').flatMap(s => visible(groups, s.kind))

/** How wide each column is, so every row of the list lines up. */
export function widths(list: Group[], columns: number) {
  const port = Math.min(14, Math.max(5, ...list.map(g => portsText(g).length)))
  const folder = Math.min(16, Math.max(4, ...list.map(g => (basename(g.cwd) || '/').length)))
  // age and memory are short and right-aligned; the command gets what it needs, up to what is left
  const longest = Math.max(16, ...list.map(g => g.label.length))
  const name = Math.min(longest, Math.max(16, columns - port - folder - 6 - 8 - 4 * 2 - 10))

  return { port, name, folder }
}

/** One process as one line: port, what it is, folder, age, memory. */
export function line(g: Group, w: ReturnType<typeof widths>) {
  return [
    fit(portsText(g) || '—', w.port),
    `${g.icon} ${fit(g.label, w.name)}`,
    fit(basename(g.cwd) || '/', w.folder),
    age(g.seconds).padStart(6),
    megabytes(g.rssKb).padStart(8),
  ].join('  ')
}

/** The list as text, each row numbered: the number is what `/strays 2` and `/strays kill 2` name. */
export function listText(groups: Group[], me: string) {
  const rows = shown(groups, false)
  const w = widths(rows, 100)
  const order = rows.map(g => g.pid)
  if (rows.length === 0) return { text: '✨ All clean: nothing Claude Code started is still running.', order }
  const digits = String(rows.length).length
  const blocks = SECTIONS.filter(s => s.kind !== 'mcp')
    .map(section => ({ ...section, rows: visible(groups, section.kind) }))
    .filter(section => section.rows.length > 0)
    .map(section =>
      [
        `${section.icon} ${section.title} (${section.why})`,
        ...section.rows.map(
          g =>
            `  ${String(order.indexOf(g.pid) + 1).padStart(digits)}  ${line(g, w).trimEnd()}${g.sid === me && g.kind !== 'orphan' ? '  this session' : ''}`,
        ),
      ].join('\n'),
    )
  const hasOrphans = rows.some(g => g.kind === 'orphan')
  const hint = `/strays 1 shows one in full · /strays kill 1 ends it${hasOrphans ? ' · /strays kill all ends the left-behind ones' : ''} · /strays ui opens the panel`

  return { text: [...blocks, hint].join('\n\n'), order }
}

/** What bin/info.sh printed: one value a key, and every listening address. */
export type Info = { fields: Record<string, string>; listen: string[] }

export function parseInfo(stdout: string): Info {
  const info: Info = { fields: {}, listen: [] }
  for (const row of stdout.split('\n')) {
    const tab = row.indexOf('\t')
    if (tab < 0) continue
    const key = row.slice(0, tab)
    const value = row.slice(tab + 1).trim()
    if (key === 'listen') info.listen.push(value)
    else info.fields[key] = value
  }

  return info
}

/** Everything known about one group, as label and value pairs in the order they are shown. */
export function facts(g: Group, info: Info | null): [string, string][] {
  const f = info?.fields ?? {}
  const session = f.session_alive
    ? `${f.session_name || 'open'} · ${f.session_kind === 'claude-vscode' ? 'VS Code' : f.session_kind === 'cli' ? 'terminal' : f.session_kind || 'Claude Code'} · ${f.session_status || 'open'}`
    : `closed${g.sid ? ` · ${g.sid.slice(0, 8)}` : ''}`
  const project = f.session_cwd || f.transcript_cwd || ''
  const rows: [string, string][] = [
    ['State', STATE[g.kind]],
    ['Ports', g.ports.length > 0 ? `${portsText(g)}  →  http://localhost:${g.ports[0]}` : ''],
    ['Folder', f.cwd || g.cwd],
    ['Command', f.command || g.command],
    ['Program', f.program ?? ''],
    ['Started', f.started ? `${f.started} (${age(g.seconds)} ago)` : `${age(g.seconds)} ago`],
    ['Memory', `${megabytes(g.rssKb)}${g.members.length > 1 ? ` in ${g.members.length} processes` : ''} · CPU ${g.cpu}%`],
    ['Processes', g.members.map(m => `${m.pid} ${m.label}`).reverse().join('\n')],
    ['Session', session],
    ['Project', project],
    ['Transcript', f.transcript ?? ''],
    ['Found by', FOUND[g.how]],
  ]

  return rows.filter(([, value]) => value !== '')
}

/** One group in full, as text. */
export function detailText(g: Group, info: Info | null, index: number) {
  const pad = 11
  const body = facts(g, info).map(([label, value]) => {
    const [first, ...rest] = value.split('\n')

    return [`  ${label.padEnd(pad)}${first}`, ...rest.map(more => `  ${' '.repeat(pad)}${more}`)].join('\n')
  })
  const name = index > 0 ? `#${index}  ` : ''

  return [`${name}${g.icon} ${g.label}`, ...body, '', `/strays kill ${index > 0 ? index : g.pid} ends it`].join('\n')
}

/** What a word after /strays asks for. */
export type Ask = { verb: 'list' | 'ui' | 'info' | 'kill' | 'help'; target: string }

const VERBS: Record<string, Ask['verb']> = {
  list: 'list', ls: 'list', l: 'list',
  ui: 'ui', u: 'ui', panel: 'ui', pane: 'ui', p: 'ui', open: 'ui', o: 'ui',
  info: 'info', i: 'info', show: 'info', s: 'info', detail: 'info', details: 'info', d: 'info',
  kill: 'kill', k: 'kill', end: 'kill', e: 'kill', stop: 'kill', x: 'kill',
  help: 'help', h: 'help', '?': 'help',
}

export function parseArgs(args: string): Ask {
  const [first = '', ...rest] = args.trim().split(/\s+/)
  if (first === '') return { verb: 'list', target: '' }
  const verb = VERBS[first.toLowerCase()]
  if (verb) return { verb, target: rest.join(' ') }
  // A bare number, pid or :port asks for that one in full.
  if (/^[:#]?\d+$/.test(first)) return { verb: 'info', target: first }

  return { verb: 'help', target: first }
}

/** The group a word names: `2` (its number in the last list, else a pid), `#2`, or `:3000` (a port). */
export function resolve(target: string, groups: Group[], order: number[]): Group | undefined {
  const word = target.trim()
  if (/^:\d+$/.test(word)) return groups.find(g => g.ports.includes(Number(word.slice(1))))
  const n = Number(word.replace(/^#/, ''))
  if (!Number.isInteger(n) || n <= 0) return undefined
  const listed = order[n - 1]
  const byNumber = listed === undefined ? undefined : groups.find(g => g.pid === listed)

  return byNumber ?? groups.find(g => g.pid === n || g.members.some(m => m.pid === n))
}

export const HELP = [
  'strays: processes Claude Code started and left running, in any session',
  '',
  '  /strays              the list, each row numbered',
  '  /strays 2            row 2 in full: folder, command, start time, memory, session   (also: i, info, show)',
  '  /strays :3000        the same, for whatever listens on port 3000',
  '  /strays kill 2       end row 2 and what it started   (also: k, end, stop; a pid or :port works too)',
  '  /strays kill all     end every left-behind one',
  '  /strays ui           the panel: click a row for details, click End to end it   (also: u, open)',
  '',
  '  /ps is the same command, shorter.',
].join('\n')
