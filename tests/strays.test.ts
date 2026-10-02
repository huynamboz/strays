import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { age, describe, detailText, group, iconOf, line, listText, parse, parseArgs, parseInfo, resolve, widths } from '../hooks/procs'

// What Claude Code passes a ui.render hook for the panel, apart from the app.
const PANE = {
  plugin: 'strays',
  component: 'Pane',
  requestId: 'strays',
  viewport: { columns: 160, rows: 50 },
  props: {
    title: 'Strays',
    isFocused: true,
    bodyColumns: 80,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 18 },
    view: {},
  },
} as const

// bin/scan.sh's lines:
// pid up seconds rssKB sessionId claudePid alive attached ports cwd how pgid cpu start command
const WRAPPER =
  "/bin/zsh -c source /Users/me/.claude/shell-snapshots/snap.sh 2>/dev/null || true && eval 'npm test -- --watch' < /dev/null"
const SCAN = [
  // a dev server and its helper, two days old: the session that started them is gone
  ['501', '1', '180000', '204800', 'old-session', '400', '0', '0', '3000,24678', '/Users/me/shop', 'e', '500', '0.4', '1000', '/usr/local/bin/node /Users/me/shop/node_modules/.bin/vite'],
  ['502', '501', '179990', '102400', 'old-session', '400', '0', '0', '', '/Users/me/shop', 'e', '500', '0.1', '1010', '/Users/me/shop/node_modules/esbuild/bin/esbuild --service'],
  // started with nohup by a session that still runs
  ['601', '1', '600', '24000', 'session-1', '900', '1', '0', '8766', '/private/tmp', 'e', '600', '0', '2000', '/opt/x/Python -m http.server 8766'],
  // a system program in the same group: macOS shows no environment for it
  ['602', '1', '600', '2000', 'session-1', '900', '1', '0', '', '/private/tmp', 'g', '600', '0', '2000', 'tail -f build.log'],
  // a command the Bash tool is still running, and its child
  ['701', '900', '420', '3000', '', '900', '1', '1', '', '/work', 'w', '701', '0', '3000', WRAPPER],
  ['702', '701', '419', '90000', 'session-1', '900', '1', '1', '', '/work', 'e', '701', '2.5', '3001', 'npm test -- --watch'],
  // a command the Bash tool started a moment ago: not worth a row
  ['711', '900', '3', '2000', 'session-1', '900', '1', '1', '', '/work', 'e', '711', '0', '4000', 'git status'],
  // an MCP server: marked with the session, never with Claude's pid
  ['801', '800', '3000', '98000', 'session-1', '', '1', '1', '', '/work', 'e', '800', '0', '5000', '/usr/bin/node /x/chrome-devtools-mcp'],
]
const tsv = (rows: string[][]) => rows.map(row => row.join('\t')).join('\n') + '\n'
const INFO = [
  'started\tFri  2 Oct 19:28:44 2026',
  'program\t/usr/local/bin/node',
  'command\t/usr/local/bin/node /Users/me/shop/node_modules/.bin/vite',
  'cwd\t/Users/me/shop',
  'listen\t*:3000',
  'listen\t*:24678',
  'session_id\told-session',
  'transcript\t/Users/me/.claude/projects/-Users-me-shop/old-session.jsonl',
  'transcript_cwd\t/Users/me/shop',
].join('\n')

/** What $.process.run resolves with for a command that printed `stdout` and exited 0. */
const ran = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** /strays as the person types it: the kit fills in who ran it and how it shows. */
const run = ($: Engine, args: string, command = 'strays') =>
  $.command.run({ command, args } as Parameters<Engine['command']['run']>[0])

