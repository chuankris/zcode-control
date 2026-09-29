/**
 * Durable workbench task records in one JSON file under the private state
 * directory. Writes are tmp+rename atomic and serialized through one
 * in-process chain; creation is idempotent by source identity so an ingress
 * retry can never mint a second task.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isTerminal, transitionAllowed, type WorkbenchTaskRecord } from './state.ts'
import type { WorkbenchTaskSource } from './types.ts'

/** Persisted file envelope; `v` guards the shape on load. */
interface TaskFile {
  v: 1
  tasks: WorkbenchTaskRecord[]
}

/** Identity of one origin task: source plus its own ids. */
export interface TaskSourceIdentity {
  source: WorkbenchTaskSource
  sourceTaskId: string | null
  threadId: string | null
}

/** Creation input for a new task record. */
export interface CreateTaskInput extends TaskSourceIdentity {
  title: string
  prompt: string
  now: Date
  /** Original desktop task a continuation round continues; null for fresh tasks. */
  desktopTaskId?: string | null
}

/**
 * Exclusive-creation guard: the create refuses while any retained record
 * satisfies the predicate, inside the same serialized transaction, so two
 * racing submissions can never both pass the check.
 */
export interface CreateGuard {
  conflicts: (record: WorkbenchTaskRecord) => boolean
  refusal: string
}

/** Upper bound on retained transcript events per task. */
export const TRANSCRIPT_EVENT_CAP = 400

function emptyFile(): TaskFile {
  return { v: 1, tasks: [] }
}

function parseFile(raw: string): TaskFile {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('task store is not an object')
  const file = parsed as Partial<TaskFile>
  if (file.v !== 1 || !Array.isArray(file.tasks)) throw new Error('task store envelope mismatch')
  return { v: 1, tasks: file.tasks.filter((task): task is WorkbenchTaskRecord => typeof task === 'object' && task !== null) }
}

function hasDedupIdentity(identity: TaskSourceIdentity): boolean {
  // Workbench-origin tasks have no external identity to deduplicate on.
  return identity.source === 'codex' && identity.sourceTaskId !== null && identity.sourceTaskId.length > 0
}

/**
 * File-backed task store. One instance owns the file for the process
 * lifetime; the Host service is its only writer.
 */
export class TaskStore {
  private readonly stateDir: string
  private readonly file: string
  private readonly maxTasks: number
  private readonly transcriptCap: number
  private tasks: WorkbenchTaskRecord[] = []
  private chain: Promise<void> = Promise.resolve()

  /**
   * @param stateDir - private directory holding `tasks.json`.
   * @param maxTasks - retained record cap.
   * @param transcriptCap - retained transcript events per task (tests use small values).
   */
  constructor(stateDir: string, maxTasks: number, transcriptCap: number = TRANSCRIPT_EVENT_CAP) {
    this.stateDir = stateDir
    this.file = join(stateDir, 'tasks.json')
    this.maxTasks = maxTasks
    this.transcriptCap = transcriptCap
  }

