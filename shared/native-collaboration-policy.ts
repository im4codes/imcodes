/**
 * Supervision-authority policy for provider-native collaboration agents.
 *
 * Provider-native agents (Claude `Agent`/`Workflow`/`SendMessage`, Codex
 * multi-agent, Copilot `task`/`write_agent`, ACP/runtime sub-agents) are useful
 * for ephemeral parallel reasoning and read-only analysis. Inside an IM.codes
 * MANAGED session -- any Brain (nested included), a formal participant bound
 * to a live supervision assignment, an execution clone, a Brain's child
 * sub-session, or a session carrying the sticky fence-required marker -- they
 * must never carry PROJECT TASK WORK: implementation, repair, audit or
 * re-audit, a PASS/REWORK verdict, IM.codes lifecycle authority, or a
 * Git/deploy gate. That work needs a formal IM.codes sub-session and a
 * supervision task (taskId, assignmentId, readable title, lifecycle, audit).
 * A genuinely unmanaged session keeps its provider defaults untouched.
 *
 * Enforcement is at the tool layer, never prompt text. Every agent runtime
 * declares one admission mode (`NATIVE_AGENT_ADMISSION_MODES`):
 *
 * - `pre_execution_gate`: the runtime asks the daemon before a native agent
 *   tool runs; a managed session admits only a request this classifier proves
 *   to be analysis. Task work AND unclassified text are refused.
 * - `session_fence`: no veto boundary, so a managed session's runtime is
 *   launched/loaded with native agent tools withheld; supervised work is
 *   dispatched only to (and from) a runtime whose fence is proven.
 * - `no_native_agent_tools`: nothing to withhold.
 * - `unenforceable`: neither; such a runtime cannot send or receive supervised
 *   work at all.
 *
 * The classifier is deterministic and fails closed: a request is task work
 * when it carries IM.codes authority tokens, a verdict, a repository/deploy
 * gate, an audit of a work product, or an implementation directive; it is
 * analysis ONLY when it states analysis intent and nothing else; everything in
 * between (no analysis intent, an unrecognized instruction, a request too large
 * to read whole) is `unclassified` and refused like task work.
 */

export const NATIVE_COLLABORATION_POLICY_VERSION = 'native_collaboration_policy_v1' as const;

/** Marker that opens a daemon-authored policy correction delivered to a Brain. */
export const NATIVE_COLLABORATION_POLICY_NOTICE_MARKER = '<imcodes-native-collaboration-policy-v1>' as const;

/** Hidden, durable timeline evidence of one Brain policy enforcement. */
export const NATIVE_COLLABORATION_POLICY_TIMELINE_EVENT = 'native_collaboration.policy' as const;

/**
 * How one agent runtime keeps task-bearing provider-native agent tools
 * (spawn / delegate / send-more-work) out of IM.codes-managed work. Every
 * runtime declares exactly one; there is no after-the-fact mode.
 */
export const NATIVE_AGENT_ADMISSION_MODES = {
  /** The runtime asks the daemon gate BEFORE any native agent tool executes and can refuse it with a reason. */
  PRE_EXECUTION_GATE: 'pre_execution_gate',
  /**
   * No veto boundary, but the tools can be withheld per session: a managed
   * session runs with them disabled, a verified unmanaged one keeps provider
   * defaults. Supervised work needs the fence proven for the live runtime.
   */
  SESSION_FENCE: 'session_fence',
  /** The agent has no provider-native agent tool. */
  NO_NATIVE_AGENT_TOOLS: 'no_native_agent_tools',
  /**
   * Native agent tools exist and can be neither refused per call nor withheld
   * per session: the runtime cannot host supervised work.
   */
  UNENFORCEABLE: 'unenforceable',
} as const;
export type NativeAgentAdmissionMode = typeof NATIVE_AGENT_ADMISSION_MODES[keyof typeof NATIVE_AGENT_ADMISSION_MODES];

const NATIVE_AGENT_ADMISSION_MODE_VALUES: ReadonlySet<string> = new Set(Object.values(NATIVE_AGENT_ADMISSION_MODES));

/** Strict reader: an unknown or missing declaration is never an enforcing mode. */
export function readNativeAgentAdmissionMode(value: unknown): NativeAgentAdmissionMode {
  return typeof value === 'string' && NATIVE_AGENT_ADMISSION_MODE_VALUES.has(value)
    ? value as NativeAgentAdmissionMode
    : NATIVE_AGENT_ADMISSION_MODES.UNENFORCEABLE;
}

/** The native-agent tool state of one live runtime serving a `session_fence` session. */
export const NATIVE_AGENT_FENCES = {
  /** The runtime serving this session was launched or loaded with native agent tools withheld. */
  DISABLED: 'disabled',
  /** The runtime serving this session carries the provider's default tool set. */
  PROVIDER_DEFAULT: 'provider_default',
  /**
   * Nothing is loaded or running yet: the next launch, load or turn decides
   * the fence from the session's authority at that moment.
   */
  DECIDED_AT_NEXT_LAUNCH: 'decided_at_next_launch',
} as const;
export type NativeAgentFence = typeof NATIVE_AGENT_FENCES[keyof typeof NATIVE_AGENT_FENCES];

/**
 * Is supervised work admissible on a runtime with this mode and fence? A gate
 * or a tool-less agent always is; a session fence only when it is disabled now
 * or will be decided (under managed authority) at the next launch; an
 * unenforceable runtime never is.
 */
