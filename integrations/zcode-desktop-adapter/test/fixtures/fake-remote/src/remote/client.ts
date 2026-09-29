// Fake RemoteClient for the desktop-adapter integration tests.
//
// Loads its behaviour from environment variables (set by the test on the
// adapter child process; the fake is imported in-process by the adapter):
//   ZCODE_FAKE_JOURNAL        append-only JSONL journal of every call
//   ZCODE_FAKE_STATE_DIR      binding dir checked at send time to prove the
//                             dispatch ledger was persisted BEFORE the envelope
//                             left the process
//   ZCODE_FAKE_BOOTSTRAP      JSON bootstrap result (default: one workspace)
//   ZCODE_FAKE_BOOTSTRAP_DELAY_MS delays bootstrap so a discovery can be held
//                             open (controller-slot serialization tests)
//   ZCODE_FAKE_CONNECT_ERROR  when set, connect() throws it (site offline)
//   ZCODE_FAKE_ACK            JSON sendConversationCommandV4 ack (default:
//                             accepted with sessionId dtask-1)
//   ZCODE_FAKE_SEND_ERROR     when set, createSession/sendText throws it
//   ZCODE_FAKE_STOP_ERROR     when set, the stop command throws it (cancel path)
//   ZCODE_FAKE_REGISTER_ERROR when set, zcode-task/createTask throws it
//   ZCODE_FAKE_REGISTER_DELAY_MS delays registration so turn frames can race it
//   ZCODE_FAKE_TASK_LIST       JSON map bridge-workspace-key → ZCodeTaskMeta[]
//                             served by zcode-task/listTasks
//   ZCODE_FAKE_LIST_TASKS_ERROR when set, zcode-task/listTasks throws it
//   ZCODE_FAKE_V4_SCRIPT_FILE JSON conversation-frame script:
//                             { subscribeFrames: [...], frames: [...],
//                               resyncFrames: [...], stopFrames: [...],
//                               resyncError?: string, frameDelayMs?: number,
//                               gate?: { turnIndex, frameIndex, releaseFile } }
//                             Wire entries are official TopicWireFrameCandidate
//                             shapes. subscribeFrames play at subscription (the
//                             pre-dispatch baseline snapshot); frames play once
//                             after the first createSession/sendText ack;
//                             resyncFrames play when the adapter calls
//                             resyncConversationV4; stopFrames play when it
//                             sends a stop command. `gate` parks one dispatched
//                             turn's frame (and everything after it in that
//                             turn's list) until `releaseFile` exists — the
//                             journal records gate-held/gate-released/gate-
//                             timeout, so a test can PROVE a frame has not
//                             been delivered yet and release it on demand
//                             instead of guessing with frame delays.
//
// zcode-task/getTaskSnapshot is intentionally UNSUPPORTED: the adapter must
// not regress to the stale snapshot path, so an accidental call fails loud.
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import type { RemoteConnectionParams } from "./connection-params.ts";

function journal(kind: string, value: unknown): void {
  const file = process.env.ZCODE_FAKE_JOURNAL;
  if (file === undefined) return;
  appendFileSync(file, `${JSON.stringify({ t: Date.now(), kind, value })}\n`);
}

function readJsonEnv(name: string, fallback: unknown): unknown {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return JSON.parse(raw);
}

interface FrameScript {
  /** The Nth subscription plays the Nth entry. */
  subscribeTurns?: unknown[][];
  /** Single-turn convenience: wrapped as a one-entry subscribe list. */
  subscribeFrames?: unknown[];
  /** Single-turn convenience: wrapped as a one-entry turn list. */
  frames?: unknown[];
  /** The Nth dispatched input plays the Nth entry. */
  turns?: unknown[][];
  resyncFrames?: unknown[];
  stopFrames?: unknown[];
  resyncError?: string;
  frameDelayMs?: number;
  /** Deterministic latch over one dispatched turn's frames (see header). */
  gate?: ScriptGate;
}

