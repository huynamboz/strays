import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { age, describe, group, line, parse, table, widths } from '../hooks/register'

// What Claude Code passes a ui.render hook for the pane, apart from the app.
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

// bin/scan.sh's lines: pid ppid seconds rssKB sessionId claudePid alive attached ports cwd command
const WRAPPER =
  "/bin/zsh -c source /Users/me/.claude/shell-snapshots/snap.sh 2>/dev/null || true && eval 'npm test -- --watch' < /dev/null"
const SCAN = [
  // a dev server and its helper, two days old: the session that started them is gone
  ['501', '1', '180000', '204800', 'old-session', '400', '0', '0', '3000', '/Users/me/shop', '/usr/local/bin/node /Users/me/shop/node_modules/.bin/vite'],
  ['502', '501', '179990', '102400', 'old-session', '400', '0', '0', '24678', '/Users/me/shop', '/Users/me/shop/node_modules/esbuild/bin/esbuild --service'],
  // started with nohup by a session that still runs
  ['601', '1', '600', '24000', 'session-1', '900', '1', '0', '8766', '/private/tmp', '/opt/x/Python -m http.server 8766'],
  // a command the Bash tool is still running, and its child
  ['701', '900', '420', '3000', 'session-1', '900', '1', '1', '', '/work', WRAPPER],
  ['702', '701', '419', '90000', 'session-1', '900', '1', '1', '', '/work', 'npm test -- --watch'],
  // a command the Bash tool started a moment ago: not worth a row
  ['711', '900', '3', '2000', 'session-1', '900', '1', '1', '', '/work', 'git status'],
  // an MCP server: marked with the session, never with Claude's pid
  ['801', '800', '3000', '98000', 'session-1', '', '1', '1', '', '/work', '/usr/bin/node /x/chrome-devtools-mcp'],
]
const tsv = (rows: string[][]) => rows.map(row => row.join('\t')).join('\n') + '\n'

/** What $.process.run resolves with for a command that printed `stdout` and exited 0. */
const ran = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

/** /strays as the person types it: the kit fills in who ran it and how it shows. */
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'strays', args } as Parameters<Engine['command']['run']>[0])

test('groups a process with what it started and says why each is here', () => {
  const groups = group(parse(tsv(SCAN)))
  expect(groups.map(g => [g.pid, g.kind])).toEqual([
    [501, 'orphan'],
    [801, 'mcp'],
    [601, 'detached'],
    [701, 'running'],
    [711, 'running'],
  ])
  const server = groups[0]
  expect(server?.pids).toEqual([502, 501])
  expect(server?.ports).toEqual([3000, 24678])
  expect(server?.rssKb).toBe(307200)
  // every path is cut to its name
  expect(server?.label).toBe('node vite')
  // the Bash tool's wrapper reads as the command it was given
  expect(groups[3]?.label).toBe('npm test -- --watch')
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
  const crash = ['900', '1', '5', '8000', 'old-session', '400', '0', '0', '', '/x', '/c/chrome_crashpad_handler --monitor-self']
  expect(group(parse(tsv([crash])))).toEqual([])
  expect([age(42), age(600), age(7260), age(180000)]).toEqual(['42s', '10m', '2h 1m', '2d 2h'])
})

test('draws the rows as one table: every column starts at the same place', () => {
  const groups = group(parse(tsv(SCAN)))
  const w = widths(groups, 80)
  expect(groups.map(g => line(g, w))).toEqual([
    ':3000 :24678  node vite                   shop   2d 2h    300 MB',
    '—             node chrome-devtools-mcp    work     50m     96 MB',
    ':8766         Python -m http.server 8766  tmp      10m     23 MB',
    '—             npm test -- --watch         work      7m     91 MB',
    '—             git status                  work      3s      2 MB',
  ])
  // a command too long for its column is cut, never wrapped
  const long = { ...groups[0]!, label: 'node ' + 'x'.repeat(200) }
  const cut = line(long, widths([long], 80))
  expect(cut.length).toBeLessThanOrEqual(80)
  expect(cut).toContain('…')
})

