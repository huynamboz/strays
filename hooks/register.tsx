// strays: the processes Claude Code started and left running, in any session.
// Claude Code marks every process it starts (CLAUDECODE=1 and its session's id
// in the environment), and a process keeps that mark after its session is gone:
// bin/scan.sh finds them all, /strays lists them with their ports, and Enter
// ends the one under the cursor, or one key every one whose session is gone.
import type { EngineInterface, Register } from 'claude-code'

const PANE = 'strays'

/** One marked process, as bin/scan.sh prints it. */
export type Proc = {
  pid: number
  ppid: number
  seconds: number
  rssKb: number
  sid: string
  hasClaudePid: boolean
  isAlive: boolean
  isAttached: boolean
  ports: number[]
  cwd: string
  command: string
}

/**
 * Why a process is here: its session is gone (`orphan`); its session runs but
 * it was cut loose from it, as with nohup or & (`detached`); it still hangs
 * under a running session (`running`); it is a session's MCP server (`mcp`).
 */
export type Kind = 'orphan' | 'detached' | 'running' | 'mcp'

/** A process and everything it started, shown and ended as one. */
export type Group = {
  pid: number
  kind: Kind
  label: string
  pids: number[]
  ports: number[]
  rssKb: number
  seconds: number
  cwd: string
  sid: string
}

const SECTIONS: { kind: Kind; title: string; why: string }[] = [
  { kind: 'orphan', title: 'Left behind', why: 'session closed' },
  { kind: 'detached', title: 'In the background', why: 'session still open' },
  { kind: 'running', title: 'Still running', why: 'under an open session, for over a minute' },
  { kind: 'mcp', title: 'MCP servers', why: 'ending one breaks its session' },
]

let groups: Group[] = []
let me = ''
let isPaneOpen = false
let isScanning = false
let showsMcp = false
// The row asked to end and waiting for a second Enter; `all` is the end-all key.
let armed: number | 'all' | null = null
let arming = 0
let ticks = 0
let statusText: string | undefined
let note = ''
// The key of the control that holds the pane's focus ring.
let focused = ''

/** The color each kind is drawn in, everywhere it shows. */
const ACCENT: Record<Kind, string> = { orphan: 'yellow', detached: 'cyan', running: 'green', mcp: 'gray' }

export function parse(stdout: string): Proc[] {
  const procs: Proc[] = []
  for (const line of stdout.split('\n')) {
    const f = line.split('\t')
    if (f.length < 11) continue
    procs.push({
      pid: Number(f[0]),
      ppid: Number(f[1]),
      seconds: Number(f[2]),
      rssKb: Number(f[3]),
      sid: f[4] ?? '',
      hasClaudePid: f[5] !== '',
      isAlive: f[6] === '1',
      isAttached: f[7] === '1',
      ports: (f[8] ?? '').split(',').filter(Boolean).map(Number),
      cwd: f[9] ?? '',
      command: f.slice(10).join(' '),
    })
  }

  return procs
}

const basename = (path: string) => path.slice(path.lastIndexOf('/') + 1)
const isSession = (command: string) => basename(command.split(' ')[0] ?? '') === 'claude'

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
  const isPath = (word: string) => word.includes('/') && !word.startsWith('-') && !word.includes('://') && !word.endsWith('/')
  const words = text
    .split(' ')
    .filter(Boolean)
    .map(word => (isPath(word) ? basename(word) : word))

  return [name, ...words].filter(Boolean).join(' ')
}

// A browser's crash reporter runs beside it and ends with it: not worth a row.
const isNoise = (command: string) => /crashpad[_-]handler/.test(command)

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
    const kind: Kind = !root.isAlive ? 'orphan' : !root.hasClaudePid ? 'mcp' : root.isAttached ? 'running' : 'detached'
    out.push({
      pid: root.pid,
      kind,
      label: describe(root.command),
      // children first, so a parent does not restart what was just ended
      pids: members.map(m => m.pid).reverse(),
      ports: [...new Set(members.flatMap(m => m.ports))].sort((a, b) => a - b),
      rssKb: members.reduce((sum, m) => sum + m.rssKb, 0),
      seconds: root.seconds,
      cwd: root.cwd,
      sid: root.sid,
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

const megabytes = (kb: number) =>
  kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(kb / 1024))} MB`
const portsText = (g: Group) => g.ports.map(p => `:${p}`).join(' ')
const portsOf = (list: Group[]) => {
  const ports = [...new Set(list.flatMap(g => g.ports))].map(p => `:${p}`)

  return ports.length > 4 ? `${ports.slice(0, 4).join(' ')} +${ports.length - 4}` : ports.join(' ')
}
const strays = () => groups.filter(g => g.kind === 'orphan' || g.kind === 'detached')
const orphans = () => groups.filter(g => g.kind === 'orphan')
// A command the Bash tool is running right now is not worth a row: under an open
// session, only what has run for a minute is shown.
const visible = (kind: Kind) => groups.filter(g => g.kind === kind && (kind !== 'running' || g.seconds >= 60))
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : word.endsWith('s') ? 'es' : 's'}`
const fit = (text: string, width: number) =>
  text.length > width ? text.slice(0, Math.max(1, width - 1)) + '…' : text.padEnd(width)