interface ScriptGate {
  /** 0-based index into `turns`/`frames` whose delivery is held. */
  turnIndex: number;
  /** 0-based frame index inside that turn's list that parks on the gate. */
  frameIndex: number;
  /** The gate opens when this file exists; the test writes it to release. */
  releaseFile: string;
  /** Bounded hold; on expiry the frame releases anyway and gate-timeout journals. */
  timeoutMs?: number;
}

/** A gate is only trusted when its shape is complete; malformed means absent. */
function gateOf(script: FrameScript, turnIndex: number): ScriptGate | undefined {
  const gate = script.gate;
  if (gate === undefined || gate.turnIndex !== turnIndex) return undefined;
  if (typeof gate.releaseFile !== "string" || gate.releaseFile.length === 0) return undefined;
  if (!Number.isInteger(gate.frameIndex) || gate.frameIndex < 0) return undefined;
  return gate;
}

function listOf(script: FrameScript, key: "turns" | "subscribeTurns", convenience: "frames" | "subscribeFrames"): unknown[][] {
  if (script[key] !== undefined) return script[key];
  if (script[convenience] !== undefined) return [script[convenience]];
  return [];
}

function turnListOf(script: FrameScript): unknown[][] {
  return listOf(script, "turns", "frames");
}

function subscribeListOf(script: FrameScript): unknown[][] {
  return listOf(script, "subscribeTurns", "subscribeFrames");
}

function readScript(): FrameScript {
  const file = process.env.ZCODE_FAKE_V4_SCRIPT_FILE;
  if (file === undefined || !existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as FrameScript;
}

/** True when any binding file already carries this command id in its ledger. */
function dispatchPersisted(commandId: unknown): boolean {
  const dir = process.env.ZCODE_FAKE_STATE_DIR;
  if (typeof commandId !== "string" || dir === undefined) return false;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const binding = JSON.parse(readFileSync(`${dir}/${name}`, "utf8"));
      if (binding?.dispatch?.commandId === commandId) return true;
    } catch {
      /* unreadable bindings cannot prove anything */
    }
  }
  return false;
}

const DEFAULT_BOOTSTRAP = {
  desktopAppVersion: "3.14.0-fake",
  workspaces: [{ workspacePath: "D:\\fake-ws", workspaceIdentity: "wid-fake" }],
};

type FrameListener = (wire: unknown) => void;

// The adapter releases and re-bridges the relay slot at every turn boundary,
// so per-conversation counters must outlive one RemoteBridgeSession.
let commandCount = 0;
let subscribeCount = 0;

// One controller slot per paired device, like the official relay: a connect()
// while another client still holds the slot kicks the older controller
// (journaled as "kick"; the adapter observes it through client.state).
let activeController: RemoteClient | null = null;

export class RemoteBridgeSession {
  readonly workspaceKey: string;
  private readonly frameListeners = new Set<FrameListener>();
  private readonly pendingBroadcast: unknown[] = [];

  constructor(workspaceKey: string) {
    this.workspaceKey = workspaceKey;
  }

  onRecovered(): () => void {
    return () => {};
  }

  subscribe(_channel: string, _event: string, listener: FrameListener, _arg?: unknown): () => void {
    this.frameListeners.add(listener);
    if (this.frameListeners.size === 1 && this.pendingBroadcast.length > 0) {
      const backlog = this.pendingBroadcast.splice(0);
      for (const wire of backlog) listener(wire);
    }
    return () => {
      this.frameListeners.delete(listener);
    };
  }

  private broadcast(wire: unknown): void {
    if (this.frameListeners.size === 0) {
      this.pendingBroadcast.push(wire);
      return;
    }
    for (const listener of this.frameListeners) listener(wire);
  }

