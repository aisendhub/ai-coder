import { observer } from "mobx-react-lite"
import { useEffect, useState } from "react"
import {
  MessageSquare,
  Gauge,
  Zap,
  GitBranch,
  Clock,
  Ship,
  Users,
  Pause,
  Eye,
  Workflow,
  Loader2,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { workspace } from "@/models"
import type { Conversation } from "@/models"
import { usePersistentState } from "@/hooks/use-persistent-state"

type IconType = typeof MessageSquare

// ─────────────────────────────────────────────────────────────────────────────
// Three variants:
//   - NoActive: no conversation selected. Dual-card overview with primary actions.
//   - FreshChat: active chat with zero messages. Brief "what is a chat" card.
//   - FreshTask: active task with zero messages. Brief "what is a task" card.
// Everything derives from `workspace.active` so the caller just renders
// <EmptyState />. Returns null when there's nothing empty to show.
// ─────────────────────────────────────────────────────────────────────────────

export const EmptyState = observer(function EmptyState() {
  const conv = workspace.active
  if (!conv) return <NoActive />
  if (conv.messages.items.length > 0) return null
  // Until the messages fetch has committed, `messages.length === 0` is
  // ambiguous — it could be a draft or a saved task whose rows haven't
  // arrived yet. Rendering FreshTask/FreshChat here is what causes the
  // post-reload flash on saved tasks. Wait for `loaded` to commit so we
  // only show the compose card for genuine empties (true drafts).
  if (!conv.loaded) return null
  if (conv.kind === "task") return <FreshTask conversation={conv} />
  return <FreshChat />
})

// ── No active conversation ──────────────────────────────────────────────────

const NoActive = observer(function NoActive() {
  const hasProject = !!workspace.activeProjectId
  const [creating, setCreating] = useState<null | "chat" | "task">(null)

  const onNewChat = async () => {
    if (!hasProject) return
    setCreating("chat")
    try { await workspace.createNew() } catch (err) { console.error(err) }
    finally { setCreating(null) }
  }

  const onNewTask = async () => {
    if (!hasProject) return
    setCreating("task")
    try { await workspace.createTaskDraft() } catch (err) { console.error(err) }
    finally { setCreating(null) }
  }

  return (
    <div className="flex flex-col items-center justify-center py-12 px-6 gap-6 min-h-full">
      <div className="text-center max-w-xl">
        <h2 className="text-xl font-semibold mb-2">Chat or Task?</h2>
        <p className="text-sm text-muted-foreground">
          Two ways to work with the agent. Pick deliberately — they behave very differently.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4 w-full max-w-3xl">
        <GuideCard
          icon={MessageSquare}
          tone="primary"
          title="Chat"
          tagline="Interactive · shared cwd · quick"
          bullets={[
            { icon: Eye, text: "You read each reply before the next — steering turn-by-turn." },
            { icon: Clock, text: "Short work. Minutes, not hours." },
            { icon: Zap, text: "Edits land on the project cwd. Commit/Push straight to the repo." },
          ]}
          cta={
            <Button className="w-full" onClick={onNewChat} disabled={!hasProject || creating !== null}>
              {creating === "chat" ? <Loader2 className="size-4 animate-spin" /> : <MessageSquare className="size-4" />}
              New chat
            </Button>
          }
        />
        <GuideCard
          icon={Gauge}
          tone="accent"
          title="Task"
          tagline="Autonomous · own branch · shippable"
          bullets={[
            { icon: Workflow, text: "Write a goal, walk away. Evaluator-optimizer loop iterates." },
            { icon: GitBranch, text: "Own worktree on its own branch. Parallel tasks don't collide." },
            { icon: Ship, text: "Finish with Merge (fast-forward) or PR (gh pr create)." },
          ]}
          cta={
            <Button
              variant="secondary"
              className="w-full"
              onClick={onNewTask}
              disabled={!hasProject || creating !== null}
            >
              {creating === "task" ? <Loader2 className="size-4 animate-spin" /> : <Gauge className="size-4" />}
              New task
            </Button>
          }
        />
      </div>

      <div className="text-xs text-muted-foreground text-center max-w-xl">
        Rule of thumb: would you write a ticket for this? → Task. Are you just talking? → Chat.
      </div>

      {!hasProject && (
        <div className="text-xs text-muted-foreground text-center">
          Select or create a project from the sidebar to get started.
        </div>
      )}
    </div>
  )
})

// ── Fresh chat ──────────────────────────────────────────────────────────────

function FreshChat() {
  return (
    <div className="flex flex-col items-center justify-center py-10 px-6 min-h-full">
      <div className="w-full max-w-xl rounded-lg border bg-muted/30 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="size-4" />
          <h3 className="text-sm font-semibold">This is a chat</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          You're in the project's working directory. The agent's edits show up in the Changes panel; <span className="font-medium text-foreground">Commit</span> and <span className="font-medium text-foreground">Push</span> act directly on the repo.
        </p>
        <div className="text-xs text-muted-foreground space-y-1.5">
          <Row icon={Eye} text="Turn-by-turn — you read replies before sending the next." />
          <Row icon={Clock} text="Best for short work: Q&A, quick fixes, pair-programming." />
          <Row icon={Gauge} text="Need to run autonomously or ship on a branch? Click Spin off in the top bar — becomes a task." />
        </div>
      </div>
      <p className="text-xs text-muted-foreground mt-4">Type below to start.</p>
    </div>
  )
}

// ── Fresh task ──────────────────────────────────────────────────────────────

const FreshTask = observer(function FreshTask({ conversation }: { conversation: Conversation }) {
  // Draft inputs persist locally, keyed per conversation — so a user who
  // types a goal and reloads (or opens the tab elsewhere) gets their input
  // back. The server's autoLoopGoal is the fallback only; localStorage wins
  // once there's anything there. Cleared after a successful `armTask`.
  const goalKey = `ai-coder:draft:${conversation.id}:goal`
  const maxIterKey = `ai-coder:draft:${conversation.id}:maxIterations`
  const maxCostKey = `ai-coder:draft:${conversation.id}:maxCostUsd`
  const [goal, setGoal] = usePersistentState(goalKey, conversation.autoLoopGoal ?? "")
  const [maxIterations, setMaxIterations] = usePersistentState(maxIterKey, conversation.maxIterations || 5)
  const [maxCostUsd, setMaxCostUsd] = usePersistentState(maxCostKey, conversation.maxCostUsd || 1)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!goal && conversation.autoLoopGoal) setGoal(conversation.autoLoopGoal)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.autoLoopGoal])

  const handleStart = async () => {
    if (!goal.trim()) {
      setError("Goal is required")
      return
    }
    setStarting(true)
    setError(null)
    try {
      await workspace.armTask(conversation.id, {
        goal: goal.trim(),
        maxIterations,
        maxCostUsd,
      })
      // Draft is armed — drop the saved input so stale drafts don't linger
      // in localStorage forever.
      try {
        window.localStorage.removeItem(goalKey)
        window.localStorage.removeItem(maxIterKey)
        window.localStorage.removeItem(maxCostKey)
      } catch { /* ignore */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="flex flex-col items-center justify-center py-10 px-6 gap-6 min-h-full w-full">
      <div className="w-full max-w-2xl rounded-lg border bg-muted/30 p-5 space-y-3">
        <div className="flex items-center gap-2">
          <Gauge className="size-4" />
          <h3 className="text-sm font-semibold">This is a task</h3>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Autonomous work on its own branch. The evaluator-optimizer loop drives the next step until the goal is met, the iteration cap is hit, or the budget runs out. Use a task when you want to write a goal once and walk away.
        </p>
        <div className="text-xs text-muted-foreground space-y-1.5">
          <Row icon={Workflow} text="Worker edits → read-only evaluator critiques → next worker turn. Iteration meter ticks above." />
          <Row icon={GitBranch} text="Own worktree on its own branch. Parallel tasks don't step on each other's files." />
          <Row icon={Pause} text="Pause / Resume / Stop from the task header anytime." />
          <Row icon={Ship} text="Ship via Merge (fast-forward into base) or PR (push + gh pr create)." />
          <Row icon={Users} text="Send messages mid-loop — they land at the next tool boundary as nudges." />
        </div>
      </div>

      <div className="w-full max-w-2xl rounded-lg border bg-card p-5 space-y-4">
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium">Goal</label>
            <span className="text-[10px] text-muted-foreground">
              Shift+Enter or ⌘Enter to start
            </span>
          </div>
          <textarea
            className="w-full min-h-32 rounded-md border bg-background px-3 py-2 text-sm font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="Describe the outcome the agent should achieve. Be specific about what done looks like."
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              // Shift+Enter or Cmd/Ctrl+Enter submits. Plain Enter keeps the
              // textarea default (newline) so multi-line goals are easy to type.
              const submitCombo =
                (e.key === "Enter" && e.shiftKey) ||
                (e.key === "Enter" && (e.metaKey || e.ctrlKey))
              if (submitCombo && !starting && goal.trim()) {
                e.preventDefault()
                void handleStart()
              }
            }}
            autoFocus
            disabled={starting}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Max iterations</label>
            <Input
              type="number"
              min={1}
              max={20}
              value={maxIterations}
              disabled={starting}
              onChange={(e) => setMaxIterations(Number(e.target.value) || 5)}
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium">Max cost (USD)</label>
            <Input
              type="number"
              min={0.1}
              step={0.1}
              value={maxCostUsd}
              disabled={starting}
              onChange={(e) => setMaxCostUsd(Number(e.target.value) || 1)}
            />
          </div>
        </div>

        {error && <div className="text-xs text-red-600">{error}</div>}

        <div className="flex justify-end">
          <Button onClick={handleStart} disabled={starting || !goal.trim()}>
            {starting ? <Loader2 className="size-3.5 animate-spin" /> : <Gauge className="size-3.5" />}
            Start task
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        The worktree is provisioned when you start. No branch is created for a draft.
      </p>
    </div>
  )
})

// ── Shared bits ─────────────────────────────────────────────────────────────

function Row({ icon: Icon, text }: { icon: IconType; text: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="size-3.5 mt-0.5 shrink-0 text-muted-foreground" />
      <span>{text}</span>
    </div>
  )
}

function GuideCard({
  icon: Icon,
  tone,
  title,
  tagline,
  bullets,
  cta,
}: {
  icon: IconType
  tone: "primary" | "accent"
  title: string
  tagline: string
  bullets: { icon: IconType; text: string }[]
  cta: React.ReactNode
}) {
  const ring = tone === "primary" ? "ring-primary/10" : "ring-sky-500/10"
  return (
    <div className={`rounded-lg border bg-card p-5 space-y-3 ring-1 ${ring}`}>
      <div className="flex items-center gap-2">
        <Icon className="size-5" />
        <h3 className="font-semibold">{title}</h3>
      </div>
      <p className="text-xs text-muted-foreground">{tagline}</p>
      <div className="space-y-2 text-xs text-muted-foreground">
        {bullets.map((b, i) => (
          <Row key={i} icon={b.icon} text={b.text} />
        ))}
      </div>
      <div className="pt-2">{cta}</div>
    </div>
  )
}
