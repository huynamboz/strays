// strays: the processes Claude Code started and left running, in any session.
// bin/scan.sh finds them (by Claude Code's mark, the Bash tool's shell, the
// process tree and the process group); /strays lists them, numbered, wherever
// Claude Code runs; `/strays 2` shows one in full and `/strays kill 2` ends it;
// `/strays ui` opens a panel in the terminal and the desktop app where a click
// on a row shows it in full and a click on End ends it. A server left behind
// beside a newer copy of it (vite on :3000, the new one on :3001) is marked as
// an older copy everywhere it shows, and told of once in a toast.
import type { EngineInterface, Register } from 'claude-code'

import {
  HELP,
  HELP_MARKDOWN,
  SECTIONS,
  age,
  basename,
  clashNote,
  clashToast,
  clashes,
  detailMarkdown,
  detailText,
  facts,
  fit,
  group,
  listMarkdown,
  listText,
  megabytes,
  parse,
  parseArgs,
  parseInfo,
  plural,
  portsOf,
  portsText,
  resolve,
  shown,
  visible,
} from './procs'
import type { Clash, Group, Info, Kind } from './procs'

const PANE = 'strays'
const COMMANDS = ['strays', 'ps']
/** The color each kind is drawn in, everywhere it shows. */
const ACCENT: Record<Kind, string> = { orphan: 'yellow', detached: 'cyan', running: 'green', mcp: 'gray' }
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
// How many frames a bar takes to grow to its length when the panel opens.
const GROW = 6

let groups: Group[] = []
let me = ''
let isPaneOpen = false
let isScanning = false
let showsMcp = false
// The row asked to end and waiting for a second press; `all` is the end-all button.
let armed: number | 'all' | null = null
let arming = 0
let ticks = 0
let statusText: string | undefined
let note = ''
// The key of the control that holds the panel's focus ring.
let focused = ''
// The pids of the last numbered list, in order: what `/strays 2` names.
let order: number[] = []
// The group the panel shows in full, and what bin/info.sh said of it.
let detail: number | null = null
let info: { pid: number; data: Info } | null = null
// Animation: a frame counter that runs only while something moves.
let frame = 0
let runUntil = 0
let timer: { cancel: () => void } | null = null
let openedAt = 0
let spinUntil = 0
const ending = new Set<number>()
// The lists printed in this session, by their text: the transcript draws them from these.
const printed = new Map<string, { groups: Group[]; order: number[]; clashes: Clash[] }>()
// The old copies a toast has told of, each by its pid and start: told once.
const told = new Set<string>()
// Whether the session draws yet: a toast sent before then is dropped.
let isDrawn = false

const redraw = ($: EngineInterface) => $.ui.invalidate('ui.render')
const strays = () => groups.filter(g => g.kind === 'orphan' || g.kind === 'detached')
const orphans = () => groups.filter(g => g.kind === 'orphan')
const clashOf = (g: Group) => clashes(groups).find(c => c.old.pid === g.pid)

/** A toast for each old copy of a server that was not told of yet: once each. */
function tell($: EngineInterface) {
  for (const clash of clashes(groups)) {
    const key = `${clash.old.pid}@${clash.old.start}`
    if (told.has(key)) continue
    told.add(key)
    $.ui.toast(clashToast(clash))
  }
}

/** Keeps the frames coming for `frames` more, and stops by itself when nothing moves. */
function animate($: EngineInterface, frames: number) {
  runUntil = Math.max(runUntil, frame + frames)
  if (timer) return
  timer = $.clock.every(90, () => {
    frame += 1
    if (isPaneOpen) redraw($)
    if (frame >= runUntil && ending.size === 0) {
      timer?.cancel()
      timer = null
    }
  })
}

// The scan running now, and the one asked for while it ran: whoever awaits a
// scan gets one that started after it asked, so a command typed while the
// first scan of a session still runs does not answer from an empty list.
let running: Promise<void> | null = null
let queued: Promise<void> | null = null

function scan($: EngineInterface): Promise<void> {
  if (running) {
    queued ??= running.then(() => {
      queued = null
      return scan($)
    })
    return queued
  }
  running = scanNow($).finally(() => {
    running = null
  })
  return running
}