export function nativeAgentAdmissionProven(mode: unknown, fence?: NativeAgentFence): boolean {
  const admission = readNativeAgentAdmissionMode(mode);
  if (admission === NATIVE_AGENT_ADMISSION_MODES.PRE_EXECUTION_GATE
    || admission === NATIVE_AGENT_ADMISSION_MODES.NO_NATIVE_AGENT_TOOLS) return true;
  if (admission === NATIVE_AGENT_ADMISSION_MODES.SESSION_FENCE) {
    return fence === NATIVE_AGENT_FENCES.DISABLED || fence === NATIVE_AGENT_FENCES.DECIDED_AT_NEXT_LAUNCH;
  }
  return false;
}

/** Why supervised work was refused for one side of a dispatch. */
export const NATIVE_AGENT_ADMISSION_REFUSALS = {
  /** The runtime can neither refuse native agent tools per call nor withhold them per session. */
  UNENFORCEABLE: 'native_agent_tools_unenforceable',
  /** A `session_fence` runtime is live with the provider's default tool set, or its fence cannot be proven. */
  FENCE_UNPROVEN: 'native_agent_fence_unproven',
  /** No live runtime answers for the session, so nothing can be proven. */
  RUNTIME_UNAVAILABLE: 'native_agent_runtime_unavailable',
  /** The admission check itself failed; it never degrades into admitting. */
  ADMISSION_UNVERIFIABLE: 'native_agent_admission_unverifiable',
} as const;
export type NativeAgentAdmissionRefusal =
  typeof NATIVE_AGENT_ADMISSION_REFUSALS[keyof typeof NATIVE_AGENT_ADMISSION_REFUSALS];

/** Which party of a supervised dispatch a refusal concerns. */
export const NATIVE_AGENT_ADMISSION_SIDES = {
  CALLER: 'caller',
  TARGET: 'target',
} as const;
export type NativeAgentAdmissionSide =
  typeof NATIVE_AGENT_ADMISSION_SIDES[keyof typeof NATIVE_AGENT_ADMISSION_SIDES];

/** How a refused side is repaired; read by the dispatching model. */
export const NATIVE_AGENT_ADMISSION_REPAIRS = {
  /** A fresh conversation is created with the fence (Codex fixes the fence per thread at creation). */
  RESTART_RESET: 'session_restart_reset',
  /** Relaunch the same conversation; the launch re-decides the fence from managed authority. */
  RESTART_RESUME: 'session_restart_resume',
  /** Wait for the active unfenced turn to settle; the next turn is fenced. */
  WAIT_FOR_TURN: 'wait_for_active_turn',
  /** Move the work to a session on an enforceable runtime. */
  USE_ENFORCEABLE_RUNTIME: 'use_enforceable_runtime',
} as const;
export type NativeAgentAdmissionRepair =
  typeof NATIVE_AGENT_ADMISSION_REPAIRS[keyof typeof NATIVE_AGENT_ADMISSION_REPAIRS];

export const NATIVE_COLLABORATION_ENFORCEMENT = {
  /** A pre-execution provider gate refused the native agent before it ran. */
  DENIED_BEFORE_EXECUTION: 'denied_before_execution',
  /**
   * A task-bearing native agent was observed after start in a managed session
   * whose runtime has no pre-execution gate (an unproven fence or an
   * unenforceable runtime). Evidence only: the daemon records it and stops the
   * turn. It is never the enforcing boundary.
   */
  OBSERVED_AFTER_START: 'observed_after_start',
  /**
   * The installed pre-execution gate could not evaluate the request, so it
   * failed closed. The gate exists only inside IM.codes-managed sessions; a
   * request nobody could classify must not slip past as Brain task work.
   */
  GATE_UNAVAILABLE: 'gate_unavailable',
} as const;
export type NativeCollaborationEnforcement =
  typeof NATIVE_COLLABORATION_ENFORCEMENT[keyof typeof NATIVE_COLLABORATION_ENFORCEMENT];

export const NATIVE_COLLABORATION_PARTICIPATION = {
  TASK: 'task',
  ANALYSIS: 'analysis',
  /**
   * Neither provably task work nor provably analysis: no analysis intent, an
   * instruction the policy does not recognize, or a request too large to read
   * whole. A managed session denies it exactly like task work.
   */
  UNCLASSIFIED: 'unclassified',
} as const;
export type NativeCollaborationParticipation =
  typeof NATIVE_COLLABORATION_PARTICIPATION[keyof typeof NATIVE_COLLABORATION_PARTICIPATION];

/** Why a request without task signals is still not provably analysis. */
export const NATIVE_COLLABORATION_UNCLASSIFIED_REASONS = {
  /** Nothing in the request states read-only analysis, a question, or an analysis verb. */
  NO_ANALYSIS_INTENT: 'no_analysis_intent',
  /** An instruction opens with a word that is neither analysis, a question, nor context. */
  UNRECOGNIZED_INSTRUCTION: 'unrecognized_instruction',
  /** Longer than the bounded window: the unread middle could hold task work. */
  INPUT_TRUNCATED: 'input_truncated',
} as const;
export type NativeCollaborationUnclassifiedReason =
  typeof NATIVE_COLLABORATION_UNCLASSIFIED_REASONS[keyof typeof NATIVE_COLLABORATION_UNCLASSIFIED_REASONS];

