import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { delimiter, join, relative } from 'node:path'
import test from 'node:test'

const fixtureCodex = `#!/bin/sh
set -eu

if [ "$#" -eq 1 ] && [ "$1" = --version ]; then
    printf '%s\\n' "$FIXTURE_CODEX_VERSION"
    exit 0
fi

[ "$#" -eq 5 ]
[ "$1" = app-server ]
[ "$2" = generate-json-schema ]
[ "$3" = --experimental ]
[ "$4" = --out ]

mkdir -p "$5/v2"
printf '%s\\n' "$FIXTURE_SCHEMA" >"$5/root.json"
if [ "$FIXTURE_CODEX_FAIL" = 1 ]; then
    printf '%s\\n' 'fixture generation failed' >&2
    exit 17
fi
printf '%s\\n' '{"type":"object"}' >"$5/v2/Response.json"
`

function createFixture(t) {
  const projectDir = mkdtempSync('/tmp/codex-schema-test-')
  t.after(() => rmSync(projectDir, { recursive: true, force: true }))
  const scriptsDir = join(projectDir, 'scripts')
  const binDir = join(projectDir, 'bin')
  const schemaDir = join(projectDir, 'protocol/schema')
  mkdirSync(scriptsDir)
  mkdirSync(binDir)
  const scriptPath = join(scriptsDir, 'generate-protocol-schema.sh')
  copyFileSync(new URL('./generate-protocol-schema.sh', import.meta.url), scriptPath)
  writeFileSync(join(binDir, 'codex'), fixtureCodex, { mode: 0o755 })

  function run(mode, overrides = {}) {
    return spawnSync('sh', [scriptPath, mode], {
      cwd: projectDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH}`,
        FIXTURE_CODEX_VERSION: 'codex-cli 0.158.0',
        FIXTURE_SCHEMA: '{"type":"string"}',
        FIXTURE_CODEX_FAIL: '0',
        ...overrides,
      },
    })
  }

  function snapshot(dir = schemaDir) {
    return readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const path = join(dir, entry.name)
        return entry.isDirectory()
          ? snapshot(path)
          : [[relative(schemaDir, path), readFileSync(path, 'utf8')]]
      })
  }

  return { run, schemaDir, snapshot }
}

function assertSuccess(result) {
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stdout + result.stderr)
}

function assertFailure(result) {
  assert.ifError(result.error)
  assert.notEqual(result.status, null, result.stdout + result.stderr)
  assert.notEqual(result.status, 0, result.stdout + result.stderr)
}

test('--update accepts local release and development versions and records the actual version', (t) => {
  const fixture = createFixture(t)
  mkdirSync(fixture.schemaDir, { recursive: true })
  writeFileSync(join(fixture.schemaDir, 'UPSTREAM_COMMIT'), 'obsolete commit\n')
  writeFileSync(join(fixture.schemaDir, 'obsolete.json'), '{}\n')

  for (const version of ['codex-cli 0.158.0', 'codex-cli 0.159.0-dev.3']) {
    assertSuccess(fixture.run('--update', { FIXTURE_CODEX_VERSION: version }))
    const files = Object.fromEntries(fixture.snapshot())
    assert.deepEqual(Object.keys(files).sort(), [
      'CODEX_VERSION',
      'SHA256SUMS',
      'root.json',
      'v2/Response.json',
    ])
    assert.equal(files.CODEX_VERSION, `${version}\n`)
    assert.equal(files['root.json'], '{"type":"string"}\n')
    assert.equal(files['v2/Response.json'], '{"type":"object"}\n')
    const expectedChecksums = ['root.json', 'v2/Response.json']
      .map((path) => `${createHash('sha256').update(files[path]).digest('hex')}  protocol/schema/${path}\n`)
      .join('')
    assert.equal(files.SHA256SUMS, expectedChecksums)
  }
})

test('--check succeeds for matching schema and version without changing the baseline', (t) => {
  const fixture = createFixture(t)
  assertSuccess(fixture.run('--update'))
  const baseline = fixture.snapshot()

  assertSuccess(fixture.run('--check'))
  assert.deepEqual(fixture.snapshot(), baseline)
})

test('--check rejects a changed local Codex version without changing the baseline', (t) => {
  const fixture = createFixture(t)
  assertSuccess(fixture.run('--update'))
  const baseline = fixture.snapshot()

  const result = fixture.run('--check', { FIXTURE_CODEX_VERSION: 'codex-cli 0.159.0-dev.3' })
  assertFailure(result)
  assert.match(result.stdout, /CODEX_VERSION/)
  assert.deepEqual(fixture.snapshot(), baseline)
})

test('--check rejects changed schema without changing the baseline', (t) => {
  const fixture = createFixture(t)
  assertSuccess(fixture.run('--update'))
  const baseline = fixture.snapshot()

  const result = fixture.run('--check', { FIXTURE_SCHEMA: '{"type":"number"}' })
  assertFailure(result)
  assert.match(result.stdout, /root\.json/)
  assert.deepEqual(fixture.snapshot(), baseline)
})

test('--update preserves the baseline when Codex fails after generating partial output', (t) => {
  const fixture = createFixture(t)
  assertSuccess(fixture.run('--update'))
  const baseline = fixture.snapshot()

  const result = fixture.run('--update', {
    FIXTURE_CODEX_VERSION: 'codex-cli 0.159.0-dev.3',
    FIXTURE_SCHEMA: '{"type":"number"}',
    FIXTURE_CODEX_FAIL: '1',
  })
  assertFailure(result)
  assert.match(result.stderr, /fixture generation failed/)
  assert.deepEqual(fixture.snapshot(), baseline)
})