async function scanNow($: EngineInterface) {
  isScanning = true
  try {
    const ran = await $.process.run(['sh', `${$.plugin.root}/bin/scan.sh`], { timeoutMs: 20_000 })
    if (ran.exitCode !== 0) throw new Error(ran.stderr.trim() || `scan exited ${ran.exitCode}`)
    groups = group(parse(ran.stdout))
    if (detail !== null && !groups.some(g => g.pid === detail)) detail = null
    const left = strays()
    const text =
      left.length === 0
        ? undefined
        : `${plural(left.length, 'stray process')}${portsOf(left) ? ` on ${portsOf(left)}` : ''} · /strays`
    if (text !== statusText) {
      statusText = text
      $.ui.status(text)
    }
    if (isDrawn) tell($)
  } catch (err) {
    note = `scan failed: ${String(err)}`
  } finally {
    isScanning = false
  }
  redraw($)
}

async function stop($: EngineInterface, list: Group[]) {
  const targets = list.flatMap(g => g.members.map(m => `${m.pid}@${m.start}`))
  if (targets.length === 0) return 0
  for (const g of list) ending.add(g.pid)
  animate($, 4)
  redraw($)
  let ended = 0
  try {
    const ran = await $.process.run(['sh', `${$.plugin.root}/bin/kill.sh`, ...targets], { timeoutMs: 20_000 })
    ended = ran.stdout.trim().split(/\s+/).filter(Boolean).length
    note =
      ended > 0
        ? `ended ${list.length === 1 ? (list[0]?.label ?? '') : plural(ended, 'process')}`
        : 'nothing was ended: it had already gone or changed'
  } finally {
    for (const g of list) ending.delete(g.pid)
  }
  await scan($)

  return ended
}

async function loadInfo($: EngineInterface, g: Group) {
  try {
    const ran = await $.process.run(['sh', `${$.plugin.root}/bin/info.sh`, String(g.pid), g.sid, g.claudePid], { timeoutMs: 10_000 })
    const data = parseInfo(ran.stdout)
    info = { pid: g.pid, data }

    return data
  } catch {
    return null
  }
}

/**
 * Puts `text` on the clipboard: through the app that draws the session, else
 * through macOS itself, since the editor's panel takes no copy from a mod.
 */
async function clip($: EngineInterface, text: string) {
  const copied = await $.ui.copy({ text }).catch(() => ({ isCopied: false }))
  if (copied.isCopied) return true
  const ran = await $.process.run(['pbcopy'], { stdin: text, timeoutMs: 5000 }).catch(() => null)

  return ran?.exitCode === 0
}

/** Shows one group in full in the panel, or the list again. */
async function view($: EngineInterface, pid: number | null) {
  detail = pid
  armed = null
  note = ''
  openedAt = frame
  animate($, GROW + 2)
  const g = groups.find(x => x.pid === pid)
  if (g) await loadInfo($, g)
  redraw($)
  const key = pid === null ? `row-${shown(groups, showsMcp)[0]?.pid ?? ''}` : 'back'
  const moved = await $.ui.focus({ requestId: PANE, key }).catch(err => ({ deny: String(err) }))
  if (!moved.deny) focused = key
}

/**
 * The first press asks, the second one within four seconds ends: `what` is a
 * group's pid or `all`. A press elsewhere, or the wait, takes the question back.
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
  if (detail !== null && !groups.some(g => g.pid === detail)) detail = null
  // The row that held the ring is gone: hand the ring to the first one left.
  const next = shown(groups, showsMcp)[0]
  if (!next || !isPaneOpen) return
  $.clock.after(250, async () => {
    const key = `row-${next.pid}`
    const moved = await $.ui.focus({ requestId: PANE, key }).catch(err => ({ deny: String(err) }))
    if (moved.deny) return
    // a move this module asked for does not come back through its own ui.focus hook
    focused = key
    redraw($)
  })
}

/**
 * The numbered list, remembered so a number can name a row and, where it is
 * text, so the transcript can draw it.
 */
