import type { MessageValues } from "./catalog.ts";

export type UiText =
  | {
      kind: "message";
      key: string;
      params?: Record<string, UiTextParam>;
    }
  | {
      kind: "source";
      text: string;
    };

export type UiTextParam = string | number | UiText;

export function messageText(
  key: string,
  params?: Record<string, UiTextParam>,
): UiText {
  return params ? { kind: "message", key, params } : { kind: "message", key };
}

export function sourceText(text: string): UiText {
  return { kind: "source", text };
}

export function renderUiText(
  value: UiText,
  translate: (key: string, values?: MessageValues) => string,
  formatNumber: (value: number) => string,
): string {
  if (value.kind === "source") return value.text;

  const params: MessageValues | undefined = value.params
    ? Object.fromEntries(
        Object.entries(value.params).map(([key, param]) => [
          key,
          typeof param === "number"
            ? formatNumber(param)
            : typeof param === "string"
              ? param
              : renderUiText(param, translate, formatNumber),
        ]),
      )
    : undefined;
  return translate(value.key, params);
}