/** How wide each column is, so every row of the list lines up. */
export function widths(list: Group[], columns: number) {
  const port = Math.min(14, Math.max(5, ...list.map(g => portsText(g).length)))
  const folder = Math.min(16, Math.max(4, ...list.map(g => (basename(g.cwd) || '/').length)))
  // age and memory are short and right-aligned; the command gets what it needs, up to what is left
  const longest = Math.max(16, ...list.map(g => g.label.length))
  const name = Math.min(longest, Math.max(16, columns - port - folder - 6 - 8 - 4 * 2 - 4))

  return { port, name, folder }
}

/** One process as one line: port, command, folder, age, memory. */
export function line(g: Group, w: ReturnType<typeof widths>) {
  return [
    fit(portsText(g) || '—', w.port),
    fit(g.label, w.name),
    fit(basename(g.cwd) || '/', w.folder),
    age(g.seconds).padStart(6),
    megabytes(g.rssKb).padStart(8),
  ].join('  ')
}

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')

async function scan($: EngineInterface) {
  if (isScanning) return
  isScanning = true
  try {
    const ran = await $.process.run(['sh', `${$.plugin.root}/bin/scan.sh`], { timeoutMs: 20_000 })
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `scan exited ${ran.exitCode}`)
    groups = group(parse(ran.stdout))
    const left = strays()
    const text =
      left.length === 0
        ? undefined
        : `${plural(left.length, 'stray process')}${portsOf(left) ? ` on ${portsOf(left)}` : ''} · /strays`
    if (text !== statusText) {
      statusText = text
      $.ui.status(text)
    }
  } catch (err) {
    note = `scan failed: ${String(err)}`
  } finally {
    isScanning = false
  }
  redraw($)
}

async function stop($: EngineInterface, list: Group[]) {
  const pids = list.flatMap(g => g.pids)
  if (pids.length === 0) return 0
  const ran = await $.process.run(['sh', `${$.plugin.root}/bin/kill.sh`, ...pids.map(String)], { timeoutMs: 20_000 })
  const ended = ran.stdout.trim().split(/\s+/).filter(Boolean).length
  note = `ended ${plural(ended, 'process')}`
  await scan($)

  return ended
}

/**
 * The first press asks, the second one within four seconds ends: `what` is a
 * row's pid or `all`. A press elsewhere, or the wait, takes the question back.
 */
async function press($: EngineInterface, what: number | 'all', list: () => Group[]) {
  if (armed !== what) {
    armed = what
    const mine = ++arming
    redraw($)
    $.clock.after(4000, () => {
      if (arming !== mine || armed !== what) return
      armed = null
      redraw($)
    })

    return
  }
  armed = null
  await stop($, list())
  // The row that held the ring is gone: hand the ring to the first one left.
  const next = SECTIONS.filter(section => section.kind !== 'mcp' || showsMcp).flatMap(section => visible(section.kind))[0]
  if (!next || !isPaneOpen) return
  // once the list has been drawn again without the ended row
  $.clock.after(250, async () => {
    const key = `row-${next.pid}`
    const moved = await $.ui.focus({ requestId: PANE, key }).catch(err => ({ deny: String(err) }))
    if (moved.deny) return
    // a move this module asked for does not come back through its own ui.focus hook
    focused = key
    redraw($)
  })
}

/** The emoji that carries each kind's color where text has none of its own (markdown). */
const DOT: Record<Kind, string> = { orphan: '🟡', detached: '🔵', running: '🟢', mcp: '⚪' }