export const NATIVE_COLLABORATION_TASK_SIGNALS = {
  /** IM.codes task/assignment/attempt ids or supervision lifecycle tools. */
  IMCODES_AUTHORITY: 'imcodes_authority',
  /** A PASS/REWORK task verdict. */
  TASK_VERDICT: 'task_verdict',
  /** Git mutation, pull request, deploy, release, rollback or service restart. */
  REPOSITORY_GATE: 'repository_gate',
  /** Auditing or reviewing a work product (code, diff, patch, bundle...). */
  AUDIT: 'audit',
  /** Implementation or repair work. Exempt only when declared read-only. */
  IMPLEMENTATION: 'implementation',
} as const;
export type NativeCollaborationTaskSignal =
  typeof NATIVE_COLLABORATION_TASK_SIGNALS[keyof typeof NATIVE_COLLABORATION_TASK_SIGNALS];

const TASK_SIGNAL_VALUES: ReadonlySet<string> = new Set(Object.values(NATIVE_COLLABORATION_TASK_SIGNALS));
const PARTICIPATION_VALUES: ReadonlySet<string> = new Set(Object.values(NATIVE_COLLABORATION_PARTICIPATION));

const REQUEST_ROUTING_FIELD = /^(?:id|call_?id|tool_?use_?id|type|agent_?id|target|to|thread_?id|model|subagent_?type|run_?in_?background|team_?name|mode|isolation|resume_?from_?run_?id|timeout)$/i;
const REQUEST_STRING_MAX_DEPTH = 4;
const REQUEST_STRING_MAX_COUNT = 64;

/**
 * Every request string a native agent tool input carries, for classification:
 * prompts, descriptions, messages, workflow scripts and arguments, at bounded
 * depth. Identifier and routing fields (ids, targets, model, agent type, mode)
 * are not request text. An input with no request string yields none, which
 * the classifier reads as not provably analysis.
 */
export function collectNativeAgentRequestStrings(value: unknown): string[] {
  const out: string[] = [];
  const visit = (entry: unknown, depth: number): void => {
    if (depth > REQUEST_STRING_MAX_DEPTH || out.length >= REQUEST_STRING_MAX_COUNT) return;
    if (typeof entry === 'string') {
      if (entry.trim()) out.push(entry);
      return;
    }
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item, depth + 1);
      return;
    }
    if (!entry || typeof entry !== 'object') return;
    for (const [key, item] of Object.entries(entry as Record<string, unknown>)) {
      if (REQUEST_ROUTING_FIELD.test(key)) continue;
      visit(item, depth + 1);
    }
  };
  visit(value, 0);
  return out;
}

/** One native agent request presented to a provider pre-execution gate. */
export interface NativeCollaborationGateRequest {
  provider: string;
  toolName: string;
  /** Full request text (prompt, description, message) before any preview truncation. */
  requestText: string;
  toolUseId?: string;
}

export type NativeCollaborationGateDecision =
  | { allow: true }
  | { allow: false; reason: string; signals: NativeCollaborationTaskSignal[] };

/** Pre-execution gate a provider consults; installed by the daemon transport relay. */
export type NativeCollaborationGate = (
  providerSessionId: string,
  request: NativeCollaborationGateRequest,
) => NativeCollaborationGateDecision;

export interface NativeCollaborationClassification {
  participation: NativeCollaborationParticipation;
  /** Stable, ordered, de-duplicated task signals that matched. */
  signals: NativeCollaborationTaskSignal[];
  /** The request explicitly declared read-only analysis (informational; never an exemption). */
  readOnlyDeclared: boolean;
  /** Present only for `unclassified`: why no-signal text is still not provably analysis. */
  unclassifiedReason?: NativeCollaborationUnclassifiedReason;
}

/**
 * Bound classifier input so a pathological prompt cannot stall a delivery
 * edge. Longer text is read as its head AND its tail (an instruction appended
 * after a long context is still seen), and is never provably analysis.
 */
export const NATIVE_COLLABORATION_CLASSIFIER_MAX_CHARS = 20_000;

const IMCODES_AUTHORITY_PATTERNS: readonly RegExp[] = [
  /\b(?:tsk|asg)_[a-z0-9]{2,}\b/i,
  /\bauto-audit-[0-9a-f]{8,}\b/i,
  /\bsupervision_task_[a-z_]+\b/i,
  /\b(?:peer_audit_reply|delegation_reply|supervision_integration_finalize)\b/i,
  /IMCODES_EXEC/,
];

const TASK_VERDICT_PATTERNS: readonly RegExp[] = [
  /\bPASS\s*(?:\/|\||or|或)\s*REWORK\b/i,
  /\bREWORK\b/,
];

// Nouns such as "the deploy", "部署日志" or "回滚原因" are ordinary analysis
// vocabulary. Gate wording therefore requires an action shape: a git verb, an
// object after the verb, or an explicit do/run/execute form.
const REPOSITORY_GATE_PATTERNS: readonly RegExp[] = [
  /\bgit\s+(?:commit|push|merge|rebase|cherry-pick|tag|revert|am|apply|reset\s+--hard)\b/i,
  /\b(?:deploy|redeploy|roll\s*back)\s+(?:it|this|that|the|to|a|an|new|version|build|release|service|daemon|server|production|prod|staging|changes?|fix)\b/i,
  /\b(?:do|run|perform|trigger|start|execute)\s+(?:a\s+|the\s+)?(?:deploy(?:ment)?|redeploy(?:ment)?|rollback|release)\b/i,
  /\b(?:open|create|merge|submit)\s+(?:a\s+|the\s+)?(?:pr|pull\s+request|merge\s+request)\b/i,
  /\bpush\s+(?:the\s+|this\s+|these\s+)?(?:branch|commits?|changes|fix|tag)\b/i,
  /\b(?:publish|cut|ship)\s+(?:a\s+|the\s+)?(?:release|package|version)\b/i,
  /\brestart\s+(?:the\s+)?(?:daemon|service|server|production)\b/i,
  /(?:提交(?:代码|改动|变更|修改|commit)|推送(?:到|代码|分支|提交|远端|远程)|合并(?:到|分支|代码|PR|MR)|(?:执行|进行|重新|直接)部署|部署(?:到|上线|新版本|服务)|(?:发布|发版)(?:上线|版本|到|包|新版)|上线(?:新版本|服务|到)|(?:执行|进行)回滚|回滚(?:到|版本|部署|提交)|重启(?:服务|daemon|进程|守护))/i,
];

