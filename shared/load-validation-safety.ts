/**
 * One policy for every supervision/audit surface. Agents that need artificial
 * load should use scripts/docker-cpu-limited-test.sh instead of inventing a
 * process launcher; the helper prefers Docker and owns the bounded host
 * fallback, hard timeout, trap cleanup, and residue check.
 *
 * User's final authoritative rule (superseding the older Docker-only wording):
 * “只要有docker 就可以用 如果还有不用docker 也可以限制cpu制造负载也可以”
 * English gloss: prefer Docker when available; otherwise CPU-capped host load
 * is allowed. Only uncapped, all-core, or unbounded host load is forbidden.
 */
export const LOAD_VALIDATION_SAFETY_COMPACT = 'Docker preferred[--cpus,--memory,--pids-limit,timeout,--rm]; host fallback<=min(2cpu,25%):<=2 nice19 timed+trap burners+cleanup; ban uncapped/all-core; repeats/lower workers ok' as const;

/** Tiny local reminder; the adjacent audit_convergence_v1 body has the limits. */
export const LOAD_VALIDATION_SAFETY_PREAMBLE = 'Docker CPU-limited preferred; capped host fallback only; uncapped/all-core burners forbidden; see audit_convergence_v1' as const;

export const LOAD_VALIDATION_SAFETY_CLAUSE = 'Load/stress/repeat-under-load validation: prefer CPU-limited Docker (`--cpus`, `--memory`, `--pids-limit`, hard timeout, `--rm`). Without Docker, host load is allowed only when capped to min(2 cores, 25%): at most 2 `nice -n 19`, timeout-bound, trap-cleaned burners with cleanup verified. Never use uncapped/all-core host burners. Plain host repeats and lower `--maxWorkers` are allowed. Use `scripts/docker-cpu-limited-test.sh`.' as const;

export const LOAD_VALIDATION_SAFETY_BY_LOCALE = {
  en: LOAD_VALIDATION_SAFETY_CLAUSE,
  'zh-CN': '负载/压力/带负载重复验证：优先使用受 CPU 限制的 Docker（--cpus、--memory、--pids-limit、硬超时、--rm）。没有 Docker 时，仅可使用上限为 min(2 核, 25%) 的主机负载：最多 2 个 nice -n 19、带超时、由 trap 清理并验证无残留的负载进程；严禁无限制/全核主机压测。主机普通重复运行和降低 --maxWorkers 可以使用。',
  'zh-TW': '負載/壓力/帶負載重複驗證：優先使用受 CPU 限制的 Docker（--cpus、--memory、--pids-limit、硬逾時、--rm）。沒有 Docker 時，只可使用上限為 min(2 核, 25%) 的主機負載：最多 2 個 nice -n 19、帶逾時、由 trap 清理並驗證無殘留的負載程序；嚴禁無限制/全核主機壓測。主機普通重複執行和降低 --maxWorkers 可以使用。',
  es: 'Validación de carga/estrés/repetición con carga: prefiere Docker limitado por CPU (--cpus, --memory, --pids-limit, tiempo máximo estricto, --rm). Sin Docker, solo carga del host limitada a min(2 núcleos, 25%): como máximo 2 procesos nice -n 19 con timeout, trap y limpieza verificada; nunca carga ilimitada/de todos los núcleos. Se permiten repeticiones normales y menor --maxWorkers.',
  ru: 'Нагрузочные/стрессовые проверки: предпочтителен Docker с лимитами CPU (--cpus, --memory, --pids-limit, жёсткий таймаут, --rm). Без Docker допустима только нагрузка хоста не выше min(2 ядер, 25%): максимум 2 процесса nice -n 19 с таймаутом, trap и проверкой очистки; запрещена неограниченная/всеядерная нагрузка. Обычные повторы и меньший --maxWorkers разрешены.',
  ja: '負荷/ストレス/負荷下反復検証：CPU 制限付き Docker（--cpus、--memory、--pids-limit、ハードタイムアウト、--rm）を優先します。Docker なしでは min(2コア, 25%) 以下、最大2個の nice -n 19・タイムアウト付き・trap 清掃・残存なし確認済みホスト負荷だけを許可し、無制限/全コア負荷は禁止します。通常の反復と低い --maxWorkers はホストで実行できます。',
  ko: '부하/스트레스/부하 반복 검증은 CPU 제한 Docker(--cpus, --memory, --pids-limit, 강제 시간 제한, --rm)를 우선합니다. Docker가 없으면 min(2코어, 25%) 이하, 최대 2개의 nice -n 19·timeout·trap 정리·잔류 없음 확인을 갖춘 호스트 부하만 허용하며 무제한/전체 코어 부하는 금지합니다. 일반 반복과 낮춘 --maxWorkers는 호스트에서 허용됩니다.',
} as const;

export type LoadValidationSafetyLocale = keyof typeof LOAD_VALIDATION_SAFETY_BY_LOCALE;
