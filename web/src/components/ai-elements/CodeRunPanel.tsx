import { createContext, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { PlayIcon, SquareIcon } from "lucide-react";
import { DisabledActionTooltip } from "@/components/DisabledActionTooltip";
import { useScopedConversationId } from "@/components/chat/conversationScope";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useCanEdit, useIsOwner } from "@/hooks/usePermissions";
import { useIsMobileViewport } from "@/hooks/useIsMobileViewport";
import { useSession } from "@/hooks/useSession";
import {
  codeRunComposerText,
  confirmCodeRuns,
  deriveCodeRunCommand,
  finishedStatusText,
  harnessReceivesCodeRuns,
  isCodeRunConfirmed,
  sha256Hex,
  startCodeRun,
  stopCodeRun,
  type CodeRunLanguage,
} from "@/lib/codeRuns";
import { cn } from "@/lib/utils";
import { OutputView } from "@/shell/NotebookPreview";
import { useChatStore } from "@/store/chatStore";
import {
  blockRuns,
  codeBlockKey,
  codeRunState,
  useCodeRunStore,
  type CodeRun,
  type CodeRunState,
  type SessionCodeRuns,
} from "@/store/codeRunStore";

/** The assistant message a chat code block belongs to; unset outside saved assistant text. */
export interface CodeRunMessage {
  messageId: string;
  /** The message is still streaming, so its blocks can't run yet. */
  streaming: boolean;
}

export const CodeRunMessageContext = createContext<CodeRunMessage | null>(null);

const LANGUAGE_LABELS: Record<CodeRunLanguage, string> = {
  shell: "Shell",
  python: "Python",
  node: "Node",
};

const RUN_NOTE =
  "Runs in this session are saved, visible to anyone who can view it, and sent to the agent on its next turn.";

// Touch-sized (44px) targets on phones.
const TOUCH_TARGET = "max-md:min-h-11 max-md:min-w-11";

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function statusText(state: CodeRunState, run: CodeRun, now: number): string {
  switch (state) {
    case "running":
      return run.startedAt === null
        ? "Running"
        : `Running · ${formatDuration(now - run.startedAt * 1000)}`;
    case "interrupted":
      return "Interrupted";
    case "waiting":
      return "Waiting for the runner";
    default: {
      const finished = run.finished!;
      const text = finishedStatusText(finished.status, finished.exitCode);
      return finished.status === "failed"
        ? text
        : `${text} · ${formatDuration(finished.durationMs)}`;
    }
  }
}

/** One run: status line, output, and the controls this viewer may use. */
function RunView({
  run,
  session,
  sessionId,
  runnerOnline,
  canStop,
  addOutput,
}: {
  run: CodeRun;
  session: SessionCodeRuns;
  sessionId: string;
  runnerOnline: boolean;
  canStop: boolean;
  /** Set when the agent doesn't receive runs and the viewer may draft a message. */
  addOutput: ((run: CodeRun) => void) | null;
}) {
  const state = codeRunState(session, run, runnerOnline);
  const now = useNow(state === "running");
  const [expanded, setExpanded] = useState(false);
  const segments = useMemo(() => {
    let at = 0;
    return run.output.map((segment) => {
      const key = at;
      at += segment.text.length;
      return { key, segment };
    });
  }, [run.output]);

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
        <span
          data-testid="code-run-status"
          data-state={state}
          className={cn(
            "text-muted-foreground",
            (state === "failed" || (state === "exited" && run.finished?.exitCode !== 0)) &&
              "text-destructive",
          )}
        >
          {statusText(state, run, now)}
        </span>
        <div className="flex items-center gap-1">
          {segments.length > 0 && (
            <Button
              className={TOUCH_TARGET}
              onClick={() => setExpanded((value) => !value)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {expanded ? "Collapse output" : "Expand output"}
            </Button>
          )}
          {canStop && state === "running" && (
            <Button
              className={TOUCH_TARGET}
              data-testid="code-run-stop"
              onClick={() => void stopCodeRun(sessionId, run.runId)}
              size="sm"
              type="button"
              variant="outline"
            >
              <SquareIcon aria-hidden="true" />
              Stop
            </Button>
          )}
        </div>
      </div>
      {segments.length > 0 && (
        <div
          data-testid="code-run-output"
          className={cn("overflow-auto border-t", !expanded && "max-h-72")}
        >
          {segments.map(({ key, segment }) => (
            <OutputView
              key={key}
              nowrap
              output={{ output_type: "stream", name: segment.stream, text: segment.text }}
            />
          ))}
        </div>
      )}
      {run.finished?.truncated && (
        <p className="border-t px-3 py-1.5 text-muted-foreground">
          Output cut: only the start and end were kept.
        </p>
      )}
      {addOutput && run.finished && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-1.5">
          <span className="text-muted-foreground">
            This agent doesn&apos;t receive runs automatically
          </span>
          <Button
            className={TOUCH_TARGET}
            onClick={() => addOutput(run)}
            size="sm"
            type="button"
            variant="outline"
          >
            Add output to message
          </Button>
        </div>
      )}
    </div>
  );
}

