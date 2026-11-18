#!/usr/bin/env node
// capture.mjs: the verify skill's headless smoke capture (.claude/skills/verify/SKILL.md). It builds the web client of one checkout in
// fake mode, serves it from this process, drives each route under every theme the app lists, saves a screenshot per route x theme
// to the evidence folder and writes index.md. It also checks fonts (identical in every theme) and text contrast (WCAG AA).
//
//   node scripts/verify/capture.mjs web --worktree <dir> --label before|after --routes wordmark,home [options]
//   node scripts/verify/capture.mjs sim --worktree <dir> --label before|after --routes home [options]
//
// Options: --themes all|id,id (default all: the list is read from packages/protocol/src/theme.ts of the checkout)
//          --viewport desktop|phone (default desktop 1280x800; phone 390x844)   --engine chromium|webkit (default chromium)
//          --scheme light|dark (default light)   --sha <folder name> (default the checkout's short sha)
//          --route-list <file> (required for --label after: every sender, device and platform, each exercised or NOT exercised)
//          --path <p> --route-name <n> (an ad hoc route)   --proves <text> (overrides a route's default claim)
//          --font-targets body,wordmark,heading,mono (default: all that are on screen)   --no-contrast (skip the contrast check)
// Environment: TALOS_VERIFY_EVIDENCE_ROOT (default: the macOS Shared folder, in talos-verify-evidence; the run prints the exact path).
// Exit: 0 all good; 1 an expectation failed in an "after" run (in a "before" run a failed expectation is recorded as observed and
// the run still exits 0: that is the bug being shown); 2 bad usage; 3 a surface could not be reached. Nothing is skipped quietly.
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import {
  addCapture,
  captureName,
  EXIT,
  evidenceRoot,
  fontDifferences,
  installSignalCleanup,
  judgeContrast,
  listThemes,
  loadIndex,
  onInterrupt,
  parseArgs,
  runGroup,
  safePart,
  saveIndex,
  Unreachable,
  Usage,
} from './lib.mjs'
import { adhocRoute, measureInPage, ROUTES } from './routes.mjs'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
}
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } }

/** The built bundle, served from memory-light streams; an unknown path with no extension is the single-page app's index. */
function serve(dir) {
  const served = new Set() // the paths it has answered, so the simulator run can tell the page was really fetched
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    served.add(url.pathname)
    let file = join(dir, decodeURIComponent(url.pathname))
    if (!file.startsWith(dir) || url.pathname.endsWith('.map')) {
      res.writeHead(404).end()
      return
    }
    if (!existsSync(file) || statSync(file).isDirectory()) {
      if (extname(url.pathname)) {
        res.writeHead(404).end()
        return
      }
      file = join(dir, 'index.html')
    }
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    createReadStream(file).pipe(res)
  })
  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', () => ok({ server, port: server.address().port, served }))
  })
}

const git = (wt, ...a) => execFileSync('git', ['-C', wt, ...a], { encoding: 'utf8' }).trim()

function treeId(wt) {
  const sha = git(wt, 'rev-parse', '--short=9', 'HEAD')
  return git(wt, 'status', '--porcelain') ? `${sha}-dirty` : sha
}

async function buildFake(wt, outDir) {
  const web = join(wt, 'apps/web')
  if (!existsSync(join(web, 'node_modules'))) {
    throw new Unreachable(
      `${web}/node_modules is missing: run "pnpm install --frozen-lockfile --ignore-scripts" in ${wt} first`,
    )
  }
  const r = await runGroup('pnpm', ['exec', 'vite', 'build', '--outDir', outDir, '--emptyOutDir'], {
    cwd: web,
    env: { ...process.env, VITE_FAKE: '1' },
    timeoutMs: 240_000,
  })
  if (r.code !== 0) {
    const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').slice(-12).join('\n')
    throw new Unreachable(`the fake-mode web build failed (exit ${r.code}${r.timedOut ? ', timed out' : ''}):\n${tail}`)
  }
  if (!existsSync(join(outDir, 'index.html'))) throw new Unreachable(`the build wrote no index.html in ${outDir}`)
}

