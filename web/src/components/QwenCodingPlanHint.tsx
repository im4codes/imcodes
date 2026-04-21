import { useTranslation } from "react-i18next";

interface Props {
  selected: boolean;
}

export function QwenCodingPlanHint({ selected }: Props) {
  const { t } = useTranslation();

  return (
    <div
      style={{
        marginTop: 8,
        padding: "10px 12px",
        borderRadius: 6,
        border: "1px solid #1e3a8a",
        background: "#0f172a",
        fontSize: 12,
        lineHeight: 1.5,
        color: "#bfdbfe",
      }}
    >
      <div>{t("new_session.qwen_provider_hint")}</div>
      {selected && (
        <div style={{ marginTop: 6, color: "#dbeafe" }}>
          {t("new_session.qwen_provider_selected_hint")}
        </div>
      )}
    </div>
  );
}