// "Review the code to understand X" is reading, not auditing. Audit wording
// counts only when it assesses a WORK PRODUCT (changes, diff, patch, PR,
// commit, bundle, revision, fix, implementation) or is an explicit re-audit.
const AUDIT_PATTERNS: readonly RegExp[] = [
  /\b(?:re-?audit|re-?review)\b/i,
  /\b(?:audit|review|verify|validate)(?:\s+(?:of|on|for))?\s+(?:the\s+|this\s+|these\s+|that\s+|a\s+|an\s+|its\s+|my\s+|our\s+)?(?:frozen\s+|immutable\s+|latest\s+|new\s+|repaired\s+|proposed\s+)?(?:changes?|diff|pr|pull\s+request|patch(?:es)?|implementation|commits?|bundle|revision|fix(?:es)?|delta)\b/i,
  /\b(?:run|perform|do|conduct)\s+(?:an?\s+|the\s+)?(?:peer\s+|code\s+|security\s+)?(?:audit|review)\b/i,
  /\b(?:code\s+review|security\s+review|peer\s+audit)\b/i,
  /(?:复审|重新审计|重审|代码审查|代码评审)/,
  /(?:审计|审查|评审|验收)[^。\n]{0,20}(?:代码|改动|变更|实现|PR|提交|补丁|修复|分支|冻结包|revision|diff)/i,
];

// Directed work on the repository. A directive is a work verb in instruction
// position: opening a clause (after optional sequencing/politeness words) or
// following please/to/and/then/must/should/will/go/now or a comma. "Analyze why
// the fix failed" and "how they implement caching" stay analysis; "fix the
// bug", "add a retry queue", "build the reconnect feature" and "investigate and
// repair" are task work. `(?![-\w])` keeps compounds such as "fix-candidate" nouns.
const WORK_VERB = String.raw`(?:implement|fix|repair|patch|refactor|rework|hotfix|add|build|create|make|write|modify|edit|change|update|rewrite|delete|remove|rename|move|migrate|install|configure|wire|integrate|enable|disable|upgrade|bump|generate|scaffold|port|convert|replace|restructure|extend|introduce|optimi[sz]e|improve|harden|adjust|tweak|resolve|address|complete|finish|land|ship|bootstrap|set\s+up|clean\s+up)(?![-\w])`;
const IMPLEMENTATION_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`(?:^|[.;:!?,\n]\s*|\b(?:please|to|and|then|must|should|will|go|now|also|first|next|finally|just)\s+)${WORK_VERB}`, 'i'),
  // A polite question is still a request to do the work: "could you fix X?".
  new RegExp(String.raw`\b(?:can|could|would|will)\s+you\s+(?:please\s+)?${WORK_VERB}`, 'i'),
  /\b(?:write|modify|edit|change|update|rewrite)\s+(?:the\s+|this\s+|these\s+)?(?:code|files?|tests?|implementation|source)\b/i,
  /\bapply\s+(?:the\s+)?(?:fix|patch|changes|diff)\b/i,
  /(?:(?:去|来|负责|开始|完成|继续|直接)?实现(?:这个|该|一下|功能|需求|接口)|实现并|修复(?:这个|该|一下|bug|问题|缺陷|漏洞|测试|代码)|修复并|修补|修改代码|改代码|重构(?:代码|模块|这个|该)|返工|编写代码|写代码|打补丁)/i,
  /(?:新增|添加|增加|加上|创建|新建|构建|搭建|开发|编写|删除|移除|重命名|迁移|替换|优化|完善|接入|集成|升级|补充测试|补测试|补上)(?:一个|一下|这个|该|新的|功能|模块|测试|代码|文件|接口|支持|逻辑|字段|表|配置|队列|依赖)?/,
];

const READ_ONLY_DECLARATION_PATTERNS: readonly RegExp[] = [
  /\bread-?only\b/i,
  /\b(?:analysis|analy[sz]e|investigate|research)\s+only\b/i,
  /\b(?:do\s+not|don't|never)\s+(?:modify|edit|change|write|touch)\b/i,
  /\bwithout\s+(?:modifying|editing|changing|writing)\b/i,
  /\bno\s+(?:code\s+|file\s+)?(?:changes|edits|modifications)\b/i,
  /(?:只读|仅分析|只分析|只做分析|不要修改|不修改|不得修改|不改代码|不要改动|禁止修改)/,
];

// A negated work verb states what must NOT happen ("do not implement",
// "fix nothing", "不要修改"). It is removed before directive matching, and
// only there: authority, verdict and audit wording are never negated away.
const NEGATED_DIRECTIVE_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:do\s+not|don't|dont|never|without|must\s+not|mustn't|should\s+not|shouldn't|no\s+need\s+to|not\s+to|avoid)\s+(?:\w+\s+){0,2}?(?:${WORK_VERB}|git\s+\w+|deploy|push|commit)`, 'gi'),
  new RegExp(String.raw`${WORK_VERB}\s+(?:nothing|none|anything)\b`, 'gi'),
  /(?:不要|不得|禁止|无需|不用|请勿|切勿|别)(?:去|再|直接)?(?:修改|改动|改代码|实现|修复|重构|新增|添加|删除|提交|推送|部署|回滚)/g,
];