const cut = (text: string, width: number) => (text.length > width ? text.slice(0, width - 1) + '…' : text)
// Words that stay on one line when a narrow table folds its cells.
const together = (text: string) => text.replace(/ /g, ' ')
// A table cell: a pipe would end it, and markdown's marks would be read as marks.
const plain = (text: string) => text.replace(/[\\`*_[\]<>|~]/g, '\\$&')
const code = (text: string) => {
  const ticks = '`'.repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length)) + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''

  return `${ticks}${pad}${text.replace(/\|/g, '\\|')}${pad}${ticks}`
}

/**
 * The list as markdown, for where a command's answer is drawn as a reply is
 * (the editor's panel): one table, each group named on its first row. Columns
 * padded with spaces do not line up there, the font is not monospace.
 */
export function table(list: Group[], session: string) {
  const sections = SECTIONS.map(section => ({ ...section, rows: list.filter(g => g.kind === section.kind) })).filter(
    section => section.rows.length > 0,
  )
  if (sections.length === 0) return ''
  const held = list.filter(g => g.kind === 'orphan' || g.kind === 'detached').reduce((sum, g) => sum + g.rssKb, 0)
  const counts = sections.map(section => `**${section.rows.length}** ${section.title.toLowerCase()}`)
  if (held > 0) counts.push(`**${megabytes(held)}** held`)
  const rows = sections.flatMap(section =>
    section.rows.map((g, i) => {
      const ports = g.ports.slice(0, 3).map(p => `:${p}`)
      if (g.ports.length > 3) ports.push(`+${g.ports.length - 3}`)
      const size = together(megabytes(g.rssKb))

      return [
        i === 0 ? together(`${DOT[section.kind]} **${section.title}**`) : '',
        ports.join(' '),
        code(cut(g.label, 56)) + (g.sid === session && g.kind !== 'orphan' ? ' _this session_' : ''),
        plain(basename(g.cwd) || '/'),
        together(age(g.seconds)),
        // what the pane's memory bar draws in yellow or red
        g.rssKb > 300 * 1024 ? `**${size}**` : size,
      ]
    }),
  )

  return [
    counts.join(' · '),
    '',
    '| | Port | Command | Folder | Running | Memory |',
    '| :- | :- | :- | :- | -: | -: |',
    ...rows.map(cells => `| ${cells.join(' | ')} |`),
    ...(sections.some(section => section.kind === 'orphan') ? ['', '`/strays kill` ends what was left behind.'] : []),
  ].join('\n')
}

// MCP servers belong to sessions that are open: the pane shows them on request, the text never.
const listing = (isMarkdown: boolean) => {
  const shown = SECTIONS.filter(s => s.kind !== 'mcp').flatMap(s => visible(s.kind))
  if (isMarkdown) return table(shown, me)
  const w = widths(shown, 100)

  return SECTIONS.filter(s => s.kind !== 'mcp')
    .map(section => ({ ...section, rows: visible(section.kind) }))
    .filter(section => section.rows.length > 0)
    .map(section =>
      [
        `${section.title} (${section.why})`,
        ...section.rows.map(g => `  ${line(g, w).trimEnd()}${g.sid === me && g.kind !== 'orphan' ? '  this session' : ''}`),
      ].join('\n'),
    )
    .join('\n\n')
}

/**
 * Whether a command's answer is drawn as markdown here, in a font that is not
 * monospace: the editor's panel, and a session no terminal draws.
 */
async function drawsMarkdown($: EngineInterface) {
  const entry = await $.env.get('CLAUDE_CODE_ENTRYPOINT').catch(() => undefined)
  if (entry === 'claude-vscode') return true
  const surfaces = await $.session.surfaces()

  return surfaces.length > 0 && !surfaces.includes('terminal')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: 'strays',
        description: 'Processes Claude Code started and left running, in any session: see them, end them',
        argumentHint: '[list | kill]',
        immediate: true,
      })
    } catch (err) {
      $.ui.log(`/strays was not added: ${String(err)}`)
    }
    me = await $.session.id()
    // Off the session's start: look once now, then every half minute, or every five seconds while the pane is open.
    $.clock.after(0, async () => {
      await scan($)
      const left = orphans()
      if (left.length > 0) {
        const size = megabytes(left.reduce((sum, g) => sum + g.rssKb, 0))
        $.ui.toast(`${plural(left.length, 'process')} from earlier Claude Code sessions still running (${size}): /strays`)
      }
    })
    $.clock.every(5000, () => {
      ticks += 1
      if (isPaneOpen || ticks % 6 === 0) void scan($)
    })

    return next(e)
  })

  on('command.run', { command: 'strays' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'list' || arg === 'kill') {
      await scan($)
      const isMarkdown = await drawsMarkdown($)
      if (arg === 'kill') {
        const ended = await stop($, orphans())

        return {
          text: `Ended ${plural(ended, 'process')} whose session was closed.\n\n${listing(isMarkdown) || 'Nothing else is running.'}`,
        }
      }

      return { text: listing(isMarkdown) || 'No process started by Claude Code is running.' }
    }
    isPaneOpen = true
    note = ''
    armed = null
    await $.ui.open({ id: PANE, title: 'Strays', focus: true, rows: 16, columns: 90 })
    void scan($)

    return {}
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    isPaneOpen = false
    armed = null

    return next(e)
  })

  // The ring moved: the row that holds it is the one drawn as chosen.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (!moved.deny && (e.element ?? '') !== focused) {
      focused = e.element ?? ''
      redraw($)
    }

    return moved
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const sections = SECTIONS.filter(s => s.kind !== 'mcp' || showsMcp)
      .map(section => ({ ...section, rows: visible(section.kind) }))
      .filter(section => section.rows.length > 0)
    const rows = sections.flatMap(section => section.rows)
    const gone = orphans()
    const loose = visible('detached')
    const left = strays()
    const hidden = showsMcp ? 0 : visible('mcp').length
    const first = rows[0]?.pid
    const columns = e.props.bodyColumns
    const isWide = columns >= 72
    const portWidth = Math.min(12, Math.max(5, ...rows.map(g => portsText(g).length)))
    const biggest = Math.max(256 * 1024, ...rows.map(g => g.rssKb))
    const folderWidth = Math.min(10, Math.max(3, ...rows.map(g => (basename(g.cwd) || '/').length)))
    // The command takes what the fixed columns leave, within bounds: a long
    // command is cut, so it never widens the pane over the transcript.
    // Beside the transcript the pane is as wide as its content asks, so the
    // list keeps to about ninety columns there whatever room there is.
    const fixed = 1 + (portWidth + 2) + 15 + (8 + folderWidth) + 7 + 5 + 4
    const nameWidth = e.props.placement === 'dock' ? 38 - portWidth : Math.min(64, Math.max(14, columns - fixed))
    // A frame hugs its rows (the widest, with the question's longer button) and stops at the pane's edge.
    const frameWidth = Math.min(columns, 1 + (portWidth + 2) + nameWidth + 15 + (8 + folderWidth) + 15 + 5 + 4)

    // A number over its name, in a frame the color of what it counts.
    const tile = (value: string, name: string, color: string, isLit: boolean) => (
      <Box flexDirection="column" borderStyle="round" borderColor={color} borderDimColor={!isLit} paddingX={1} width={18}>
        <Text bold color={isLit ? color : undefined} dimColor={!isLit}>
          {value}
        </Text>
        <Text dimColor>{name}</Text>
      </Box>
    )

    // Memory as a bar: eight cells against the heaviest process here (256 MB at least).
    const meter = (g: Group) => {
      const filled = Math.max(1, Math.round((g.rssKb / biggest) * 8))
      const color = g.rssKb > 1024 * 1024 ? 'red' : g.rssKb > 300 * 1024 ? 'yellow' : 'green'

      return (
        <Box flexDirection="row" flexShrink={0}>
          <Text color={color} wrap="truncate">
            {'█'.repeat(filled)}
          </Text>
          <Text dimColor wrap="truncate">
            {'░'.repeat(8 - filled)}
          </Text>
          <Text dimColor wrap="truncate">
            {megabytes(g.rssKb).padStart(7)}
          </Text>
        </Box>
      )
    }

    const item = (g: Group) => {
      const color = ACCENT[g.kind]
      const key = `row-${g.pid}`
      const isChosen = focused === key
      const isAsked = armed === g.pid
      const port = portsText(g)
      // Everything but the command keeps its width: the command gives way and is cut with an ellipsis.
      const mark = (
        <Box flexShrink={0}>
          <Text bold color={color}>
            {isChosen ? '❯' : ' '}
          </Text>
        </Box>
      )
      const pill = (
        <Box flexShrink={0}>
          {port ? (
            <Text backgroundColor={color} color="black" bold wrap="truncate">
              {` ${fit(port, portWidth)} `}
            </Text>
          ) : (
            <Text dimColor wrap="truncate">
              {` ${fit('·', portWidth)} `}
            </Text>
          )}
        </Box>
      )
      const name = (
        <Box flexShrink={0}>
          <Text bold={isChosen || g.kind === 'orphan'} color={isAsked ? 'red' : undefined} wrap="truncate">
            {fit(isAsked ? `End ${g.label}?` : g.label, isWide ? nameWidth : Math.max(14, columns - portWidth - 10))}
          </Text>
        </Box>
      )
      const facts = (
        <Box flexShrink={0}>
          <Text dimColor wrap="truncate">
            {`${age(g.seconds).padStart(6)}  ${fit(basename(g.cwd) || '/', folderWidth)}`}
          </Text>
        </Box>
      )
      // The one control of the row: the arrows land on it, Enter asks, Enter again ends.
      const button = (
        <Box flexShrink={0}>
        <Button
          key={key}
          label={isAsked ? 'Yes, end it' : 'End'}
          {...(isAsked ? { variant: 'primary' as const } : {})}
          {...(g.pid === first ? { autoFocus: true as const } : {})}
          onPress={() => press($, g.pid, () => groups.filter(x => x.pid === g.pid))}
        />
        </Box>
      )
      if (isWide) {
        return (
          <Box flexDirection="row" columnGap={1}>
            {mark}
            {pill}
            {name}
            {meter(g)}
            {facts}
            {button}
          </Box>
        )
      }

      // A narrow pane (docked beside the transcript): the same row on two lines.
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {mark}
            {pill}
            {name}
          </Box>
          <Box flexDirection="row" columnGap={1} paddingLeft={2}>
            {meter(g)}
            {facts}
            {button}
          </Box>
        </Box>
      )
    }

    const memory = megabytes(left.reduce((sum, g) => sum + g.rssKb, 0))
    const title = (section: (typeof sections)[number]) => (
      <Box flexDirection="row" columnGap={1}>
        <Text bold color={ACCENT[section.kind]}>
          {`● ${section.title}`}
        </Text>
        <Text dimColor>{section.why}</Text>
      </Box>
    )
    const actions = (
      <Box flexDirection="row" columnGap={2}>
        {gone.length > 0 && (
          <Button
            key="end-orphans"
            label={armed === 'all' ? `Press o again to end ${gone.length}` : `End all left behind (${gone.length})`}
            hotkey="o"
            variant="primary"
            onPress={() => press($, 'all', orphans)}
          />
        )}
        <Button key="refresh" label="Refresh" hotkey="r" dimColor onPress={() => scan($)} />
        <Button
          key="mcp"
          label={showsMcp ? 'Hide MCP' : `MCP${hidden > 0 ? ` (${hidden})` : ''}`}
          hotkey="m"
          dimColor
          onPress={() => {
            showsMcp = !showsMcp
            redraw($)
          }}
        />
        <Button key="close" label="Close" hotkey="x" dimColor role="dismiss" onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )
    const hint = <Text dimColor>{`↑↓ move   ⏎ end   ${gone.length > 0 ? 'o end all   ' : ''}r refresh   m MCP   x close`}</Text>
    const done = note !== '' && <Text color="green">{`✓ ${note}`}</Text>

    // Above the prompt a pane is wide and short: the counts become one line of
    // labels, the actions sit under them where they are never cut off, and the
    // groups lose their frames.
    if (e.props.placement === 'inline') {
      const badge = (text: string, color: string, isLit: boolean) =>
        isLit ? (
          <Text backgroundColor={color} color="black" bold>
            {` ${text} `}
          </Text>
        ) : (
          <Text dimColor>{` ${text} `}</Text>
        )

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {rows.length === 0 && left.length === 0 ? (
              <Text bold color="green">
                ✓ All clean: nothing Claude Code started is still running
              </Text>
            ) : (
              <Box flexDirection="row" columnGap={1}>
                {badge(`${gone.length} left behind`, ACCENT.orphan, gone.length > 0)}
                {badge(`${loose.length} in background`, ACCENT.detached, loose.length > 0)}
                {badge(`${memory} held`, 'magenta', left.length > 0)}
              </Box>
            )}
            {done}
          </Box>
          {actions}
          {sections.map(section => (
            <Box flexDirection="column">
              {title(section)}
              {section.rows.map(item)}
            </Box>
          ))}
          {hint}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={1}>
          {tile(String(gone.length), 'left behind', ACCENT.orphan, gone.length > 0)}
          {tile(String(loose.length), 'in background', ACCENT.detached, loose.length > 0)}
          {tile(memory.split(' ')[0] ?? '', `${memory.split(' ')[1] ?? 'MB'} held`, 'magenta', left.length > 0)}
        </Box>
        {rows.length === 0 && (
          <Box borderStyle="round" borderColor="green" paddingX={2} flexDirection="column">
            <Text bold color="green">
              ✓ All clean
            </Text>
            <Text dimColor>Nothing Claude Code started is still running.</Text>
          </Box>
        )}
        {sections.map(section => (
          <Box
            flexDirection="column"
            borderStyle="round"
            borderColor={ACCENT[section.kind]}
            borderDimColor={section.kind === 'running' || section.kind === 'mcp'}
            paddingX={1}
            width={frameWidth}
          >
            {title(section)}
            {section.rows.map(item)}
          </Box>
        ))}
        {done}
        {actions}
        {hint}
      </Box>
    )
  })
}