  /** Load or initialize the store; the directory is created when absent. */
  async load(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true })
    let raw: string
    try {
      raw = await readFile(this.file, 'utf8')
    } catch {
      this.tasks = emptyFile().tasks
      await this.persist(emptyFile())
      return
    }
    this.tasks = parseFile(raw).tasks.map(normalizeRecord)
  }

  /**
   * Close dispatched tasks whose owning ACP process vanished with a Host
   * restart. Their desktop outcome is unknown, so they must never remain
   * indefinitely active or be dispatched again automatically.
   * @param now - repair instant stamped onto repaired records.
   * @returns number of records repaired.
   */
  async reconcileInterruptedDispatches(now: Date = new Date()): Promise<number> {
    return this.transaction(async () => {
      let repaired = 0
      for (const task of this.tasks) {
        if (task.promptSentAt === null) continue
        if (task.status !== 'dispatching' && task.status !== 'zcode_acknowledged' && task.status !== 'running') continue
        task.status = 'failed'
        task.echoLost = true
        task.awaitingInput = false
        task.lastError = 'the workbench restarted while the desktop task was active; the desktop outcome is unknown — verify the task in the Zcode desktop'
        task.updatedAt = now.toISOString()
        repaired += 1
      }
      if (repaired > 0) await this.persist({ v: 1, tasks: this.tasks })
      return repaired
    })
  }

  private persist(file: TaskFile): Promise<void> {
    const temporary = `${this.file}.${process.pid}.tmp`
    return writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, 'utf8').then(() => rename(temporary, this.file))
  }

  /** Serialize one read-modify-persist cycle. */
  private transaction<T>(mutate: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(() => mutate())
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Create a task, or return the existing one for a repeated origin identity.
   * @param input - origin identity, title, prompt, and creation instant.
   * @param guard - optional exclusive-creation conflict check (continuations).
   * @returns the record plus whether this call created it.
   */
  async create(input: CreateTaskInput, guard?: CreateGuard): Promise<{ record: WorkbenchTaskRecord; created: boolean }> {
    return this.transaction(() => {
      if (guard !== undefined && this.tasks.some(guard.conflicts)) throw new Error(guard.refusal)
      if (hasDedupIdentity(input)) {
        const existing = this.tasks.find(task => task.source === input.source
          && task.sourceTaskId === input.sourceTaskId && (task.threadId ?? '') === (input.threadId ?? ''))
        if (existing !== undefined) return { record: cloneRecord(existing), created: false }
      }
      const now = input.now.toISOString()
      const record: WorkbenchTaskRecord = {
        workbenchTaskId: this.nextId(input.now),
        source: input.source,
        sourceTaskId: input.sourceTaskId,
        threadId: input.threadId,
        title: input.title,
        prompt: input.prompt,
        status: 'received',
        nodeId: null,
        nodeLabel: null,
        workspacePath: null,
        workspaceLabel: null,
        acpSessionId: null,
        desktopTaskId: input.desktopTaskId ?? null,
        promptSentAt: null,
        awaitingInput: false,
        echoLost: false,
        lastError: null,
        transcript: [{ at: now, kind: 'status', text: 'received', key: null, toolStatus: null }],
        createdAt: now,
        updatedAt: now,
      }
      this.tasks.unshift(record)
      this.evict()
      return this.persist({ v: 1, tasks: this.tasks }).then(() => ({ record: cloneRecord(record), created: true }))
    })
  }

  /** Mint the next daily sequence id `WB-YYYYMMDD-NNN`. */
  private nextId(now: Date): string {
    const day = now.toISOString().slice(0, 10).replaceAll('-', '')
    const prefix = `WB-${day}-`
    let max = 0
    for (const task of this.tasks) {
      if (!task.workbenchTaskId.startsWith(prefix)) continue
      const tail = Number(task.workbenchTaskId.slice(prefix.length))
      if (Number.isInteger(tail) && tail > max) max = tail
    }
    return `${prefix}${String(max + 1).padStart(3, '0')}`
  }

  /** Retention: drop oldest terminal tasks beyond the cap, never live ones. */
  private evict(): void {
    if (this.tasks.length <= this.maxTasks) return
    const keep: WorkbenchTaskRecord[] = []
    let overflow = this.tasks.length - this.maxTasks
    for (const task of this.tasks) {
      if (overflow > 0 && (isTerminal(task.status) || task.status === 'reported')) {
        overflow -= 1
        continue
      }
      keep.push(task)
    }
    this.tasks = keep
  }

  /**
   * Read one record; the caller receives an independent copy.
   * @param workbenchTaskId - task to read.
   * @returns the record, or undefined for an unknown id.
   */
  get(workbenchTaskId: string): WorkbenchTaskRecord | undefined {
    const record = this.tasks.find(task => task.workbenchTaskId === workbenchTaskId)
    return record === undefined ? undefined : cloneRecord(record)
  }

  /**
   * Newest-first snapshot of every retained record.
   * @returns independent copies of every record.
   */
  list(): WorkbenchTaskRecord[] {
    return this.tasks.map(cloneRecord)
  }

  /**
   * Apply one mutation to a record and persist. The mutator runs against the
   * live record; returning without changes is a no-op write.
   * @param workbenchTaskId - task to mutate.
   * @param mutate - in-place mutation of the live record.
   * @returns the updated record, or undefined when the task is missing.
   */
  async update(workbenchTaskId: string, mutate: (record: WorkbenchTaskRecord) => void): Promise<WorkbenchTaskRecord | undefined> {
    return this.transaction(() => {
      const record = this.tasks.find(task => task.workbenchTaskId === workbenchTaskId)
      if (record === undefined) return undefined
      mutate(record)
      record.updatedAt = new Date().toISOString()
      if (record.transcript.length > this.transcriptCap) {
        record.transcript = record.transcript.slice(record.transcript.length - this.transcriptCap)
      }
      return this.persist({ v: 1, tasks: this.tasks }).then(() => cloneRecord(record))
    })
  }

  /**
   * Guarded status transition: refuses illegal moves instead of coercing.
   * @param workbenchTaskId - task to transition.
   * @param to - requested terminal or chain status.
   * @param fields - record patches applied with the transition.
   * @returns the updated record, or undefined when the task is missing.
   * @throws Error naming the refused transition.
   */
  async transition(
    workbenchTaskId: string,
    to: WorkbenchTaskRecord['status'],
    fields: Partial<Pick<WorkbenchTaskRecord, 'lastError' | 'echoLost' | 'acpSessionId' | 'awaitingInput'>> = {},
  ): Promise<WorkbenchTaskRecord | undefined> {
    return this.update(workbenchTaskId, (record) => {
      if (record.status === to) {
        Object.assign(record, fields)
        return
      }
      if (!transitionAllowed(record.status, to)) {
        throw new Error(`illegal task transition ${record.status} -> ${to} for ${workbenchTaskId}`)
      }
      record.status = to
      record.transcript.push({ at: new Date().toISOString(), kind: 'status', text: to, key: null, toolStatus: null })
      Object.assign(record, fields)
    })
  }
}

function cloneRecord(record: WorkbenchTaskRecord): WorkbenchTaskRecord {
  return { ...record, transcript: record.transcript.map(event => ({ ...event })) }
}

/** Default fields added after the persisted shape grew; old files keep loading. */
function normalizeRecord(record: WorkbenchTaskRecord): WorkbenchTaskRecord {
  return { ...record, desktopTaskId: record.desktopTaskId ?? null }
}
