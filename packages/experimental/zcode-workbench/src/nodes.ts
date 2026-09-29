/**
 * Durable registry of dispatched Zcode nodes. A node is an operator-owned ACP
 * agent launcher: command plus arguments that name a private adapter
 * configuration file. The registry stores paths and labels only — connection
 * addresses and credentials live inside the adapter configuration the node
 * points at and are never read here.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkbenchNodeInput, ZcodeNodeHealth, ZcodeNodeRecord } from './types.ts'

/** Persisted file envelope; `v` guards the shape on load. */
interface NodeFile {
  v: 1
  nodes: ZcodeNodeRecord[]
}

/** Node id grammar: lowercase slug. */
export const NODE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Label and site note bounds. */
export const NODE_LABEL_MAX = 80

/** Maximum adapter argument count on one node. */
export const NODE_ARGS_MAX = 16

function parseFile(raw: string): NodeFile {
  const parsed: unknown = JSON.parse(raw)
  if (typeof parsed !== 'object' || parsed === null) throw new Error('node store is not an object')
  const file = parsed as Partial<NodeFile>
  if (file.v !== 1 || !Array.isArray(file.nodes)) throw new Error('node store envelope mismatch')
  return { v: 1, nodes: file.nodes.filter((node): node is ZcodeNodeRecord => typeof node === 'object' && node !== null) }
}

/** Create-or-update input validated before it reaches the registry. */
export type SaveNodeInput = WorkbenchNodeInput

/**
 * Validate one node submission. Validation lives here so every entry point
 * (Client RPC) enforces the same bounds.
 * @throws Error naming the first violated bound.
 */
/**
 * Validate one node submission before it reaches the store.
 * @param input - node submission to validate.
 * @throws Error naming the first invalid field.
 */
export function validateNodeInput(input: SaveNodeInput): void {
  if (!NODE_ID_PATTERN.test(input.id)) throw new Error('node id must be a lowercase slug')
  if (input.kind !== 'local' && input.kind !== 'remote') throw new Error('node kind must be local or remote')
  if (input.label.length === 0 || input.label.length > NODE_LABEL_MAX) {
    throw new Error(`node label must be 1..${NODE_LABEL_MAX} characters`)
  }
  if (input.siteLabel.length > NODE_LABEL_MAX) throw new Error(`node site label exceeds ${NODE_LABEL_MAX} characters`)
  if (input.command.length === 0) throw new Error('node command must not be empty')
  if (input.args.length > NODE_ARGS_MAX) throw new Error(`node accepts at most ${NODE_ARGS_MAX} arguments`)
  for (const argument of input.args) {
    if (typeof argument !== 'string' || argument.length === 0) throw new Error('node arguments must be non-empty strings')
  }
  if (input.workspaceSelection !== 'fixed' && input.workspaceSelection !== 'session') {
    throw new Error('node workspaceSelection must be fixed or session')
  }
}

/**
 * File-backed node registry with last-health side data kept beside the records
 * so a restart keeps the last observed probe result.
 */
export class NodeStore {
  private readonly stateDir: string
  private readonly file: string
  private readonly healthFile: string
  private nodes: ZcodeNodeRecord[] = []
  private health = new Map<string, ZcodeNodeHealth>()
  private chain: Promise<void> = Promise.resolve()

  /** @param stateDir - private directory holding `nodes.json` and `node-health.json`. */
  constructor(stateDir: string) {
    this.stateDir = stateDir
    this.file = join(stateDir, 'nodes.json')
    this.healthFile = join(stateDir, 'node-health.json')
  }