test('lists as a markdown table in the editor panel, where padded columns do not line up', async ($, on) => {
  const clock = mock.clock(on)
  mock.env(on, { CLAUDE_CODE_ENTRYPOINT: 'claude-vscode' })
  on('process.run', () => ran(tsv(SCAN)))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))

  await $.session.start({ surface: 'vscode', isInteractive: true, cwd: '/work' })
  await clock.settle()
  const listed = await run($, 'list')
  // the first line is prose: the row's "strays: " prefix lands on it, never on the table
  expect(listed.text).toBe(
    [
      '**1** left behind · **1** in the background · **1** still running · **323 MB** held',
      '',
      '| | Port | Command | Folder | Running | Memory |',
      '| :- | :- | :- | :- | -: | -: |',
      '| 🟡 **Left behind** | :3000 :24678 | `node vite` | shop | 2d 2h | 300 MB |',
      '| 🔵 **In the background** | :8766 | `Python -m http.server 8766` _this session_ | tmp | 10m | 23 MB |',
      '| 🟢 **Still running** |  | `npm test -- --watch` _this session_ | work | 7m | 91 MB |',
      '',
      '`/strays kill` ends what was left behind.',
    ].join('\n'),
  )

  // a group is named once, heavy memory stands out, and nothing in a command or a folder breaks the table
  const [server] = group(parse(tsv(SCAN)))
  const heavy = { ...server!, pid: 9, label: 'sh -c cat `ls` | wc', cwd: '/x/my_*app', rssKb: 700 * 1024, ports: [1, 2, 3, 4, 5] }
  const rows = table([server!, heavy], '').split('\n')
  expect(rows[5]).toBe('|  | :1 :2 :3 +2 | ``sh -c cat `ls` \\| wc`` | my\\_\\*app | 2d 2h | **700 MB** |')
  expect(rows.at(-1)).toBe('`/strays kill` ends what was left behind.')
  expect(table([], '')).toBe('')
})