// Clause openers. An instruction clause must open with an analysis verb, a
// question, a read-only declaration or ordinary context words; any other
// opener is an instruction the policy does not recognize.
const ANALYSIS_OPENERS: ReadonlySet<string> = new Set([
  'search', 'find', 'locate', 'look', 'grep', 'list', 'read', 'inspect', 'examine', 'explore', 'investigate',
  'research', 'analyze', 'analyse', 'study', 'review', 'trace', 'map', 'explain', 'describe', 'summarize',
  'summarise', 'outline', 'compare', 'contrast', 'recommend', 'suggest', 'propose', 'identify', 'determine',
  'figure', 'understand', 'learn', 'count', 'report', 'show', 'tell', 'give', 'provide', 'gather', 'collect',
  'brainstorm', 'think', 'consider', 'reason', 'diagnose', 'plan', 'answer', 'clarify', 'enumerate', 'catalog',
  'catalogue', 'discover', 'surface', 'scan', 'skim', 'browse', 'peruse', 'note', 'observe', 'estimate',
]);
const QUESTION_OPENERS: ReadonlySet<string> = new Set([
  'how', 'why', 'what', 'where', 'which', 'who', 'whom', 'whose', 'when', 'whether',
]);
const CONTEXT_OPENERS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', "it's", 'its', 'i', "i'm", 'we', "we're", 'you',
  'your', 'they', 'their', 'there', 'here', 'my', 'our', 'some', 'all', 'each', 'every', 'any', 'both', 'either',
  'neither', 'no', 'not', 'if', 'while', 'because', 'since', 'although', 'though', 'as', 'so', 'but', 'or', 'for',
  'in', 'on', 'at', 'from', 'with', 'without', 'by', 'of', 'after', 'before', 'during', 'currently', 'previously',
  'recently', 'earlier', 'background', 'context', 'goal', 'goals', 'objective', 'notes', 'summary', 'scope',
  'constraints', 'requirements', 'output', 'format', 'focus', 'only', 'e.g', 'i.e', 'per', 'via', 'is', 'are', 'was',
  'were', 'has', 'have', 'had', 'does', 'do', 'did', 'can', 'could', 'should', 'would', 'will', 'may', 'might',
  'task', 'request', 'question', 'problem', 'issue', 'symptom', 'symptoms', 'observed', 'expected', 'result', 'results',
]);
// Sequencing and politeness words that precede the real opener.
const OPENER_FILLERS: ReadonlySet<string> = new Set([
  'please', 'kindly', 'also', 'then', 'now', 'first', 'firstly', 'next', 'finally', 'lastly', 'just', 'and', 'ok',
  'okay', 'additionally', 'afterwards', 'meanwhile', 'again', 'quickly', 'carefully', 'briefly',
]);
const CJK_ANALYSIS_OPENERS = /^(?:请|帮我|帮忙|麻烦|然后|接着|先|再|并|同时|另外|最后|逐页|逐张|逐一|逐个|挨个|挨页)*(?:分析|调研|研究|总结|解释|说明|查找|搜索|阅读|查看|梳理|对比|比较|列出|列举|理解|定位|排查|看看|看下|看一下|看图|看截图|看页面|浏览|统计|概括|归纳|调查|追踪|找出|找到|了解|回答|解读|描述|汇总|评估原因|只读|仅分析|只分析)/;
const CJK_QUESTION = /(?:为什么|为何|怎么|怎样|如何|哪些|哪个|哪里|是否|什么|有没有|是不是)/;
const CJK_CONTEXT_OPENERS = /^(?:这个|这些|这里|该|当前|目前|之前|以前|现在|背景|上下文|问题|现象|目标|注意|备注|我们|我|你|他们|其中|如果|因为|由于|但是|所以|已知|期望|预期|结果)/;

// An analysis verb inside an instruction ("I want you to explain", "you should
// trace") states analysis intent even when the clause opens with context words.
const EMBEDDED_ANALYSIS_INTENT = new RegExp(
  String.raw`\b(?:to|please|you|should|must|will|and|then|need\s+to)\s+(?:${[...ANALYSIS_OPENERS].join('|')})\b`,
  'i',
);
// Multi-word analysis openers whose first word alone is not analysis.
const PHRASE_ANALYSIS_OPENER = /^(?:(?:please|also|then|now|first|next|just|and)\s+)*(?:(?:take|have)\s+a\s+(?:quick\s+|closer\s+|careful\s+|brief\s+)?look\b|dig\s+into\b|(?:go|walk|read)\s+through\b|check\s+(?:whether|if|how|what|where|which|why|when|who)\b)/i;
// A second instruction chained inside a clause ("explore X and tidy the
// imports"): a connector, then a verb-shaped word, then a determiner. The chained
// word must itself be analysis, question or context, or the clause is unrecognized.
const CHAINED_INSTRUCTION = /\b(?:and|then|also|please)\s+([a-z]+)\s+(?:the|a|an|this|that|these|those|all|every|each|its|our|my|your|their|some|any|it|them)\b/gi;
const CHAINED_NON_DIRECTIVES: ReadonlySet<string> = new Set([
  'see', 'view', 'watch', 'notice', 'spot', 'tell', 'let', 'where', 'whether', 'how', 'what', 'which', 'why', 'when',
  'who', 'is', 'are', 'was', 'were', 'has', 'have', 'had', 'does', 'do', 'did', 'not', 'in', 'on', 'at', 'for', 'from',
  'with', 'by', 'of', 'to', 'into', 'across', 'between', 'within', 'about', 'against', 'under', 'over', 'through',
  'if', 'so', 'then', 'also', 'all', 'both', 'either',
]);

