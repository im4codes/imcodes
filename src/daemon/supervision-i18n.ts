import {
  SUPERVISION_AUDIT_ENABLED_STATUS,
  SUPERVISION_AUDIT_TARGET_RECOVERY_AUTOMATION_KIND,
  SUPERVISION_SUPERVISOR_RETRY_AUTOMATION_KIND,
  SUPERVISION_WAITING_HEARTBEAT_AUTOMATION_KIND,
  normalizeSupervisionUiLocale,
  type SupervisionUiLocale,
} from '../../shared/supervision-config.js';

type SupervisionDisplayCopy = {
  status: Record<string, string>;
  note: {
    checking: string;
    auditDelegated: string;
    auditReply: string;
    auditRecovery: (details: string) => string;
    postAuditComplete: string;
    auditSkipped: string;
    complete: string;
    auditAlreadyPassed: string;
    parkedExternal: string;
    parkedReason: (reason: string) => string;
    supervisorRetry: (detail: string) => string;
    heartbeat: (minutes: string) => string;
    auditPreparing: string;
    markerCorrection: string;
    postAuditFinalizing: string;
    continueSent: string;
  };
};

const COPY: Record<SupervisionUiLocale, SupervisionDisplayCopy> = {
  en: {
    status: {
      [SUPERVISION_AUDIT_ENABLED_STATUS]: 'Supervised + audit is enabled.',
      supervision_waiting: 'Supervised: analyzing completion...', supervision_audit_waiting: 'Supervised: peer audit running; commit/push paused until the result.', supervision_complete: 'Supervised: task looks complete.', supervision_continue_sent: 'Supervised: sent a continue prompt.', supervision_post_audit_finalizing: 'Supervised: audit passed; running post-audit finalization.', supervision_needs_input: 'Supervised: returned control to you.', supervision_audit_pass: 'Supervised: audit passed.', supervision_rework: 'Supervised: audit requested rework; brief sent.', supervision_blocked: 'Supervised: stopped because the session is blocked.', supervision_parked: 'Supervised: parked until the pending reply arrives.',
    },
    note: {
      checking: 'Auto: checking whether the task is complete...', auditDelegated: 'Auto: observed the existing reply-enabled peer-audit delegation; waiting for its PASS/REWORK receipt without sending another request.', auditReply: 'Auto: the delegated audit reply arrived; waiting for this session to produce the final PASS/REWORK judgment.', auditRecovery: (d) => `Auto: the configured audit session stopped unexpectedly, so supervision sent continue ${d}.`, postAuditComplete: 'Auto: peer audit passed and post-audit finalization completed.', auditSkipped: 'Auto: task looks complete; the supervisor determined that no new peer audit is needed.', complete: 'Auto: task looks complete.', auditAlreadyPassed: 'Auto: the completed turn already reports an independent audit PASS; skipped the duplicate audit request.', parkedExternal: 'Auto: parked on the executing session\'s reported external reply.', parkedReason: (r) => `Auto: parked while waiting — ${r}`, supervisorRetry: (d) => `Auto: the supervisor decision did not land — ${d}`, heartbeat: (m) => `Auto: requested a waiting-status update after ${m} minutes; the original deadline was preserved.`, auditPreparing: '⏳ Auto is asking this session to prepare and delegate the peer audit. Commit/push is paused until PASS.', markerCorrection: 'Auto: the audit reply arrived, but the final marker was missing or ambiguous; requested one bounded marker-only correction turn.', postAuditFinalizing: '✅ Peer audit passed. Auto is now running the deferred commit/push finalization.', continueSent: 'Auto: sent a continue prompt to keep the task moving.',
    },
  },
  'zh-CN': {
    status: {
      [SUPERVISION_AUDIT_ENABLED_STATUS]: '监督+审计已开启。',
      supervision_waiting: '监督：正在判断任务是否完成…', supervision_audit_waiting: '监督：同伴审计进行中；结果返回前暂停提交和推送。', supervision_complete: '监督：任务已完成。', supervision_continue_sent: '监督：已发送继续执行提示。', supervision_post_audit_finalizing: '监督：审计已通过，正在执行审计后收尾。', supervision_needs_input: '监督：已交还人工处理。', supervision_audit_pass: '监督：审计已通过。', supervision_rework: '监督：审计要求返工，已发送修复说明。', supervision_blocked: '监督：会话受阻，已停止。', supervision_parked: '监督：等待外部回执。',
    },
    note: {
      checking: '自动：正在检查任务是否完成…', auditDelegated: '自动：已发现现有可回执审计委派，等待 PASS/REWORK 回执，不重复发送。', auditReply: '自动：审计回执已到，等待当前会话给出最终 PASS/REWORK 判断。', auditRecovery: (d) => `自动：审计会话意外停止，已发送继续指令${d}。`, postAuditComplete: '自动：同伴审计已通过，审计后收尾已完成。', auditSkipped: '自动：任务已完成；监督判断无需再次审计。', complete: '自动：任务已完成。', auditAlreadyPassed: '自动：本轮已报告独立审计 PASS，已跳过重复审计。', parkedExternal: '自动：已根据执行会话上报的外部回执进入等待。', parkedReason: (r) => `自动：等待中——${r}`, supervisorRetry: (d) => `自动：本次监督决策未返回——${d}`, heartbeat: (m) => `自动：等待 ${m} 分钟后已请求状态更新；原截止时间不变。`, auditPreparing: '⏳ 自动：正在要求当前会话准备并委派同伴审计；PASS 前暂停提交和推送。', markerCorrection: '自动：审计回执缺少或包含冲突标记，已请求一次有界的仅标记修正。', postAuditFinalizing: '✅ 同伴审计已通过，正在执行延后的提交/推送收尾。', continueSent: '自动：已发送继续执行提示。',
    },
  },
  'zh-TW': {
    status: {
      [SUPERVISION_AUDIT_ENABLED_STATUS]: '監督+稽核已開啟。',
      supervision_waiting: '監督：正在判斷任務是否完成…', supervision_audit_waiting: '監督：同伴審計進行中；結果回覆前暫停提交與推送。', supervision_complete: '監督：任務已完成。', supervision_continue_sent: '監督：已傳送繼續執行提示。', supervision_post_audit_finalizing: '監督：審計已通過，正在執行審計後收尾。', supervision_needs_input: '監督：已交還人工處理。', supervision_audit_pass: '監督：審計已通過。', supervision_rework: '監督：審計要求返工，已傳送修復說明。', supervision_blocked: '監督：工作階段受阻，已停止。', supervision_parked: '監督：等待外部回覆。',
    },
    note: {
      checking: '自動：正在檢查任務是否完成…', auditDelegated: '自動：已發現現有可回覆審計委派，等待 PASS/REWORK 回覆，不重複傳送。', auditReply: '自動：審計回覆已到，等待目前工作階段給出最終 PASS/REWORK 判斷。', auditRecovery: (d) => `自動：審計工作階段意外停止，已傳送繼續指令${d}。`, postAuditComplete: '自動：同伴審計已通過，審計後收尾已完成。', auditSkipped: '自動：任務已完成；監督判斷無需再次審計。', complete: '自動：任務已完成。', auditAlreadyPassed: '自動：本輪已回報獨立審計 PASS，已略過重複審計。', parkedExternal: '自動：已依執行工作階段回報的外部回覆進入等待。', parkedReason: (r) => `自動：等待中——${r}`, supervisorRetry: (d) => `自動：本次監督決策未返回——${d}`, heartbeat: (m) => `自動：等待 ${m} 分鐘後已要求狀態更新；原截止時間不變。`, auditPreparing: '⏳ 自動：正在要求目前工作階段準備並委派同伴審計；PASS 前暫停提交與推送。', markerCorrection: '自動：審計回覆缺少或包含衝突標記，已要求一次有界的僅標記修正。', postAuditFinalizing: '✅ 同伴審計已通過，正在執行延後的提交/推送收尾。', continueSent: '自動：已傳送繼續執行提示。',
    },
  },
  es: {
    status: {
      [SUPERVISION_AUDIT_ENABLED_STATUS]: 'Supervisión + auditoría activadas.',
      supervision_waiting: 'Supervisión: comprobando si terminó…', supervision_audit_waiting: 'Supervisión: auditoría en curso; commit/push pausados.', supervision_complete: 'Supervisión: tarea completada.', supervision_continue_sent: 'Supervisión: continuación enviada.', supervision_post_audit_finalizing: 'Supervisión: auditoría aprobada; finalizando.', supervision_needs_input: 'Supervisión: control devuelto al usuario.', supervision_audit_pass: 'Supervisión: auditoría aprobada.', supervision_rework: 'Supervisión: se solicitó corrección.', supervision_blocked: 'Supervisión: sesión bloqueada.', supervision_parked: 'Supervisión: esperando respuesta externa.',
    },
    note: {
      checking: 'Auto: comprobando si la tarea terminó…', auditDelegated: 'Auto: se detectó una auditoría con respuesta; esperando PASS/REWORK sin duplicarla.', auditReply: 'Auto: llegó la auditoría; esperando el juicio final PASS/REWORK.', auditRecovery: (d) => `Auto: la sesión auditora se detuvo; se envió continuar ${d}.`, postAuditComplete: 'Auto: auditoría aprobada y finalización completada.', auditSkipped: 'Auto: tarea completa; no hace falta otra auditoría.', complete: 'Auto: tarea completa.', auditAlreadyPassed: 'Auto: ya existe un PASS independiente; se omitió la auditoría duplicada.', parkedExternal: 'Auto: en espera de la respuesta externa informada por la sesión ejecutora.', parkedReason: (r) => `Auto: esperando — ${r}`, supervisorRetry: (d) => `Auto: la decisión del supervisor no llegó — ${d}`, heartbeat: (m) => `Auto: se solicitó estado tras ${m} minutos; el plazo original no cambió.`, auditPreparing: '⏳ Auto: preparando la auditoría; commit/push pausados hasta PASS.', markerCorrection: 'Auto: faltaba un marcador inequívoco; se solicitó una corrección acotada.', postAuditFinalizing: '✅ Auditoría aprobada; ejecutando la finalización diferida.', continueSent: 'Auto: se envió una continuación.',
    },
  },
  ru: {
    status: {
      [SUPERVISION_AUDIT_ENABLED_STATUS]: 'Надзор и аудит включены.',
      supervision_waiting: 'Надзор: проверка завершения…', supervision_audit_waiting: 'Надзор: аудит выполняется; commit/push приостановлены.', supervision_complete: 'Надзор: задача завершена.', supervision_continue_sent: 'Надзор: продолжение отправлено.', supervision_post_audit_finalizing: 'Надзор: аудит пройден; выполняется завершение.', supervision_needs_input: 'Надзор: управление возвращено пользователю.', supervision_audit_pass: 'Надзор: аудит пройден.', supervision_rework: 'Надзор: требуется доработка.', supervision_blocked: 'Надзор: сессия заблокирована.', supervision_parked: 'Надзор: ожидание внешнего ответа.',
    },
    note: {
      checking: 'Авто: проверка завершения задачи…', auditDelegated: 'Авто: найдена проверка с ответом; ждём PASS/REWORK без повторной отправки.', auditReply: 'Авто: ответ аудита получен; ждём итоговый PASS/REWORK.', auditRecovery: (d) => `Авто: сессия аудита остановилась; отправлено продолжение ${d}.`, postAuditComplete: 'Авто: аудит пройден, завершение выполнено.', auditSkipped: 'Авто: задача завершена; новый аудит не нужен.', complete: 'Авто: задача завершена.', auditAlreadyPassed: 'Авто: независимый PASS уже есть; повторный аудит пропущен.', parkedExternal: 'Авто: ожидание внешнего ответа, указанного исполнительной сессией.', parkedReason: (r) => `Авто: ожидание — ${r}`, supervisorRetry: (d) => `Авто: решение супервизора не получено — ${d}`, heartbeat: (m) => `Авто: через ${m} мин. запрошен статус; исходный срок сохранён.`, auditPreparing: '⏳ Авто: готовится аудит; commit/push приостановлены до PASS.', markerCorrection: 'Авто: итоговый маркер отсутствовал или был неоднозначным; запрошено одно исправление.', postAuditFinalizing: '✅ Аудит пройден; выполняется отложенное завершение.', continueSent: 'Авто: отправлено продолжение работы.',
    },
  },
  ja: {
    status: {
      [SUPERVISION_AUDIT_ENABLED_STATUS]: '監督＋監査が有効です。',
      supervision_waiting: '監督：完了を確認中…', supervision_audit_waiting: '監督：監査中。結果まで commit/push を停止。', supervision_complete: '監督：タスク完了。', supervision_continue_sent: '監督：続行指示を送信。', supervision_post_audit_finalizing: '監督：監査 PASS。仕上げを実行中。', supervision_needs_input: '監督：ユーザーへ制御を返却。', supervision_audit_pass: '監督：監査 PASS。', supervision_rework: '監督：修正が必要。', supervision_blocked: '監督：セッションがブロック。', supervision_parked: '監督：外部返信を待機中。',
    },
    note: {
      checking: '自動：タスク完了を確認中…', auditDelegated: '自動：返信可能な監査を検出。重複送信せず PASS/REWORK を待機します。', auditReply: '自動：監査返信を受信。最終 PASS/REWORK を待機します。', auditRecovery: (d) => `自動：監査セッションが停止したため続行を送信しました${d}。`, postAuditComplete: '自動：監査 PASS、仕上げ完了。', auditSkipped: '自動：タスク完了。新たな監査は不要です。', complete: '自動：タスク完了。', auditAlreadyPassed: '自動：独立監査 PASS 済みのため重複監査を省略しました。', parkedExternal: '自動：実行セッションが報告した外部返信を待機します。', parkedReason: (r) => `自動：待機中 — ${r}`, supervisorRetry: (d) => `自動：監督判断が返りませんでした — ${d}`, heartbeat: (m) => `自動：${m} 分後に状態を確認しました。元の期限は維持されます。`, auditPreparing: '⏳ 自動：監査を準備中。PASS まで commit/push を停止します。', markerCorrection: '自動：最終マーカーが不足または曖昧なため、1回の修正を要求しました。', postAuditFinalizing: '✅ 監査 PASS。延期された仕上げを実行中です。', continueSent: '自動：続行指示を送信しました。',
    },
  },
  ko: {
    status: {
      [SUPERVISION_AUDIT_ENABLED_STATUS]: '감독+감사가 활성화되었습니다.',
      supervision_waiting: '감독: 완료 여부 확인 중…', supervision_audit_waiting: '감독: 감사 진행 중; 결과 전까지 commit/push 중지.', supervision_complete: '감독: 작업 완료.', supervision_continue_sent: '감독: 계속 지시 전송.', supervision_post_audit_finalizing: '감독: 감사 PASS; 마무리 진행 중.', supervision_needs_input: '감독: 사용자에게 제어 반환.', supervision_audit_pass: '감독: 감사 PASS.', supervision_rework: '감독: 수정 필요.', supervision_blocked: '감독: 세션 차단.', supervision_parked: '감독: 외부 회신 대기 중.',
    },
    note: {
      checking: '자동: 작업 완료 여부 확인 중…', auditDelegated: '자동: 회신 가능한 감사를 감지했습니다. 중복 전송 없이 PASS/REWORK를 기다립니다.', auditReply: '자동: 감사 회신이 도착했습니다. 최종 PASS/REWORK를 기다립니다.', auditRecovery: (d) => `자동: 감사 세션이 중지되어 계속 지시를 보냈습니다${d}.`, postAuditComplete: '자동: 감사 PASS, 마무리 완료.', auditSkipped: '자동: 작업 완료; 새 감사 불필요.', complete: '자동: 작업 완료.', auditAlreadyPassed: '자동: 독립 감사 PASS가 이미 있어 중복 감사를 건너뜁니다.', parkedExternal: '자동: 실행 세션이 보고한 외부 회신을 기다립니다.', parkedReason: (r) => `자동: 대기 중 — ${r}`, supervisorRetry: (d) => `자동: 감독 판단이 오지 않았습니다 — ${d}`, heartbeat: (m) => `자동: ${m}분 후 상태를 요청했습니다. 원래 기한은 유지됩니다.`, auditPreparing: '⏳ 자동: 감사를 준비 중입니다. PASS 전까지 commit/push를 중지합니다.', markerCorrection: '자동: 최종 마커가 없거나 모호하여 한 번의 제한된 수정을 요청했습니다.', postAuditFinalizing: '✅ 감사 PASS. 연기된 마무리를 실행 중입니다.', continueSent: '자동: 계속 지시를 전송했습니다.',
    },
  },
};