  /**
   * Schedules one frame list. `turnIndex >= 0` names the dispatched turn the
   * list belongs to (gates only ever key on dispatched turns); negative values
   * mark non-turn lists (subscribe baseline, resync, stop) which no gate holds.
   */
  private play(entries: unknown[] | undefined, turnIndex: number): void {
    if (entries === undefined) return;
    const script = readScript();
    const gate = gateOf(script, turnIndex);
    let delay = 0;
    entries.forEach((wire, index) => {
      if (gate !== undefined && index > gate.frameIndex) return; // the gate release schedules these
      if (gate !== undefined && index === gate.frameIndex) {
        this.holdAtGate(gate, () => {
          this.broadcast(wire);
          let after = 0;
          for (let later = index + 1; later < entries.length; later += 1) {
            after += script.frameDelayMs ?? 5;
            const timer = setTimeout(() => {
              this.broadcast(entries[later]);
            }, after);
            timer.unref?.();
          }
        });
        return;
      }
      delay += script.frameDelayMs ?? 5;
      const timer = setTimeout(() => {
        this.broadcast(wire);
      }, delay);
      timer.unref?.();
    });
  }

  /** Parks the gated frame until the release file exists; journals both edges. */
  private holdAtGate(gate: ScriptGate, onRelease: () => void): void {
    journal("gate-held", { turnIndex: gate.turnIndex, frameIndex: gate.frameIndex });
    const deadline = Date.now() + (gate.timeoutMs ?? 30_000);
    const poll = setInterval(() => {
      if (!existsSync(gate.releaseFile)) {
        if (Date.now() > deadline) {
          clearInterval(poll);
          journal("gate-timeout", { turnIndex: gate.turnIndex, frameIndex: gate.frameIndex });
          onRelease();
        }
        return;
      }
      clearInterval(poll);
      journal("gate-released", { turnIndex: gate.turnIndex, frameIndex: gate.frameIndex });
      onRelease();
    }, 10);
    poll.unref?.();
  }

  async call(channel: string, name: string, args: unknown[]): Promise<unknown> {
    journal("call", { channel, name, args });
    if (channel === "zcode-agent" && name === "helloConversationV4") {
      return {
        kind: "hello",
        protocolVersion: 3,
        connectionId: "fake-connection-1",
        clientMode: "web-remote-replayable",
        deliveryProfile: "replayable",
        serverTime: Date.now(),
        capabilities: {
          nativeDialogs: true,
          localTerminal: true,
          binaryFrames: false,
          compression: "none",
          workspaceHookReview: true,
          independentPlanState: true,
        },
        auth: {},
      };
    }
    if (channel === "zcode-agent" && name === "initializeConversationV4") {
      return {};
    }
    if (channel === "zcode-agent" && name === "subscribeConversationV4") {
      const subscribes = subscribeListOf(readScript());
      this.play(subscribes[Math.min(subscribeCount, subscribes.length - 1)], -1);
      subscribeCount += 1;
      return { ack: { subscriptionId: "fsub-1", mode: "snapshot", logEpoch: "fake-epoch" } };
    }
    if (channel === "zcode-agent" && name === "resyncConversationV4") {
      if (!("base" in (args[0] as Record<string, unknown>))) throw new Error("fake: resync base is required");
      const script = readScript();
      if (typeof script.resyncError === "string") throw new Error(script.resyncError);
      this.play(script.resyncFrames, -1);
      return {};
    }
    if (channel === "zcode-agent" && name === "unsubscribeConversationV4") {
      return {};
    }
    if (channel === "zcode-agent" && name === "sendConversationCommandV4") {
      const envelope = (args[0] as { envelope?: { commandId?: unknown; type?: string } })?.envelope;
      if (envelope?.type === "createSession" || envelope?.type === "sendText" || envelope?.type === "stop") {
        journal("send-check", {
          commandId: envelope.commandId,
          type: envelope.type,
          dispatchPersistedBeforeSend: dispatchPersisted(envelope.commandId),
        });
      }
      const sendError = process.env.ZCODE_FAKE_SEND_ERROR;
      if (sendError !== undefined && envelope?.type !== "stop") throw new Error(sendError);
      const stopError = process.env.ZCODE_FAKE_STOP_ERROR;
      if (stopError !== undefined && envelope?.type === "stop") throw new Error(stopError);
      if (envelope?.type === "stop") {
        this.play(readScript().stopFrames, -1);
      } else {
        // The Nth dispatched input plays the Nth turn's frame list; the index
        // is passed through so a script gate can key on this exact turn.
        const turns = turnListOf(readScript());
        const turnIndex = Math.min(commandCount, turns.length - 1);
        this.play(turns[turnIndex], turnIndex);
        commandCount += 1;
      }
      const ack = readJsonEnv("ZCODE_FAKE_ACK", { status: "accepted", result: { sessionId: "dtask-1" } });
      // The real desktop echoes the dispatched command id on its acknowledgement;
      // flat fixtures that omit one are filled in so they stay contract-faithful.
      if (
        typeof envelope?.commandId === "string" &&
        typeof (ack as { commandId?: unknown }).commandId === "undefined" &&
        typeof (ack as { status?: unknown }).status === "string"
      ) {
        return { ...(ack as Record<string, unknown>), commandId: envelope.commandId };
      }
      return ack;
    }
    if (channel === "zcode-task" && name === "createTask") {
      const delayMs = Number(process.env.ZCODE_FAKE_REGISTER_DELAY_MS ?? 0);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const registerError = process.env.ZCODE_FAKE_REGISTER_ERROR;
      if (registerError !== undefined) throw new Error(registerError);
      return { taskId: (args[0] as { draftSessionId?: string })?.draftSessionId };
    }
    if (channel === "zcode-task" && name === "listTasks") {
      // The desktop's synced task index, workspace-scoped: a map from bridge
      // workspace key (identity, else path) to ZCodeTaskMeta rows.
      const listError = process.env.ZCODE_FAKE_LIST_TASKS_ERROR;
      if (listError !== undefined) throw new Error(listError);
      const byKey = readJsonEnv("ZCODE_FAKE_TASK_LIST", {}) as Record<string, unknown>;
      const scope = args[0] as { workspacePath?: string; workspaceIdentity?: string } | undefined;
      const key = scope?.workspaceIdentity ?? scope?.workspacePath ?? "";
      return Array.isArray(byKey[key]) ? byKey[key] : [];
    }
    if (channel === "zcode-task") {
      throw new Error(`fake: zcode-task/${name} is intentionally unsupported (the adapter must not read stale snapshots)`);
    }
    if (channel === "zcode-agent") return {};
    throw new Error(`fake: unsupported call ${channel}/${name}`);
  }
}