function CodeRunDialog({
  open,
  command,
  language,
  reason,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  command: string;
  language: CodeRunLanguage;
  /** A policy's reason for asking; unset for the first-run confirmation. */
  reason: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const sheet = useIsMobileViewport();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent
        data-testid="code-run-dialog"
        data-variant={sheet ? "sheet" : "dialog"}
        className={cn(
          sheet &&
            "top-auto bottom-0 max-w-full translate-y-0 rounded-b-none pb-[max(1.5rem,var(--omnigent-safe-bottom,0px))] sm:max-w-full",
        )}
        // The iOS shell pins `top` inline; a sheet sits on the bottom edge instead.
        style={sheet ? { top: "auto" } : undefined}
      >
        <DialogHeader>
          <DialogTitle>Run this code?</DialogTitle>
          <DialogDescription>{RUN_NOTE}</DialogDescription>
        </DialogHeader>
        {reason !== null && (
          <p className="text-sm">A policy asks you to approve this run: {reason}</p>
        )}
        <div className="min-w-0 space-y-1">
          <span className="text-xs text-muted-foreground">{LANGUAGE_LABELS[language]}</span>
          <pre className="max-h-60 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-sm whitespace-pre">
            {command}
          </pre>
        </div>
        <DialogFooter>
          <Button className={TOUCH_TARGET} onClick={onCancel} type="button" variant="outline">
            Cancel
          </Button>
          <Button className={TOUCH_TARGET} onClick={onConfirm} type="button">
            Run
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Run controls for one runnable chat code block: the header Run button
 * (owner only) and the output panel under the block (anyone who can view).
 *
 * @param render - Draws the block itself, given the Run button for its header.
 */
export function CodeBlockRunner({
  message,
  code,
  language,
  console,
  render,
  runButtonClassName,
}: {
  message: CodeRunMessage;
  /** The block's normalized text, as the server compares it. */
  code: string;
  language: CodeRunLanguage;
  console: boolean;
  render: (runButton?: ReactNode) => ReactNode;
  /** Matches the Run button to its sibling header buttons. */
  runButtonClassName?: string;
}) {
  const sessionId = useScopedConversationId() ?? "";
  const { session } = useSession(sessionId || null);
  const isOwner = useIsOwner(sessionId);
  const canEdit = useCanEdit(sessionId);
  const runs = useCodeRunStore((state) => state.sessions[sessionId]);
  const blockHash = useMemo(() => sha256Hex(code), [code]);
  const blockKey = codeBlockKey(message.messageId, blockHash);
  const command = useMemo(
    () => deriveCodeRunCommand(language, code, console),
    [language, code, console],
  );
  const [dialog, setDialog] = useState<{ reason: string | null } | null>(null);
  const [starting, setStarting] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);

  const start = useCallback(
    async (approved: boolean) => {
      const store = useCodeRunStore.getState();
      store.setRefusal(sessionId, blockKey, null);
      setStarting(true);
      try {
        const result = await startCodeRun(sessionId, {
          messageId: message.messageId,
          blockHash,
          language,
          code,
          approved,
        });
        if (result.ok) {
          store.accepted(sessionId, result.runId, {
            messageId: message.messageId,
            blockHash,
            language,
            command,
          });
        } else if (result.code === "needs_approval") {
          setDialog({ reason: result.reason });
        } else {
          if (result.code === "copy_on_write") store.setCopyOnWrite(sessionId);
          store.setRefusal(sessionId, blockKey, result.reason);
        }
      } catch (error) {
        store.setRefusal(sessionId, blockKey, error instanceof Error ? error.message : "Failed");
      } finally {
        setStarting(false);
      }
    },
    [sessionId, blockKey, message.messageId, blockHash, language, code, command],
  );

  const onRun = () => {
    if (isCodeRunConfirmed(sessionId)) void start(false);
    else setDialog({ reason: null });
  };
  const onConfirm = () => {
    const approved = dialog?.reason != null;
    if (!approved) confirmCodeRuns(sessionId);
    setDialog(null);
    void start(approved);
  };
  const onCancel = () => {
    if (dialog?.reason != null) {
      useCodeRunStore
        .getState()
        .setRefusal(sessionId, blockKey, `${dialog.reason || "Needs approval"} (not approved)`);
    }
    setDialog(null);
  };

  const addOutput = useCallback((run: CodeRun) => {
    if (!run.finished || !run.language) return;
    useChatStore.getState().addComposerText(
      codeRunComposerText({
        language: run.language,
        command: run.command,
        status: run.finished.status,
        exitCode: run.finished.exitCode,
        output: run.output,
      }),
    );
  }, []);

  if (!sessionId) return <>{render()}</>;
  const canRun = isOwner && session?.runnerId != null && !message.streaming;
  const copyOnWrite = runs?.copyOnWrite ?? false;
  const refusal = runs?.refusals[blockKey] ?? null;
  const allRuns = blockRuns(runs, message.messageId, blockHash);
  const latest = refusal === null ? allRuns[0] : undefined;
  const earlier = refusal === null ? allRuns.slice(1) : allRuns;
  const runnerOnline = session?.runnerOnline !== false;
  const runViewProps = {
    session: runs!,
    sessionId,
    runnerOnline,
    canStop: isOwner,
    addOutput: canEdit && !harnessReceivesCodeRuns(session?.harness) ? addOutput : null,
  };

  const runButton = canRun ? (
    <DisabledActionTooltip
      label="Run"
      reason={
        copyOnWrite
          ? "Code runs are unavailable in sessions whose sandbox uses copy-on-write roots"
          : undefined
      }
    >
      <Button
        aria-label="Run"
        className={cn(runButtonClassName, "max-md:size-11")}
        data-testid="code-run-button"
        disabled={copyOnWrite || starting}
        onClick={onRun}
        size="icon-sm"
        title={copyOnWrite ? undefined : "Run"}
        type="button"
        variant="ghost"
      >
        <PlayIcon aria-hidden="true" />
      </Button>
    </DisabledActionTooltip>
  ) : undefined;

  return (
    <>
      {render(runButton)}
      {(refusal !== null || allRuns.length > 0) && (
        <div
          data-testid="code-run-panel"
          className="mt-1 mb-4 w-full min-w-0 overflow-hidden rounded-md border bg-background text-sm"
        >
          {refusal !== null && (
            <div className="px-3 py-1.5">
              <span data-testid="code-run-status" data-state="refused" className="text-destructive">
                Refused: {refusal}
              </span>
            </div>
          )}
          {latest && <RunView run={latest} {...runViewProps} />}
          {earlier.length > 0 && (
            <div className="border-t">
              <Button
                className={cn("w-full justify-start rounded-none", TOUCH_TARGET)}
                onClick={() => setShowEarlier((value) => !value)}
                size="sm"
                type="button"
                variant="ghost"
              >
                {showEarlier
                  ? "Hide earlier runs"
                  : `Show ${earlier.length} earlier run${earlier.length === 1 ? "" : "s"}`}
              </Button>
              {showEarlier &&
                earlier.map((run) => (
                  <div key={run.runId} className="border-t">
                    <RunView run={run} {...runViewProps} />
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
      {dialog !== null && (
        <CodeRunDialog
          open
          command={command}
          language={language}
          reason={dialog.reason}
          onCancel={onCancel}
          onConfirm={onConfirm}
        />
      )}
    </>
  );
}