async function loadPlaywright(wt) {
  // The checkout's own copy first (it matches its tests), then this script's.
  for (const from of [join(wt, 'apps/web/package.json'), import.meta.url]) {
    try {
      const { createRequire } = await import('node:module')
      const req = createRequire(from.startsWith('file:') ? from : resolve(from))
      const mod = await import(req.resolve('@playwright/test'))
      return mod.chromium ? mod : mod.default
    } catch {}
  }
  throw new Unreachable('@playwright/test is not installed (pnpm install in the checkout); nothing was captured')
}

function pickRoutes(args) {
  const out = []
  if (args.path) out.push(adhocRoute(safePart('route name', args['route-name'] ?? 'adhoc'), args.path))
  for (const n of (args.routes ?? '').split(',').filter(Boolean)) {
    const r = ROUTES[n]
    if (!r)
      throw new Usage(`unknown route "${n}". Known: ${Object.keys(ROUTES).join(', ')} (or --path /x --route-name n)`)
    out.push(r)
  }
  if (out.length === 0) throw new Usage('no route: pass --routes a,b or --path /x --route-name n')
  return out
}

function problemsFor(route, facts, themeFonts, args) {
  const problems = []
  if (route.expect) problems.push(...route.expect(facts))
  if (facts.pageErrors?.length) problems.push(`page errors: ${facts.pageErrors.join(' / ')}`)
  if (!facts.themeApplied) problems.push(`the theme did not apply (inline --bg ${facts.inlineBg ? 'set' : 'empty'})`)
  if (!args['no-contrast']) {
    for (const s of facts.contrast ?? [])
      if (!s.ok) problems.push(`contrast ${s.label}: ${s.ratio ?? '?'} < ${s.need ?? '?'} ${s.note}`.trim())
  }
  return problems.concat(themeFonts)
}

/** Settings > Appearance > Colour theme: the radio whose name is the theme id (any case). */
async function pickTheme(page, theme) {
  const radio = page.getByRole('radio', { name: new RegExp(`^${theme}$`, 'i') })
  await radio.first().waitFor({ state: 'visible', timeout: 20_000 })
  await radio.first().click()
  await page
    .waitForFunction(
      ([t]) =>
        [...document.querySelectorAll('[role=radio]')].some(
          (r) =>
            r.getAttribute('aria-checked') === 'true' &&
            new RegExp(`^${t}$`, 'i').test(r.getAttribute('aria-label') || r.textContent?.trim() || ''),
        ),
      [theme],
      { timeout: 10_000 },
    )
    .catch(() => {})
}

/** A client-side move to another route (the router hears popstate), so the picked theme stays. */
async function openInApp(page, path) {
  await page.evaluate((p) => {
    history.pushState({}, '', p)
    dispatchEvent(new PopStateEvent('popstate'))
  }, path)
}