export class RemoteClient {
  readonly params: RemoteConnectionParams;
  private kicked = false;

  constructor(params: RemoteConnectionParams, _options: unknown) {
    this.params = params;
  }

  get state(): string {
    return this.kicked ? "kicked" : "paired";
  }

  get description(): string {
    return "fake-remote-client";
  }

  onWorkspaceListUpdated(): () => void {
    return () => {};
  }

  onFailure(): () => void {
    return () => {};
  }

  async connect(): Promise<unknown> {
    journal("connect", this.params.source.host);
    const connectError = process.env.ZCODE_FAKE_CONNECT_ERROR;
    if (connectError !== undefined) throw new Error(connectError);
    if (activeController !== null && activeController !== this) {
      journal("kick", null);
      activeController.kicked = true;
    }
    activeController = this;
    return { paired: true, state: "paired", workspaces: [] };
  }

  async bootstrap(): Promise<unknown> {
    journal("bootstrap", null);
    const delayMs = Number(process.env.ZCODE_FAKE_BOOTSTRAP_DELAY_MS ?? 0);
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return readJsonEnv("ZCODE_FAKE_BOOTSTRAP", DEFAULT_BOOTSTRAP);
  }

  async listWorkspaces(): Promise<unknown> {
    return { workspaces: [] };
  }

  async openBridge(workspaceKey: string): Promise<RemoteBridgeSession> {
    journal("openBridge", workspaceKey);
    return new RemoteBridgeSession(workspaceKey);
  }

  async useWorkspace(workspaceKey: string): Promise<RemoteBridgeSession> {
    return await this.openBridge(workspaceKey);
  }

  dispose(): void {
    journal("dispose", null);
    if (activeController === this) activeController = null;
  }
}

export function parseRemoteMethod(method: string): { channel: string; name: string } {
  const separator = Math.max(method.lastIndexOf("/"), method.lastIndexOf("."));
  return { channel: method.slice(0, separator), name: method.slice(separator + 1) };
}