function hasUnrecognizedChainedInstruction(clause: string): boolean {
  CHAINED_INSTRUCTION.lastIndex = 0;
  for (const match of clause.matchAll(CHAINED_INSTRUCTION)) {
    const word = (match[1] ?? '').toLowerCase();
    if (!ANALYSIS_OPENERS.has(word) && !QUESTION_OPENERS.has(word) && !CONTEXT_OPENERS.has(word)
      && !CHAINED_NON_DIRECTIVES.has(word) && !OPENER_FILLERS.has(word)) return true;
  }
  return false;
}

interface ClauseReading {
  analysisIntent: boolean;
  unrecognized: boolean;
}

// Ideographs, kana, hangul and full-width forms: scripts read without spaces.
const isCjk = (value: string): boolean => /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(value.charAt(0));

/** Markdown structure (bullets, numbering, headings, quotes) is never an opener. */
const stripClauseMarkup = (clause: string): string => clause
  .replace(/^[\s>#*•\-–—+]*(?:\(?\d+[.)]\s*|\(?[a-z][.)]\s+)?/i, '')
  .trim();

/** Lower-cased words of a clause with surrounding punctuation removed. */
const clauseTokens = (clause: string): string[] => clause.toLowerCase().split(/\s+/)
  .map((token) => token.replace(/^[("'`[{]+|[)"'`\]}:;,.!?]+$/g, ''))
  .filter(Boolean);

/** Index of the real opener: sequencing/politeness words and "could you" skipped. */
function openerIndex(tokens: readonly string[]): number {
  let index = 0;
  for (;;) {
    while (index < tokens.length - 1 && OPENER_FILLERS.has(tokens[index]!)) index += 1;
    if (['can', 'could', 'would', 'will'].includes(tokens[index] ?? '') && tokens[index + 1] === 'you') {
      index += 2;
      continue;
    }
    return index;
  }
}

function readClause(rawClause: string): ClauseReading {
  const clause = stripClauseMarkup(rawClause);
  if (!clause) return { analysisIntent: false, unrecognized: false };
  if (matchesAny(READ_ONLY_DECLARATION_PATTERNS, clause)) return { analysisIntent: true, unrecognized: false };
  if (isCjk(clause)) {
    if (CJK_ANALYSIS_OPENERS.test(clause)) return { analysisIntent: true, unrecognized: false };
    if (CJK_QUESTION.test(clause) && /[?？]$/.test(clause)) return { analysisIntent: true, unrecognized: false };
    return { analysisIntent: false, unrecognized: !CJK_CONTEXT_OPENERS.test(clause) };
  }
  if (hasUnrecognizedChainedInstruction(clause)) return { analysisIntent: false, unrecognized: true };
  if (PHRASE_ANALYSIS_OPENER.test(clause)) return { analysisIntent: true, unrecognized: false };
  const tokens = clauseTokens(clause);
  const opener = tokens[openerIndex(tokens)] ?? '';
  // Code, a path, a number or punctuation in opener position is context.
  if (!/^[a-z][a-z'-]*$/.test(opener)) return { analysisIntent: EMBEDDED_ANALYSIS_INTENT.test(clause), unrecognized: false };
  if (ANALYSIS_OPENERS.has(opener) || QUESTION_OPENERS.has(opener)) return { analysisIntent: true, unrecognized: false };
  if (CONTEXT_OPENERS.has(opener) || OPENER_FILLERS.has(opener)) {
    return { analysisIntent: EMBEDDED_ANALYSIS_INTENT.test(clause), unrecognized: false };
  }
  return { analysisIntent: false, unrecognized: true };
}

/** Instruction clauses: sentences, lines and colon/semicolon-separated segments. */
const splitClauses = (text: string): string[] => text.split(/(?<=[.;:!?。；：！？])\s+|\n+|(?<=[;:；：])/);

/** Is this clause a genuine question about the work (not a polite request to do it)? */
function isInterrogativeClause(rawClause: string): boolean {
  const clause = stripClauseMarkup(rawClause);
  if (isCjk(clause)) {
    return CJK_QUESTION.test(clause) && /[?？]$/.test(clause)
      && !/(?:帮我|帮忙|麻烦|能不能|可不可以|可以帮|请你)/.test(clause);
  }
  const tokens = clauseTokens(clause);
  return QUESTION_OPENERS.has(tokens[openerIndex(tokens)] ?? '');
}

/**
 * Bound request text for carriage to the classifier: the head and the tail of
 * an oversized request, joined so the result still exceeds the classifier
 * bound. The classifier therefore still sees an instruction appended after a
 * long context AND still knows the middle was never read.
 */
export function boundNativeCollaborationRequestText(text: string): string {
  if (text.length <= NATIVE_COLLABORATION_CLASSIFIER_MAX_CHARS) return text;
  const half = Math.floor(NATIVE_COLLABORATION_CLASSIFIER_MAX_CHARS / 2);
  return `${text.slice(0, half)}\n${text.slice(text.length - half)}`;
}

function joinClassifierInput(input: string | readonly (string | undefined | null)[]): { text: string; truncated: boolean } {
  const text = typeof input === 'string'
    ? input
    : input.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).join('\n');
  if (text.length <= NATIVE_COLLABORATION_CLASSIFIER_MAX_CHARS) return { text, truncated: false };
  return { text: boundNativeCollaborationRequestText(text), truncated: true };
}

const matchesAny = (patterns: readonly RegExp[], text: string): boolean => patterns.some((pattern) => {
  pattern.lastIndex = 0;
  return pattern.test(text);
});

/** Directive text: negated work verbs removed, genuine question clauses dropped. */
function directiveText(text: string): string {
  let stripped = text;
  for (const pattern of NEGATED_DIRECTIVE_PATTERNS) stripped = stripped.replace(pattern, ' ');
  return splitClauses(stripped).filter((clause) => !isInterrogativeClause(clause)).join('\n');
}

/**
 * Classify one native collaboration request (prompt, description, message).
 *
 * Task work wins over everything: a read-only declaration never exempts a
 * directive elsewhere in the request. Without task signals a request is
 * analysis only when every instruction clause is recognizably analysis,
 * question or context and the whole request was read; otherwise it is
 * `unclassified`, which managed sessions deny.
 */
export function classifyNativeCollaborationRequest(
  input: string | readonly (string | undefined | null)[],
): NativeCollaborationClassification {
  const { text, truncated } = joinClassifierInput(input);
  const readOnlyDeclared = matchesAny(READ_ONLY_DECLARATION_PATTERNS, text);
  const directives = directiveText(text);
  const signals: NativeCollaborationTaskSignal[] = [];
  if (matchesAny(IMCODES_AUTHORITY_PATTERNS, text)) signals.push(NATIVE_COLLABORATION_TASK_SIGNALS.IMCODES_AUTHORITY);
  if (matchesAny(TASK_VERDICT_PATTERNS, text)) signals.push(NATIVE_COLLABORATION_TASK_SIGNALS.TASK_VERDICT);
  if (matchesAny(REPOSITORY_GATE_PATTERNS, directives)) signals.push(NATIVE_COLLABORATION_TASK_SIGNALS.REPOSITORY_GATE);
  if (matchesAny(AUDIT_PATTERNS, text)) signals.push(NATIVE_COLLABORATION_TASK_SIGNALS.AUDIT);
  if (matchesAny(IMPLEMENTATION_PATTERNS, directives)) signals.push(NATIVE_COLLABORATION_TASK_SIGNALS.IMPLEMENTATION);
  if (signals.length > 0) {
    return { participation: NATIVE_COLLABORATION_PARTICIPATION.TASK, signals, readOnlyDeclared };
  }
  const unclassified = (unclassifiedReason: NativeCollaborationUnclassifiedReason): NativeCollaborationClassification => ({
    participation: NATIVE_COLLABORATION_PARTICIPATION.UNCLASSIFIED,
    signals,
    readOnlyDeclared,
    unclassifiedReason,
  });
  if (truncated) return unclassified(NATIVE_COLLABORATION_UNCLASSIFIED_REASONS.INPUT_TRUNCATED);
  let analysisIntent = false;
  for (const clause of splitClauses(text)) {
    const reading = readClause(clause);
    if (reading.unrecognized) return unclassified(NATIVE_COLLABORATION_UNCLASSIFIED_REASONS.UNRECOGNIZED_INSTRUCTION);
    analysisIntent ||= reading.analysisIntent;
  }
  if (!analysisIntent) return unclassified(NATIVE_COLLABORATION_UNCLASSIFIED_REASONS.NO_ANALYSIS_INTENT);
  return { participation: NATIVE_COLLABORATION_PARTICIPATION.ANALYSIS, signals, readOnlyDeclared };
}

/** Compact wire form for bounded metadata fields. */
export function formatNativeCollaborationSignals(signals: readonly NativeCollaborationTaskSignal[]): string {
  return signals.join(',');
}

/** Strict reader for metadata that crossed a trust boundary (timeline, replay). */
export function readNativeCollaborationClassification(
  participation: unknown,
  signals: unknown,
): Pick<NativeCollaborationClassification, 'participation' | 'signals'> | undefined {
  if (typeof participation !== 'string' || !PARTICIPATION_VALUES.has(participation)) return undefined;
  const parsedSignals = typeof signals === 'string' && signals.trim()
    ? signals.split(',').map((entry) => entry.trim()).filter((entry) => TASK_SIGNAL_VALUES.has(entry))
    : [];
  const unique = [...new Set(parsedSignals)] as NativeCollaborationTaskSignal[];
  // A task participation claim must name at least one real signal; analysis and
  // unclassified must name none. Anything else is malformed and dropped.
  if (participation === NATIVE_COLLABORATION_PARTICIPATION.TASK && unique.length === 0) return undefined;
  if (participation !== NATIVE_COLLABORATION_PARTICIPATION.TASK && unique.length > 0) return undefined;
  return { participation: participation as NativeCollaborationParticipation, signals: unique };
}

/**
 * The correction a Brain receives when it tries to (or did) hand project task
 * work to a native agent. It is read by the model, so it names the exact
 * IM.codes route and what native agents remain allowed to do.
 */
const NATIVE_COLLABORATION_NOTICE_OUTCOMES: Record<NativeCollaborationEnforcement, string> = {
  [NATIVE_COLLABORATION_ENFORCEMENT.DENIED_BEFORE_EXECUTION]: 'native_agent_task_participation_denied',
  [NATIVE_COLLABORATION_ENFORCEMENT.OBSERVED_AFTER_START]: 'native_agent_task_participation_turn_stopped',
  [NATIVE_COLLABORATION_ENFORCEMENT.GATE_UNAVAILABLE]: 'native_agent_request_denied_policy_unavailable',
};

/** Who made a refused native agent request; each has its own IM.codes route. */
export const NATIVE_COLLABORATION_REQUESTERS = {
  /** A Brain delegates task work to formal sub-sessions. */
  BRAIN: 'brain',
  /** A formal participant performs its assigned work itself and escalates to its Brain. */
  PARTICIPANT: 'participant',
} as const;
export type NativeCollaborationRequester =
  typeof NATIVE_COLLABORATION_REQUESTERS[keyof typeof NATIVE_COLLABORATION_REQUESTERS];

export function buildNativeCollaborationRerouteNotice(input: {
  provider: string;
  toolName: string;
  signals: readonly NativeCollaborationTaskSignal[];
  /** Whether the native agent was stopped before it ran (pre-execution gate). */
  enforcement: NativeCollaborationEnforcement;
  /** Who asked. Defaults to a Brain. */
  requester?: NativeCollaborationRequester;
  /** Present when a request without task signals was refused because it is not provably analysis. */
  unclassifiedReason?: NativeCollaborationUnclassifiedReason;
}): string {
  const participant = input.requester === NATIVE_COLLABORATION_REQUESTERS.PARTICIPANT;
  const refusedUnclassified = input.unclassifiedReason !== undefined
    && input.enforcement === NATIVE_COLLABORATION_ENFORCEMENT.DENIED_BEFORE_EXECUTION;
  return JSON.stringify({
    policy: NATIVE_COLLABORATION_POLICY_VERSION,
    outcome: refusedUnclassified
      ? 'native_agent_request_denied_unclassified'
      : NATIVE_COLLABORATION_NOTICE_OUTCOMES[input.enforcement],
    provider: input.provider,
    tool: input.toolName,
    signals: [...input.signals],
    ...(input.unclassifiedReason ? { unclassifiedReason: input.unclassifiedReason } : {}),
    ...(participant ? {
      requester: NATIVE_COLLABORATION_REQUESTERS.PARTICIPANT,
      rule: 'A formal IM.codes participant performs its assigned task work itself, in this session. Project task work (implementation, repair, audit, re-audit, PASS/REWORK, Git/deploy gates, IM.codes task authority) is never handed to a provider-native agent, and a native agent is never a task participant.',
      requiredRoute: ['continue the assigned work in this session', 'report a structured blocker to the coordinating Brain when another executor or more capacity is needed'],
    } : {
      rule: 'Project task work (implementation, repair, audit, re-audit, PASS/REWORK, Git/deploy gates, IM.codes task authority) must be delegated to a formal IM.codes sub-session with a supervision task. A provider-native agent is never a task participant, WAITING target, or basis for an arranged-task claim.',
      requiredRoute: ['send_list_targets', 'send_message with task {objective, acceptance}'],
    }),
    nativeAgentsMay: 'ephemeral read-only analysis or parallel reasoning only; treat their output as non-authoritative input',
    ...(refusedUnclassified
      ? { retry: 'state a native agent request as explicit read-only analysis (search, read, explain, summarize, compare) with no implementation, audit, verdict or repository-gate instruction, and keep it within the classifier bound' }
      : {}),
    ...(input.enforcement === NATIVE_COLLABORATION_ENFORCEMENT.OBSERVED_AFTER_START
      ? {
          turn: 'the IM.codes daemon stopped the turn that started this native agent',
          nativeAgentOutput: participant
            ? 'discard it: do not rely on, wait for, or report this native agent as task progress; do the work in this session'
            : 'discard it: do not rely on, wait for, or report this native agent as task progress; re-dispatch the task through IM.codes',
        }
      : {}),
    ...(input.enforcement === NATIVE_COLLABORATION_ENFORCEMENT.GATE_UNAVAILABLE
      ? { retry: 'the IM.codes policy gate could not classify this request; dispatch any project task work through IM.codes, or retry a clearly read-only analysis request' }
      : {}),
  });
}

/** Wrap a policy notice so the model reads it as trusted runtime policy, not a user request. */
export function formatNativeCollaborationPolicyNotice(notice: string): string {
  return `${NATIVE_COLLABORATION_POLICY_NOTICE_MARKER}\nTrusted IM.codes runtime policy notice (not a user request).\n${notice}`;
}

/** The fail-closed decision of an installed gate that could not evaluate a request. */
export function denyNativeCollaborationGateUnavailable(
  request: Pick<NativeCollaborationGateRequest, 'provider' | 'toolName'>,
): NativeCollaborationGateDecision {
  return {
    allow: false,
    signals: [],
    reason: formatNativeCollaborationPolicyNotice(buildNativeCollaborationRerouteNotice({
      provider: request.provider,
      toolName: request.toolName,
      signals: [],
      enforcement: NATIVE_COLLABORATION_ENFORCEMENT.GATE_UNAVAILABLE,
    })),
  };
}