function locale(value: string | null | undefined): SupervisionUiLocale {
  return normalizeSupervisionUiLocale(value) ?? 'en';
}

export function localizeSupervisionStatusLabel(
  status: string,
  fallback: string,
  uiLocale: string | null | undefined,
): string {
  return COPY[locale(uiLocale)].status[status] ?? fallback;
}

export function localizeSupervisionAutomationNote(
  kind: string,
  fallback: string,
  uiLocale: string | null | undefined,
): string {
  const copy = COPY[locale(uiLocale)].note;
  switch (kind) {
    case SUPERVISION_SUPERVISOR_RETRY_AUTOMATION_KIND: return copy.supervisorRetry(fallback);
    case 'supervision-status': return copy.checking;
    case 'supervision-audit-delegated': return copy.auditDelegated;
    case 'supervision-audit-reply-received': return copy.auditReply;
    case SUPERVISION_AUDIT_TARGET_RECOVERY_AUTOMATION_KIND: {
      const match = fallback.match(/continue\s+(\([^)]*\)\s+for audit attempt\s+[^.]+)/i);
      return copy.auditRecovery(match ? ` ${match[1]}` : '');
    }
    case 'supervision-post-audit-complete': return copy.postAuditComplete;
    case 'supervision-audit-skipped': return copy.auditSkipped;
    case 'supervision-complete': return copy.complete;
    case 'supervision-audit-already-passed': return copy.auditAlreadyPassed;
    case 'supervision-parked': {
      const reason = fallback.match(/—\s*(.+)$/)?.[1];
      return reason ? copy.parkedReason(reason) : copy.parkedExternal;
    }
    case SUPERVISION_WAITING_HEARTBEAT_AUTOMATION_KIND: {
      const minutes = fallback.match(/after\s+(\d+)\s+minutes/i)?.[1] ?? '?';
      return copy.heartbeat(minutes);
    }
    case 'supervision-audit': return copy.auditPreparing;
    case 'supervision-audit-marker-correction-status': return copy.markerCorrection;
    case 'supervision-post-audit-finalization-status': return copy.postAuditFinalizing;
    case 'supervision-continue-status': return copy.continueSent;
    default: return fallback;
  }
}