async function webRun(args, kind) {
  const label = args.label
  if (label !== 'before' && label !== 'after') throw new Usage('--label must be before or after')
  const wt = args.worktree && resolve(args.worktree)
  if (!wt || !existsSync(wt)) throw new Usage('--worktree <dir> is required and must exist')
  const routes = pickRoutes(args)
  const viewport = args.viewport ?? 'desktop'
  if (!VIEWPORTS[viewport]) throw new Usage('--viewport must be desktop or phone')
  const engineName = args.engine ?? 'chromium'
  if (!['chromium', 'webkit'].includes(engineName)) throw new Usage('--engine must be chromium or webkit')
  const scheme = args.scheme ?? 'light'
  const routeList = args['route-list'] ? readFileSync(args['route-list'], 'utf8') : ''
  if (label === 'after' && !routeList.trim()) {
    throw new Usage(
      'an "after" run needs --route-list <file>: write every sender, device and platform the change reaches, each exercised or NOT exercised and why',
    )
  }
  const all = await listThemes(wt)
  const themes = !args.themes || args.themes === 'all' ? all : args.themes.split(',')
  for (const t of themes)
    if (!all.includes(t)) throw new Usage(`theme "${t}" is not in the app's list (${all.join(', ')})`)

  const tree = treeId(wt)
  const dir = join(evidenceRoot(), safePart('sha', args.sha ?? tree.replace(/-dirty$/, '')))
  mkdirSync(dir, { recursive: true })
  const index = loadIndex(dir)
  index.title = index.title || `for ${args.sha ?? tree}`
  if (routeList.trim()) index.routeList = routeList
  index.findings ??= []

  const t0 = Date.now()
  installSignalCleanup()
  const out = mkdtempSync(join(tmpdir(), 'talos-verify-web-'))
  onInterrupt(() => rmSync(out, { recursive: true, force: true }))
  let served
  let browser
  const failures = []
  try {
    await buildFake(wt, out)
    const buildS = ((Date.now() - t0) / 1000).toFixed(1)
    served = await serve(out)
    const pw = await loadPlaywright(wt)
    const engine = pw[engineName]
    try {
      browser = await engine.launch()
      onInterrupt(() => browser?.close())
    } catch (e) {
      throw new Unreachable(
        `could not start ${engineName} (try: pnpm exec playwright install ${engineName}): ${String(e.message).split('\n')[0]}`,
      )
    }
    const base = `http://127.0.0.1:${served.port}`
    const surface = engineName === 'chromium' ? `web-${viewport}` : `web-${viewport}-${engineName}`
    for (const route of routes) {
      const byTheme = {}
      const perTheme = []
      for (const theme of themes) {
        const ctx = await browser.newContext({
          viewport: VIEWPORTS[viewport],
          hasTouch: viewport === 'phone',
          isMobile: viewport === 'phone',
          deviceScaleFactor: 2,
          serviceWorkers: 'block',
          colorScheme: scheme,
          reducedMotion: route.reducedMotion ? 'reduce' : 'no-preference',
        })
        const page = await ctx.newPage()
        const pageErrors = []
        page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 160)))
        try {
          // The fake client keeps the owner's config in memory and re-applies it at start, so a stored theme does not stick: the
          // theme is picked the way the owner picks it (Settings > Appearance), then the route opens in the same page, no reload.
          const resp = await page.goto(`${base}/settings/appearance`, { waitUntil: 'load', timeout: 30_000 })
          if (!resp?.ok()) throw new Error(`HTTP ${resp?.status()} for the app`)
          await pickTheme(page, theme)
          if (route.path !== '/settings/appearance') await openInApp(page, route.path)
          await route.ready(page)
          if (route.act) await route.act(page, { touch: viewport === 'phone' })
          await page.waitForTimeout(300)
          const m = await page.evaluate(measureInPage)
          const extra = route.facts ? await route.facts(page) : {}
          const inlineBg = await page.evaluate(() => document.documentElement.style.getPropertyValue('--bg').trim())
          const facts = {
            ...extra,
            fonts: m.fonts,
            inlineBg,
            themeApplied: theme === 'talos' ? inlineBg === '' : inlineBg !== '',
            contrast: m.samples.map(judgeContrast),
            pageErrors,
          }
          const wanted = args['font-targets']?.split(',')
          byTheme[theme] = Object.fromEntries(Object.entries(m.fonts).filter(([k]) => !wanted || wanted.includes(k)))
          const file = captureName({ surface, route: route.name, theme, label, ext: 'png' })
          await page.screenshot({ path: join(dir, file), fullPage: false })
          perTheme.push({ theme, file, facts })
        } catch (e) {
          throw new Unreachable(
            `route ${route.name} under theme ${theme} could not be driven: ${String(e.message).split('\n')[0]}`,
          )
        } finally {
          await ctx.close()
        }
      }
      const diffs = fontDifferences(byTheme)
      for (const p of perTheme) {
        const fontProblems = diffs.map(
          (d) => `fonts differ between themes for ${d.target}: ${JSON.stringify(d.values)}`,
        )
        const problems = problemsFor(route, p.facts, fontProblems, args)
        const ok = problems.length === 0
        const result = ok
          ? 'ok'
          : label === 'before'
            ? `observed: ${problems.join('; ')}`
            : `FAIL: ${problems.join('; ')}`
        if (!ok && label === 'after') failures.push(`${p.file}: ${problems.join('; ')}`)
        // keep the facts short in the index: the ratio list as {label: ratio}
        const facts = { ...p.facts, contrast: Object.fromEntries(p.facts.contrast.map((c) => [c.label, c.ratio])) }
        addCapture(index, {
          file: p.file,
          surface,
          route: route.name,
          theme: p.theme,
          label,
          tree,
          result,
          proves: args.proves ?? route.proves,
          facts,
        })
      }
      if (diffs.length)
        index.findings.push(
          `${label} ${route.name}: fonts differ between themes (${diffs.map((d) => d.target).join(', ')})`,
        )
      console.log(
        `route ${route.name}: ${perTheme.length} themes (${themes.join(', ')}), fonts ${diffs.length ? 'DIFFER' : 'identical'}`,
      )
    }
    saveIndex(dir, index)
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    console.log(`${kind}: ${routes.length * themes.length} captures in ${secs} s (build ${buildS} s) -> ${dir}`)
    for (const f of failures) console.error(`FAIL ${f}`)
    return failures.length ? EXIT.failed : EXIT.ok
  } catch (e) {
    if (e instanceof Unreachable) {
      index.findings.push(`UNREACHABLE (${label}, ${new Date().toISOString()}): ${e.message.split('\n')[0]}`)
      saveIndex(dir, index)
    }
    throw e
  } finally {
    if (browser) await browser.close().catch(() => {})
    if (served) served.server.close()
    rmSync(out, { recursive: true, force: true })
  }
}