function listing(isMarkdown: boolean) {
  if (isMarkdown) {
    const table = listMarkdown(groups, me)
    order = table.order

    return table.text
  }
  const list = listText(groups, me)
  order = list.order
  printed.set(list.text, { groups: shown(groups, false), order: list.order, clashes: clashes(groups) })
  if (printed.size > 12) printed.delete(printed.keys().next().value ?? '')

  return list.text
}

/**
 * Whether a command's answer is drawn as markdown here, in a font that is not
 * monospace: the editor's panel, which draws none of a mod's own trees.
 */
async function drawsMarkdown($: EngineInterface) {
  const entry = await $.env.get('CLAUDE_CODE_ENTRYPOINT').catch(() => undefined)
  if (entry === 'claude-vscode') return true
  const surfaces = await $.session.surfaces()

  return surfaces.length > 0 && surfaces.every(surface => surface === 'vscode' || surface === 'mobile')
}

/**
 * Calls `fn` once the session draws somewhere: in the terminal, once its screen
 * is up and has bound the session. A toast or a status sent before then is
 * dropped, and the session's first scan may end sooner. A look every quarter
 * second; past `tries` of them `fn` runs anyway, as it did before it waited.
 */
function whenDrawn($: EngineInterface, fn: () => void, tries = 120) {
  void $.session.surfaces().then(surfaces => {
    if (surfaces.length > 0 || tries <= 1) fn()
    else $.clock.after(250, () => whenDrawn($, fn, tries - 1))
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    for (const name of COMMANDS) {
      try {
        await $.command.register({
          name,
          description:
            name === 'strays'
              ? 'Processes Claude Code started and left running: list them, see one in full, end it'
              : 'Short for /strays: processes Claude Code left running',
          argumentHint: '[number | :port | kill <number|all> | copy <number> | ui | help]',
          immediate: true,
        })
      } catch (err) {
        $.ui.log(`/${name} was not added: ${String(err)}`, { to: 'debug' })
      }
    }
    me = await $.session.id()
    // Off the session's start: look once now, then every half minute, or every five seconds while the panel is open.
    $.clock.after(0, async () => {
      await scan($)
      whenDrawn($, () => {
        isDrawn = true
        // The scan's status may have gone out before the screen was up: again, now that it is.
        if (statusText !== undefined) $.ui.status(statusText)
        const left = orphans()
        if (left.length > 0) {
          const size = megabytes(left.reduce((sum, g) => sum + g.rssKb, 0))
          $.ui.toast(`👻 ${plural(left.length, 'process')} from earlier Claude Code sessions still running (${size}): /strays`)
        }
        tell($)
      })
    })
    $.clock.every(5000, () => {
      ticks += 1
      if (isPaneOpen || ticks % 6 === 0) void scan($)
    })

    return next(e)
  })

  on('command.run', { command: ['strays', 'ps'] }, async ($, e) => {
    const ask = parseArgs(e.args)
    const isMarkdown = await drawsMarkdown($)
    if (ask.verb === 'help') return { text: isMarkdown ? HELP_MARKDOWN : HELP }
    await scan($)
    // A number names a row of the last list; before any list was printed here, of the list as it stands.
    if (order.length === 0) order = listText(groups, me).order

    if (ask.verb === 'ui' || ask.verb === 'auto') {
      // The panel draws in the terminal and the desktop app. Anywhere else (the
      // editor's panel, claude -p) the bare command prints the list instead.
      const surfaces = await $.session.surfaces()
      if (isMarkdown || !surfaces.some(surface => surface === 'terminal' || surface === 'desktop')) {
        if (ask.verb === 'auto') return { text: listing(isMarkdown) }

        return { text: `The panel draws in the terminal and the desktop app. Here it is as a list:\n\n${listing(isMarkdown)}` }
      }
      isPaneOpen = true
      note = ''
      armed = null
      detail = null
      openedAt = frame
      await $.ui.open({ id: PANE, title: 'Strays', focus: true, rows: 16, columns: 90 })
      animate($, GROW + 2)

      return {}
    }

    if (ask.verb === 'info') {
      const g = resolve(ask.target, groups, order)
      if (!g) return { text: `Nothing matches ${ask.target || 'that'}.\n\n${listing(isMarkdown)}` }

      const data = await loadInfo($, g)
      const index = order.indexOf(g.pid) + 1

      const clash = clashOf(g)

      return { text: isMarkdown ? detailMarkdown(g, data, index, clash) : detailText(g, data, index, clash) }
    }

    if (ask.verb === 'copy') {
      if (ask.target === '') return { text: `Which one? /strays copy 2 copies row 2's command.\n\n${listing(isMarkdown)}` }
      const g = resolve(ask.target, groups, order)
      if (!g) return { text: `Nothing matches ${ask.target}.\n\n${listing(isMarkdown)}` }
      // as the machine has it, whole: the scan's own copy may be cut
      const command = (await loadInfo($, g))?.fields.command || g.command
      const name = isMarkdown ? `${g.icon} \`${g.label.replace(/`/g, "'")}\`` : `${g.icon} ${g.label}`

      return {
        text: (await clip($, command))
          ? `Copied the command of ${name} to the clipboard.`
          : `The clipboard did not take it. The command of ${name}:\n\n${isMarkdown ? `\`\`\`\n${command}\n\`\`\`` : command}`,
      }
    }

    if (ask.verb === 'kill') {
      if (ask.target === '') {
        return { text: `Which one? /strays kill 2 ends row 2, /strays kill all ends every left-behind one.\n\n${listing(isMarkdown)}` }
      }
      const list =
        ask.target === 'all' ? orphans() : [resolve(ask.target, groups, order)].filter((g): g is Group => g !== undefined)
      if (list.length === 0) {
        return { text: `${ask.target === 'all' ? 'Nothing is left behind.' : `Nothing matches ${ask.target}.`}\n\n${listing(isMarkdown)}` }
      }
      const names = list.map(g => `${g.icon} ${g.label}${portsText(g) ? ` (${portsText(g)})` : ''}`)
      const ended = await stop($, list)

      return {
        text:
          ended > 0
            ? `Ended ${names.join(', ')}: ${plural(ended, 'process')}.\n\n${listing(isMarkdown)}`
            : `Nothing was ended: ${names.join(', ')} had already gone or changed.\n\n${listing(isMarkdown)}`,
      }
    }

    return { text: listing(isMarkdown) }
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    isPaneOpen = false
    armed = null
    detail = null

    return next(e)
  })

  // The ring moved: the control that holds it is the one drawn as chosen.
  on('ui.focus', { requestId: PANE }, async ($, e, next) => {
    const moved = await next(e)
    if (!moved.deny && (e.element ?? '') !== focused) {
      focused = e.element ?? ''
      redraw($)
    }

    return moved
  })

  // The list a command printed, drawn in the transcript in color: the same rows, numbered.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    // The output may carry words before the list ("Ended …"), and the plugin's name before those.
    const text = COMMANDS.includes(e.props.command) ? e.props.text : ''
    const key = [...printed.keys()].reverse().find(known => text.includes(known))
    const list = key === undefined ? undefined : printed.get(key)
    if (key === undefined || !list || list.groups.length === 0) return next(e)
    const before = text
      .slice(0, text.indexOf(key))
      .replace(/^strays:\s*/, '')
      .trim()
    const { Box, Text } = $.ui.resolve(e)
    const portWidth = Math.min(12, Math.max(5, ...list.groups.map(g => portsText(g).length)))
    const nameWidth = Math.min(48, Math.max(16, ...list.groups.map(g => g.label.length)))
    const digits = String(list.groups.length).length

    return (
      <Box flexDirection="column">
        {before !== '' && <Text>{before}</Text>}
        {SECTIONS.map(section => ({ ...section, rows: list.groups.filter(g => g.kind === section.kind) }))
          .filter(section => section.rows.length > 0)
          .map(section => (
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Text bold color={ACCENT[section.kind]}>
                  {`${section.icon} ${section.title}`}
                </Text>
                <Text dimColor>{section.why}</Text>
              </Box>
              {section.rows.map(g => {
                const n = list.order.indexOf(g.pid) + 1
                const clash = list.clashes.find(c => c.old.pid === g.pid)

                return (
                  <Box flexDirection="column">
                    <Box flexDirection="row" columnGap={1}>
                      <Text dimColor>{`  ${String(n).padStart(digits)}`}</Text>
                      {portsText(g) ? (
                        <Text backgroundColor={ACCENT[g.kind]} color="black" bold>
                          {` ${fit(portsText(g), portWidth)} `}
                        </Text>
                      ) : (
                        <Text dimColor>{` ${fit('·', portWidth)} `}</Text>
                      )}
                      <Text bold={g.kind === 'orphan'}>{`${g.icon} ${fit(g.label, nameWidth)}`}</Text>
                      <Text dimColor>{`${megabytes(g.rssKb).padStart(7)}  ${age(g.seconds).padStart(6)}  ${basename(g.cwd) || '/'}`}</Text>
                    </Box>
                    {clash && (
                      <Text color="yellow">
                        {`  ${' '.repeat(digits)}  ⚠️ ${clashNote(clash)} · /strays kill ${n} ends it and frees :${clash.oldPort}`}
                      </Text>
                    )}
                  </Box>
                )
              })}
            </Box>
          ))}
        <Text dimColor>/strays 1 shows one in full · /strays kill 1 ends it · /strays ui opens the panel</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const columns = e.props.bodyColumns
    const isDocked = e.props.placement === 'dock'
    const grow = Math.min(1, (frame - openedAt + 1) / GROW)
    const spinner = frame < spinUntil || isScanning || ending.size > 0 ? (SPIN[frame % SPIN.length] ?? '') : ' '

    // Memory as a bar: eight cells against the heaviest here (256 MB at least), growing in as the panel opens.
    const meter = (g: Group, biggest: number) => {
      const filled = Math.max(1, Math.round((g.rssKb / biggest) * 8 * grow))
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

    const chosen = detail === null ? undefined : groups.find(g => g.pid === detail)
    if (chosen) {
      // One group in full.
      const color = ACCENT[chosen.kind]
      const data = info?.pid === chosen.pid ? info.data : null
      const clash = clashOf(chosen)
      const isAsked = armed === chosen.pid
      const isEnding = ending.has(chosen.pid)
      const port = chosen.ports[0]
      const labelWidth = 11
      const cardWidth = Math.min(columns, 100)
      const valueWidth = Math.max(20, cardWidth - labelWidth - 4)

      const back = <Button key="back" label="← Back" hotkey="b" dimColor onPress={() => view($, null)} />
      const heading = (
        <Box flexDirection="row" columnGap={1}>
          {portsText(chosen) !== '' && (
            <Text backgroundColor={color} color="black" bold>
              {` ${portsText(chosen)} `}
            </Text>
          )}
          <Text bold wrap="truncate-end">{`${chosen.icon} ${chosen.label}`}</Text>
        </Box>
      )
      const card = (
        <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} width={cardWidth}>
          {facts(chosen, data, clash).map(([label, value]) => (
            <Box flexDirection="row">
              <Box flexShrink={0} width={labelWidth}>
                <Text dimColor>{label}</Text>
              </Box>
              <Box flexDirection="column" width={valueWidth}>
                {label === 'Memory' ? (
                  <Box flexDirection="row" columnGap={1}>
                    {meter(chosen, Math.max(256 * 1024, chosen.rssKb))}
                    <Text dimColor wrap="truncate-end">
                      {value.slice(megabytes(chosen.rssKb).length)}
                    </Text>
                  </Box>
                ) : (
                  value.split('\n').map(text => (
                    <Text wrap="wrap" color={label === 'State' ? color : label === 'Clash' ? 'yellow' : undefined}>
                      {text}
                    </Text>
                  ))
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )
      const done = note !== '' && <Text color="green">{`✓ ${note}`}</Text>
      const buttons = (
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {isEnding ? (
            <Text color="red">{`${spinner} ending…`}</Text>
          ) : (
            <Button
              key="end"
              label={isAsked ? 'Yes, end it' : 'End process'}
              hotkey="e"
              variant="primary"
              onPress={() => press($, chosen.pid, () => groups.filter(g => g.pid === chosen.pid))}
            />
          )}
          <Button
            key="folder"
            label="Open folder"
            hotkey="f"
            onPress={async () => {
              await $.process.run(['open', data?.fields.cwd || chosen.cwd])
            }}
          />
          {port !== undefined && (
            <Button
              key="browser"
              label={`Open :${port}`}
              hotkey="o"
              onPress={async () => {
                await $.process.run(['open', `http://localhost:${port}`])
              }}
            />
          )}
          <Button
            key="copy"
            label="Copy command"
            hotkey="c"
            onPress={async pressed => {
              await $.ui.copy({ text: data?.fields.command || chosen.command, surface: pressed.surface })
              note = 'command copied'
              redraw($)
            }}
          />
        </Box>
      )
      const hint = <Text dimColor>click a button · b back · e end · f folder · c copy · Esc to the prompt</Text>

      // Above the prompt a panel shows about ten rows: the buttons go under the
      // name, over the facts, where they are never cut off.
      if (!isDocked) {
        return (
          <Box flexDirection="column">
            <Box flexDirection="row" columnGap={1}>
              {back}
              <Text color={color}>{spinner}</Text>
              {heading}
            </Box>
            {buttons}
            {done}
            {card}
            {hint}
          </Box>
        )
      }

      return (
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" columnGap={1}>
            {back}
            <Text color={color}>{spinner}</Text>
          </Box>
          {heading}
          {card}
          {done}
          {buttons}
          {hint}
        </Box>
      )
    }

    // The list.
    const sections = SECTIONS.filter(s => s.kind !== 'mcp' || showsMcp)
      .map(section => ({ ...section, rows: visible(groups, section.kind) }))
      .filter(section => section.rows.length > 0)
    const rows = sections.flatMap(section => section.rows)
    const gone = orphans()
    const loose = visible(groups, 'detached')
    const left = strays()
    const hidden = showsMcp ? 0 : visible(groups, 'mcp').length
    const first = rows[0]?.pid
    const isWide = columns >= 72
    const portWidth = Math.min(12, Math.max(5, ...rows.map(g => portsText(g).length)))
    const biggest = Math.max(256 * 1024, ...rows.map(g => g.rssKb))
    const folderWidth = Math.min(10, Math.max(3, ...rows.map(g => (basename(g.cwd) || '/').length)))
    // Beside the transcript the panel is as wide as its content asks, so the
    // list keeps to about ninety columns there whatever room there is.
    const fixed = 1 + (portWidth + 2) + 15 + (8 + folderWidth) + 7 + 5 + 4
    const nameWidth = isDocked ? 46 - portWidth : Math.min(64, Math.max(14, columns - fixed))
    // A frame hugs its rows (the widest, with the question's longer button) and stops at the panel's edge.
    const frameWidth = Math.min(columns, 1 + (portWidth + 2) + nameWidth + 15 + (8 + folderWidth) + 15 + 5 + 4)
    const memory = megabytes(left.reduce((sum, g) => sum + g.rssKb, 0))
    const found = clashes(groups)

    // A number over its name, in a frame the color of what it counts.
    const tile = (icon: string, value: string, name: string, color: string, isLit: boolean) => (
      <Box flexDirection="column" borderStyle="round" borderColor={color} borderDimColor={!isLit} paddingX={1} width={19}>
        <Text bold color={isLit ? color : undefined} dimColor={!isLit}>
          {`${icon} ${value}`}
        </Text>
        <Text dimColor>{name}</Text>
      </Box>
    )

    const item = (g: Group) => {
      const color = ACCENT[g.kind]
      const rowKey = `row-${g.pid}`
      const endKey = `end-${g.pid}`
      const isChosen = focused === rowKey || focused === endKey
      const isAsked = armed === g.pid
      const isEnding = ending.has(g.pid)
      const port = portsText(g)
      const clash = found.find(c => c.old.pid === g.pid)
      // Under an older copy of a server an open session runs: what it is, and that End frees its port.
      const warning = clash && (
        <Box paddingLeft={2}>
          <Text color="yellow" wrap="truncate-end">
            {`⚠️ ${clashNote(clash)} · End frees :${clash.oldPort}`}
          </Text>
        </Box>
      )
      // Everything but the command keeps its width: the command is cut with an ellipsis.
      const mark = (
        <Box flexShrink={0}>
          <Text bold color={color}>
            {isEnding ? (SPIN[frame % SPIN.length] ?? ' ') : isChosen ? '❯' : ' '}
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
      const width = isWide ? nameWidth : Math.max(14, columns - portWidth - 10)
      // The row itself is the control: a click, or Enter, shows the process in full.
      const name = (
        <Box flexShrink={0}>
          <Button
            key={rowKey}
            plain
            label={`${g.icon} ${fit(isAsked ? `End ${g.label}?` : g.label, width - 3)}`}
            hover={{ underline: true, bold: true }}
            dimColor={isEnding || g.kind === 'mcp'}
            {...(g.pid === first ? { autoFocus: true as const } : {})}
            onPress={() => view($, g.pid)}
          />
        </Box>
      )
      const about = (
        <Box flexShrink={0}>
          <Text dimColor wrap="truncate">
            {`${age(g.seconds).padStart(6)}  ${fit(basename(g.cwd) || '/', folderWidth)}`}
          </Text>
        </Box>
      )
      const button = (
        <Box flexShrink={0}>
          {isEnding ? (
            <Text color="red">ending…</Text>
          ) : (
            <Button
              key={endKey}
              label={isAsked ? 'Yes, end it' : 'End'}
              {...(isAsked ? { variant: 'primary' as const } : {})}
              onPress={() => press($, g.pid, () => groups.filter(x => x.pid === g.pid))}
            />
          )}
        </Box>
      )
      // The row's Box has a key, so the pointer anywhere on the row lights its name.
      if (isWide) {
        const row = (
          <Box key={`item-${g.pid}`} flexDirection="row" columnGap={1}>
            {mark}
            {pill}
            {name}
            {meter(g, biggest)}
            {about}
            {button}
          </Box>
        )

        return warning ? (
          <Box flexDirection="column">
            {row}
            {warning}
          </Box>
        ) : (
          row
        )
      }

      // A narrow panel: the same row on two lines.
      return (
        <Box key={`item-${g.pid}`} flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {mark}
            {pill}
            {name}
          </Box>
          <Box flexDirection="row" columnGap={1} paddingLeft={2}>
            {meter(g, biggest)}
            {about}
            {button}
          </Box>
          {warning}
        </Box>
      )
    }

    const title = (section: (typeof sections)[number]) => (
      <Box flexDirection="row" columnGap={1}>
        <Text bold color={ACCENT[section.kind]}>
          {`${section.icon} ${section.title}`}
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
        <Button
          key="refresh"
          label="Refresh"
          hotkey="r"
          dimColor
          onPress={async () => {
            spinUntil = frame + 6
            animate($, 6)
            await scan($)
          }}
        />
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
        <Text color="cyan">{spinner}</Text>
      </Box>
    )
    const hint = (
      <Text dimColor>{`click a row for details · click End to end it · ↑↓ ⏎ work too${gone.length > 0 ? ' · o ends all left behind' : ''}`}</Text>
    )
    const done = note !== '' && <Text color="green">{`✓ ${note}`}</Text>

    // Above the prompt a panel is wide and short: the counts become one line of
    // labels, the actions sit under them where they are never cut off, and the
    // groups lose their frames.
    if (!isDocked) {
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
                ✨ All clean: nothing Claude Code started is still running
              </Text>
            ) : (
              <Box flexDirection="row" columnGap={1}>
                {badge(`👻 ${gone.length} left behind`, ACCENT.orphan, gone.length > 0)}
                {badge(`🌙 ${loose.length} in background`, ACCENT.detached, loose.length > 0)}
                {badge(`💾 ${memory} held`, 'magenta', left.length > 0)}
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
          {tile('👻', String(gone.length), 'left behind', ACCENT.orphan, gone.length > 0)}
          {tile('🌙', String(loose.length), 'in background', ACCENT.detached, loose.length > 0)}
          {tile('💾', memory, 'memory held', 'magenta', left.length > 0)}
        </Box>
        {rows.length === 0 && (
          <Box borderStyle="round" borderColor="green" paddingX={2} flexDirection="column">
            <Text bold color="green">
              ✨ All clean
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