test('lists what was left behind and ends it', async ($, on) => {
  const clock = mock.clock(on)
  let rows = SCAN
  const ended: string[][] = []
  on('process.run', ($, e) => {
    if (e.argv[1]?.endsWith('/bin/kill.sh')) {
      const pids = e.argv.slice(2)
      ended.push(pids)
      rows = rows.filter(row => !pids.includes(row[0] ?? ''))

      return ran(pids.join(' ') + '\n')
    }

    return ran(tsv(rows))
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
  on('session.start', () => ({ cwd: '/work' }))
  on('session.id', () => ({ value: 'session-1' }))
  // a terminal draws the session: the list stays text in padded columns
  on('session.surfaces', () => ({ value: ['terminal'] as const }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await clock.settle()
  // one group from an earlier session: the dev server and its helper, 300 MB together
  expect(toasts).toEqual(['1 process from earlier Claude Code sessions still running (300 MB): /strays'])
  expect(statuses.at(-1)).toBe('2 stray processes on :3000 :24678 :8766 · /strays')

  const listed = await run($, 'list')
  expect(listed.text).toContain('Left behind (session closed)\n  :3000 :24678  node vite')
  expect(listed.text).toMatch(/In the background \(session still open\)\n  :8766 +Python -m http\.server 8766 +tmp +10m +23 MB  this session/)
  expect(listed.text).toMatch(/Still running \(under an open session, for over a minute\)\n  — +npm test -- --watch +work +7m +91 MB  this session/)
  expect(listed.text).not.toContain('git status')
  expect(listed.text).not.toContain('chrome-devtools-mcp')

  await run($, '')
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // above the prompt: three labels, how many were left behind, how many run in the background, the memory they hold
    expect(await ui.find({ type: 'Text', text: ' 1 left behind ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 1 in background ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: ' 323 MB held ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '● Left behind' })).toBeDefined()
    // a row: its ports as a label, its command, and one End button, the first holding the cursor
    expect(await ui.find({ type: 'Text', text: ' :3000 :24678 ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'node vite' })).toBeDefined()
    expect((await ui.find({ key: 'row-501' }))?.text).toBe('End')
    expect((await ui.find({ key: 'row-501' }))?.props.autoFocus).toBe(true)
    // MCP servers stay out of the way until asked for
    expect(await ui.find({ key: 'row-801' })).toBeUndefined()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'mcp' })
  expect(await ui.find({ key: 'row-801' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^node chrome-devtools/ })).toBeDefined()

  // one row: Enter asks, Enter again ends, and the row goes
  await ui.press({ key: 'row-601' })
  expect(ended).toEqual([])
  expect((await ui.find({ key: 'row-601' }))?.text).toBe('Yes, end it')
  expect(await ui.find({ type: 'Text', text: /^End Python -m http/ })).toBeDefined()
  await ui.press({ key: 'row-601' })
  expect(ended).toEqual([['601']])
  expect(await ui.find({ key: 'row-601' })).toBeUndefined()

  // all left behind: the first press arms, the second ends, children first
  await ui.press({ key: 'end-orphans' })
  expect(ended).toHaveLength(1)
  expect((await ui.find({ key: 'end-orphans' }))?.text).toBe('Press o again to end 1')
  await ui.press({ key: 'end-orphans' })
  expect(ended[1]).toEqual(['502', '501'])
  expect(await ui.find({ key: 'end-orphans' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '✓ ended 2 processes' })).toBeDefined()
  // nothing is stray any more: only what Claude is running now is left
  expect(await ui.find({ type: 'Text', text: '● Left behind' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '● Still running' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'git status' })).toBeUndefined()
  // nothing stray is left: the line under the prompt is cleared
  expect(statuses.at(-1)).toBeUndefined()
})

test('an armed key forgets itself', async ($, on) => {
  const clock = mock.clock(on)
  const ended: string[][] = []
  on('process.run', ($, e) => {
    if (e.argv[1]?.endsWith('/bin/kill.sh')) ended.push(e.argv.slice(2))

    return ran(tsv(SCAN))
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))

  await run($, '')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'end-orphans' })
  await clock.advance(4000)
  expect((await ui.find({ key: 'end-orphans' }))?.text).toBe('End all left behind (1)')
  await ui.press({ key: 'end-orphans' })
  expect(ended).toEqual([])
  // asking about another row takes the first question back
  await ui.press({ key: 'row-501' })
  await ui.press({ key: 'row-601' })
  expect((await ui.find({ key: 'row-501' }))?.text).toBe('End')
  await ui.press({ key: 'row-501' })
  expect(ended).toEqual([])
})

test('says all is clean when nothing runs, and folds its rows in a narrow pane', async ($, on) => {
  mock.clock(on)
  let rows: string[][] = []
  on('process.run', () => ran(tsv(rows)))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.focus', () => ({}))

  await run($, '')
  const clean = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await clean.find({ type: 'Text', text: /^✓ All clean/ })).toBeDefined()
  expect(await clean.find({ key: 'end-orphans' })).toBeUndefined()
  await clean.press({ key: 'refresh' })
  await clean.unmount()

  // docked beside the transcript the pane is narrow: every row still draws, on any surface
  rows = SCAN
  for (const surface of ['terminal', 'desktop'] as const) {
    const narrow = await $.ui.mount({ ...PANE, surface, props: { ...PANE.props, bodyColumns: 44, placement: 'dock' } })
    await narrow.press({ key: 'refresh' })
    // docked, the counts are tiles: a number over its name
    expect(await narrow.find({ type: 'Text', text: 'left behind' })).toBeDefined()
    expect(await narrow.find({ type: 'Text', text: /^323$/ })).toBeDefined()
    expect(await narrow.find({ type: 'Text', text: 'node vite' })).toBeDefined()
    expect((await narrow.find({ key: 'row-601' }))?.text).toBe('End')
    await narrow.unmount()
  }
})