/** The simulator: the booted device opens the same fake-mode build (it shares the host's 127.0.0.1) and a screenshot is saved. */
async function simRun(args) {
  const label = args.label
  if (label !== 'before' && label !== 'after') throw new Usage('--label must be before or after')
  const wt = args.worktree && resolve(args.worktree)
  if (!wt || !existsSync(wt)) throw new Usage('--worktree <dir> is required and must exist')
  const routes = pickRoutes(args)
  const routeList = args['route-list'] ? readFileSync(args['route-list'], 'utf8') : ''
  if (label === 'after' && !routeList.trim()) {
    throw new Usage(
      'an "after" run needs --route-list <file>: write every sender, device and platform the change reaches, each exercised or NOT exercised and why',
    )
  }
  // Never drive a device somebody else booted. Either name a shut-down device (--udid: this run boots it and shuts it down again,
  // also when interrupted) or say the booted one is yours (--use-booted, left running).
  if (!args.udid && !args['use-booted']) {
    throw new Usage(
      'name the simulator: --udid <udid> (a shut-down device: this run boots it and shuts it down after) or --use-booted (a device you booted yourself; left running)',
    )
  }
  let all
  try {
    all = JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' }))
  } catch (e) {
    throw new Unreachable(`xcrun simctl is not usable: ${String(e.message).split('\n')[0]}`)
  }
  const devices = Object.values(all.devices ?? {}).flat()
  let dev
  let ours = false
  if (args['use-booted']) {
    const up = devices.filter((d) => d.state === 'Booted')
    if (up.length !== 1) {
      throw new Usage(
        `--use-booted needs exactly one booted simulator, found ${up.length}: use --udid <udid> of a shut-down device instead`,
      )
    }
    dev = up[0]
  } else {
    dev = devices.find((d) => d.udid === args.udid)
    if (!dev) throw new Usage(`no simulator with udid ${args.udid} (xcrun simctl list devices available)`)
    if (dev.state === 'Booted') {
      throw new Usage(
        `${dev.name} (${dev.udid}) is already booted: not by this run, so it is not driven. Shut it down, or pass --use-booted if you booted it yourself`,
      )
    }
    ours = true
  }
  installSignalCleanup()
  let stopDevice = () => {}
  if (ours) {
    stopDevice = () => {
      try {
        execFileSync('xcrun', ['simctl', 'shutdown', dev.udid], { stdio: 'ignore' })
      } catch {}
    }
    onInterrupt(stopDevice)
    try {
      execFileSync('xcrun', ['simctl', 'boot', dev.udid], { stdio: 'ignore' })
      execFileSync('xcrun', ['simctl', 'bootstatus', dev.udid, '-b'], { stdio: 'ignore', timeout: 180_000 })
    } catch (e) {
      stopDevice()
      throw new Unreachable(`could not boot ${dev.name}: ${String(e.message).split('\n')[0]}`)
    }
  }
  const tree = treeId(wt)
  const dir = join(evidenceRoot(), safePart('sha', args.sha ?? tree.replace(/-dirty$/, '')))
  mkdirSync(dir, { recursive: true })
  const index = loadIndex(dir)
  index.findings ??= []
  if (routeList.trim()) index.routeList = routeList
  const out = mkdtempSync(join(tmpdir(), 'talos-verify-sim-'))
  onInterrupt(() => rmSync(out, { recursive: true, force: true }))
  let served
  const t0 = Date.now()
  try {
    await buildFake(wt, out)
    served = await serve(out)
    for (const route of routes) {
      served.served.clear()
      execFileSync('xcrun', ['simctl', 'openurl', dev.udid, `http://127.0.0.1:${served.port}${route.path}`])
      // Mobile Safari has no ready event we can reach: the page is "there" once it has fetched its script and style, then it settles
      const end = Date.now() + 45_000
      const fetched = () =>
        [...served.served].some((p) => p.endsWith('.js')) && [...served.served].some((p) => p.endsWith('.css'))
      while (!fetched() && Date.now() < end) await new Promise((r) => setTimeout(r, 500))
      if (!fetched())
        throw new Unreachable(
          `the simulator ${dev.name} never fetched the app from 127.0.0.1:${served.port} within 45 s`,
        )
      await new Promise((r) => setTimeout(r, 4000))
      const file = captureName({ surface: 'ios-sim', route: route.name, theme: 'talos', label, ext: 'png' })
      execFileSync('xcrun', ['simctl', 'io', dev.udid, 'screenshot', join(dir, file)])
      addCapture(index, {
        file,
        surface: 'ios-sim',
        route: route.name,
        theme: 'talos',
        label,
        tree,
        result: 'captured (read the picture: the page cannot be measured from here; theme not forced)',
        proves: args.proves ?? route.proves,
        facts: { device: dev.name },
      })
    }
    saveIndex(dir, index)
    console.log(`sim: ${routes.length} captures in ${((Date.now() - t0) / 1000).toFixed(1)} s on ${dev.name} -> ${dir}`)
    return EXIT.ok
  } finally {
    if (served) served.server.close()
    rmSync(out, { recursive: true, force: true })
    stopDevice()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { booleans: ['no-contrast'] })
  const cmd = args._[0]
  if (cmd === 'web') return webRun(args, 'web')
  if (cmd === 'sim') return simRun(args)
  throw new Usage(
    'usage: capture.mjs web|sim --worktree <dir> --label before|after --routes a,b [options] (see the header of this file)',
  )
}

main().then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof Usage) {
      console.error(`verify: ${e.message}`)
      process.exit(EXIT.usage)
    }
    if (e instanceof Unreachable) {
      console.error(`verify: SURFACE NOT REACHED: ${e.message}`)
      process.exit(EXIT.unreachable)
    }
    console.error(`verify: unexpected error: ${e?.stack ?? e}`)
    process.exit(EXIT.failed)
  },
)
