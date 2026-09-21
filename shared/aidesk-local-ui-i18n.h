#ifndef IMCODES_SHARED_AIDESK_LOCAL_UI_I18N_H_
#define IMCODES_SHARED_AIDESK_LOCAL_UI_I18N_H_

#include <array>

namespace imcodes::aidesk::i18n {

// Single authored source for every native aiDesk local-UI string. Columns are
// en, zh-CN, zh-TW, es, ru, ja and ko, matching the product locale set.
using Row = std::array<const char*, 7>;

// One authored table for all native user-visible strings. Columns are
// en, zh-CN, zh-TW, es, ru, ja, ko. UI code only refers to Text values.
inline constexpr std::array<Row, 29> kText = {{
    {"aiDesk.to by IM.codes", "aiDesk.to by IM.codes", "aiDesk.to by IM.codes", "aiDesk.to by IM.codes", "aiDesk.to by IM.codes", "aiDesk.to by IM.codes", "aiDesk.to by IM.codes"},
    {"Public ID", "本机公共 ID", "本機公開 ID", "ID público", "Публичный ID", "公開 ID", "공개 ID"},
    {"Copy", "复制", "複製", "Copiar", "Копировать", "コピー", "복사"},
    {"Copied", "已复制", "已複製", "Copiado", "Скопировано", "コピー済み", "복사됨"},
    {"Ready", "已就绪", "已就緒", "Listo", "Готово", "準備完了", "준비됨"},
    {"Starting…", "正在启动…", "正在啟動…", "Iniciando…", "Запуск…", "起動中…", "시작 중…"},
    {"Service stopped", "服务已停止", "服務已停止", "Servicio detenido", "Служба остановлена", "サービス停止", "서비스 중지됨"},
    {"Service needs repair", "服务需要修复", "服務需要修復", "Reparar servicio", "Требуется ремонт", "修復が必要", "서비스 복구 필요"},
    {"Version mismatch", "版本不匹配", "版本不相容", "Versiones incompatibles", "Несовместимая версия", "バージョン不一致", "버전 불일치"},
    {"Connections", "连接列表", "連線清單", "Conexiones", "Подключения", "接続一覧", "연결 목록"},
    {"No active connections", "当前无人连接", "目前無人連線", "Sin conexiones activas", "Нет активных подключений", "接続なし", "활성 연결 없음"},
    {"Viewing", "查看", "檢視", "Vista", "Просмотр", "閲覧", "보기"},
    {"Controlling", "控制", "控制", "Control", "Управление", "操作", "제어"},
    {"Connected", "连接时间", "連線時間", "Conectado", "Подключён", "接続時刻", "연결 시간"},
    {"Duration", "时长", "時間", "Duración", "Длительность", "経過時間", "기간"},
    {"Disconnect", "断开", "中斷", "Desconectar", "Отключить", "切断", "연결 끊기"},
    {"Disconnect only this connection?", "只断开这一条连接？", "只中斷這一條連線？", "¿Desconectar solo esta conexión?", "Отключить только это подключение?", "この接続だけを切断しますか？", "이 연결만 끊을까요?"},
    {"Pause remote access", "暂停远程访问", "暫停遠端存取", "Pausar acceso remoto", "Приостановить доступ", "リモートアクセスを一時停止", "원격 액세스 일시 중지"},
    {"Resume remote access", "恢复远程访问", "恢復遠端存取", "Reanudar acceso remoto", "Возобновить доступ", "リモートアクセスを再開", "원격 액세스 재개"},
    {"Stop all current connections", "停止所有当前连接", "停止所有目前連線", "Detener conexiones actuales", "Остановить текущие подключения", "現在の全接続を停止", "현재 모든 연결 중지"},
    {"Stop every current viewing and control connection? Remote access remains enabled.", "断开全部当前查看和控制连接？远程访问仍保持启用。", "中斷全部目前檢視和控制連線？遠端存取仍保持啟用。", "¿Detener todas las conexiones actuales? El acceso seguirá habilitado.", "Отключить всех сейчас? Удалённый доступ останется включён.", "現在の全接続を停止しますか？リモートアクセスは有効なままです。", "현재 모든 연결을 끊을까요? 원격 액세스는 계속 활성화됩니다."},
    {"Confirm again", "再次确认", "再次確認", "Confirmar de nuevo", "Подтвердить ещё раз", "もう一度確認", "다시 확인"},
    {"Cancel", "取消", "取消", "Cancelar", "Отмена", "キャンセル", "취소"},
    {"Web management", "网页管理", "網頁管理", "Administración web", "Веб-управление", "Web 管理", "웹 관리"},
    {"Share", "分享", "分享", "Compartir", "Поделиться", "共有", "공유"},
    {"Waiting for service…", "等待服务确认…", "等待服務確認…", "Esperando al servicio…", "Ожидание службы…", "サービス確認待ち…", "서비스 확인 대기 중…"},
    {"Action failed", "操作失败", "操作失敗", "Error en la acción", "Ошибка операции", "操作に失敗しました", "작업 실패"},
    {"aiDesk service is not running", "aiDesk 服务未运行", "aiDesk 服務未執行", "El servicio aiDesk no está activo", "Служба aiDesk не запущена", "aiDesk サービスが停止しています", "aiDesk 서비스가 실행 중이 아님"},
    {"Remote access paused", "远程访问已暂停", "遠端存取已暫停", "Acceso remoto en pausa", "Удалённый доступ приостановлен", "リモートアクセス一時停止中", "원격 액세스 일시 중지됨"},
}};

}  // namespace imcodes::aidesk::i18n

#endif  // IMCODES_SHARED_AIDESK_LOCAL_UI_I18N_H_