  /** Load or initialize both files; the directory is created when absent. */
  async load(): Promise<void> {
    await mkdir(this.stateDir, { recursive: true })
    this.nodes = await this.readFile(this.file, raw => parseFile(raw).nodes, [])
    this.health = await this.readFile(this.healthFile, (raw) => {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null) throw new Error('node health is not an object')
      const record = parsed as Record<string, unknown>
      const out = new Map<string, ZcodeNodeHealth>()
      for (const [id, value] of Object.entries(record)) {
        if (typeof value === 'object' && value !== null) out.set(id, value as ZcodeNodeHealth)
      }
      return out
    }, new Map<string, ZcodeNodeHealth>())
  }

  private async readFile<T>(file: string, parse: (raw: string) => T, fallback: T): Promise<T> {
    let raw: string
    try {
      raw = await readFile(file, 'utf8')
    } catch {
      return fallback
    }
    try {
      return parse(raw)
    } catch {
      return fallback
    }
  }

  private write(file: string, value: object): Promise<void> {
    const temporary = `${file}.${process.pid}.tmp`
    return writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8').then(() => rename(temporary, file))
  }

  private transaction<T>(mutate: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(() => mutate())
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Insert or update one node by id.
   * @param input - validated node submission.
   * @returns the stored record.
   */
  async save(input: SaveNodeInput): Promise<ZcodeNodeRecord> {
    return this.transaction(() => {
      validateNodeInput(input)
      const now = new Date().toISOString()
      const existing = this.nodes.find(node => node.id === input.id)
      const record: ZcodeNodeRecord = {
        id: input.id,
        kind: input.kind,
        label: input.label,
        siteLabel: input.siteLabel,
        command: input.command,
        args: [...input.args],
        workspaceSelection: input.workspaceSelection,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      }
      this.nodes = [record, ...this.nodes.filter(node => node.id !== input.id)]
      return this.write(this.file, { v: 1, nodes: this.nodes }).then(() => ({ ...record, args: [...record.args] }))
    })
  }

  /**
   * Remove one node; its health side data goes with it.
   * @param id - node id.
   * @returns whether a node was removed.
   */
  async remove(id: string): Promise<boolean> {
    return this.transaction(() => {
      const before = this.nodes.length
      this.nodes = this.nodes.filter(node => node.id !== id)
      const removed = this.nodes.length < before
      if (removed) this.health.delete(id)
      return removed
        ? this.write(this.file, { v: 1, nodes: this.nodes })
          .then(() => this.write(this.healthFile, Object.fromEntries(this.health)))
          .then(() => true)
        : false
    })
  }

  /**
   * Read one node record.
   * @param id - node id.
   * @returns an independent copy, or undefined for an unknown id.
   */
  get(id: string): ZcodeNodeRecord | undefined {
    const node = this.nodes.find(entry => entry.id === id)
    return node === undefined ? undefined : { ...node, args: [...node.args] }
  }

  /**
   * Snapshot of every node record.
   * @returns independent copies of every node.
   */
  list(): ZcodeNodeRecord[] {
    return this.nodes.map(node => ({ ...node, args: [...node.args] }))
  }

  /**
   * Last observed health of one node; `unknown` until first probe.
   * @param id - node id.
   * @returns the recorded health view.
   */
  healthOf(id: string): ZcodeNodeHealth {
    return this.health.get(id) ?? { state: 'unknown', checkedAt: null, desktopVersion: null, workspaceCount: null, detail: null }
  }

  /**
   * Record one probe outcome durably.
   * @param id - node id.
   * @param health - probe outcome to record.
   */
  async saveHealth(id: string, health: ZcodeNodeHealth): Promise<void> {
    return this.transaction(() => {
      this.health.set(id, health)
      return this.write(this.healthFile, Object.fromEntries(this.health))
    })
  }

  /**
   * Best-effort in-memory mark that a probe started.
   * @param id - node id.
   */
  markChecking(id: string): void {
    const current = this.health.get(id)
    this.health.set(id, {
      state: 'checking',
      checkedAt: current?.checkedAt ?? null,
      desktopVersion: current?.desktopVersion ?? null,
      workspaceCount: current?.workspaceCount ?? null,
      detail: current?.detail ?? null,
    })
  }
}
