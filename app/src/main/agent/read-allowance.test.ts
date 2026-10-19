/**
 * Where a READ may go outside the project (path-containment.ts,
 * `readAllowedOutside`) — measured on the real profile 2026-10-09: most "reads
 * outside" refusals were not reads of anything.
 */
import { bashContainmentCheck, readContainmentCheck } from './path-containment'

const ROOT = '/Users/me/proj'
const CONFIG = '/Users/me/.flow/accounts/7d24'
const ON_DISK = new Set(['/', '/Users', '/Users/me', '/Users/me/other', '/Users/me/other/secret.env', '/etc/hosts'])
const exists = (abs: string): boolean => ON_DISK.has(abs)
const allowance = { sessionConfigDir: CONFIG, exists }
const bash = (command: string) => bashContainmentCheck({ command }, [ROOT], 'darwin', allowance)

describe('a shell read outside the project', () => {
  it('passes a word that names nothing on disk: a sed address, a route, a heredoc string', () => {
    expect(bash("sed -n '/def _stream_key/,/return/p' src/x.py | head -40").deny).toBe(false)
    expect(bash('curl -s localhost:3000/api/chat/stream | head -5').deny).toBe(false)
    expect(bash("planflow-ai blueprint narrate --from flow/d.md | tail -3\npython3 - <<'EOF'\ns = '/create-plan'\nEOF").deny).toBe(false)
  })

  it('still refuses a real file, and names it', () => {
    const check = bash('cat /Users/me/other/secret.env')
    expect(check.deny).toBe(true)
    expect(check.reason).toContain('reads outside')
    expect(check.reason).toContain('"/Users/me/other/secret.env"')
  })

  it('judges a glob by the folder it searches, so a wildcard cannot hide a real place', () => {
    expect(bash('ls /Users/me/other/*.env').deny).toBe(true)
    expect(bash('ls /nowhere/*.env').deny).toBe(false)
  })

  it('takes every path to exist when no existence check is given', () => {
    expect(bashContainmentCheck({ command: "sed -n '/def x/,/return/p' f | head" }, [ROOT], 'darwin').deny).toBe(true)
  })

  it('passes the session’s own saved tool output and plan file, nothing else in its config dir', () => {
    const own = `${CONFIG}/projects/-Users-me-proj/ef15/tool-results/toolu_1.txt`
    const always = { sessionConfigDir: CONFIG, exists: () => true }
    expect(bashContainmentCheck({ command: `head -50 ${own}` }, [ROOT], 'darwin', always).deny).toBe(false)
    expect(bashContainmentCheck({ command: `cat ${CONFIG}/plans/p.md` }, [ROOT], 'darwin', always).deny).toBe(false)
    expect(bashContainmentCheck({ command: `cat ${CONFIG}/.credentials.json` }, [ROOT], 'darwin', always).deny).toBe(true)
    expect(bashContainmentCheck({ command: `cat ${CONFIG}/projects/x/y/notes.txt` }, [ROOT], 'darwin', always).deny).toBe(true)
  })

  it('passes the system program folders and not /etc', () => {
    const always = { exists: () => true }
    expect(bashContainmentCheck({ command: 'ls -l /opt/homebrew/bin/git' }, [ROOT], 'darwin', always).deny).toBe(false)
    expect(bashContainmentCheck({ command: 'file /usr/local/bin/node' }, [ROOT], 'darwin', always).deny).toBe(false)
    expect(bash('cat /etc/hosts').deny).toBe(true)
  })

  it('does not read a quoted run of slashes as the filesystem root', () => {
    const always = { exists: () => true }
    const command = "git grep -l key origin/main -- configs | sed 's/^origin\\/main://' | head -5"
    expect(bashContainmentCheck({ command }, [ROOT], 'darwin', always).deny).toBe(false)
  })

  it('changes nothing for writes: a missing path outside is still a write outside', () => {
    expect(bash('cp src/x /nowhere/stolen').deny).toBe(true)
  })
})

describe('a read tool outside the project', () => {
  it('passes the session’s saved tool output, refuses the rest of its config dir', () => {
    const own = `${CONFIG}/projects/-Users-me-proj/ef15/tool-results/b1.txt`
    expect(readContainmentCheck({ file_path: own }, [ROOT], 'darwin', { sessionConfigDir: CONFIG }).deny).toBe(false)
    expect(readContainmentCheck({ file_path: `${CONFIG}/settings.json` }, [ROOT], 'darwin', { sessionConfigDir: CONFIG }).deny).toBe(true)
  })

  it('never uses existence: a read tool names one literal path', () => {
    expect(readContainmentCheck({ file_path: '/nowhere/x' }, [ROOT], 'darwin', { sessionConfigDir: CONFIG }).deny).toBe(true)
  })
})