/** Stands for Claude Code and the machine: the scan answers `rows`, a kill takes its pids out of them. */
function machine(on: On, surfaces: readonly string[] = ['terminal']) {
  const clock = mock.clock(on)
  const state = { rows: SCAN, ended: [] as string[][], opened: [] as string[][], copied: [] as string[] }
  on('process.run', ($, e) => {
    if (e.argv[1]?.endsWith('/bin/kill.sh')) {
      const targets = e.argv.slice(2)
      state.ended.push(targets)
      const pids = targets.map(target => target.split('@')[0] ?? '')
      state.rows = state.rows.filter(row => !pids.includes(row[0] ?? ''))

      return ran(pids.join(' ') + '\n')
    }
    if (e.argv[1]?.endsWith('/bin/info.sh')) return ran(INFO)
    if (e.argv[0] === 'open') {
      state.opened.push(e.argv.slice(1))

      return ran('')
    }

    return ran(tsv(state.rows))
  })
  const statuses: (string | undefined)[] = []
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  const toasts: string[] = []
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))
  on('ui.copy', ($, e) => {
    state.copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.surfaces', () => ({ value: surfaces as never }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))

  return { clock, state, statuses, toasts }
}

test('groups a process with what it started and says why each is here', () => {
  const groups = group(parse(tsv(SCAN)))
  expect(groups.map(g => [g.pid, g.kind, g.how])).toEqual([
    [501, 'orphan', 'e'],
    [801, 'mcp', 'e'],
    [601, 'detached', 'e'],
    [602, 'detached', 'g'],
    [701, 'running', 'w'],
    [711, 'running', 'e'],
  ])
  const server = groups[0]
  // children first, each with the moment it started: what bin/kill.sh checks before it ends one
  expect(server?.members.map(m => `${m.pid}@${m.start}`)).toEqual(['502@1010', '501@1000'])
  expect(server?.ports).toEqual([3000, 24678])
  expect(server?.rssKb).toBe(307200)
  expect(server?.cpu).toBe(0.5)
  // every path is cut to its name
  expect(server?.label).toBe('node vite')
  // the Bash tool's wrapper reads as the command it was given
  expect(groups[4]?.label).toBe('npm test -- --watch')
  expect(describe('/opt/x/Python -m http.server 8766')).toBe('Python -m http.server 8766')
  // an app is named for its bundle, whatever spaces its path holds
  expect(
    describe('/Users/me/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --headless --remote-debugging-pipe'),
  ).toBe('Google Chrome for Testing --headless --remote-debugging-pipe')
  // Homebrew's Python is an app bundle too: its script and arguments stay
  expect(
    describe('/opt/homebrew/Cellar/python@3.14/3.14.7/Frameworks/Python.framework/Versions/3.14/Resources/Python.app/Contents/MacOS/Python manage.py runserver 8000'),
  ).toBe('Python manage.py runserver 8000')
  expect(describe('node node_modules/.bin/jest --watch --config=/a/b.json http://localhost:3000/x')).toBe(
    'node jest --watch --config=/a/b.json http://localhost:3000/x',
  )
  // a browser's crash reporter gets no row
  const crash = ['900', '1', '5', '8000', 'old', '400', '0', '0', '', '/x', 'e', '900', '0', '1', '/c/chrome_crashpad_handler --monitor-self']
  expect(group(parse(tsv([crash])))).toEqual([])
  expect([age(42), age(600), age(7260), age(180000)]).toEqual(['42s', '10m', '2h 1m', '2d 2h'])
})

test('gives each kind of process its icon', () => {
  expect([
    iconOf('node vite --host', ''),
    iconOf('Python manage.py runserver 8000', ''),
    iconOf('Google Chrome for Testing --headless', ''),
    iconOf('node jest --watch', ''),
    iconOf('npm run dev', ''),
    iconOf('tail -f build.log', ''),
    iconOf('postgres -D data', ''),
    iconOf('nc -lk 5432', ''),
    iconOf('node-app dev', './target/debug/node-app dev'),
    iconOf('cd blog && sleep 5', ''),
    iconOf('something-else', ''),
    iconOf('npm test -- --watch', ''),
  ]).toEqual(['🟩', '🐍', '🌐', '🧪', '📦', '👀', '💾', '🐚', '🦀', '🐚', '🔧', '🧪'])
})

test('draws the rows as one table and numbers them', () => {
  const groups = group(parse(tsv(SCAN)))
  const w = widths(groups, 80)
  expect(line(groups[0]!, w)).toBe(':3000 :24678  🟩 node vite                   shop   2d 2h    300 MB')
  expect(line(groups[2]!, w)).toBe(':8766         🐍 Python -m http.server 8766  tmp      10m     23 MB')
  // a command too long for its column is cut, never wrapped
  const long = { ...groups[0]!, label: 'node ' + 'x'.repeat(200) }
  const cut = line(long, widths([long], 80))
  expect(cut.length).toBeLessThanOrEqual(80)
  expect(cut).toContain('…')

  const list = listText(groups, 'session-1')
  // the number of a row is what a command names: left behind first, MCP servers never
  expect(list.order).toEqual([501, 601, 602, 701])
  expect(list.text).toContain('👻 Left behind (session closed)\n  1  :3000 :24678  🟩 node vite')
  expect(list.text).toMatch(/🌙 In the background \(session still open\)\n {2}2 {2}:8766 +🐍 Python -m http\.server 8766 +tmp +10m +23 MB {2}this session\n {2}3 {2}— +👀 tail -f build\.log/)
  expect(list.text).toMatch(/🏃 Still running \(under an open session, for over a minute\)\n {2}4 {2}— +🧪 npm test -- --watch/)
  expect(list.text).not.toContain('chrome-devtools-mcp')
  expect(list.text).not.toContain('git status')
  expect(listText([], 'x').text).toMatch(/^✨ All clean/)
})

test('reads a command the short way and the long way', () => {
  expect(parseArgs('')).toEqual({ verb: 'list', target: '' })
  for (const word of ['ls', 'l', 'list']) expect(parseArgs(word).verb).toBe('list')
  for (const word of ['ui', 'u', 'open', 'panel']) expect(parseArgs(word).verb).toBe('ui')
  expect(parseArgs('2')).toEqual({ verb: 'info', target: '2' })
  expect(parseArgs(':3000')).toEqual({ verb: 'info', target: ':3000' })
  expect(parseArgs('i 2')).toEqual({ verb: 'info', target: '2' })
  expect(parseArgs('show :3000')).toEqual({ verb: 'info', target: ':3000' })
  for (const word of ['kill', 'k', 'end', 'stop']) expect(parseArgs(`${word} 2`)).toEqual({ verb: 'kill', target: '2' })
  expect(parseArgs('k all')).toEqual({ verb: 'kill', target: 'all' })
  expect(parseArgs('?').verb).toBe('help')
  expect(parseArgs('nonsense').verb).toBe('help')

  // a number is a row of the last list, else a pid; a colon makes it a port
  const groups = group(parse(tsv(SCAN)))
  const order = [501, 601, 602, 701]
  expect(resolve('2', groups, order)?.pid).toBe(601)
  expect(resolve('#3', groups, order)?.pid).toBe(602)
  expect(resolve('702', groups, order)?.pid).toBe(701)
  expect(resolve(':24678', groups, order)?.pid).toBe(501)
  expect(resolve('99', groups, order)).toBeUndefined()
  expect(resolve(':1', groups, order)).toBeUndefined()
})

test('says everything about one process', () => {
  const groups = group(parse(tsv(SCAN)))
  const text = detailText(groups[0]!, parseInfo(INFO), 1)
  expect(text.split('\n')).toEqual([
    '#1  🟩 node vite',
    '  State      left behind: the session that started it is closed',
    '  Ports      :3000 :24678  →  http://localhost:3000',
    '  Folder     /Users/me/shop',
    '  Command    /usr/local/bin/node /Users/me/shop/node_modules/.bin/vite',
    '  Program    /usr/local/bin/node',
    '  Started    Fri  2 Oct 19:28:44 2026 (2d 2h ago)',
    '  Memory     300 MB in 2 processes · CPU 0.5%',
    '  Processes  501 node vite',
    '             502 esbuild --service',
    '  Session    closed · old-sess',
    '  Project    /Users/me/shop',
    '  Transcript /Users/me/.claude/projects/-Users-me-shop/old-session.jsonl',
    "  Found by   Claude Code's mark in its environment (CLAUDECODE=1)",
    '',
    '/strays kill 1 ends it',
  ])
  // without the details, what the scan knew is still said
  expect(detailText(groups[3]!, null, 0)).toContain('  Found by   its process group, shared with a process Claude Code marked')
})

test('/strays prints the list, a number shows one in full, kill ends it: in any app', async ($, on) => {
  const { clock, state, statuses, toasts } = machine(on, ['vscode'])
  await $.session.start({ surface: 'vscode', isInteractive: true, cwd: '/work' })
  await clock.settle()
  // one group from an earlier session: the dev server and its helper, 300 MB together
  expect(toasts).toEqual(['👻 1 process from earlier Claude Code sessions still running (300 MB): /strays'])
  expect(statuses.at(-1)).toBe('3 stray processes on :3000 :24678 :8766 · /strays')

  const listed = await run($, '')
  expect(listed.text).toContain('  1  :3000 :24678  🟩 node vite')
  expect(listed.text).toContain('/strays 1 shows one in full')
  // /ps is the same command
  expect((await run($, '', 'ps')).text).toBe(listed.text)

  const shownInFull = await run($, '1')
  expect(shownInFull.text).toContain('#1  🟩 node vite\n  State      left behind')
  expect(shownInFull.text).toContain('  Started    Fri  2 Oct 19:28:44 2026')
  expect((await run($, 'i :8766')).text).toContain('#2  🐍 Python -m http.server 8766')

  // where no panel can draw, ui says so and prints the list
  expect((await run($, 'ui')).text).toMatch(/^The panel draws in the terminal and the desktop app/)

  // kill by number: children first, each with its start time
  const killed = await run($, 'k 1')
  expect(state.ended).toEqual([['502@1010', '501@1000']])
  expect(killed.text).toMatch(/^Ended 🟩 node vite \(:3000 :24678\): 2 processes\.\n\n🌙 In the background/)
  // the list is numbered afresh, and a port names a row too
  await run($, 'kill :8766')
  expect(state.ended[1]).toEqual(['601@2000'])
  expect((await run($, 'kill all')).text).toMatch(/^Nothing is left behind\./)
  expect((await run($, 'kill')).text).toMatch(/^Which one\?/)
  expect((await run($, 'kill 42')).text).toMatch(/^Nothing matches 42\./)
  expect((await run($, 'help')).text).toMatch(/^strays: processes Claude Code started/)
})

test('the panel: a row opens a process in full, End asks and then ends', async ($, on) => {
  const { clock, state } = machine(on)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()
  // in the terminal, ui opens the panel and prints nothing
  expect((await run($, 'ui')).text).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // above the prompt: three labels with what they count
    expect(await ui.find({ type: 'Text', text: ' 👻 1 left behind ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 🌙 2 in background ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '👻 Left behind' })).toBeDefined()
    // a row is its icon and command, with an End button; the first holds the cursor
    expect((await ui.find({ key: 'row-501' }))?.text).toMatch(/^🟩 node vite/)
    expect((await ui.find({ key: 'row-501' }))?.props.autoFocus).toBe(true)
    expect((await ui.find({ key: 'end-501' }))?.text).toBe('End')
    // MCP servers stay out of the way until asked for
    expect(await ui.find({ key: 'row-801' })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'mcp' })
  expect((await ui.find({ key: 'row-801' }))?.text).toMatch(/^🌐 node chrome-devtoo/)

  // a click on a row: the process in full, with what to do about it
  await ui.press({ key: 'row-501' })
  expect(await ui.find({ type: 'Text', text: '🟩 node vite' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '/Users/me/shop' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Fri  2 Oct 19:28:44 2026 (2d 2h ago)' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '502 esbuild --service' })).toBeDefined()
  await ui.press({ key: 'folder' })
  await ui.press({ key: 'browser' })
  expect(state.opened).toEqual([['/Users/me/shop'], ['http://localhost:3000']])
  await ui.press({ key: 'copy' })
  expect(state.copied).toEqual(['/usr/local/bin/node /Users/me/shop/node_modules/.bin/vite'])
  // Back returns to the list
  await ui.press({ key: 'back' })
  expect(await ui.find({ key: 'row-601' })).toBeDefined()

  // End on a row: the first press asks, the second ends, and the row goes
  await ui.press({ key: 'end-601' })
  expect(state.ended).toEqual([])
  expect((await ui.find({ key: 'end-601' }))?.text).toBe('Yes, end it')
  expect((await ui.find({ key: 'row-601' }))?.text).toMatch(/^🐍 End Python -m http/)
  await ui.press({ key: 'end-601' })
  expect(state.ended).toEqual([['601@2000']])
  expect(await ui.find({ key: 'row-601' })).toBeUndefined()

  // End in the full view ends it and returns to the list
  await ui.press({ key: 'row-501' })
  await ui.press({ key: 'end' })
  expect((await ui.find({ key: 'end' }))?.text).toBe('Yes, end it')
  await ui.press({ key: 'end' })
  expect(state.ended[1]).toEqual(['502@1010', '501@1000'])
  expect(await ui.find({ type: 'Text', text: '✓ ended node vite' })).toBeDefined()
  expect(await ui.find({ key: 'end-orphans' })).toBeUndefined()
  expect(await ui.find({ key: 'row-602' })).toBeDefined()
})

test('an asked question takes itself back, and End all asks first', async ($, on) => {
  const { clock, state } = machine(on)
  await run($, 'ui')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'end-orphans' })
  expect((await ui.find({ key: 'end-orphans' }))?.text).toBe('Press o again to end 1')
  await clock.advance(4000)
  expect((await ui.find({ key: 'end-orphans' }))?.text).toBe('End all left behind (1)')
  // asking about another row takes the first question back
  await ui.press({ key: 'end-501' })
  await ui.press({ key: 'end-601' })
  expect((await ui.find({ key: 'end-501' }))?.text).toBe('End')
  await ui.press({ key: 'end-501' })
  expect(state.ended).toEqual([])
  // twice on End all ends every left-behind group
  await ui.press({ key: 'end-orphans' })
  await ui.press({ key: 'end-orphans' })
  expect(state.ended).toEqual([['502@1010', '501@1000']])
})

test('says all is clean when nothing runs, and draws docked and in the transcript', async ($, on) => {
  const { state } = machine(on)
  // what Claude Code would draw for a command's output when the mod leaves it alone
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['plain'] }))
  state.rows = []
  expect((await run($, '')).text).toMatch(/^✨ All clean/)
  await run($, 'ui')
  const clean = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await clean.find({ type: 'Text', text: /^✨ All clean/ })).toBeDefined()
  expect(await clean.find({ key: 'end-orphans' })).toBeUndefined()
  await clean.unmount()

  // docked beside the transcript the panel is narrow: tiles, frames, every row still drawn
  state.rows = SCAN
  for (const surface of ['terminal', 'desktop'] as const) {
    const narrow = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 44, placement: 'dock' } })
    await narrow.press({ key: 'refresh' })
    expect(await narrow.find({ type: 'Text', text: '👻 1' })).toBeDefined()
    expect(await narrow.find({ type: 'Text', text: 'left behind' })).toBeDefined()
    expect((await narrow.find({ key: 'row-601' }))?.text).toMatch(/^🐍 Python/)
    expect((await narrow.find({ key: 'end-601' }))?.text).toBe('End')
    await narrow.unmount()
  }

  // the list a command printed is drawn in the transcript in color, row by row
  const listed = await run($, '')
  const output = { plugin: 'strays', component: 'CommandOutput', requestId: 'message-1', viewport: { columns: 120, rows: 40 } } as const
  const drawn = await $.ui.mount({ ...output, surface: 'terminal', props: { command: 'strays', args: '', isErrored: false, text: listed.text ?? '' } })
  expect(await drawn.find({ type: 'Text', text: '👻 Left behind' })).toBeDefined()
  expect(await drawn.find({ type: 'Text', text: / :3000 :24678 / })).toBeDefined()
  expect(await drawn.find({ type: 'Text', text: /^🟩 node vite/ })).toBeDefined()
  await drawn.unmount()
  // any other output is left as Claude Code draws it
  const other = await $.ui.mount({ ...output, surface: 'terminal', props: { command: 'strays', args: '', isErrored: false, text: 'something else' } })
  expect(await other.find({ type: 'Text', text: 'plain' })).toBeDefined()
})
